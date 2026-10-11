"""NU40 FieldLink v1 protocol and per-axis RMS; no Bluetooth dependency here."""
import math
import struct
import time
import zlib
from collections import deque

HEADER = struct.Struct('<2sBBBBHH')
FRAME = struct.Struct('<IHHIQIHH8hI')
MAGIC = 0x3034554E  # NU40, distinct from ADS8688 (never voltage encoded)
RATES = (13, 26, 52, 104)
G_PER_LSB = 0.000061
MEDIAN_WINDOW = 10
AVERAGE_WINDOW = 10


def packet(kind, payload=b'', sequence=0):
    body = HEADER.pack(b'FL', 1, kind, 1, 0, sequence & 65535, len(payload)) + payload
    return body + struct.pack('<I', zlib.crc32(body))


class Parser:
    def __init__(self):
        self.buffer = bytearray()
        self.corrupt = 0

    def feed(self, data):
        if len(data) > 2048:
            self.buffer.clear()
            self.corrupt += 1
            return []
        self.buffer.extend(data)
        result = []
        while len(self.buffer) >= 10:
            magic, version, kind, flags, reserved, seq, length = HEADER.unpack_from(self.buffer)
            if magic != b'FL' or version != 1 or flags != 1 or reserved or length > 1024:
                del self.buffer[0]
                self.corrupt += 1
                continue
            total = 14 + length
            if len(self.buffer) < total:
                break
            if zlib.crc32(self.buffer[:10 + length]) != struct.unpack_from('<I', self.buffer, 10 + length)[0]:
                del self.buffer[0]
                self.corrupt += 1
                continue
            result.append((kind, seq, bytes(self.buffer[10:10 + length])))
            del self.buffer[:total]
        return result


