#!/usr/bin/env python3
"""Repeat UDP discovery, TCP reconnect, and rate-control checks."""

from __future__ import annotations

import argparse
from pathlib import Path
import struct
import sys
import time


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "client"))
import ads8688_protocol as protocol


def repeat(count: int, action) -> float:
    started = time.monotonic()
    for index in range(count):
        action(index)
    return time.monotonic() - started


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="192.168.1.104")
    parser.add_argument("--broadcast", default="192.168.1.255")
    parser.add_argument("--count", type=int, default=100)
    args = parser.parse_args()

    def check_discovery(index: int) -> None:
        found = protocol.discover(args.broadcast, 0.08)
        if not any(board["ip"] == args.host for board in found):
            raise RuntimeError(f"discovery failed at iteration {index}")

    def check_reconnect(index: int) -> None:
        if not protocol.request(args.host, protocol.STATUS).get("uuid"):
            raise RuntimeError(f"status failed at iteration {index}")

    def check_rate(index: int) -> None:
        rate = 800 if index % 2 == 0 else 1000
        result = protocol.request(
            args.host, protocol.SET_RATE, struct.pack("!I", rate)
        )
        if result["scan_rate_hz"] != rate:
            raise RuntimeError(f"rate ACK mismatch at iteration {index}")

    discovery_seconds = repeat(args.count, check_discovery)
    reconnect_seconds = repeat(args.count, check_reconnect)
    rate_seconds = repeat(args.count, check_rate)
    protocol.request(args.host, protocol.SET_RATE, struct.pack("!I", 1000))
    print(f"discovery={args.count}/{args.count} elapsed={discovery_seconds:.2f}s")
    print(f"tcp_reconnect={args.count}/{args.count} elapsed={reconnect_seconds:.2f}s")
    print(f"rate_ack={args.count}/{args.count} elapsed={rate_seconds:.2f}s final=1000")


if __name__ == "__main__":
    main()
