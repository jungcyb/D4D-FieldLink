#!/usr/bin/env python3
"""Run the ADS1263 scan firmware on R5FSS1-0 and stream its samples as JSON lines.

The scan firmware reports each sample through DebugP_log, i.e. the remoteproc
trace ring (4 KiB). This polls the ring fast enough that it never wraps between
reads and emits each sample once, keyed by the R5 timestamp. The core is left
offline when the stream ends (stdin/SSH closed, SIGINT or SIGTERM).
"""

from __future__ import annotations

import json
import re
import signal
import sys
import time

from ads1263_scan_test import SAMPLE, SCAN_FW, find_remoteproc, set_core, stop_core, trace_path

STAMP = re.compile(r"\[r5f1-0\]\s+(\d+\.\d+)s :")
VREF = 2.5


def main() -> int:
    rproc = find_remoteproc()
    trace = trace_path(rproc)
    running = True

    def finish(*_args) -> None:
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, finish)
    signal.signal(signal.SIGINT, finish)
    signal.signal(signal.SIGHUP, finish)

    set_core(rproc, SCAN_FW)
    started = time.monotonic()
    last = -1.0
    try:
        while running:
            try:
                text = trace.read_bytes().replace(b"\0", b"").decode("ascii", "replace")
            except OSError:
                text = ""
            # The trace ring survives a core restart, so lines from an earlier
            # run can still be in it; they carry R5 times beyond this run's age.
            horizon = time.monotonic() - started + 0.5
            rows = []
            for line in text.splitlines():
                stamp, sample = STAMP.search(line), SAMPLE.search(line)
                if stamp and sample and float(stamp.group(1)) <= horizon:
                    rows.append((float(stamp.group(1)), sample))
            rows.sort(key=lambda row: row[0])
            for stamp, sample in rows:
                if stamp <= last:
                    continue
                last = stamp
                code = int(sample.group(3))
                print(json.dumps({"t": stamp, "ch": int(sample.group(1)),
                                  "status": int(sample.group(2), 16), "code": code,
                                  "v": code * VREF / 2**31}), flush=True)
            time.sleep(0.05)
    except BrokenPipeError:
        pass
    finally:
        stop_core(rproc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