class MedianMovingAverage:
    """ESP-compatible per-axis sliding median followed by moving average."""
    def __init__(self, median_window=MEDIAN_WINDOW, average_window=AVERAGE_WINDOW):
        self.median_window, self.average_window = median_window, average_window
        self.median = [deque(maxlen=median_window) for _ in range(3)]
        self.average = [deque(maxlen=average_window) for _ in range(3)]

    @staticmethod
    def _median(values):
        values = sorted(values)
        middle = len(values) // 2
        return values[middle] if len(values) & 1 else (values[middle - 1] + values[middle] + 1) // 2

    @staticmethod
    def _rounded_mean(values):
        total, count = sum(values), len(values)
        return ((total + count // 2) // count if total >= 0
                else -((-total + count // 2) // count))

    def update(self, xyz):
        output = []
        for axis, value in enumerate(xyz):
            self.median[axis].append(value)
            self.average[axis].append(self._median(self.median[axis]))
            output.append(self._rounded_mean(self.average[axis]))
        return tuple(output)


class RmsDetector:
    """ESP detector equations, in g instead of synthetic volts. Every sample is scored."""
    def __init__(self, rate, short_tau=.25, long_tau=10., warn=2., alarm=3., floor=.002):
        self.rate, self.short_tau, self.long_tau = rate, short_tau, long_tau
        self.warn, self.alarm, self.floor = warn, alarm, floor
        self.short = 1 - math.exp(-1 / (short_tau * rate))
        self.long = 1 - math.exp(-1 / (long_tau * rate))
        self.count = 0
        self.last_ms = 0
        self.axes = [dict(id=f'CH{i + 8}', state='warmup', mean=0., ps=0., pl=0.,
                          rms_short=0., rms_long=0., ratio=0., events=0, changed_unix_ms=0) for i in range(3)]

    def update(self, xyz, at_ms):
        self.last_ms = at_ms
        changed = False
        for c, raw in zip(self.axes, xyz):
            value = raw * G_PER_LSB
            if not self.count:
                c['mean'] = value
            c['mean'] += self.long * (value - c['mean'])
            power = (value - c['mean']) ** 2
            c['ps'] += self.short * (power - c['ps'])
            c['pl'] += self.long * (power - c['pl'])
            c['rms_short'], c['rms_long'] = math.sqrt(c['ps']), math.sqrt(c['pl'])
            ratio = c['ratio'] = math.sqrt(c['ps'] / max(c['pl'], self.floor ** 2))
            previous = c['state']
            state = ('alarm' if ratio >= self.alarm or previous == 'alarm' and ratio >= .8 * self.alarm else
                     'warning' if ratio >= self.warn or previous in ('warning', 'alarm') and ratio >= .8 * self.warn else 'normal')
            if self.count < self.long_tau * self.rate:
                state = 'warmup'
            if state != previous:
                c['state'], c['changed_unix_ms'] = state, at_ms
                c['events'] += int(state in ('warning', 'alarm') and previous not in ('warning', 'alarm'))
                changed = True
        self.count += 1
        return changed

    def snapshot(self):
        return dict(method='rms_sta_lta', unit='g', short_tau_s=self.short_tau, long_tau_s=self.long_tau,
                    warn_ratio=self.warn, alarm_ratio=self.alarm, rms_floor=self.floor,
                    samples_scored=self.count, evaluated_unix_ms=self.last_ms,
                    channels=[{k: v for k, v in c.items() if k not in ('mean', 'ps', 'pl')} for c in self.axes])


class Link:
    """One explicitly identified NU40 central. Callback emits batches/status to DAQ."""
    def __init__(self, send, emit, gateway_id=b'AM6442DA', rate=104):
        self.send, self.emit, self.gateway_id = send, emit, gateway_id[:8]
        self.rate = rate
        self.parser = Parser()
        self.tx_seq = 0
        self.wanted = True
        self.reset()

    def reset(self):
        self.parser.buffer.clear()
        self.state = 'disconnected'
        self.identity = None
        self.next_seq = None
        self.next_us = None
        self.last_rx = 0.
        self.gaps = 0
        self.filter = MedianMovingAverage()
        self.detector = RmsDetector(self.rate)

    def send_control(self, kind, payload=b''):
        self.send(packet(kind, payload, self.tx_seq))
        self.tx_seq = (self.tx_seq + 1) & 65535

    def status(self):
        return dict(state=self.state, identity=self.identity, rate_hz=self.rate, gaps=self.gaps,
                    corrupt=self.parser.corrupt, timestamp_quality='host_estimated',
                    filter=dict(order=['median', 'moving_average'],
                                median_window_samples=MEDIAN_WINDOW,
                                moving_average_window_samples=AVERAGE_WINDOW,
                                stream_input='filtered', anomaly_input='raw'),
                    anomaly=self.detector.snapshot() if self.state == 'streaming' else None)

    def configure(self):
        self.state = 'configuring'
        # 10 frames: ~96 ms per BLE packet at 104 Hz. Maximum source ODR is preserved.
        self.send_control(0x20, struct.pack('<IHBBHH', self.rate, 7, 10, 1, 100, 1000))

    def receive(self, data, now_ns=None):
        now_ns = time.time_ns() if now_ns is None else now_ns
        for kind, _seq, payload in self.parser.feed(data):
            try:
                self.handle(kind, payload, now_ns)
            except (ValueError, struct.error):
                self.parser.corrupt += 1

    def handle(self, kind, p, now_ns):
        if kind == 1:
            if (len(p) < 37 or not 1 <= p[36] <= 32 or len(p) != 37 + p[36] or
                    p[:4] != bytes((1, 1, 1, 2)) or p[20] != 3 or
                    p[37:] != b'NU40_ACCEL' or struct.unpack_from('<H', p, 12)[0] != 1 or
                    struct.unpack_from('<I', p, 16)[0] & 5 != 5):
                raise ValueError('not the supported NU40')
            self.reset()
            self.identity = p[4:12].hex()
            self.state = 'hello'
            ack = struct.pack('<BBBB8sHHIHI', 0, 1, 0x80, 1, self.gateway_id, 1, 244, 5, 1000, 0xffffffff)
            self.send_control(2, ack)
        elif kind == 3 and self.state == 'hello':
            if len(p) != 12 or struct.unpack_from('<H', p)[0] < 23:
                raise ValueError('invalid LINK_INFO')
            self.configure()
        elif kind == 0x21 and self.state == 'configuring':
            if len(p) != 16 or p[0] not in (0, 1):
                raise ValueError('configuration rejected')
            rate = struct.unpack_from('<I', p, 4)[0]
            if rate not in RATES or struct.unpack_from('<H', p, 8)[0] != 7 or p[11] != 1:
                raise ValueError('unsupported configuration')
            self.rate = rate
            self.filter = MedianMovingAverage()
            self.detector = RmsDetector(rate)
            self.next_seq = self.next_us = None
            self.state = 'starting' if self.wanted else 'stopping'
            self.send_control(0x22 if self.wanted else 0x23)
        elif kind == 0x24:
            if len(p) != 4 or p[1] != 0:
                raise ValueError('command rejected')
            if p[0] in (0x22, 0x23):
                self.state = 'streaming' if p[0] == 0x22 else 'stopped'
        elif kind == 0x30 and self.state in ('starting', 'streaming'):
            seq, timestamp, rate, count, channels, fmt, reserved = struct.unpack_from('<IQIBBBB', p)
            if rate != self.rate or not 1 <= count <= 35 or channels != 3 or fmt != 2 or reserved or len(p) != 20 + count * 6:
                raise ValueError('invalid DATA')
            # NU40 declares CAP_TS=0. Reconstruct within a continuity epoch, never claim hardware synchronization.
            if self.next_seq is None or seq != self.next_seq:
                if self.next_seq is not None:
                    gap = (seq - self.next_seq) & 0xffffffff
                    if gap >= 0x80000000:  # duplicate/out-of-order, not billions of missing samples
                        raise ValueError('old DATA')
                    self.gaps += gap
                self.next_us = now_ns / 1000 - (count - 1) * 1e6 / rate
                self.filter = MedianMovingAverage()
                self.detector = RmsDetector(rate)
            frames = []
            anomaly_changed = False
            for i in range(count):
                xyz = struct.unpack_from('<3h', p, 20 + i * 6)
                at_us = round(self.next_us + i * 1e6 / rate)
                # Match the ESP gateway: anomaly sees raw vibration energy;
                # stored/streamed channels see median(10) -> moving average(10).
                anomaly_changed = self.detector.update(xyz, at_us // 1000) or anomaly_changed
                xyz = self.filter.update(xyz)
                frame = FRAME.pack(MAGIC, 1, 28, (seq + i) & 0xffffffff, at_us, rate, 3, 2, *xyz, 0, 0, 0, 0, 0, 0)
                frames.append(frame[:-4] + struct.pack('<I', zlib.crc32(frame[:-4])))
            self.next_us += count * 1e6 / rate
            self.next_seq = (seq + count) & 0xffffffff
            self.state = 'streaming'
            self.emit({'frames': frames, 'status': self.status(), 'anomaly_changed': anomaly_changed})
        self.last_rx = time.monotonic()
