"""One independent receiving connection per DAQ; pygame never waits on I/O."""
from __future__ import annotations

from collections import deque
import json
import socket
import threading
import time
import uuid

from client import ads8688_protocol as wire
from .model import History, decode_sample, validate_rate


class PacketDecoder:
    def __init__(self):
        self.buffer = bytearray()

    def feed(self, chunk: bytes):
        self.buffer.extend(chunk)
        packets = []
        while len(self.buffer) >= wire.NET_HEADER.size:
            size, version, kind, request_id = wire.NET_HEADER.unpack_from(self.buffer)
            if version != wire.VERSION or size > 65536:
                raise ValueError("invalid network header")
            end = wire.NET_HEADER.size + size
            if len(self.buffer) < end:
                break
            packets.append((kind, request_id, bytes(self.buffer[wire.NET_HEADER.size:end])))
            del self.buffer[:end]
        return packets


def transaction(stream, kind, payload=b"", request_id=1):
    stream.sendall(wire.message(kind, request_id, payload))
    while True:
        reply, identity, body = wire.receive(stream)
        if identity != request_id:
            continue
        data = wire.decode_json(body)
        if not isinstance(data, dict):
            raise ValueError("invalid response")
        if reply == wire.ERROR:
            raise RuntimeError(str(data.get("error", "DAQ rejected command")))
        if reply == kind | wire.RESPONSE:
            return data


def checked_control(host, port, identity, action, group_id=None, value=None):
    """Recheck identity/capabilities; require ACK AND matching STATUS read-back."""
    with socket.create_connection((host, port), timeout=4) as stream:
        stream.settimeout(5)
        hello = transaction(stream, wire.HELLO)
        if hello.get("uuid") != identity:
            raise ValueError("DAQ UUID가 바뀌었습니다. 명령을 보내지 않았습니다.")
        status = transaction(stream, wire.STATUS, request_id=2)
        if status.get("uuid") != identity:
            raise ValueError("STATUS UUID mismatch")
        if action in ("start", "stop"):
            if "acquisition_control" not in hello.get("capabilities", []):
                raise ValueError("이 DAQ는 수집 제어를 지원하지 않습니다.")
            kind, payload = (wire.ACQ_START if action == "start" else wire.ACQ_STOP), b""
        elif action == "rate":
            caps = wire.normalize_capabilities(status.get("channel_capabilities", hello.get("channel_capabilities")))
            group = next((g for g in caps["sampleRateGroups"] if g["id"] == group_id), {})
            rate = validate_rate(group, str(value))
            kind, payload = wire.SET_RATE_GROUP, json.dumps({"groupId": group_id, "rateHz": rate}).encode()
        else:
            raise ValueError("unsupported command")
        transaction(stream, kind, payload, 3)
        result = transaction(stream, wire.STATUS, request_id=4)
        if result.get("uuid") != identity:
            raise ValueError("명령 후 UUID가 일치하지 않습니다.")
        if action in ("start", "stop") and result.get("acquiring") is not (action == "start"):
            raise ValueError("ACK를 받았지만 수집 상태가 일치하지 않습니다.")
        if action == "rate":
            caps = wire.normalize_capabilities(result.get("channel_capabilities"))
            actual = next((g for g in caps["sampleRateGroups"] if g["id"] == group_id), {})
            if actual.get("currentHz") != rate or any(c.get("sampleRateHz") != rate for c in caps["channels"] if c["id"] in group["channelIds"]):
                raise ValueError("ACK를 받았지만 실제 그룹 샘플레이트가 일치하지 않습니다.")
        return result


