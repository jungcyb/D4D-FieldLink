#!/usr/bin/env python3
"""ADS8688 acquisition, ring storage, discovery, and TCP service."""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import platform
import queue
import selectors
import shutil
import signal
import socket
import struct
import time
import uuid
import zlib

try:
    from .nu40 import MAGIC as NU40_MAGIC
except ImportError:
    from nu40 import MAGIC as NU40_MAGIC

try:
    import resource
except ModuleNotFoundError:  # Windows-side storage tests
    resource = None


FRAME_MAGIC = 0x38534441
CONTROL_MAGIC = 0x384C5443
FRAME = struct.Struct("<IHHIQIHH8HI")
CONTROL = struct.Struct("<IHHIIiI")
SEGMENT_HEADER = struct.Struct("<8sHH16sQQII12x")
RECORD = struct.Struct("<QQ48s")
NET_HEADER = struct.Struct("!IHHI")
DISCOVERY_REQUEST = struct.Struct("!4sHHQ")
DISCOVERY_RESPONSE = struct.Struct("!4sHHQ16sHBB")
DISCOVERY_RESPONSE_V2 = struct.Struct("!4sHHQ16sHBBH")

PROTOCOL_VERSION = 1
DISCOVERY_VERSION = 2
MAX_NET_PAYLOAD = 64 * 1024
MAX_CLIENT_OUTPUT = 2 * 1024 * 1024
MAX_BACKLOG_PAGE = 2000

MSG_HELLO = 1
MSG_STATUS = 2
MSG_ACQ_START = 3
MSG_ACQ_STOP = 4
MSG_SET_RATE = 5
MSG_STREAM_START = 6
MSG_STREAM_STOP = 7
MSG_ARCHIVE_INFO = 8
MSG_READ_BACKLOG = 9
MSG_READ_BACKLOG_V2 = 10
MSG_STREAM_START_V2 = 11
MSG_SET_RATE_GROUP = 12
MSG_STREAM_START_V3 = 13
MSG_READ_BACKLOG_V3 = 14
MSG_LIVE_DATA = 0x0100
MSG_ARCHIVE_DATA = 0x0101
MSG_ARCHIVE_DATA_V2 = 0x0102
MSG_LIVE_DATA_V2 = 0x0103
MSG_ANOMALY_EVENT = 0x0104
MSG_RESPONSE = 0x8000
MSG_ERROR = 0xFFFF

CONTROL_START = 1
CONTROL_STOP = 2
CONTROL_SET_RATE = 3
CONTROL_ACK = 0x8000
MIN_SCAN_RATE = 10
MAX_SCAN_RATE = 2000


def channel_capabilities(scan_rate: int, nu40: dict | None = None) -> dict[str, object]:
    nu40 = nu40 or {}
    nu40_rate = nu40.get('rate_hz', 104)
    channels = [
        {
            "id": f"CH{channel}",
            "label": f"ADS8688 CH{channel}",
            "adc": "ADS8688",
            "adcChannel": f"AIN{channel}",
            "sampleRateHz": scan_rate,
            "inputUnit": "V",
            "rateGroupId": "ads8688.scan",
            "streamAvailable": True,
        }
        for channel in range(8)
    ]
    channels += [dict(id=f'CH{i + 8}', label=f'NU40 Accel {axis}', adc='NU40',
                     adcChannel=axis, sampleRateHz=nu40_rate, inputUnit='g',
                     rateGroupId='nu40.xyz', streamAvailable=nu40.get('state') == 'streaming')
                 for i, axis in enumerate('XYZ')]
    return {
        "schemaVersion": 1,
        "channelCount": len(channels),
        "channels": channels,
        "sampleRateGroups": [
            {
                "id": "ads8688.scan",
                "label": "ADS8688 8채널 공통",
                "channelIds": [f"CH{channel}" for channel in range(8)],
                "currentHz": scan_rate,
                "writable": True,
                "minHz": MIN_SCAN_RATE,
                "maxHz": MAX_SCAN_RATE,
                "stepHz": 1,
            },
            dict(id='nu40.xyz', label='NU40 XYZ 공통', channelIds=['CH8', 'CH9', 'CH10'],
                 currentHz=nu40_rate, writable=False),
        ],
    }


