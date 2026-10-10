#!/usr/bin/env python3
"""ADS8688 + ADS1263 acquisition, ring storage, discovery, and TCP service.

ADS8688 frames arrive from the M4F through the R5FSS0-0 relay; ADS1263 scan
frames arrive directly from R5FSS1-0. Each ADC has its own segment ring and
record_id space; see docs/PROTOCOL.md."""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import platform
import selectors
import shutil
import signal
import socket
import struct
import time
import uuid
import zlib

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
MSG_LIVE_DATA = 0x0100
MSG_ARCHIVE_DATA = 0x0101
MSG_ARCHIVE_DATA_V2 = 0x0102
MSG_LIVE_DATA_V2 = 0x0103
MSG_RESPONSE = 0x8000
MSG_ERROR = 0xFFFF

CONTROL_START = 1
CONTROL_STOP = 2
CONTROL_SET_RATE = 3
CONTROL_ACK = 0x8000
MIN_SCAN_RATE = 10
MAX_SCAN_RATE = 2000

# ADS1263 4-channel differential scan (firmware/common/ads1263_scan_stream.h).
SCAN_FRAME = struct.Struct("<IHBBIQI4B4iI")
SCAN_MAGIC = 0x53363241
SCAN_CONTROL_MAGIC = 0x364C5443
SCAN_CONTROL_GET_STATUS = 1
SCAN_CONTROL_SET_RATE = 6
SCAN_HELLO_REPLY = b"A26OK"
ADS1263_MIN_RATE = 1
ADS1263_MAX_RATE = 300
ADS1263_DEFAULT_RATE = 100
ADS1263_VREF = 2.5
ADS1263_PAIRS = ("AIN0_AIN1", "AIN2_AIN3", "AIN4_AIN5", "AIN6_AIN7")

MSG_ADS1263_STREAM_START = 0x000D
MSG_ADS1263_STREAM_STOP = 0x000E
MSG_ADS1263_READ_BACKLOG = 0x000F
MSG_ADS1263_ARCHIVE_INFO = 0x0010
MSG_ADS1263_LIVE_DATA = 0x0110
MSG_ADS1263_ARCHIVE_DATA = 0x0111


def channel_capabilities(scan_rate: int, ads1263_rate: int = ADS1263_DEFAULT_RATE) -> dict[str, object]:
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
    # ADS1263 is acquired and served by this daemon (ADS1263 stream messages),
    # but the dashboard collector does not forward it yet.
    channels += [
        {
            "id": f"ADS1263-{pair}",
            "label": f"ADS1263 {pair.replace('_', '–')}",
            "adc": "ADS1263",
            "adcChannel": pair.replace("_", "-"),
            "sampleRateHz": ads1263_rate,
            "inputUnit": "V",
            "rateGroupId": "ads1263.scan",
            "streamAvailable": False,
        }
        for pair in ADS1263_PAIRS
    ]
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
            {
                "id": "ads1263.scan",
                "label": "ADS1263 차동 4채널 순차 스캔",
                "channelIds": [f"ADS1263-{pair}" for pair in ADS1263_PAIRS],
                "currentHz": ads1263_rate,
                "writable": True,
                "minHz": ADS1263_MIN_RATE,
                "maxHz": ADS1263_MAX_RATE,
                "stepHz": 1,
            },
        ],
    }


def discovery_capabilities(scan_rate: int, ads1263_rate: int = ADS1263_DEFAULT_RATE) -> dict[str, object]:
    capabilities = channel_capabilities(scan_rate, ads1263_rate)
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


def valid_control(data: bytes, magic: int = CONTROL_MAGIC) -> bool:
    if len(data) != CONTROL.size:
        return False
    fields = CONTROL.unpack(data)
    return (
        fields[0] == magic
        and fields[1] == 1
        and fields[-1] == zlib.crc32(data[:-4])
    )


