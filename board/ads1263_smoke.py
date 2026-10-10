#!/usr/bin/env python3
"""Query and sample the ADS1263 R5FSS1-0 RPMsg endpoint."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import selectors
import struct
import time
import zlib


FRAME_MAGIC = 0x36323141
CONTROL_MAGIC = 0x364C5443
FRAME = struct.Struct("<IHBBIQiiIHHIII")
CONTROL = struct.Struct("<IHHIIiI")

CONTROL_GET_STATUS = 1
CONTROL_START = 2
CONTROL_STOP = 3
CONTROL_RESET = 4
CONTROL_ACK = 0x8000

FLAG_DEVICE_ONLINE = 1 << 0
FLAG_ACQUIRING = 1 << 1
FLAG_PRESSURE_NEW = 1 << 2
FLAG_THERMOCOUPLE_NEW = 1 << 3


def capture_passed(flags: int, samples: int, adc2_updates: int,
                   invalid: int, crc_delta: int, stopping: bool = False) -> bool:
    if not flags & FLAG_DEVICE_ONLINE or invalid or crc_delta:
        return False
    if stopping:
        return not flags & FLAG_ACQUIRING
    return bool(flags & FLAG_ACQUIRING and samples > 0 and adc2_updates > 0)


def valid_frame(data: bytes) -> bool:
    if len(data) != FRAME.size:
        return False
    fields = FRAME.unpack(data)
    return (
        fields[0] == FRAME_MAGIC
        and fields[1] == 2
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
    packet = CONTROL.pack(CONTROL_MAGIC, 1, command, request_id, value, 0, 0)
    return packet[:-4] + struct.pack("<I", zlib.crc32(packet[:-4]))


def find_rpmsg_device() -> Path:
    remoteproc_name = None
    for remoteproc in Path("/sys/class/remoteproc").glob("remoteproc*"):
        if (remoteproc / "name").read_text().strip() == "78400000.r5f":
            remoteproc_name = remoteproc.name
            break
    if remoteproc_name is None:
        raise FileNotFoundError("MAIN R5FSS1-0 remoteproc not found")

    for entry in sorted(Path("/sys/class/rpmsg").glob("rpmsg[0-9]*")):
        if f"/{remoteproc_name}/" in str(entry.resolve()):
            return Path("/dev") / entry.name
    raise FileNotFoundError("R5FSS1-0 rpmsg_chrdev endpoint not found")


def command_from_args(args: argparse.Namespace) -> int:
    if args.start:
        return CONTROL_START
    if args.stop:
        return CONTROL_STOP
    if args.reset:
        return CONTROL_RESET
    return CONTROL_GET_STATUS


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", type=Path)
    parser.add_argument("--seconds", type=float, default=3.0)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--start", action="store_true")
    group.add_argument("--stop", action="store_true")
    group.add_argument("--reset", action="store_true")
    args = parser.parse_args()

    device = args.device or find_rpmsg_device()
    descriptor = os.open(device, os.O_RDWR | os.O_NONBLOCK)
    selector = selectors.DefaultSelector()
    selector.register(descriptor, selectors.EVENT_READ)
    request_id = time.time_ns() & 0xFFFFFFFF
    samples = 0
    adc2_updates = 0
    invalid = 0
    first_crc_errors = None
    latest = None
    acknowledgement = None

    try:
        os.write(descriptor, make_control(command_from_args(args), request_id))
        deadline = time.monotonic() + max(args.seconds, 0.1)
        while time.monotonic() < deadline:
            timeout = min(0.25, deadline - time.monotonic())
            if not selector.select(timeout):
                continue
            try:
                packet = os.read(descriptor, 496)
            except BlockingIOError:
                continue
            if valid_control(packet):
                fields = CONTROL.unpack(packet)
                if fields[2] & CONTROL_ACK and fields[3] == request_id:
                    acknowledgement = fields
                continue
            if valid_frame(packet):
                fields = FRAME.unpack(packet)
                latest = fields
                if first_crc_errors is None:
                    first_crc_errors = fields[11]
                if fields[2] == 1:
                    samples += 1
                    adc2_updates += ((fields[8] & (FLAG_PRESSURE_NEW | FLAG_THERMOCOUPLE_NEW))
                                     == (FLAG_PRESSURE_NEW | FLAG_THERMOCOUPLE_NEW))
                continue
            invalid += 1
    finally:
        selector.close()
        os.close(descriptor)

    if acknowledgement is None:
        print("FAIL: no control acknowledgement")
        return 1
    if acknowledgement[5] != 0:
        print(f"FAIL: firmware command status={acknowledgement[5]}")
        return 1
    if latest is None:
        print("FAIL: no valid status or sample frame")
        return 1

    flags = latest[8]
    crc_delta = (latest[11] - first_crc_errors) & 0xFFFFFFFF
    passed = capture_passed(flags, samples, adc2_updates, invalid, crc_delta, args.stop)
    print(
        f"{'PASS' if passed else 'FAIL'} device={device} online={bool(flags & FLAG_DEVICE_ONLINE)} "
        f"acquiring={bool(flags & FLAG_ACQUIRING)} samples={samples} "
        f"fresh_adc1_pairs={adc2_updates} "
        f"pressure_raw={latest[6]} thermocouple_raw={latest[7]} "
        f"crc_errors={latest[11]} crc_delta={crc_delta} "
        f"io_errors={latest[12]} invalid={invalid} adc_checksum=not_read_stm_mode"
    )
    return 0 if passed else 2


if __name__ == "__main__":
    raise SystemExit(main())
