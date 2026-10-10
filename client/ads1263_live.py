#!/usr/bin/env python3
"""Live 4-channel plot of the R5FSS1-0 ADS1263 scan firmware.

Starts board/ads1263_trace_stream.py over SSH (the board then runs the scan
firmware and streams JSON samples) and plots each differential channel in
volts. Closing the window ends the SSH session; the board leaves R5FSS1-0
offline. Use --csv to also record every sample.
"""

from __future__ import annotations

import argparse
from collections import deque
import csv
import json
from pathlib import Path
import queue
import subprocess
import threading
import time

import matplotlib
from matplotlib.animation import FuncAnimation

ROOT = Path(__file__).resolve().parents[1]
LABELS = ("ch0  AIN0 − AIN1", "ch1  AIN2 − AIN3", "ch2  AIN4 − AIN5", "ch3  AIN6 − AIN7")
COLORS = ("#2a7de1", "#e8743b", "#19a979", "#c94fb5")
ALARMS = ((0x08, "PGAL"), (0x04, "PGAH"), (0x02, "PGAD"), (0x10, "REF"))


plt = None


def board_profile() -> tuple[str, str]:
    config = {}
    profile = ROOT / ".meta" / "connection.txt"
    if profile.exists():
        for line in profile.read_text(encoding="utf-8-sig").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                config[key.strip().lower()] = value.strip()
    return config.get("ip", ""), config.get("user", "root")


def reader(process: subprocess.Popen, samples: queue.Queue, state: dict) -> None:
    for line in process.stdout:
        try:
            samples.put(json.loads(line))
        except ValueError:
            continue
    state["ended"] = True


def main() -> int:
    host, user = board_profile()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=host, help="board address (default: .meta/connection.txt)")
    parser.add_argument("--user", default=user)
    parser.add_argument("--samples", type=int, default=20, help="samples shown per channel")
    parser.add_argument("--csv", type=Path, help="also write every sample to this CSV file")
    parser.add_argument("--snapshot", type=Path,
                        help="no window: collect --seconds of data, save the plot to this PNG, exit")
    parser.add_argument("--seconds", type=float, default=8.0, help="collection time for --snapshot")
    args = parser.parse_args()
    if not args.host:
        parser.error("no board address; pass --host or create .meta/connection.txt")
    global plt
    if args.snapshot:
        matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    command = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
               "-o", "ServerAliveInterval=3", f"{args.user}@{args.host}",
               "/opt/ads1263/ads1263_trace_stream.py"]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stdin=subprocess.PIPE,
                               text=True, bufsize=1)
    samples: queue.Queue = queue.Queue()
    state = {"ended": False}
    threading.Thread(target=reader, args=(process, samples, state), daemon=True).start()

    writer = None
    csv_file = None
    if args.csv:
        csv_file = args.csv.open("w", newline="", encoding="utf-8")
        writer = csv.writer(csv_file)
        writer.writerow(["r5_time_s", "channel", "status_hex", "code", "volts"])

    history = [deque(maxlen=args.samples) for _ in LABELS]
    latest = [None] * len(LABELS)
    counts = deque()

    fig, axes = plt.subplots(len(LABELS), 1, sharex=True, figsize=(11, 8))
    fig.canvas.manager.set_window_title(f"ADS1263 live - {args.host}")
    lines = []
    for ax, label, color in zip(axes, LABELS, COLORS):
        (line,) = ax.plot([], [], color=color, linewidth=1.4)
        ax.set_ylabel("Vdiff (mV)")
        ax.grid(True, alpha=0.3)
        ax.set_title(label, loc="left", fontsize=10)
        lines.append(line)
    axes[-1].set_xlabel("R5 time (s)")
    banner = fig.suptitle("connecting...", fontsize=11)
    fig.tight_layout(rect=(0, 0, 1, 0.96))

    def update(_frame):
        now = time.monotonic()
        while True:
            try:
                sample = samples.get_nowait()
            except queue.Empty:
                break
            ch = sample["ch"]
            if not 0 <= ch < len(LABELS):
                continue
            history[ch].append((sample["t"], sample["v"] * 1000.0))
            latest[ch] = sample
            counts.append(now)
            if writer:
                writer.writerow([sample["t"], ch, f"{sample['status']:02X}", sample["code"],
                                 f"{sample['v']:.9f}"])
        if csv_file:
            csv_file.flush()
        while counts and now - counts[0] > 2.0:
            counts.popleft()

        for ch, (ax, line) in enumerate(zip(axes, lines)):
            buf = history[ch]
            if buf:
                xs, ys = zip(*buf)
                line.set_data(xs, ys)
                low, high = min(ys), max(ys)
                pad = max((high - low) * 0.15, 0.01)
                ax.set_ylim(low - pad, high + pad)
            sample = latest[ch]
            if sample and buf:
                mean = sum(ys) / len(ys)
                flags = [name for bit, name in ALARMS if sample["status"] & bit]
                ax.set_title(f"{LABELS[ch]} (differential)   now {sample['v'] * 1000:+.3f} mV   "
                             f"mean {mean:+.3f} mV   p-p {(high - low) * 1000:.0f} µV   "
                             f"status 0x{sample['status']:02X}"
                             + (f"  [{' '.join(flags)}]" if flags else ""), loc="left", fontsize=10)
        spans = [(h[0][0], h[-1][0]) for h in history if len(h) > 1]
        if spans:
            axes[-1].set_xlim(min(a for a, _ in spans), max(b for _, b in spans))

        if state["ended"] and samples.empty():
            banner.set_text("stream ended (SSH closed) - check the board")
        else:
            rate = len(counts) / 2.0
            banner.set_text(f"ADS1263 differential inputs (Vref 2.5 V) - R5FSS1-0 via {args.host}   {rate:.0f} samples/s total"
                            + (f"   recording {args.csv.name}" if args.csv else ""))
        return lines

    animation = None
    try:
        if args.snapshot:
            end = time.monotonic() + args.seconds
            while time.monotonic() < end and not state["ended"]:
                time.sleep(0.1)
                update(None)
            update(None)
            fig.savefig(args.snapshot, dpi=110)
            print(f"saved {args.snapshot}: " + ", ".join(
                f"{LABELS[ch].split()[0]} n={len(history[ch])}" for ch in range(len(LABELS))))
        else:
            animation = FuncAnimation(fig, update, interval=100, cache_frame_data=False)
            plt.show()
    finally:
        del animation
        if process.poll() is None:
            try:
                process.stdin.close()
            except OSError:
                pass
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        if csv_file:
            csv_file.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