def discovery_capabilities(scan_rate: int, nu40: dict | None = None) -> dict[str, object]:
    capabilities = channel_capabilities(scan_rate, nu40)
    return {
        "schemaVersion": capabilities["schemaVersion"],
        "channelCount": capabilities["channelCount"],
        "channels": [
            [channel[key] for key in (
                "id", "label", "adc", "adcChannel", "sampleRateHz",
                "inputUnit", "rateGroupId", "streamAvailable",
            )]
            for channel in capabilities["channels"]
        ],
        "sampleRateGroups": [
            [
                group["id"], group["label"], group["channelIds"],
                group["currentHz"], group["writable"],
                group.get("minHz"), group.get("maxHz"), group.get("stepHz"),
            ]
            for group in capabilities["sampleRateGroups"]
        ],
    }


def valid_frame(data: bytes) -> bool:
    if len(data) != FRAME.size:
        return False
    fields = FRAME.unpack(data)
    return (
        fields[0] == FRAME_MAGIC
        and fields[1] == 1
        and fields[2] == 28
        and fields[6] == 8
        and fields[7] == 1
        and fields[-1] == zlib.crc32(data[:-4])
    )


def valid_control(data: bytes) -> bool:
    if len(data) != CONTROL.size:
        return False
    fields = CONTROL.unpack(data)
    return (
        fields[0] == CONTROL_MAGIC
        and fields[1] == 1
        and fields[-1] == zlib.crc32(data[:-4])
    )


def make_control(command: int, request_id: int, value: int = 0) -> bytes:
    body = CONTROL.pack(CONTROL_MAGIC, 1, command, request_id, value, 0, 0)
    return body[:-4] + struct.pack("<I", zlib.crc32(body[:-4]))


def make_message(message_type: int, request_id: int, payload: bytes = b"") -> bytes:
    return NET_HEADER.pack(len(payload), PROTOCOL_VERSION, message_type, request_id) + payload