class Session:
    def __init__(self, board: dict, on_change=lambda: None):
        self.on_change = on_change
        self.host, self.port = board["ip"], board.get("tcp_port", 8765)
        self.identity = board.get("uuid", "")
        self.label = board.get("hostname") or self.host
        self.model = board.get("model", "FieldLink DAQ")
        self.caps = board.get("channel_capabilities", {})
        self.features = []
        self.status = {}
        self.anomaly = {}
        self.history = History()
        self.lock = threading.RLock()
        self.link = "connecting"
        self.error = ""
        self.bad_frames = self.reconnects = 0
        self.connected_at = self.last_status = 0.0
        self.events = deque(maxlen=80)
        self.enabled = threading.Event()
        self.enabled.set()
        self.stopping = threading.Event()
        self.stream = None
        self.busy = False
        self.thread = threading.Thread(target=self.run, name=f"daq-{self.host}", daemon=True)
        self.thread.start()

    def note(self, message):
        with self.lock:
            self.events.appendleft((time.strftime("%H:%M:%S"), str(message)[:250]))
        self.on_change()

    def snapshot(self, samples=False):
        with self.lock:
            return dict(host=self.host, port=self.port, uuid=self.identity, label=self.label, model=self.model,
                        caps=self.caps, features=self.features, status=self.status, anomaly=self.anomaly,
                        link=self.link, error=self.error, busy=self.busy, enabled=self.enabled.is_set(),
                        bad=self.bad_frames, reconnects=self.reconnects, total=self.history.total,
                        gaps=self.history.gaps, restarts=self.history.restarts, rx_rate=self.history.rate,
                        last_receive=self.history.last_receive, last_status=self.last_status,
                        latest=self.history.rows[-1] if self.history.rows else None,
                        rows=list(self.history.rows) if samples else [], events=list(self.events))

    def update_status(self, status):
        if status.get("uuid") != self.identity:
            raise ValueError("STATUS UUID mismatch")
        caps = status.get("channel_capabilities")
        if caps is not None:
            caps = wire.normalize_capabilities(caps)
        with self.lock:
            self.status = status
            self.label = status.get("hostname") or self.label
            self.last_status = time.monotonic()
            if caps is not None:
                self.caps = caps
        if isinstance(status.get("anomaly"), dict):
            self.update_anomaly(status["anomaly"])
        self.on_change()

    def update_anomaly(self, value):
        if not isinstance(value, dict) or not isinstance(value.get("channels", []), list):
            return
        with self.lock:
            before = {c.get("id"): c.get("state") for c in self.anomaly.get("channels", []) if isinstance(c, dict)}
            for channel in value.get("channels", [])[:64]:
                if isinstance(channel, dict) and before.get(channel.get("id")) != channel.get("state"):
                    self.note(f"{channel.get('id')} / {channel.get('state')} / ratio {channel.get('ratio', '—')}")
            self.anomaly = value
        self.on_change()

    def connect_enabled(self, enabled):
        if enabled:
            self.enabled.set()
        else:
            self.enabled.clear()
            self.close_socket()
        self.on_change()

    def close_socket(self):
        stream = self.stream
        if stream:
            try:
                stream.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def stop(self):
        self.stopping.set()
        self.enabled.set()
        self.close_socket()

    def run(self):
        while not self.stopping.is_set():
            if not self.enabled.wait(.25):
                with self.lock:
                    self.link = "disconnected"
                continue
            if self.stopping.is_set():
                break
            try:
                with self.lock:
                    self.link, self.error = "connecting", ""
                self.on_change()
                with socket.create_connection((self.host, self.port), timeout=3) as stream:
                    self.stream = stream
                    stream.settimeout(4)
                    stream.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                    hello = transaction(stream, wire.HELLO)
                    identity = str(uuid.UUID(hello["uuid"]))
                    if self.identity and self.identity != identity:
                        raise ValueError("UUID mismatch; refusing a different device")
                    with self.lock:
                        self.identity = identity
                        self.features = hello.get("capabilities", [])
                        self.model = hello.get("model") or self.model
                    self.update_status(transaction(stream, wire.STATUS, request_id=2))
                    if "live_stream" not in self.features:
                        raise ValueError("DAQ does not advertise live_stream")
                    start = (wire.STREAM_START_V3 if "mixed_stream_v3" in self.features else
                             wire.STREAM_START_V2 if "timestamped_stream" in self.features else
                             wire.STREAM_START)
                    transaction(stream, start, request_id=3)
                    with self.lock:
                        self.link = "online"
                        self.connected_at = time.monotonic()
                        self.history.break_pending = True
                    mode = "MIXED v3" if start == wire.STREAM_START_V3 else "LIVE"
                    self.note(f"TCP 연결 · {mode} 구독 시작 (보드 수집 설정 유지)")
                    stream.settimeout(.25)
                    decoder = PacketDecoder()
                    request_id, pending, next_status = 4, {}, time.monotonic() + 2
                    while not self.stopping.is_set() and self.enabled.is_set():
                        now = time.monotonic()
                        if pending and now - min(pending.values()) > 6:
                            raise TimeoutError("STATUS 응답 시간 초과")
                        if now >= next_status and not pending:
                            stream.sendall(wire.message(wire.STATUS, request_id))
                            pending[request_id] = now
                            request_id = (request_id + 1) & 0xFFFFFFFF or 4
                            next_status = now + 2
                        try:
                            chunk = stream.recv(65536)
                        except socket.timeout:
                            continue  # Decoder retains any incomplete header/body.
                        if not chunk:
                            raise ConnectionError("DAQ closed the connection")
                        for kind, reply_id, payload in decoder.feed(chunk):
                            if kind in (wire.LIVE_DATA, wire.LIVE_DATA_V2):
                                try:
                                    sample = decode_sample(payload, kind == wire.LIVE_DATA_V2)
                                    with self.lock:
                                        self.history.append(sample)
                                except ValueError:
                                    with self.lock:
                                        self.bad_frames += 1
                            elif kind == wire.ANOMALY_EVENT:
                                self.update_anomaly(wire.decode_json(payload))
                            elif reply_id in pending:
                                del pending[reply_id]
                                if kind == wire.ERROR:
                                    raise RuntimeError(str(wire.decode_json(payload)))
                                if kind != wire.STATUS | wire.RESPONSE:
                                    raise ValueError("unexpected STATUS response")
                                self.update_status(wire.decode_json(payload))
                        # One wake per received batch, not a render backlog per sample.
                        self.on_change()
            except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
                with self.lock:
                    self.error = str(error)
                    self.link = "retrying" if self.enabled.is_set() else "disconnected"
                    self.reconnects += 1
                self.note(self.error)
            finally:
                self.stream = None
            if not self.stopping.is_set():
                self.stopping.wait(1.5)
        with self.lock:
            self.link = "disconnected"
        self.on_change()

    def control(self, action, group_id=None, value=None):
        with self.lock:
            if self.busy or self.link != "online":
                return False
            self.busy = True
            target = (self.host, self.port, self.identity)

        def execute():
            try:
                status = checked_control(*target, action, group_id, value)
                self.update_status(status)
                self.note(f"명령 확인 완료: {action} {value if value is not None else ''}")
            except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
                self.note(f"명령 실패 / 상태 확인 필요: {error}")
            finally:
                with self.lock:
                    self.busy = False
                self.on_change()
        threading.Thread(target=execute, name="daq-control", daemon=True).start()
        return True


