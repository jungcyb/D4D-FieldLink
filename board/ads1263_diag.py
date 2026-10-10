#!/usr/bin/env python3
"""Private raw diagnostic stream over SSH stdout; never production samples."""
from __future__ import annotations

import argparse
import json
import os
import selectors
import signal
import struct
import sys
import time
import zlib

if __package__:
    from .ads1263_smoke import CONTROL, make_control, valid_control, find_rpmsg_device
else:
    from ads1263_smoke import CONTROL, make_control, valid_control, find_rpmsg_device

DIAG = struct.Struct("<IHBBIQi8sI")
DIAG_MAGIC = 0x36323144
DIAG_VERSION = 3
DIAG_COMMAND = 5


def decode_diagnostic(packet: bytes) -> dict | None:
    if len(packet) != DIAG.size:
        return None
    magic, version, channel, length, seq, stamp, spi, data, crc = DIAG.unpack(packet)
    if (magic != DIAG_MAGIC or version != DIAG_VERSION or channel not in (1, 2)
            or length not in (0, 5) or crc != zlib.crc32(packet[:-4])):
        return None
    rx = data[:length]
    flags = data[7]
    # Direct read: status at RX[0], signed ADC1 at RX[1:5], no checksum read.
    raw = int.from_bytes(rx[1:5], "big", signed=True) if length == 5 else None
    return dict(channel=channel, adc=1, mux=0x01 if channel == 1 else 0x67,
                configured=bool(flags & 1), mux_written=bool(flags & 2),
                drdy_low=bool(flags & 4), seq=seq, t_us=stamp,
                spi=spi, rx=rx.hex(" ").upper(),
                raw=raw if spi == 0 else None, status=rx[0] if rx else None,
                checksum_rx=None, checksum_calc=None, checksum_ok=None,
                read_attempted=length == 5,
                waiting=length == 0 and bool(flags & 2) and not bool(flags & 4),
                interpretation="STM direct ADC1 RX[1:5]; checksum not read; requested mux, no per-sample readback")


def emit(item: dict) -> None:
    print(json.dumps(item, separators=(",", ":")), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=float, default=0)
    parser.add_argument("--ignore-stdin", action="store_true")
    args = parser.parse_args()
    fd = os.open(find_rpmsg_device(), os.O_RDWR | os.O_NONBLOCK)
    selector = selectors.DefaultSelector()
    selector.register(fd, selectors.EVENT_READ, "rpmsg")
    if not args.ignore_stdin:
        selector.register(sys.stdin, selectors.EVENT_READ, "stop")
    request = time.time_ns() & 0xFFFFFFFF

    def send(value: int) -> int:
        nonlocal request
        request = (request + 1) & 0xFFFFFFFF
        os.write(fd, make_control(DIAG_COMMAND, request, value))
        return request

    def interrupted(*_args):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    started = time.monotonic()
    last_heartbeat = started
    active = False
    start_request = send(1)
    try:
        while not args.seconds or time.monotonic() - started < args.seconds:
            now = time.monotonic()
            if not active and now - started > 4:
                raise RuntimeError("No diagnostic start acknowledgement")
            if active and now - last_heartbeat >= 1:
                send(2)
                last_heartbeat = now
            for key, _mask in selector.select(0.2):
                if key.data == "stop":
                    return 0  # Any input or EOF requests cleanup.
                packet = os.read(fd, 496)
                if valid_control(packet):
                    fields = CONTROL.unpack(packet)
                    if fields[2] == (DIAG_COMMAND | 0x8000):
                        if fields[5] != 0:
                            raise RuntimeError("ADC not ready: diagnostic start/heartbeat rejected; check initialization log")
                        if fields[3] == start_request:
                            active = True
                            emit({"event": "started", "unverified": True,
                                  "configured": bool(fields[4] & 1)})
                    continue
                item = decode_diagnostic(packet)
                if item is not None:
                    emit(item)
    except KeyboardInterrupt:
        return 0
    finally:
        # R5's five-second lease also stops acquisition if SSH or this process dies.
        try:
            stop_request = send(0)
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                for key, _mask in selector.select(0.1):
                    if key.data != "rpmsg":
                        continue
                    packet = os.read(fd, 496)
                    if valid_control(packet):
                        fields = CONTROL.unpack(packet)
                        if fields[3] == stop_request:
                            return_code = fields[5]
                            if return_code != 0:
                                print("Diagnostic STOP failed", file=sys.stderr)
                            deadline = 0
        except OSError:
            pass
        selector.close()
        os.close(fd)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