def json_bytes(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")


def find_rpmsg_device() -> Path:
    remoteproc_name = None
    for remoteproc in Path("/sys/class/remoteproc").glob("remoteproc*"):
        if (remoteproc / "name").read_text().strip() == "78000000.r5f":
            remoteproc_name = remoteproc.name
            break
    if remoteproc_name is None:
        raise FileNotFoundError("MAIN R5FSS0-0 remoteproc not found")

    for entry in sorted(Path("/sys/class/rpmsg").glob("rpmsg[0-9]*")):
        if f"/{remoteproc_name}/" in str(entry.resolve()):
            return Path("/dev") / entry.name
    raise FileNotFoundError("R5FSS0-0 rpmsg_chrdev endpoint not found")


def load_identity(path: Path) -> uuid.UUID:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        return uuid.UUID(path.read_text(encoding="ascii").strip())
    except (FileNotFoundError, ValueError):
        identity = uuid.uuid4()
        temporary = path.with_suffix(".tmp")
        temporary.write_text(f"{identity}\n", encoding="ascii")
        os.replace(temporary, path)
        return identity


def system_metrics() -> dict[str, object]:
    temperatures = {}
    for zone in Path("/sys/class/thermal").glob("thermal_zone*"):
        try:
            name = (zone / "type").read_text().strip()
            temperatures[name] = int((zone / "temp").read_text()) / 1000.0
        except (FileNotFoundError, ValueError):
            pass

    remoteprocs = {}
    for remoteproc in Path("/sys/class/remoteproc").glob("remoteproc*"):
        try:
            name = (remoteproc / "name").read_text().strip()
            if name in ("5000000.m4fss", "78000000.r5f"):
                remoteprocs[name] = {
                    "state": (remoteproc / "state").read_text().strip(),
                    "firmware": (remoteproc / "firmware").read_text().strip(),
                }
        except FileNotFoundError:
            pass

    memory_current = None
    try:
        cgroup = next(
            line.split("::", 1)[1].strip()
            for line in Path("/proc/self/cgroup").read_text().splitlines()
            if "::" in line
        )
        memory_current = int((Path("/sys/fs/cgroup") / cgroup.lstrip("/") / "memory.current").read_text())
    except (FileNotFoundError, StopIteration, ValueError):
        pass

    usage = resource.getrusage(resource.RUSAGE_SELF) if resource else None
    return {
        "kernel": platform.release(),
        "python": platform.python_version(),
        "load_average": [round(value, 3) for value in os.getloadavg()],
        "process_cpu_seconds": round(usage.ru_utime + usage.ru_stime, 3) if usage else None,
        "process_peak_rss_bytes": usage.ru_maxrss * 1024 if usage else None,
        "process_memory_bytes": memory_current,
        "temperatures_c": temperatures,
        "remoteproc": remoteprocs,
    }


class SegmentRing:
    def __init__(
        self,
        directory: Path,
        identity: uuid.UUID,
        segment_bytes: int,
        max_bytes: int,
        reserve_bytes: int,
    ) -> None:
        self.directory = directory
        self.identity = identity
        self.segment_bytes = max(segment_bytes, SEGMENT_HEADER.size + RECORD.size)
        self.max_bytes = max_bytes
        self.reserve_bytes = reserve_bytes
        self.current = None
        self.current_path: Path | None = None
        self.current_first_record = 0
        self.last_sync = time.monotonic()
        self.directory.mkdir(parents=True, exist_ok=True)
        self._recover_parts()
        self.next_record_id = self._find_next_record_id()

    def _recover_parts(self) -> None:
        for path in sorted(self.directory.glob("*.part")):
            size = path.stat().st_size
            if size < SEGMENT_HEADER.size:
                path.rename(path.with_suffix(".incomplete"))
                continue
            usable = SEGMENT_HEADER.size + (
                (size - SEGMENT_HEADER.size) // RECORD.size
            ) * RECORD.size
            with path.open("r+b") as stream:
                stream.truncate(usable)
            path.rename(path.with_suffix(".ads8"))

    def _paths(self, include_current: bool = True) -> list[Path]:
        paths = sorted(self.directory.glob("*.ads8"))
        if include_current and self.current_path is not None:
            paths.append(self.current_path)
        return paths

    @staticmethod
    def _bounds(path: Path) -> tuple[int, int] | None:
        size = path.stat().st_size
        if size < SEGMENT_HEADER.size + RECORD.size:
            return None
        with path.open("rb") as stream:
            header = stream.read(SEGMENT_HEADER.size)
            fields = SEGMENT_HEADER.unpack(header)
            if fields[0] != b"ADS8SEG\0" or fields[1] != 1:
                return None
            first = fields[5]
            stream.seek(-RECORD.size, os.SEEK_END)
            last = RECORD.unpack(stream.read(RECORD.size))[0]
        return first, last

    def _find_next_record_id(self) -> int:
        for path in reversed(self._paths(include_current=False)):
            bounds = self._bounds(path)
            if bounds is not None:
                return bounds[1] + 1
        return 1

    def _open(self, sequence: int, scan_rate: int) -> None:
        timestamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        path = self.directory / (
            f"{timestamp}_{self.next_record_id:020d}_{sequence:010d}.part"
        )
        self.current = path.open("xb", buffering=1024 * 1024)
        self.current_path = path
        self.current_first_record = self.next_record_id
        self.current.write(
            SEGMENT_HEADER.pack(
                b"ADS8SEG\0",
                1,
                SEGMENT_HEADER.size,
                self.identity.bytes,
                time.time_ns(),
                self.next_record_id,
                sequence,
                scan_rate,
            )
        )
        self.last_sync = time.monotonic()

    def append(self, frame: bytes) -> tuple[int, int]:
        return self.append_many((frame,))[0]

    def append_many(self, frames) -> list[tuple[int, int]]:
        """Persist one RPMsg batch with one filesystem write per segment."""
        frames = list(frames)
        records = []
        offset = 0
        while offset < len(frames):
            fields = FRAME.unpack(frames[offset])
            if self.current is None:
                self._open(fields[3], fields[5])
            available = (self.segment_bytes - self.current.tell()) // RECORD.size
            if available == 0:
                self.rotate()
                continue
            chunk = frames[offset:offset + available]
            data = bytearray()
            for frame in chunk:
                record_id = self.next_record_id
                received_ns = time.time_ns()
                data.extend(RECORD.pack(record_id, received_ns, frame))
                records.append((record_id, received_ns))
                self.next_record_id += 1
            self.current.write(data)
            offset += len(chunk)

        now = time.monotonic()
        if now - self.last_sync >= 1.0:
            self.current.flush()
            os.fsync(self.current.fileno())
            self.last_sync = now
        return records

    def rotate(self) -> None:
        if self.current is None or self.current_path is None:
            return
        self.current.flush()
        os.fsync(self.current.fileno())
        self.current.close()
        completed = self.current_path.with_suffix(".ads8")
        os.replace(self.current_path, completed)
        self.current = None
        self.current_path = None
        self._prune()

    def _prune(self) -> None:
        completed = sorted(self.directory.glob("*.ads8"))
        used = sum(path.stat().st_size for path in completed)
        usage = shutil.disk_usage(self.directory)
        reserve = max(self.reserve_bytes, usage.total // 10)
        while completed and (
            (self.max_bytes > 0 and used > self.max_bytes)
            or usage.free < reserve
        ):
            oldest = completed.pop(0)
            size = oldest.stat().st_size
            oldest.unlink()
            used -= size
            usage = shutil.disk_usage(self.directory)

    def close(self) -> None:
        self.rotate()

    def info(self) -> dict[str, int | None]:
        if self.current is not None:
            self.current.flush()
        paths = self._paths()
        bounds = [bound for path in paths if (bound := self._bounds(path))]
        usage = shutil.disk_usage(self.directory)
        return {
            "earliest_record_id": bounds[0][0] if bounds else None,
            "latest_record_id": bounds[-1][1] if bounds else None,
            "segments": len(paths),
            "stored_bytes": sum(path.stat().st_size for path in paths),
            "free_bytes": usage.free,
            "reserve_bytes": max(self.reserve_bytes, usage.total // 10),
        }

    def record_bounds(self) -> tuple[int | None, int | None]:
        """Cheap bounds for paged replay; avoids rescanning every segment."""
        earliest = None
        for path in self._paths():
            bounds = self._bounds(path)
            if bounds is not None:
                earliest = bounds[0]
                break
        latest = self.next_record_id - 1 if self.next_record_id > 1 else None
        return earliest, latest

    def read_after(self, after_record_id: int, limit: int):
        if self.current is not None:
            self.current.flush()
        wanted = after_record_id + 1
        remaining = min(max(limit, 1), MAX_BACKLOG_PAGE)
        for path in self._paths():
            bounds = self._bounds(path)
            if bounds is None or bounds[1] < wanted:
                continue
            first, last = bounds
            start = max(first, wanted)
            offset = SEGMENT_HEADER.size + (start - first) * RECORD.size
            with path.open("rb") as stream:
                stream.seek(offset)
                while remaining and start <= last:
                    data = stream.read(RECORD.size)
                    if len(data) != RECORD.size:
                        break
                    record = RECORD.unpack(data)
                    if record[0] >= wanted:
                        yield record
                        remaining -= 1
                    start += 1
            if remaining == 0:
                return


@dataclass
class Client:
    address: tuple[str, int]
    incoming: bytearray = field(default_factory=bytearray)
    outgoing: bytearray = field(default_factory=bytearray)
    streaming: int = 0


class Server:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.identity = load_identity(args.identity_file)
        self.ring = SegmentRing(
            args.data_dir,
            self.identity,
            args.segment_bytes,
            args.max_storage_bytes,
            args.reserve_bytes,
        )
        self.selector = selectors.DefaultSelector()
        self.clients: dict[socket.socket, Client] = {}
        self.pending: dict[int, tuple[socket.socket, int, int, float, int]] = {}
        self.control_id = 1
        self.running = True
        self.started = time.monotonic()
        self.frames_total = 0
        self.invalid_total = 0
        self.gaps_total = 0
        self.last_sequence: int | None = None
        self.scan_rate = 1000
        self.acquiring = True
        self.report_frames = 0
        self.report_invalid = 0
        self.report_gaps = 0
        self.last_report = time.monotonic()
        self.nu40_status = {'state': 'disconnected', 'rate_hz': 104}
        self.nu40_receiver = None
        self.nu40_frames = 0

    def _nu40_read(self):
        for event in self.nu40_receiver.drain():
            self.nu40_status = event['status']
            for frame in event.get('frames', []):
                self._publish_frame(frame, nu40=True)
                self.nu40_frames += 1
            anomaly = self.nu40_status.get('anomaly')
            if anomaly and event.get('anomaly_changed'):
                message = make_message(MSG_ANOMALY_EVENT, 0, json_bytes(anomaly))
                for stream, client in tuple(self.clients.items()):
                    if client.streaming == 3:
                        self._queue(stream, message)

    def stop(self, *_args) -> None:
        self.running = False

    def _queue(self, stream: socket.socket, message: bytes) -> None:
        client = self.clients.get(stream)
        if client is None:
            return
        if len(client.outgoing) + len(message) > MAX_CLIENT_OUTPUT:
            self._disconnect(stream, "slow client")
            return
        client.outgoing.extend(message)
        self.selector.modify(stream, selectors.EVENT_READ | selectors.EVENT_WRITE, "client")

    def _response(self, stream: socket.socket, message_type: int, request_id: int,
                  value: object) -> None:
        self._queue(
            stream,
            make_message(message_type | MSG_RESPONSE, request_id, json_bytes(value)),
        )

    def _error(self, stream: socket.socket, request_id: int, error: str) -> None:
        self._queue(stream, make_message(MSG_ERROR, request_id, json_bytes({"error": error})))

    def _disconnect(self, stream: socket.socket, reason: str) -> None:
        client = self.clients.pop(stream, None)
        if client is None:
            return
        print(f"client disconnected: {client.address[0]}:{client.address[1]} ({reason})", flush=True)
        try:
            self.selector.unregister(stream)
        except Exception:
            pass
        stream.close()

    def _status(self) -> dict[str, object]:
        return {
            "uuid": str(self.identity),
            "hostname": socket.gethostname(),
            "acquiring": self.acquiring,
            "scan_rate_hz": self.scan_rate,
            "channel_capabilities": channel_capabilities(self.scan_rate, self.nu40_status),
            "nu40": self.nu40_status,
            "nu40_frames_total": self.nu40_frames,
            "anomaly": self.nu40_status.get('anomaly'),
            "frames_total": self.frames_total,
            "invalid_total": self.invalid_total,
            "sequence_gaps_total": self.gaps_total,
            "uptime_seconds": round(time.monotonic() - self.started, 3),
            "archive": self.ring.info(),
            "system": system_metrics(),
        }

    def _send_control(
        self, stream: socket.socket, message_type: int, request_id: int,
        command: int, value: int = 0,
    ) -> None:
        internal_id = self.control_id
        self.control_id = (self.control_id + 1) & 0xFFFFFFFF or 1
        try:
            os.write(self.rpmsg, make_control(command, internal_id, value))
        except OSError as error:
            self._error(stream, request_id, f"RPMsg control failed: {error}")
            return
        self.pending[internal_id] = (
            stream, message_type, request_id, time.monotonic(), value
        )

    def _complete_control(self, pending, value: int) -> None:
        stream, message_type, request_id, _started, _expected = pending
        if stream not in self.clients:
            return
        self._response(stream, message_type, request_id, {
            "acquiring": self.acquiring,
            "scan_rate_hz": self.scan_rate,
            "channel_capabilities": channel_capabilities(self.scan_rate, self.nu40_status),
            "nu40": self.nu40_status,
        })

    def _confirm_rate_from_frame(self, observed_rate: int) -> None:
        """A data frame is authoritative proof that M4 applied a requested rate."""
        for internal_id, pending in tuple(self.pending.items()):
            _stream, message_type, _request_id, _started, expected = pending
            if (message_type in (MSG_SET_RATE, MSG_SET_RATE_GROUP)
                    and expected == observed_rate):
                self.pending.pop(internal_id, None)
                self._complete_control(pending, observed_rate)

    def _command(
        self, stream: socket.socket, message_type: int, request_id: int, payload: bytes
    ) -> None:
        client = self.clients[stream]
        if message_type == MSG_HELLO:
            self._response(stream, message_type, request_id, {
                "protocol_version": PROTOCOL_VERSION,
                "uuid": str(self.identity),
                "model": "AM6442-SK+ADS8688+NU40",
                "capabilities": [
                    "acquisition_control", "sample_rate", "live_stream",
                    "local_ring", "backlog_replay", "timestamped_stream", "mixed_stream_v3",
                ],
                "channel_capabilities": channel_capabilities(self.scan_rate, self.nu40_status),
            })
        elif message_type == MSG_STATUS:
            self._response(stream, message_type, request_id, self._status())
        elif message_type == MSG_STREAM_START:
            client.streaming = 1
            self._response(stream, message_type, request_id, {"streaming": True})
        elif message_type == MSG_STREAM_START_V2:
            client.streaming = 2
            self._response(stream, message_type, request_id, {"streaming": True, "timestamps": "unix_ns"})
        elif message_type == MSG_STREAM_START_V3:
            client.streaming = 3
            self._response(stream, message_type, request_id, {"streaming": True, "formats": ['ADS8', 'NU40']})
        elif message_type == MSG_STREAM_STOP:
            client.streaming = 0
            self._response(stream, message_type, request_id, {"streaming": False})
        elif message_type == MSG_ACQ_START:
            self._send_control(stream, message_type, request_id, CONTROL_START)
        elif message_type == MSG_ACQ_STOP:
            self._send_control(stream, message_type, request_id, CONTROL_STOP)
        elif message_type == MSG_SET_RATE:
            if len(payload) != 4:
                self._error(stream, request_id, "SET_RATE payload must be uint32")
                return
            rate = struct.unpack("!I", payload)[0]
            if not MIN_SCAN_RATE <= rate <= MAX_SCAN_RATE:
                self._error(stream, request_id, f"rate must be {MIN_SCAN_RATE}..{MAX_SCAN_RATE}")
                return
            self._send_control(stream, message_type, request_id, CONTROL_SET_RATE, rate)
        elif message_type == MSG_SET_RATE_GROUP:
            try:
                request = json.loads(payload)
                group_id = request["groupId"]
                rate = request["rateHz"]
            except (json.JSONDecodeError, KeyError, TypeError):
                self._error(stream, request_id, "SET_RATE_GROUP payload is invalid")
                return
            if group_id != "ads8688.scan":
                self._error(stream, request_id, "sample-rate group is not writable")
                return
            if type(rate) is not int or not MIN_SCAN_RATE <= rate <= MAX_SCAN_RATE:
                self._error(stream, request_id, f"rate must be {MIN_SCAN_RATE}..{MAX_SCAN_RATE}")
                return
            self._send_control(stream, message_type, request_id, CONTROL_SET_RATE, rate)
        elif message_type == MSG_ARCHIVE_INFO:
            self._response(stream, message_type, request_id, self.ring.info())
        elif message_type in (MSG_READ_BACKLOG, MSG_READ_BACKLOG_V2, MSG_READ_BACKLOG_V3):
            if len(payload) != 12:
                self._error(stream, request_id, "READ_BACKLOG payload must be uint64,uint32")
                return
            after_record, limit = struct.unpack("!QI", payload)
            earliest, latest = self.ring.record_bounds()
            returned = 0
            last_record = after_record
            messages = bytearray()
            for record_id, received_ns, frame in self.ring.read_after(after_record, limit):
                last_record = record_id
                if message_type != MSG_READ_BACKLOG_V3 and FRAME.unpack(frame)[0] == NU40_MAGIC:
                    continue
                messages.extend(
                    make_message(
                        MSG_ARCHIVE_DATA if message_type == MSG_READ_BACKLOG else MSG_ARCHIVE_DATA_V2,
                        request_id,
                        (struct.pack("!Q", record_id) if message_type == MSG_READ_BACKLOG else struct.pack("!QQ", record_id, received_ns)) + frame,
                    )
                )
                returned += 1
                last_record = record_id
            if messages:
                self._queue(stream, messages)
            self._response(stream, message_type, request_id, {
                "returned": returned,
                "last_record_id": last_record,
                "latest_record_id": latest,
                "more": latest is not None and last_record < latest,
                "earliest_record_id": earliest,
                "truncated": earliest is not None and after_record + 1 < earliest,
            })
        else:
            self._error(stream, request_id, f"unknown message type {message_type}")

    def _client_read(self, stream: socket.socket) -> None:
        client = self.clients[stream]
        try:
            data = stream.recv(65536)
        except BlockingIOError:
            return
        except OSError as error:
            self._disconnect(stream, str(error))
            return
        if not data:
            self._disconnect(stream, "peer closed")
            return
        client.incoming.extend(data)
        while len(client.incoming) >= NET_HEADER.size:
            payload_size, version, message_type, request_id = NET_HEADER.unpack_from(
                client.incoming
            )
            if payload_size > MAX_NET_PAYLOAD:
                self._disconnect(stream, "oversized message")
                return
            total = NET_HEADER.size + payload_size
            if len(client.incoming) < total:
                return
            payload = bytes(client.incoming[NET_HEADER.size:total])
            del client.incoming[:total]
            if version != PROTOCOL_VERSION:
                self._error(stream, request_id, "unsupported protocol version")
            else:
                self._command(stream, message_type, request_id, payload)

    def _client_write(self, stream: socket.socket) -> None:
        client = self.clients[stream]
        try:
            sent = stream.send(client.outgoing)
        except BlockingIOError:
            return
        except OSError as error:
            self._disconnect(stream, str(error))
            return
        del client.outgoing[:sent]
        if not client.outgoing:
            self.selector.modify(stream, selectors.EVENT_READ, "client")

    def _rpmsg_read(self) -> None:
        # Drain a bounded burst: one packet per select starves live capture while
        # a client is replaying large archive pages. Keep other sources responsive.
        for _ in range(64):
            try:
                packet = os.read(self.rpmsg, 496)
            except BlockingIOError:
                break
            if not packet:
                break
            self._rpmsg_packet(packet)

    def _rpmsg_packet(self, packet: bytes) -> None:
        if packet == b"ADS8OK":
            return
        if len(packet) >= FRAME.size and len(packet) % FRAME.size == 0:
            self._rpmsg_frames(
                [packet[offset:offset + FRAME.size]
                 for offset in range(0, len(packet), FRAME.size)]
            )
            return
        if valid_control(packet):
            _magic, _version, command, internal_id, value, status, _crc = CONTROL.unpack(packet)
            pending = self.pending.get(internal_id)
            if pending is None or command & CONTROL_ACK == 0:
                return
            self.pending.pop(internal_id, None)
            stream, message_type, request_id, _started, _expected = pending
            if stream not in self.clients:
                return
            if status != 0:
                self._error(stream, request_id, "MCU rejected control request")
                return
            if message_type == MSG_ACQ_START:
                self.acquiring = True
            elif message_type == MSG_ACQ_STOP:
                self.acquiring = False
            elif message_type in (MSG_SET_RATE, MSG_SET_RATE_GROUP):
                self.scan_rate = value
            if message_type in (MSG_ACQ_START, MSG_ACQ_STOP) and self.nu40_receiver:
                try:
                    self.nu40_receiver.commands.put_nowait({'acquiring': self.acquiring})
                except queue.Full:
                    self._error(stream, request_id, 'ADS8688 applied, NU40 control queue full; inspect STATUS')
                    return
            self._complete_control(pending, value)
            return
        self._rpmsg_frames([packet])

    def _rpmsg_frames(self, frames) -> None:
        valid = []
        for packet in frames:
            if not valid_frame(packet):
                self.invalid_total += 1
                self.report_invalid += 1
                continue
            fields = FRAME.unpack(packet)
            sequence = fields[3]
            self.scan_rate = fields[5]
            self._confirm_rate_from_frame(self.scan_rate)
            if self.last_sequence is not None and sequence != (self.last_sequence + 1) & 0xFFFFFFFF:
                gap = (sequence - self.last_sequence - 1) & 0xFFFFFFFF
                self.gaps_total += gap
                self.report_gaps += gap
            self.last_sequence = sequence
            self.frames_total += 1
            self.report_frames += 1
            valid.append(packet)
        if valid:
            self._publish_frames(valid)

    def _publish_frame(self, packet: bytes, nu40=False):
        self._publish_frames([packet], nu40)

    def _publish_frames(self, packets, nu40=False):
        try:
            records = self.ring.append_many(packets)
        except OSError as error:
            print(f"storage write failed: {error}", flush=True)
            return
        message = b"".join(
            make_message(MSG_LIVE_DATA, 0, struct.pack("!Q", record_id) + packet)
            for packet, (record_id, _received_ns) in zip(packets, records)
        )
        message_v2 = b"".join(
            make_message(MSG_LIVE_DATA_V2, 0, struct.pack("!QQ", record_id, received_ns) + packet)
            for packet, (record_id, received_ns) in zip(packets, records)
        )
        for stream, client in tuple(self.clients.items()):
            if client.streaming and (not nu40 or client.streaming == 3):
                self._queue(stream, message_v2 if client.streaming >= 2 else message)

    def _udp_read(self) -> None:
        try:
            packet, address = self.udp.recvfrom(1024)
        except BlockingIOError:
            return
        if len(packet) != DISCOVERY_REQUEST.size:
            return
        magic, version, _reserved, nonce = DISCOVERY_REQUEST.unpack(packet)
        if magic != b"A8DQ" or version not in (1, DISCOVERY_VERSION):
            return
        hostname = socket.gethostname().encode("utf-8")[:63]
        model = b"AM6442-SK+ADS8688+NU40"
        if version == DISCOVERY_VERSION:
            capabilities = json_bytes(discovery_capabilities(self.scan_rate, self.nu40_status))
            response = DISCOVERY_RESPONSE_V2.pack(
                b"A8DR", DISCOVERY_VERSION, 0, nonce, self.identity.bytes,
                self.args.port, len(hostname), len(model), len(capabilities),
            ) + hostname + model + capabilities
        else:
            response = DISCOVERY_RESPONSE.pack(
                b"A8DR", 1, 0, nonce, self.identity.bytes,
                self.args.port, len(hostname), len(model),
            ) + hostname + model
        self.udp.sendto(response, address)

    def serve(self) -> None:
        device = self.args.device or find_rpmsg_device()
        self.rpmsg = os.open(device, os.O_RDWR | os.O_NONBLOCK)
        os.write(self.rpmsg, b"SUBSCRIBE")

        self.tcp = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.tcp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.tcp.bind(("0.0.0.0", self.args.port))
        self.tcp.listen()
        self.tcp.setblocking(False)

        self.udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.udp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.udp.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        self.udp.bind(("0.0.0.0", self.args.discovery_port))
        self.udp.setblocking(False)

        self.selector.register(self.rpmsg, selectors.EVENT_READ, "rpmsg")
        self.selector.register(self.tcp, selectors.EVENT_READ, "server")
        self.selector.register(self.udp, selectors.EVENT_READ, "udp")
        if not getattr(self.args, 'no_nu40', False):
            from nu40_ble import Receiver
            self.nu40_receiver = Receiver(self.identity)
            self.selector.register(self.nu40_receiver.reader, selectors.EVENT_READ, 'nu40')
            self.nu40_receiver.start()
        print(
            f"ads8688d uuid={self.identity} device={device} "
            f"tcp={self.args.port} udp={self.args.discovery_port}",
            flush=True,
        )

        try:
            while self.running:
                for key, mask in self.selector.select(timeout=1.0):
                    if key.data == "rpmsg":
                        self._rpmsg_read()
                    elif key.data == "udp":
                        self._udp_read()
                    elif key.data == 'nu40':
                        self._nu40_read()
                    elif key.data == "server":
                        stream, address = self.tcp.accept()
                        stream.setblocking(False)
                        stream.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                        self.clients[stream] = Client(address)
                        self.selector.register(stream, selectors.EVENT_READ, "client")
                        print(f"client connected: {address[0]}:{address[1]}", flush=True)
                    else:
                        stream = key.fileobj
                        if mask & selectors.EVENT_READ and stream in self.clients:
                            self._client_read(stream)
                        if mask & selectors.EVENT_WRITE and stream in self.clients:
                            self._client_write(stream)

                now = time.monotonic()
                for internal_id, pending in tuple(self.pending.items()):
                    stream, _message_type, request_id, started, _expected = pending
                    if now - started > 2.0:
                        self.pending.pop(internal_id)
                        self._error(stream, request_id, "MCU control timeout")
                if now - self.last_report >= 1.0:
                    print(
                        f"frames={self.report_frames} invalid={self.report_invalid} "
                        f"seq_gaps={self.report_gaps} clients={len(self.clients)} "
                        f"stored={self.ring.next_record_id - 1}",
                        flush=True,
                    )
                    self.report_frames = self.report_invalid = self.report_gaps = 0
                    self.last_report = now
        finally:
            if self.nu40_receiver:
                self.nu40_receiver.close()
            for stream in tuple(self.clients):
                self._disconnect(stream, "service stopping")
            self.selector.close()
            self.tcp.close()
            self.udp.close()
            os.close(self.rpmsg)
            self.ring.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", type=Path)
    parser.add_argument('--no-nu40', action='store_true', help='disable BLE receiver (ADS8688 remains available)')
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--discovery-port", type=int, default=8764)
    parser.add_argument("--data-dir", type=Path, default=Path("/var/lib/ads8688/data"))
    parser.add_argument("--identity-file", type=Path, default=Path("/var/lib/ads8688/identity"))
    parser.add_argument("--segment-bytes", type=int, default=256 * 1024 * 1024)
    parser.add_argument("--max-storage-bytes", type=int, default=0)
    parser.add_argument("--reserve-bytes", type=int, default=2 * 1024 * 1024 * 1024)
    args = parser.parse_args()
    server = Server(args)
    signal.signal(signal.SIGTERM, server.stop)
    signal.signal(signal.SIGINT, server.stop)
    server.serve()


if __name__ == "__main__":
    main()