class Fleet:
    def __init__(self, addresses, hosts=()):
        self.addresses = list(dict.fromkeys(addresses)) or ["255.255.255.255"]
        self.sessions = []
        self.lock = threading.Lock()
        self.stopping = threading.Event()
        self.scan_now = threading.Event()
        self.scanning = False
        self.message = "장치 탐색 준비"
        self.on_change = None
        for host, port in hosts:
            self.add({"ip": host, "tcp_port": port})
        self.thread = threading.Thread(target=self.discover, name="daq-discovery", daemon=True)
        self.thread.start()

    def changed(self):
        callback = self.on_change
        if callback:
            callback()

    def add(self, board):
        with self.lock:
            if self.stopping.is_set():
                raise ValueError("Console is closing")
            for session in self.sessions:
                if (board.get("uuid") and session.identity == board["uuid"]) or (session.host, session.port) == (board["ip"], board.get("tcp_port", 8765)):
                    with session.lock:
                        if session.link != "online":
                            session.host, session.port = board["ip"], board.get("tcp_port", 8765)
                    return session
            # Bounded desktop workspace, not an unbounded network inventory.
            if len(self.sessions) >= 16:
                raise ValueError("동시에 표시할 수 있는 DAQ는 최대 16대입니다.")
            session = Session(board, self.changed)
            self.sessions.append(session)
            return session

    def all(self):
        with self.lock:
            return list(self.sessions)

    def discover(self):
        while not self.stopping.is_set():
            self.scanning = True
            self.changed()
            found, errors = 0, []
            for address in self.addresses:
                if self.stopping.is_set():
                    break
                try:
                    for board in wire.discover(address, timeout=.6):
                        self.add(board)
                        found += 1
                except (OSError, ValueError) as error:
                    errors.append(str(error))
            self.message = f"탐색 응답 {found} · " + (errors[-1][:70] if errors else "5초마다 자동 탐색")
            self.scanning = False
            self.changed()
            self.scan_now.wait(5)
            self.scan_now.clear()

    def stop(self):
        self.stopping.set()
        self.scan_now.set()
        self.thread.join(timeout=3)
        for session in self.all():
            session.stop()
        for session in self.all():
            session.thread.join(timeout=.5)