def make_control(command: int, request_id: int, value: int = 0,
                 magic: int = CONTROL_MAGIC) -> bytes:
    body = CONTROL.pack(magic, 1, command, request_id, value, 0, 0)
    return body[:-4] + struct.pack("<I", zlib.crc32(body[:-4]))


def valid_scan_frame(data: bytes) -> bool:
    if len(data) != SCAN_FRAME.size:
        return False
    fields = SCAN_FRAME.unpack(data)
    return (
        fields[0] == SCAN_MAGIC
        and fields[1] == 1
        and fields[2] == len(ADS1263_PAIRS)
        and fields[-1] == zlib.crc32(data[:-4])
    )


def decode_scan_frame(data: bytes) -> dict[str, object]:
    """ADS1263 scan frame -> per-channel volts; timed-out channels are None."""
    fields = SCAN_FRAME.unpack(data)
    timeout_mask = fields[3]
    statuses, codes = fields[7:11], fields[11:15]
    return {
        "sequence": fields[4],
        "timestamp_us": fields[5],
        "scan_rate_hz": fields[6],
        "timeout_mask": timeout_mask,
        "status": list(statuses),
        "codes": list(codes),
        "volts": [None if timeout_mask >> index & 1 else code * ADS1263_VREF / 2**31
                  for index, code in enumerate(codes)],
    }


def ads8688_meta(frame: bytes) -> tuple[int, int]:
    fields = FRAME.unpack(frame)
    return fields[3], fields[5]


def ads1263_meta(frame: bytes) -> tuple[int, int]:
    fields = SCAN_FRAME.unpack(frame)
    return fields[4], fields[6]


def make_message(message_type: int, request_id: int, payload: bytes = b"") -> bytes:
    return NET_HEADER.pack(len(payload), PROTOCOL_VERSION, message_type, request_id) + payload


