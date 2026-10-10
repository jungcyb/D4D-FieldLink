"""Wire samples, bounded history and display math. No UI/network dependencies."""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import math
import struct
import time
import zlib

FRAME = struct.Struct("<IHHIQIHH8HI")
FRAME_BYTES = 48
ADS8688_MAGIC = 0x38534441
NU40_MAGIC = 0x3034554E
NU40_G_PER_LSB = 0.000061


@dataclass(frozen=True, slots=True)
class Sample:
    record: int
    unix_ns: int | None
    sequence: int
    device_us: int
    rate: int
    codes: tuple[int, ...]
    segment: int = 0
    source: str = "ads8688"

    @property
    def channel_offset(self) -> int:
        return 8 if self.source == "nu40" else 0

    @property
    def time_ns(self) -> int:
        return self.unix_ns if self.unix_ns is not None else self.device_us * 1000

    def contains(self, channel: int) -> bool:
        return self.channel_offset <= channel < self.channel_offset + len(self.codes)

    def raw(self, channel: int) -> int:
        if not self.contains(channel):
            raise IndexError(channel)
        return self.codes[channel - self.channel_offset]

    def value(self, channel: int) -> float:
        raw = self.raw(channel)
        return raw * NU40_G_PER_LSB if self.source == "nu40" else raw * 20.48 / 65536 - 10.24

    def unit(self, channel: int) -> str:
        return "g" if self.source == "nu40" else "V"

    def volts(self, channel: int) -> float:
        if self.source != "ads8688":
            raise ValueError("NU40 samples are acceleration, not voltage")
        return self.value(channel)


def decode_sample(payload: bytes, timestamped: bool) -> Sample:
    prefix = 16 if timestamped else 8
    if len(payload) != prefix + FRAME_BYTES:
        raise ValueError("invalid sample length")
    packet = payload[prefix:]
    magic, version, header_size, sequence = struct.unpack_from("<IHHI", packet)
    device_us, rate, count, encoding = struct.unpack_from("<QIHH", packet, 12)
    nu40 = magic == NU40_MAGIC
    if ((not nu40 and magic != ADS8688_MAGIC) or version != 1 or header_size != 28
            or (count, encoding) != ((3, 2) if nu40 else (8, 1))
            or struct.unpack_from("<I", packet, 44)[0] != zlib.crc32(packet[:-4])
            or not 1 <= rate <= 1_000_000):
        raise ValueError("invalid frame / CRC / sample rate")
    codes = struct.unpack_from("<3h" if nu40 else "<8H", packet, 28)
    return Sample(struct.unpack_from("!Q", payload)[0],
                  struct.unpack_from("!Q", payload, 8)[0] if timestamped else None,
                  sequence, device_us, rate, tuple(codes), source="nu40" if nu40 else "ads8688")


class History:
    def __init__(self, capacity: int = 32000):
        self.rows: deque[Sample] = deque(maxlen=capacity)
        self.total = self.gaps = self.restarts = self.segment = 0
        self.last_receive = 0.0
        self.rate = 0.0
        self._rate_at = time.monotonic()
        self._rate_count = 0
        self.break_pending = False
        self._previous: dict[str, Sample] = {}
        self._segments: dict[str, int] = {}

    def append(self, sample: Sample) -> bool:
        self._segments.setdefault(sample.source, 0)
        if self.break_pending:
            for source in self._segments:
                self._segments[source] += 1
            self.break_pending = False
        previous = self._previous.get(sample.source)
        if previous and (sample.record, sample.device_us) == (previous.record, previous.device_us):
            return False
        if previous:
            delta = (sample.sequence - previous.sequence) & 0xFFFFFFFF
            if sample.device_us <= previous.device_us or sample.record < previous.record:
                self.rows = deque((row for row in self.rows if row.source != sample.source),
                                  maxlen=self.rows.maxlen)
                self.restarts += 1
                self._segments[sample.source] = self._segments.get(sample.source, 0) + 1
            elif delta != 1 or sample.rate != previous.rate:
                self._segments[sample.source] = self._segments.get(sample.source, 0) + 1
                if 1 < delta < 0x80000000:
                    self.gaps += delta - 1
        self.segment = max(self.segment, self._segments.get(sample.source, 0))
        sample = Sample(sample.record, sample.unix_ns, sample.sequence, sample.device_us,
                        sample.rate, sample.codes, self._segments.get(sample.source, 0), sample.source)
        self.rows.append(sample)
        self._previous[sample.source] = sample
        self.total += 1
        self.last_receive = time.monotonic()
        self._rate_count += 1
        elapsed = self.last_receive - self._rate_at
        if elapsed >= 1:
            self.rate = self._rate_count / elapsed
            self._rate_count = 0
            self._rate_at = self.last_receive
        return True


def visible_rows(rows: list[Sample], seconds: float, offset: float = 0) -> list[Sample]:
    if not rows:
        return []
    end = max(row.time_ns for row in rows) - offset * 1e9
    start = end - seconds * 1e9
    return [row for row in rows if start <= row.time_ns <= end]


def envelope(rows: list[Sample], channel: int, pixels: int) -> list[Sample]:
    """Reduce BEFORE coordinate conversion, preserving peaks and every gap edge."""
    rows = [row for row in rows if row.contains(channel)]
    if len(rows) <= pixels * 2 or pixels < 1:
        return rows
    keep = {i for i in range(1, len(rows)) if rows[i].segment != rows[i-1].segment}
    keep.update(i-1 for i in tuple(keep))
    size = math.ceil(len(rows) / pixels)
    codes = [row.raw(channel) for row in rows]
    for start in range(0, len(rows), size):
        stop = min(len(rows), start + size)
        bucket = codes[start:stop]
        keep.update((start, stop-1, start+bucket.index(min(bucket)), start+bucket.index(max(bucket))))
    return [rows[i] for i in sorted(keep)]


def limits(values: list[float], auto: bool, full_scale: float = 10.24) -> tuple[float, float]:
    if not auto or not values:
        return -full_scale, full_scale
    lo, hi = min(values), max(values)
    margin = max((hi - lo) * .12, .000625)
    return lo - margin, hi + margin


def validate_rate(group: dict, value: str) -> int:
    if group.get("writable") is not True:
        raise ValueError("이 그룹은 샘플레이트 변경을 지원하지 않습니다.")
    try:
        rate = float(value)
        low, high = float(group["minHz"]), float(group["maxHz"])
        step = float(group.get("stepHz") or 1)
    except (ValueError, TypeError, KeyError):
        raise ValueError("보드의 변경 범위가 없거나 입력값이 올바르지 않습니다.") from None
    if not all(map(math.isfinite, (rate, low, high, step))) or step <= 0 or not low <= rate <= high or not rate.is_integer():
        raise ValueError(f"{low:g}–{high:g} 범위의 정수 SPS를 입력하세요.")
    if not math.isclose((rate-low)/step, round((rate-low)/step), abs_tol=1e-7):
        raise ValueError(f"변경 간격은 {step:g} SPS입니다.")
    return int(rate)
