# pygame ADS8688 client

The client renders eight simultaneous, fixed-scale traces in one resizable
pygame window. It reads the board address from `.meta/client/host.txt` at the
repository root; update that local-only file if the Wi-Fi or Ethernet address changes.

```powershell
python -m venv .venv-client
.\.venv-client\Scripts\python -m pip install pygame
.\.venv-client\Scripts\python .\client\pygame_scope.py
```

After the one-time setup, launch it with `client\run_scope.ps1`. Use
`--host <address>` to override `.meta/client/host.txt`. This file is not committed;
on a fresh clone, create it with one board address or pass `--host` explicitly.

The viewer reconnects automatically. After a disconnect it requests stored
records after its last `record_id`, catches up, and then resumes the live
stream.

The standard-library CLI covers discovery, control, and archived data:

```powershell
python .\client\ads8688_cli.py discover --address 192.168.1.255
python .\client\ads8688_cli.py status
python .\client\ads8688_cli.py set-rate 1000
python .\client\ads8688_cli.py stop
python .\client\ads8688_cli.py start
python .\client\ads8688_cli.py archive-info
python .\client\ads8688_cli.py backlog --after 100000 --limit 2000 --output backlog.bin
```

See `docs/PROTOCOL.md` for the binary protocol and disconnect recovery rules.

## ADS1263 raw diagnostic scope

For **read-only firmware logs** (no ADC reset/start/stop and no RPMsg endpoint
ownership), run this in PowerShell:

```powershell
.\client\watch_ads1263_logs.ps1 -BoardHost 192.168.1.104
```

It shows the existing remoteproc trace followed by new lines, polls every 0.5 s,
and saves UTF-8 logs under ignored `.meta/logs/`. Ctrl+C stops only the reader.
`-Seconds 3` is a bounded connection/regression check. Historical DRDY/GPIO
lines are not live pin measurements; an idle log is not proof of acquisition.
This log reader can remain open alongside the scope below.

After deploying the ADS1263 diagnostic firmware plus `board/ads1263_diag.py`
and `board/ads1263_smoke.py` into `/opt/ads1263`, launch:

```powershell
.\client\run_ads1263_scope.ps1 -BoardHost 192.168.0.240
```

This uses the existing pygame environment and SSH credentials, without opening
a new TCP listener or starting the dashboard. Both input pairs use ADC1 and show candidate raw-code
traces, exact five-byte SPI responses, wait/error status, a time grid and hover
index/value details. SPACE freezes only the view; A toggles auto/full scale;
+/- changes the time window; the mouse wheel changes Y zoom; R reconnects. Close/ESC stops
diagnostic acquisition. A five-second R5 heartbeat lease is the fallback after
connection loss. Do not run another RPMsg client concurrently on this endpoint.

Red samples are **unverified** (startup configuration or SPI/DRDY observations).
Green is not proof of sensor accuracy or ADC checksum integrity. On explicit user
request, raw diagnostics also run after a failed ID/configuration check, with
an ADC INITIALIZATION FAILED warning. No calibration,
polarity change or production storage is applied. Diagnostic frames use their
own magic/length and cannot be accepted as normal samples. D126 version 3 uses
logical channel IDs 1/2; both are signed 32-bit ADC1 samples. ADC2 is not started.
The STM pressure profile is 4800 SPS/PGA bypass/SINC1/internal reference.
After MUX selection, the firmware holds that input until DRDY LOW with no
conversion deadline; once per second it emits a WAITING event (no raw value).
Only five bytes are clocked, matching STM: ADC checksum is NOT READ, not PASS.
MUX "write sent" means SPI transport completion, not ADC register verification.
Actual readout rates are measured from timestamps, not assumed to be 4800/input.
The viewer retains up to 12,000 diagnostic events per input in memory.
Its current screenshot/status and launch logs live in ignored `.meta/` files.
