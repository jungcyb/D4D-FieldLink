param(
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9.:-]*$')]
    [string]$BoardHost = '192.168.1.104',
    [ValidateRange(0, 86400)]
    [int]$Seconds = 0
)

$ErrorActionPreference = 'Stop'
$taskProject = (Resolve-Path "$PSScriptRoot\..").Path
$env:SSH_ASKPASS = Join-Path $taskProject 'tools\ssh\askpass.cmd'
$env:SSH_ASKPASS_REQUIRE = 'force'
$env:DISPLAY = 'codex-ssh'
$knownHosts = Join-Path $taskProject '.meta\tools\ssh\known_hosts'
$logDirectory = Join-Path $taskProject '.meta\logs'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$logPath = Join-Path $logDirectory ("ads1263-{0}-{1}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $PID)
$Host.UI.RawUI.WindowTitle = "ADS1263 Firmware Log | $BoardHost | READ ONLY"

# Sent over SSH stdin, executed in memory; no board files or ADC state changed.
$remoteCode = @'
from datetime import datetime
from pathlib import Path
import sys
import time


def trace_delta(previous, current):
    if previous is None:
        return "[WATCH] Existing firmware trace (historical lines):\n" + current
    if current.startswith(previous):
        return current[len(previous):]
    return "[WATCH] Trace reset/wrapped/changed; full snapshot follows:\n" + current


# Runnable regression checks: no duplicate lines; reset/wrap never silently lost.
assert trace_delta("abc", "abc") == ""
assert trace_delta("abc", "abcdef") == "def"
assert trace_delta("old", "new").endswith("new")
assert "reset/wrapped" in trace_delta("old", "new")
assert "historical" in trace_delta(None, "boot")

duration = int(sys.argv[1])
started = time.monotonic()
previous, previous_state = None, None
last_heartbeat = started
print("[WATCH] READ ONLY: no RESET, START, STOP or RPMsg endpoint access.", flush=True)
print("[WATCH] Poll=0.5s. Firmware times are seconds since its start.", flush=True)
print("[WATCH] GPIO/DRDY lines describe their logged instant, NOT live pin measurements.", flush=True)
try:
    while duration == 0 or time.monotonic() - started < duration:
        try:
            core = next(p for p in Path("/sys/class/remoteproc").glob("remoteproc*")
                        if (p / "name").read_text().strip() == "78400000.r5f")
            state = (core.name, (core / "state").read_text().strip(),
                     (core / "firmware").read_text().strip())
            if state != previous_state:
                print(f"[WATCH] {datetime.now().astimezone().isoformat(timespec='seconds')} "
                      f"{state[0]} state={state[1]} firmware={state[2]}", flush=True)
                previous_state, previous = state, None
            trace = Path("/sys/kernel/debug/remoteproc") / core.name / "trace0"
            current = trace.read_bytes().split(b"\0", 1)[0].decode("utf-8", errors="replace")
            delta = trace_delta(previous, current)
            if delta:
                print(delta, end="" if delta.endswith("\n") else "\n", flush=True)
            previous = current
        except (OSError, StopIteration) as error:
            state = ("unavailable", str(error))
            if state != previous_state:
                print(f"[WATCH] R5 trace unavailable: {error}", flush=True)
                previous_state, previous = state, None
        if time.monotonic() - last_heartbeat >= 10:
            print(f"[WATCH] {datetime.now().astimezone().isoformat(timespec='seconds')} "
                  "reader alive; unchanged trace is not evidence of ADC activity.", flush=True)
            last_heartbeat = time.monotonic()
        time.sleep(0.5)
except (KeyboardInterrupt, BrokenPipeError):
    pass
'@

$writer = [System.IO.StreamWriter]::new($logPath, $false, [System.Text.UTF8Encoding]::new($false))
$writer.AutoFlush = $true
try {
    $header = "[LOCAL] Board=$BoardHost | Log=$logPath | Ctrl+C stops this reader only."
    Write-Host $header
    $writer.WriteLine($header)
    $options = @('-T', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=5',
                 '-o', 'ServerAliveCountMax=2', '-o', "UserKnownHostsFile=$knownHosts")
    $remoteCode | & ssh @options "root@$BoardHost" "python3 -u - $Seconds" 2>&1 |
        ForEach-Object {
            $line = $_.ToString()
            $writer.WriteLine($line)
            Write-Host $line
        }
    $result = $LASTEXITCODE
    $footer = "[LOCAL] Reader ended: SSH exit=$result. ADC state was not changed by this reader."
    $writer.WriteLine($footer)
    Write-Host $footer
    if ($result -ne 0) { throw "SSH reader disconnected/failed (exit $result). See $logPath" }
}
finally {
    $writer.Dispose()
}
