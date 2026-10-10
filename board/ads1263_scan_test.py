#!/usr/bin/env python3
"""Load the ADS1263 scan firmware on R5FSS1-0 and judge its remoteproc trace log.

The firmware only reports through DebugP_log, which Linux exposes as the
remoteproc trace buffer (a 4 KiB ring). The ring wraps in a few seconds, so
the startup lines are taken from the first snapshot and the sample statistics
from the last one.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import re
import subprocess
import sys
import time

R5_NAME = "78400000.r5f"
SCAN_FW = "ads1263_scan/am64-main-r5f1_0-fw"
CHANNELS = 4
ADC1_NEW = 0x40

REGS = re.compile(r"ADS1263: regs=\[((?:[0-9A-F]{2} ?){7})\]")
VERIFY = re.compile(r"ADS1263: verify MODE0=(\w\w) MODE1=(\w\w) MODE2=(\w\w) INPMUX=(\w\w)")
SAMPLE = re.compile(r"ADS1263: ch(\d) status=0x([0-9A-F]{2}) code=(-?\d+)")
TIMEOUT = re.compile(r"ADS1263: ch(\d) DRDY timeout")
FATAL = re.compile(r"ADS1263: (SPI handle not opened|init failed|reset/configure failed|7-reg \w+ failed|START failed)")


def find_remoteproc() -> Path:
    for path in Path("/sys/class/remoteproc").glob("remoteproc*"):
        if (path / "name").read_text().strip() == R5_NAME:
            return path
    raise SystemExit(f"FAIL remoteproc {R5_NAME} not found")


def stop_core(rproc: Path) -> None:
    if (rproc / "state").read_text().strip() == "running":
        try:
            (rproc / "state").write_text("stop")
        except OSError as error:
            # k3_r5 needs the running firmware to ACK the shutdown mailbox and enter WFI.
            raise SystemExit(f"FAIL cannot stop {rproc.name} ({error}); the running firmware "
                             "ignores remoteproc shutdown, reboot the board") from None


def set_core(rproc: Path, firmware: str) -> None:
    stop_core(rproc)
    (rproc / "firmware").write_text(firmware)
    (rproc / "state").write_text("start")


def trace_path(rproc: Path) -> Path:
    debugfs = Path("/sys/kernel/debug")
    if not (debugfs / "remoteproc").exists():
        subprocess.run(["mount", "-t", "debugfs", "none", str(debugfs)], check=False)
    return debugfs / "remoteproc" / rproc.name / "trace0"


def snapshot(trace: Path) -> list[str]:
    try:
        raw = trace.read_bytes()
    except OSError:
        return []
    # The ring may hold a torn line at the write cursor; drop NULs and keep whole lines.
    return [line for line in raw.replace(b"\0", b"").decode("ascii", "replace").splitlines() if line]


def judge(first: list[str], last: list[str]) -> tuple[bool, list[str]]:
    report: list[str] = []
    ok = True
    everything = first + last

    fatal = sorted({m.group(1) for line in everything if (m := FATAL.search(line))})
    if fatal:
        ok = False
        report.append(f"FAIL firmware error: {', '.join(fatal)}")

    regs = next((m.group(1).split() for line in everything if (m := REGS.search(line))), None)
    if regs is None:
        ok = False
        report.append("FAIL no register dump (startup lines missing or firmware did not start)")
    else:
        device_id = int(regs[0], 16)
        good_id = device_id >> 5 == 1
        ok &= good_id
        report.append(f"{'PASS' if good_id else 'FAIL'} ID=0x{device_id:02X} "
                      f"(ADS1263 DEV_ID=001 expected), regs={' '.join(regs)}")

    verify = next((m.groups() for line in everything if (m := VERIFY.search(line))), None)
    if verify is None:
        ok = False
        report.append("FAIL no register verify line")
    else:
        good = tuple(v.upper() for v in verify) == ("00", "00", "8B", "0A")
        ok &= good
        report.append(f"{'PASS' if good else 'FAIL'} MODE0/1/2/INPMUX={' '.join(verify)} (expect 00 00 8B 0A)")

    samples: dict[int, list[tuple[int, int]]] = {ch: [] for ch in range(CHANNELS)}
    timeouts = {ch: 0 for ch in range(CHANNELS)}
    for line in last:
        if m := SAMPLE.search(line):
            samples[int(m.group(1))].append((int(m.group(2), 16), int(m.group(3))))
        elif m := TIMEOUT.search(line):
            timeouts[int(m.group(1))] += 1

    for ch in range(CHANNELS):
        rows = samples[ch]
        fresh = sum(1 for status, _ in rows if status & ADC1_NEW)
        codes = [code for _, code in rows]
        stuck = len(codes) > 1 and len(set(codes)) == 1 and codes[0] in (0, -1)
        good = bool(rows) and fresh > 0 and not stuck
        ok &= good
        detail = f"n={len(rows)} new={fresh} timeouts={timeouts[ch]}"
        if codes:
            detail += f" code[min/max/last]={min(codes)}/{max(codes)}/{codes[-1]}"
            detail += f" ({codes[-1] * 2.5 / 2**31:+.6f} V @2.5Vref)"
        if stuck:
            detail += " STUCK"
        report.append(f"{'PASS' if good else 'FAIL'} ch{ch} {detail}")
    return ok, report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=float, default=5.0, help="capture time after start")
    parser.add_argument("--keep", action="store_true", help="leave the scan firmware running")
    parser.add_argument("--show", type=int, default=20, help="trace lines to print (0 = none)")
    args = parser.parse_args()

    rproc = find_remoteproc()
    trace = trace_path(rproc)
    set_core(rproc, SCAN_FW)
    first: list[str] = []
    last: list[str] = []
    try:
        deadline = time.monotonic() + args.seconds
        while time.monotonic() < deadline:
            # Poll fast until the startup lines are caught; the 4 KiB ring wraps quickly.
            time.sleep(0.2 if first else 0.02)
            last = snapshot(trace)
            if not first and any(VERIFY.search(line) for line in last):
                first = last
        state = (rproc / "state").read_text().strip()
    finally:
        if not args.keep:
            # Leave the core offline: TI's default echo firmware has been seen to
            # ignore the next shutdown request, which then needs a board reboot.
            stop_core(rproc)

    print(f"R5FSS1-0 {rproc.name} state={state} firmware={SCAN_FW}")
    if args.show:
        print("--- trace (latest) ---")
        print("\n".join(last[-args.show:]) or "(empty)")
        print("----------------------")
    if state != "running":
        print("FAIL core is not running (check dmesg | grep remoteproc)")
        return 1
    ok, report = judge(first, last)
    print("\n".join(report))
    print("RESULT", "PASS" if ok else "FAIL",
          "(firmware left running)" if args.keep else "(R5FSS1-0 left offline)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
