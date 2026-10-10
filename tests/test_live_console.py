"""No hardware writes: protocol, real loopback TCP and SDL dummy rendering tests."""
import csv
import json
import math
import os
from pathlib import Path
import socket
import socketserver
import struct
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid
import zlib

from board.ads8688d import channel_capabilities, discovery_capabilities
from client import ads8688_protocol as wire
from live_console.model import FRAME, History, Sample, decode_sample, envelope, limits, validate_rate, visible_rows
from live_console.network import Fleet, PacketDecoder, Session, checked_control


def payload(sequence=1, rate=1000, code=32768, record=None):
    frame = FRAME.pack(0x38534441, 1, 28, sequence, sequence*1000, rate, 8, 1, *([code]*8), 0)
    frame = frame[:-4] + struct.pack('<I', zlib.crc32(frame[:-4]))
    return struct.pack('!QQ', sequence if record is None else record, 1_700_000_000_000_000_000+sequence*1_000_000) + frame


def nu40_payload(sequence=1, xyz=(100, -200, 300), record=None):
    frame = struct.pack('<IHHIQIHH8hI', 0x3034554e, 1, 28, sequence,
                        1_700_000_000_000_000 + sequence*9615, 104, 3, 2,
                        *xyz, 0, 0, 0, 0, 0, 0)
    frame = frame[:-4] + struct.pack('<I', zlib.crc32(frame[:-4]))
    return struct.pack('!QQ', sequence if record is None else record,
                       1_700_000_000_000_000_000+sequence*9_615_000) + frame


def until(condition, timeout=5):
    deadline = time.monotonic()+timeout
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(.02)
    raise AssertionError('condition did not become true')


