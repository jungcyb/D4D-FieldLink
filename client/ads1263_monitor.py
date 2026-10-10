#!/usr/bin/env python3
"""One line per second of ADS1263 link health, from the board's TCP stream.

Columns: real = frames whose four status bytes all carry ADC1-new-data (0x40);
zero = DRDY seen but the read returned no status (DOUT/MISO not answering);
dead = all four inputs without DRDY (chip not converting or not configured).
Useful while reseating wires: the line turns OK the moment the chip answers.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import socket
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ads8688_protocol as protocol  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


def board_host() -> str:
    profile = ROOT / ".meta" / "connection.txt"
    if profile.exists():
        for line in profile.read_text(encoding="utf-8-sig").splitlines():
            if line.strip().lower().startswith("ip="):
                return line.split("=", 1)[1].strip()
    return ""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=board_host())
    args = parser.parse_args()
    if not args.host:
        parser.error("no board address; pass --host or create .meta/connection.txt")

    print(f"ADS1263 link monitor - {args.host}  (Ctrl+C to stop)")
    print("time      real  zero  dead | ch0 mV     ch1 mV     ch2 mV     ch3 mV    | recov | state")
    while True:
        try:
            stream = socket.create_connection((args.host, protocol.TCP_PORT), timeout=3)
            stream.sendall(protocol.message(protocol.ADS1263_STREAM_START, 1))
            stream.settimeout(0.2)
            window_end = time.monotonic() + 1.0
            real = zero = dead = 0
            last = None
            recoveries = "?"
            next_status = 0.0
            while True:
                now = time.monotonic()
                if now >= next_status:
                    try:
                        recoveries = protocol.request(args.host, protocol.STATUS)["ads1263"].get("config_recoveries", "?")
                    except (OSError, RuntimeError, ValueError, KeyError):
                        recoveries = "?"
                    next_status = now + 5.0
                try:
                    message_type, _request_id, payload = protocol.receive(stream)
                    if message_type == protocol.ADS1263_LIVE_DATA:
                        record = protocol.decode_ads1263_data(payload)
                        if all(status & 0x40 for status in record["status"]):
                            real += 1
                            last = record
                        elif record["timeout_mask"] == 0x0F:
                            dead += 1
                        else:
                            zero += 1
                except socket.timeout:
                    pass
                if time.monotonic() >= window_end:
                    values = ("   ---    " * 4 if last is None else
                              " ".join(f"{v * 1e3:+10.3f}" if v is not None else "    ---   "
                                       for v in last["volts"]))
                    total = real + zero + dead
                    state = ("OK" if total and real == total else
                             "PARTIAL" if real else
                             "NO DOUT (DRDY ok, data 0)" if zero else
                             "NO DRDY (chip silent)" if dead else "NO FRAMES")
                    print(f"{time.strftime('%H:%M:%S')}  {real:4d}  {zero:4d}  {dead:4d} | {values} | {recoveries!s:>5} | {state}",
                          flush=True)
                    real = zero = dead = 0
                    window_end += 1.0
        except KeyboardInterrupt:
            return 0
        except Exception as error:  # keep the monitor alive while wires are being moved
            print(f"{time.strftime('%H:%M:%S')}  {type(error).__name__}: {error}; retrying", flush=True)
            time.sleep(2)


if __name__ == "__main__":
    raise SystemExit(main())