def json_bytes(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")


def find_rpmsg_device(core: str = "78000000.r5f") -> Path:
    remoteproc_name = None
    for remoteproc in Path("/sys/class/remoteproc").glob("remoteproc*"):
        if (remoteproc / "name").read_text().strip() == core:
            remoteproc_name = remoteproc.name
            break
    if remoteproc_name is None:
        raise FileNotFoundError(f"remoteproc {core} not found")

    for entry in sorted(Path("/sys/class/rpmsg").glob("rpmsg[0-9]*")):
        if f"/{remoteproc_name}/" in str(entry.resolve()):
            return Path("/dev") / entry.name
    raise FileNotFoundError(f"{core} rpmsg_chrdev endpoint not found")


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
            if name in ("5000000.m4fss", "78000000.r5f", "78400000.r5f"):
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
    """FIFO of fixed 64-byte records (record_id, received_ns, 48-byte frame)."""

    def __init__(
        self,
        directory: Path,
        identity: uuid.UUID,
        segment_bytes: int,
        max_bytes: int,
        reserve_bytes: int,
        magic: bytes = b"ADS8SEG\0",
        suffix: str = ".ads8",
        frame_meta=ads8688_meta,
    ) -> None:
        self.magic = magic
        self.suffix = suffix
        self.frame_meta = frame_meta
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
            path.rename(path.with_suffix(self.suffix))

    def _paths(self, include_current: bool = True) -> list[Path]:
        paths = sorted(self.directory.glob(f"*{self.suffix}"))
        if include_current and self.current_path is not None:
            paths.append(self.current_path)
        return paths

    def _bounds(self, path: Path) -> tuple[int, int] | None:
        size = path.stat().st_size
        if size < SEGMENT_HEADER.size + RECORD.size:
            return None
        with path.open("rb") as stream:
            header = stream.read(SEGMENT_HEADER.size)
            fields = SEGMENT_HEADER.unpack(header)
            if fields[0] != self.magic or fields[1] != 1:
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
                self.magic,
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
        sequence, scan_rate = self.frame_meta(frame)
        if self.current is None:
            self._open(sequence, scan_rate)
        elif self.current.tell() + RECORD.size > self.segment_bytes:
            self.rotate()
            self._open(sequence, scan_rate)

        record_id = self.next_record_id
        received_ns = time.time_ns()
        self.current.write(RECORD.pack(record_id, received_ns, frame))
        now = time.monotonic()
        if now - self.last_sync >= 1.0:
            self.current.flush()
            os.fsync(self.current.fileno())
            self.last_sync = now
        self.next_record_id += 1
        return record_id, received_ns

    def rotate(self) -> None:
        if self.current is None or self.current_path is None:
            return
        self.current.flush()
        os.fsync(self.current.fileno())
        self.current.close()
        completed = self.current_path.with_suffix(self.suffix)
        os.replace(self.current_path, completed)
        self.current = None
        self.current_path = None
        self._prune()

    def _prune(self) -> None:
        completed = sorted(self.directory.glob(f"*{self.suffix}"))
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
    streaming_ads1263: bool = False


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
        self.ring1263 = SegmentRing(
            args.ads1263_data_dir,
            self.identity,
            args.segment_bytes,
            args.max_storage_bytes,
            args.reserve_bytes,
            magic=b"A26SSEG\0",
            suffix=".a26s",
            frame_meta=ads1263_meta,
        )
        self.ads1263: int | None = None
        self.ads1263_device: Path | None = None
        self.ads1263_retry = 0.0
        self.ads1263_rate = ADS1263_DEFAULT_RATE
        self.ads1263_online = False
        self.ads1263_acquiring = False
        self.ads1263_pending: dict[int, tuple[socket.socket | None, int, int, float]] = {}
        self.ads1263_frames = 0
        self.ads1263_invalid = 0
        self.ads1263_gaps = 0
        self.ads1263_timeout_frames = 0
        self.ads1263_recoveries = 0
        self.ads1263_status_poll = 0.0
        self.ads1263_last_sequence: int | None = None
        self.ads1263_report_frames = 0
        # True once A26S frames arrive on the R5FSS0-0 relay path (m4_ads1263 on
        # the MCU header); ADS1263 control then goes to the M4 as CTL8.
        self.ads1263_via_m4 = False
        self.pending_group: dict[int, str] = {}
        self.selector = selectors.DefaultSelector()
        self.clients: dict[socket.socket, Client] = {}
        self.pending: dict[int, tuple[socket.socket, int, int, float]] = {}
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
            "channel_capabilities": channel_capabilities(self.scan_rate, self.ads1263_rate),
            "frames_total": self.frames_total,
            "invalid_total": self.invalid_total,
            "sequence_gaps_total": self.gaps_total,
            "uptime_seconds": round(time.monotonic() - self.started, 3),
            "archive": self.ring.info(),
            "ads1263": {
                "connected": self.ads1263 is not None or self.ads1263_via_m4,
                "source": "m4_mcu_header" if self.ads1263_via_m4 else "r5fss1_0",
                "device": str(self.ads1263_device) if self.ads1263_device else None,
                "online": self.ads1263_online,
                "acquiring": self.ads1263_acquiring,
                "scan_rate_hz": self.ads1263_rate,
                "frames_total": self.ads1263_frames,
                "invalid_total": self.ads1263_invalid,
                "sequence_gaps_total": self.ads1263_gaps,
                "timeout_frames_total": self.ads1263_timeout_frames,
                "config_recoveries": self.ads1263_recoveries,
                "archive": self.ring1263.info(),
            },
            "system": system_metrics(),
        }

    def _send_control(
        self, stream: socket.socket | None, message_type: int, request_id: int,
        command: int, value: int = 0, group: str = "ads8688.scan",
    ) -> None:
        internal_id = self.control_id
        self.control_id = (self.control_id + 1) & 0xFFFFFFFF or 1
        try:
            os.write(self.rpmsg, make_control(command, internal_id, value))
        except OSError as error:
            if stream is not None:
                self._error(stream, request_id, f"RPMsg control failed: {error}")
            return
        self.pending[internal_id] = (
            stream, message_type, request_id, time.monotonic()
        )
        self.pending_group[internal_id] = group

    def _command(
        self, stream: socket.socket, message_type: int, request_id: int, payload: bytes
    ) -> None:
        client = self.clients[stream]
        if message_type == MSG_HELLO:
            self._response(stream, message_type, request_id, {
                "protocol_version": PROTOCOL_VERSION,
                "uuid": str(self.identity),
                "model": "AM6442-SK+ADS8688+ADS1263",
                "capabilities": [
                    "acquisition_control", "sample_rate", "live_stream",
                    "local_ring", "backlog_replay", "timestamped_stream",
                    "ads1263_stream",
                ],
                "channel_capabilities": channel_capabilities(self.scan_rate, self.ads1263_rate),
            })
        elif message_type == MSG_STATUS:
            self._response(stream, message_type, request_id, self._status())
        elif message_type == MSG_STREAM_START:
            client.streaming = 1
            self._response(stream, message_type, request_id, {"streaming": True})
        elif message_type == MSG_STREAM_START_V2:
            client.streaming = 2
            self._response(stream, message_type, request_id, {"streaming": True, "timestamps": "unix_ns"})
        elif message_type == MSG_STREAM_STOP:
            client.streaming = 0
            self._response(stream, message_type, request_id, {"streaming": False})
        elif message_type == MSG_ADS1263_STREAM_START:
            client.streaming_ads1263 = True
            self._response(stream, message_type, request_id, {
                "streaming": True, "timestamps": "unix_ns",
                "connected": self.ads1263 is not None, "scan_rate_hz": self.ads1263_rate,
            })
        elif message_type == MSG_ADS1263_STREAM_STOP:
            client.streaming_ads1263 = False
            self._response(stream, message_type, request_id, {"streaming": False})
        elif message_type == MSG_ADS1263_ARCHIVE_INFO:
            self._response(stream, message_type, request_id, self.ring1263.info())
        elif message_type == MSG_ADS1263_READ_BACKLOG:
            self._backlog(stream, message_type, request_id, payload, self.ring1263,
                          MSG_ADS1263_ARCHIVE_DATA, True)
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
            if group_id == "ads1263.scan":
                if type(rate) is not int or not ADS1263_MIN_RATE <= rate <= ADS1263_MAX_RATE:
                    self._error(stream, request_id, f"rate must be {ADS1263_MIN_RATE}..{ADS1263_MAX_RATE}")
                    return
                if self.ads1263_via_m4:
                    self._send_control(stream, message_type, request_id, CONTROL_SET_RATE, rate,
                                       group="ads1263.scan")
                else:
                    self._send_scan_control(stream, message_type, request_id, SCAN_CONTROL_SET_RATE, rate)
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
        elif message_type in (MSG_READ_BACKLOG, MSG_READ_BACKLOG_V2):
            timestamped = message_type == MSG_READ_BACKLOG_V2
            self._backlog(stream, message_type, request_id, payload, self.ring,
                          MSG_ARCHIVE_DATA_V2 if timestamped else MSG_ARCHIVE_DATA, timestamped)
        else:
            self._error(stream, request_id, f"unknown message type {message_type}")

    def _backlog(self, stream: socket.socket, message_type: int, request_id: int,
                 payload: bytes, ring: SegmentRing, data_type: int, timestamped: bool) -> None:
        if len(payload) != 12:
            self._error(stream, request_id, "READ_BACKLOG payload must be uint64,uint32")
            return
        after_record, limit = struct.unpack("!QI", payload)
        earliest = ring.info()["earliest_record_id"]
        returned = 0
        last_record = after_record
        for record_id, received_ns, frame in ring.read_after(after_record, limit):
            prefix = struct.pack("!QQ", record_id, received_ns) if timestamped else struct.pack("!Q", record_id)
            self._queue(stream, make_message(data_type, request_id, prefix + frame))
            returned += 1
            last_record = record_id
        info = ring.info()
        self._response(stream, message_type, request_id, {
            "returned": returned,
            "last_record_id": last_record,
            "latest_record_id": info["latest_record_id"],
            "more": info["latest_record_id"] is not None and last_record < info["latest_record_id"],
            "earliest_record_id": earliest,
            "truncated": earliest is not None and after_record + 1 < earliest,
        })

    def _send_scan_control(self, stream: socket.socket | None, message_type: int,
                           request_id: int, command: int, value: int = 0) -> None:
        if self.ads1263 is None:
            if stream is not None:
                self._error(stream, request_id, "ADS1263 core (R5FSS1-0) is not connected")
            return
        internal_id = self.control_id
        self.control_id = (self.control_id + 1) & 0xFFFFFFFF or 1
        try:
            os.write(self.ads1263, make_control(command, internal_id, value, SCAN_CONTROL_MAGIC))
        except OSError as error:
            if stream is not None:
                self._error(stream, request_id, f"ADS1263 RPMsg control failed: {error}")
            self._close_ads1263(f"write failed: {error}")
            return
        self.ads1263_pending[internal_id] = (stream, message_type, request_id, time.monotonic())

    def _open_ads1263(self) -> None:
        self.ads1263_retry = time.monotonic() + 5.0
        try:
            device = self.args.ads1263_device or find_rpmsg_device("78400000.r5f")
            descriptor = os.open(device, os.O_RDWR | os.O_NONBLOCK)
        except OSError:
            return
        try:
            os.write(descriptor, b"SUBSCRIBE")
        except OSError:
            os.close(descriptor)
            return
        self.ads1263, self.ads1263_device = descriptor, device
        self.ads1263_last_sequence = None
        self.selector.register(descriptor, selectors.EVENT_READ, "ads1263")
        print(f"ads1263 connected device={device}", flush=True)
        self._send_scan_control(None, 0, 0, SCAN_CONTROL_GET_STATUS)

    def _close_ads1263(self, reason: str) -> None:
        if self.ads1263 is None:
            return
        try:
            self.selector.unregister(self.ads1263)
        except Exception:
            pass
        os.close(self.ads1263)
        self.ads1263 = None
        self.ads1263_online = self.ads1263_acquiring = False
        for stream, _type, request_id, _started in self.ads1263_pending.values():
            if stream is not None and stream in self.clients:
                self._error(stream, request_id, "ADS1263 core disconnected")
        self.ads1263_pending.clear()
        self.ads1263_retry = time.monotonic() + 5.0
        print(f"ads1263 disconnected ({reason})", flush=True)

    def _ads1263_read(self) -> None:
        try:
            packet = os.read(self.ads1263, 496)
        except BlockingIOError:
            return
        except OSError as error:
            self._close_ads1263(str(error))
            return
        if not packet:
            self._close_ads1263("endpoint closed")
            return
        if packet == SCAN_HELLO_REPLY:
            return
        if valid_control(packet, SCAN_CONTROL_MAGIC):
            _magic, _version, command, internal_id, value, status, _crc = CONTROL.unpack(packet)
            pending = self.ads1263_pending.pop(internal_id, None)
            if pending is None or command & CONTROL_ACK == 0:
                return
            if command == CONTROL_ACK | SCAN_CONTROL_GET_STATUS:
                self.ads1263_online = bool(value >> 31 & 1)
                self.ads1263_acquiring = bool(value >> 30 & 1)
                self.ads1263_recoveries = value >> 16 & 0x3FFF
                self.ads1263_rate = value & 0xFFFF or self.ads1263_rate
            elif status == 0 and command == CONTROL_ACK | SCAN_CONTROL_SET_RATE:
                self.ads1263_rate = value
            stream, message_type, request_id, _started = pending
            if stream is None or stream not in self.clients:
                return
            if status != 0:
                self._error(stream, request_id, "ADS1263 core rejected control request")
                return
            self._response(stream, message_type, request_id, {
                "group_id": "ads1263.scan",
                "scan_rate_hz": self.ads1263_rate,
                "channel_capabilities": channel_capabilities(self.scan_rate, self.ads1263_rate),
            })
            return
        if not valid_scan_frame(packet):
            self.ads1263_invalid += 1
            return
        self._ads1263_frame(packet)

    def _ads1263_frame(self, packet: bytes) -> None:
        sequence, rate = ads1263_meta(packet)
        self.ads1263_rate = rate
        self.ads1263_online = self.ads1263_acquiring = True
        if (self.ads1263_last_sequence is not None
                and sequence != (self.ads1263_last_sequence + 1) & 0xFFFFFFFF):
            self.ads1263_gaps += (sequence - self.ads1263_last_sequence - 1) & 0xFFFFFFFF
        self.ads1263_last_sequence = sequence
        if packet[7]:
            self.ads1263_timeout_frames += 1
        try:
            record_id, received_ns = self.ring1263.append(packet)
        except OSError as error:
            print(f"ads1263 storage write failed: {error}", flush=True)
            return
        self.ads1263_frames += 1
        self.ads1263_report_frames += 1
        message = make_message(MSG_ADS1263_LIVE_DATA, 0, struct.pack("!QQ", record_id, received_ns) + packet)
        for stream, client in tuple(self.clients.items()):
            if client.streaming_ads1263:
                self._queue(stream, message)

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
        try:
            packet = os.read(self.rpmsg, 496)
        except BlockingIOError:
            return
        if packet == b"ADS8OK":
            return
        if valid_control(packet):
            _magic, _version, command, internal_id, value, status, _crc = CONTROL.unpack(packet)
            pending = self.pending.pop(internal_id, None)
            group = self.pending_group.pop(internal_id, "ads8688.scan")
            if pending is None or command & CONTROL_ACK == 0:
                return
            stream, message_type, request_id, _started = pending
            if group == "ads1263.scan":
                if command == CONTROL_ACK | 4:  # GET_STATUS from m4_ads1263
                    self.ads1263_online = bool(value >> 31 & 1)
                    self.ads1263_acquiring = bool(value >> 30 & 1)
                    self.ads1263_recoveries = value >> 16 & 0x3FFF
                    self.ads1263_rate = value & 0xFFFF or self.ads1263_rate
                elif status == 0:
                    self.ads1263_rate = value
                if stream is None or stream not in self.clients:
                    return
                if status != 0:
                    self._error(stream, request_id, "ADS1263 (M4) rejected control request")
                    return
                self._response(stream, message_type, request_id, {
                    "group_id": "ads1263.scan",
                    "scan_rate_hz": self.ads1263_rate,
                    "channel_capabilities": channel_capabilities(self.scan_rate, self.ads1263_rate),
                })
                return
            if stream is None or stream not in self.clients:
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
            self._response(stream, message_type, request_id, {
                "acquiring": self.acquiring,
                "scan_rate_hz": value,
                "channel_capabilities": channel_capabilities(self.scan_rate, self.ads1263_rate),
            })
            return
        if valid_scan_frame(packet):
            if not self.ads1263_via_m4:
                print("ads1263 frames arriving from the M4 (MCU header) via R5FSS0-0", flush=True)
            self.ads1263_via_m4 = True
            self._ads1263_frame(packet)
            return
        if not valid_frame(packet):
            self.invalid_total += 1
            self.report_invalid += 1
            return

        fields = FRAME.unpack(packet)
        sequence = fields[3]
        self.scan_rate = fields[5]
        if self.last_sequence is not None and sequence != (self.last_sequence + 1) & 0xFFFFFFFF:
            gap = (sequence - self.last_sequence - 1) & 0xFFFFFFFF
            self.gaps_total += gap
            self.report_gaps += gap
        self.last_sequence = sequence
        try:
            record_id, received_ns = self.ring.append(packet)
        except OSError as error:
            print(f"storage write failed: {error}", flush=True)
            return
        self.frames_total += 1
        self.report_frames += 1
        message = make_message(MSG_LIVE_DATA, 0, struct.pack("!Q", record_id) + packet)
        message_v2 = make_message(MSG_LIVE_DATA_V2, 0, struct.pack("!QQ", record_id, received_ns) + packet)
        for stream, client in tuple(self.clients.items()):
            if client.streaming:
                self._queue(stream, message_v2 if client.streaming == 2 else message)

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
        model = b"AM6442-SK+ADS8688+ADS1263"
        if version == DISCOVERY_VERSION:
            capabilities = json_bytes(discovery_capabilities(self.scan_rate, self.ads1263_rate))
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
        if not self.args.no_ads1263:
            self._open_ads1263()
        self.selector.register(self.tcp, selectors.EVENT_READ, "server")
        self.selector.register(self.udp, selectors.EVENT_READ, "udp")
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
                    elif key.data == "ads1263":
                        if self.ads1263 is not None:
                            self._ads1263_read()
                    elif key.data == "udp":
                        self._udp_read()
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
                    stream, _message_type, request_id, started = pending
                    if now - started > 2.0:
                        self.pending.pop(internal_id)
                        self.pending_group.pop(internal_id, None)
                        if stream is not None and stream in self.clients:
                            self._error(stream, request_id, "MCU control timeout")
                for internal_id, pending in tuple(self.ads1263_pending.items()):
                    stream, _message_type, request_id, started = pending
                    if now - started > 2.0:
                        self.ads1263_pending.pop(internal_id)
                        if stream is not None and stream in self.clients:
                            self._error(stream, request_id, "ADS1263 control timeout")
                if (not self.args.no_ads1263 and self.ads1263 is None
                        and now >= self.ads1263_retry):
                    self._open_ads1263()
                if now >= self.ads1263_status_poll:
                    self.ads1263_status_poll = now + 10.0
                    if self.ads1263 is not None:
                        self._send_scan_control(None, 0, 0, SCAN_CONTROL_GET_STATUS)
                    elif self.ads1263_via_m4:
                        self._send_control(None, 0, 0, 4, group="ads1263.scan")
                if now - self.last_report >= 1.0:
                    print(
                        f"frames={self.report_frames} invalid={self.report_invalid} "
                        f"seq_gaps={self.report_gaps} clients={len(self.clients)} "
                        f"stored={self.ring.next_record_id - 1} "
                        f"ads1263_frames={self.ads1263_report_frames} "
                        f"ads1263_stored={self.ring1263.next_record_id - 1}",
                        flush=True,
                    )
                    self.report_frames = self.report_invalid = self.report_gaps = 0
                    self.ads1263_report_frames = 0
                    self.last_report = now
        finally:
            for stream in tuple(self.clients):
                self._disconnect(stream, "service stopping")
            self.selector.close()
            self.tcp.close()
            self.udp.close()
            os.close(self.rpmsg)
            if self.ads1263 is not None:
                os.close(self.ads1263)
            self.ring.close()
            self.ring1263.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", type=Path)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--discovery-port", type=int, default=8764)
    parser.add_argument("--data-dir", type=Path, default=Path("/var/lib/ads8688/data"))
    parser.add_argument("--ads1263-device", type=Path,
                        help="R5FSS1-0 rpmsg_chrdev (default: found by remoteproc name)")
    parser.add_argument("--ads1263-data-dir", type=Path, default=Path("/var/lib/ads8688/ads1263"))
    parser.add_argument("--no-ads1263", action="store_true", help="ADS8688 only")
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