class MockBoard(socketserver.ThreadingTCPServer):
    """Fixture only: models independent subscribers, never binds a LAN address."""
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, control=True, reject_readback=False, split=False):
        self.identity = str(uuid.uuid4())
        self.control, self.reject_readback, self.split = control, reject_readback, split
        self.rate, self.acquiring = 1000, True
        self.commands = []
        self.clients = set()
        self.lock = threading.Lock()
        self.closing = threading.Event()
        super().__init__(('127.0.0.1', 0), MockHandler)
        self.worker = threading.Thread(target=self.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
        self.worker.start()

    def data(self):
        caps = channel_capabilities(self.rate, {'state': 'streaming', 'rate_hz': 104})
        if not self.control:
            for group in caps['sampleRateGroups']:
                group['writable'] = False
        return dict(uuid=self.identity, hostname='Loopback fixture', model='TEST ONLY', acquiring=self.acquiring,
                    channel_capabilities=caps,
                    capabilities=['live_stream', 'timestamped_stream', 'mixed_stream_v3'] + (['acquisition_control'] if self.control else []))

    def session(self):
        return Session(dict(ip='127.0.0.1', tcp_port=self.server_address[1], uuid=self.identity))

    def drop_clients(self):
        with self.lock:
            for client in self.clients:
                try:
                    client.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    def close(self):
        self.closing.set()
        self.drop_clients()
        self.shutdown()
        self.server_close()
        self.worker.join(1)


class MockHandler(socketserver.BaseRequestHandler):
    def handle(self):
        board = self.server
        with board.lock:
            board.clients.add(self.request)
        self.request.settimeout(.015)
        decoder, streaming, seq, split = PacketDecoder(), False, 0, board.split
        try:
            while not board.closing.is_set():
                try:
                    chunk = self.request.recv(65536)
                    if not chunk:
                        break
                    for kind, req, body in decoder.feed(chunk):
                        with board.lock:
                            board.commands.append(kind)
                        if not board.reject_readback:
                            if kind in (wire.ACQ_START, wire.ACQ_STOP):
                                board.acquiring = kind == wire.ACQ_START
                            elif kind == wire.SET_RATE_GROUP:
                                board.rate = json.loads(body)['rateHz']
                        self.request.sendall(wire.message(kind | wire.RESPONSE, req, json.dumps(board.data()).encode()))
                        if kind in (wire.STREAM_START, wire.STREAM_START_V2, wire.STREAM_START_V3):
                            streaming = True
                            self.request.sendall(wire.message(wire.ANOMALY_EVENT, 0, b'{"channels":[{"id":"CH0","state":"alarm","ratio":3}]}'))
                except socket.timeout:
                    pass
                if streaming:
                    seq += 1
                    packet = wire.message(wire.LIVE_DATA_V2, 0, payload(seq, board.rate, record=seq*2))
                    packet += wire.message(wire.LIVE_DATA_V2, 0, nu40_payload(seq, record=seq*2+1))
                    if split:
                        # Longer than the client's recv timeout: a partial body MUST survive.
                        self.request.sendall(packet[:19])
                        board.closing.wait(.35)
                        self.request.sendall(packet[19:])
                        split = False
                    else:
                        self.request.sendall(packet)
        except OSError:
            pass
        finally:
            with board.lock:
                board.clients.discard(self.request)


class ModelTests(unittest.TestCase):
    def test_voltage_crc_and_timestamp(self):
        self.assertEqual(decode_sample(payload(code=0), True).volts(0), -10.24)
        self.assertEqual(decode_sample(payload(), True).volts(0), 0)
        self.assertAlmostEqual(decode_sample(payload(code=65535), True).volts(0), 10.2396875)
        self.assertIsNone(decode_sample(payload()[:8]+payload()[16:], False).unix_ns)
        for data in (payload()[:-1], payload()[:-1]+b'\xff', payload(rate=0)):
            with self.assertRaises(ValueError):
                decode_sample(data, True)

    def test_nu40_signed_acceleration_frame(self):
        sample = decode_sample(nu40_payload(xyz=(100, -200, 300)), True)
        self.assertEqual((sample.source, sample.channel_offset, sample.codes), ('nu40', 8, (100, -200, 300)))
        self.assertFalse(sample.contains(7))
        self.assertTrue(sample.contains(10))
        self.assertAlmostEqual(sample.value(8), .0061)
        self.assertAlmostEqual(sample.value(9), -.0122)
        self.assertEqual(sample.unit(10), 'g')

    def test_incremental_packets_and_rejected_header(self):
        packets = wire.message(wire.LIVE_DATA_V2, 0, payload()) + wire.message(wire.STATUS | wire.RESPONSE, 4, b'{}')
        decoder, results = PacketDecoder(), []
        for byte in packets:
            results += decoder.feed(bytes([byte]))
        self.assertEqual(len(results), 2)
        self.assertEqual(decode_sample(results[0][2], True).record, 1)
        self.assertFalse(decoder.buffer)
        with self.assertRaises(ValueError):
            decoder.feed(wire.NET_HEADER.pack(65537, 1, 1, 1))

    def test_history_bounded_gap_restart_and_reconnect(self):
        history = History(3)
        for sequence in (1, 2, 5, 6):
            history.append(decode_sample(payload(sequence), True))
        self.assertEqual(len(history.rows), 3)
        self.assertEqual(history.gaps, 2)
        frozen = list(history.rows)
        history.break_pending = True
        self.assertFalse(history.append(decode_sample(payload(6), True)))
        self.assertEqual(history.restarts, 0)
        history.append(decode_sample(payload(7), True))
        self.assertGreater(history.rows[-1].segment, frozen[-1].segment)
        history.append(decode_sample(payload(1), True))
        self.assertEqual((history.restarts, len(history.rows), len(frozen)), (1, 1, 3))

    def test_sequence_wrap_not_loss(self):
        history = History()
        history.append(Sample(1, None, 0xffffffff, 1000, 1000, (0,)*8))
        history.append(Sample(2, None, 0, 2000, 1000, (0,)*8))
        self.assertEqual(history.gaps, 0)
        self.assertEqual(history.rows[-1].segment, 0)

    def test_window_envelope_limits(self):
        rows = [decode_sample(payload(i), True) for i in range(1, 1001)]
        shown = visible_rows(rows, .2, .5)
        self.assertEqual((shown[0].device_us, shown[-1].device_us), (300000, 500000))
        points = [Sample(i, None, i, i*1000, 1000, (100 if i == 333 else 1 if i == 334 else 50,)*8, int(i>5050)) for i in range(10000)]
        reduced = envelope(points, 0, 100)
        self.assertIn(points[333], reduced)
        self.assertIn(points[334], reduced)
        self.assertIn(points[5050], reduced)
        self.assertIn(points[5051], reduced)
        self.assertEqual(reduced, sorted(reduced, key=lambda row: row.record))
        self.assertLessEqual(len(reduced), 402)
        self.assertEqual(limits([0], True), (-.000625, .000625))
        self.assertEqual(limits([0], False), (-10.24, 10.24))

    def test_discovery_v1_v2_and_bad_nonce(self):
        identity, nonce = uuid.uuid4(), 999
        caps = json.dumps(discovery_capabilities(1000)).encode()
        for version in (1, 2):
            header = wire.DISCOVERY_RESPONSE.pack(b'A8DR', version, 0, nonce, identity.bytes, 8765, 4, 5)
            packet = header + (struct.pack('!H', len(caps)) if version == 2 else b'') + b'hostmodel' + (caps if version == 2 else b'')
            result = wire.decode_discovery(packet, '127.0.0.1', nonce)
            self.assertEqual(result['uuid'], str(identity))
            if version == 2:
                self.assertEqual(result['channel_capabilities']['channelCount'], 11)
                self.assertFalse(result['channel_capabilities']['channels'][-1]['streamAvailable'])
            self.assertIsNone(wire.decode_discovery(packet, '127.0.0.1', nonce+1))
            self.assertIsNone(wire.decode_discovery(packet[:-1], '127.0.0.1', nonce))

    def test_rate_validation(self):
        group = channel_capabilities(1000)['sampleRateGroups'][0]
        self.assertEqual(validate_rate(group, '1000'), 1000)
        for value in ('nan', 'inf', '-1', '2001', '10.5', 'abc'):
            with self.assertRaises(ValueError):
                validate_rate(group, value)
        with self.assertRaises(ValueError):
            validate_rate({'writable': False}, '1000')


class NetworkTests(unittest.TestCase):
    def setUp(self):
        self.boards, self.sessions = [], []

    def board(self, **kwargs):
        board = MockBoard(**kwargs)
        self.boards.append(board)
        return board

    def session(self, board):
        session = board.session()
        self.sessions.append(session)
        return session

    def tearDown(self):
        for session in self.sessions:
            session.stop()
        for board in self.boards:
            board.close()
        for session in self.sessions:
            session.thread.join(2)
            self.assertFalse(session.thread.is_alive())

    def test_two_boards_multiple_clients_fragmentation_reconnect_and_push(self):
        first, second = self.board(split=True), self.board()
        sessions = [self.session(first), self.session(first), self.session(second)]
        until(lambda: all(s.snapshot()['total'] >= 5 for s in sessions))
        self.assertTrue(all(s.snapshot()['bad'] == 0 for s in sessions))
        self.assertTrue(all(s.snapshot()['anomaly']['channels'][0]['state'] == 'alarm' for s in sessions))
        first.drop_clients()
        until(lambda: all(s.snapshot()['reconnects'] >= 1 for s in sessions[:2]))
        until(lambda: all(s.snapshot()['link'] == 'online' for s in sessions))
        sessions[0].connect_enabled(False)
        until(lambda: sessions[0].snapshot()['link'] == 'disconnected')
        before = sessions[1].snapshot()['total']
        until(lambda: sessions[1].snapshot()['total'] > before+3)
        self.assertNotIn(wire.ACQ_STOP, first.commands)
        self.assertNotIn(wire.ACQ_START, first.commands)

    def test_ack_and_readback_controls(self):
        board = self.board()
        args = ('127.0.0.1', board.server_address[1], board.identity)
        self.assertFalse(checked_control(*args, 'stop')['acquiring'])
        self.assertTrue(checked_control(*args, 'start')['acquiring'])
        self.assertEqual(checked_control(*args, 'rate', 'ads8688.scan', 500)['channel_capabilities']['sampleRateGroups'][0]['currentHz'], 500)
        board.reject_readback = True
        with self.assertRaisesRegex(ValueError, 'ACK'):
            checked_control(*args, 'stop')
        with self.assertRaisesRegex(ValueError, 'ACK'):
            checked_control(*args, 'rate', 'ads8688.scan', 600)

    def test_identity_and_unsupported_controls_are_blocked_before_write(self):
        board = self.board(control=False)
        for identity, action in ((str(uuid.uuid4()), 'stop'), (board.identity, 'stop'), (board.identity, 'rate')):
            with self.assertRaises(ValueError):
                checked_control('127.0.0.1', board.server_address[1], identity, action, 'ads8688.scan', 500)
        self.assertFalse(set(board.commands) & {wire.ACQ_START, wire.ACQ_STOP, wire.SET_RATE_GROUP})


class RenderTests(unittest.TestCase):
    def test_event_driven_wakeup_is_coalesced_and_not_timer_throttled(self):
        try:
            import pygame
        except ImportError:
            self.skipTest('pygame not installed; use .venv-client')
        os.environ['SDL_VIDEODRIVER'] = 'dummy'
        from live_console.app import Console
        fleet = SimpleNamespace(all=lambda: [], scanning=False, message='', scan_now=threading.Event())
        console = Console(fleet)
        pygame.event.clear()
        for _ in range(1000):
            console.wake()
        self.assertEqual(len(pygame.event.get(console.data_event)), 1)
        console.wake_pending = False
        draws, sent = [], []

        def producer():
            time.sleep(.1)
            sent.append(time.monotonic())
            fleet.on_change()

        worker = threading.Thread(target=producer)
        worker.start()
        original_draw = console.draw

        def draw():
            draws.append(time.monotonic())
            original_draw()

        try:
            with patch.object(console, 'draw', side_effect=draw):
                console.run(duration=.4)
        finally:
            worker.join(1)
        self.assertTrue(any(0 <= at-sent[0] < .15 for at in draws))
        self.assertLess(len(draws), 6, 'No periodic 30 FPS redraw loop while idle')
        self.assertIsNone(fleet.on_change)
        console.wake()  # Closing is safe even if a late receive notification arrives.

    def test_controls_pause_csv_and_fluent_layout(self):
        try:
            import pygame
        except ImportError:
            self.skipTest('pygame not installed; use .venv-client')
        os.environ['SDL_VIDEODRIVER'] = 'dummy'
        from live_console.app import Console
        board = MockBoard()
        fleet = None
        try:
            with patch.object(wire, 'discover', return_value=[]):
                fleet = Fleet(['127.0.0.1'], [('127.0.0.1', board.server_address[1])])
                session = fleet.all()[0]
                until(lambda: session.snapshot()['total'] > 3)
                console = Console(fleet)
                # Deterministic rendering fixture, not sensor data.
                with session.lock:
                    session.history = History()
                    for i in range(2500):
                        codes = tuple(round(32768+9000*math.sin(i*.014+c*.4)+c*250) for c in range(8))
                        session.history.append(Sample(i, 1_700_000_000_000_000_000+i*1_000_000, i, i*1000, 1000, codes))
                    for i in range(3):
                        session.history.append(Sample(10_000+i, 1_700_000_002_500_000_000+i*1_000_000,
                                                      i, 1_700_000_002_500_000+i*9615, 104,
                                                      (100+i, -200-i, 300+i), source='nu40'))
                    session.label = 'AM6442 SK · UI fixture'
                    console.freeze()
                with tempfile.TemporaryDirectory() as folder:
                    console.export_dir = Path(folder)
                    count, last = session.snapshot()['total'], console.frozen[-1]
                    until(lambda: session.snapshot()['total'] > count+2)
                    self.assertEqual(console.frozen[-1], last)
                    console.draw()
                    self.assertEqual(len(console.plots), 11)
                    artifact = os.environ.get('LIVE_CONSOLE_TEST_RENDER_DIR')
                    if artifact:
                        Path(artifact).mkdir(parents=True, exist_ok=True)
                        pygame.image.save(console.screen, str(Path(artifact)/'winui-fixture.png'))
                    console.export(session.snapshot(), visible_rows(console.frozen, 2))
                    until(lambda: not console.exporting)
                    with next(Path(folder).glob('*.csv')).open(encoding='utf-8-sig', newline='') as stream:
                        rows = list(csv.reader(stream))
                    self.assertEqual(len(rows), 2001)
                    self.assertEqual(len(rows[0]), 29)
                    self.assertIn('CH7_V', rows[0])
                    self.assertIn('CH10_g', rows[0])
                    console.control_modal('stop')
                    self.assertNotIn(wire.ACQ_STOP, board.commands)
                    console.draw()
                    console.close_modal()
                    console.detail = True
                    console.draw()
                    self.assertEqual(len(console.plots), 1)
                    console.detail = False
                    console.handle(pygame.event.Event(pygame.VIDEORESIZE, w=1160, h=760))
                    console.draw()
                    self.assertTrue(all(console.screen.get_rect().contains(rect) for rect in console.plots))
                    if artifact:
                        pygame.image.save(console.screen, str(Path(artifact)/'winui-compact-fixture.png'))
        finally:
            if fleet:
                fleet.stop()
            board.close()
            pygame.quit()


if __name__ == '__main__':
    unittest.main()
