# FIELDLINK server collector

The collector is a long-running Node.js process on the same server as the
Next.js dashboard. It discovers or connects to every FieldLink DAQ on the LAN
(AM6442 boards, ESP32-P4 BLE proxies), keeps one TCP stream alive per board UUID, resumes live data immediately after reconnect, aggregates one
second of eight-channel scans, and posts only registered dashboard channels.
The board ring is replayed only for an explicit dashboard recovery request,
which keeps the original batches as gzip archives and records unavailable ranges.

```powershell
$env:DASHBOARD_URL = 'http://127.0.0.1:3000'
$env:BOARD_HOST = '192.168.0.240' # optional; omit to use UDP discovery, or list several: '192.168.0.240,192.168.0.62'
node .\integration\collector.mjs
```

Every 10 s the collector also sends `STATUS`; a board that does not answer
is dropped and rediscovered. When the reply carries `anomaly` (short/long-term
RMS, see `docs/PROTOCOL.md`), each channel state change is posted to the
dashboard as a diagnosis with model `edge-rms-sta-lta` (registered channels)
and as a device log `AD_RMS_WARNING` / `AD_RMS_ALARM` / `AD_RMS_NORMAL` with
the ratio and RMS values in its metadata (every channel).

Boards supporting `ANOMALY_EVENT` push state changes without waiting for the
10-second STATUS probe; initial STATUS is also processed immediately. Diagnoses
are uploaded before per-channel logs so logging does not delay that verdict.
Failed delivery does not advance the reported-state cursor, and retries reuse
stable diagnosis frame IDs. Dashboard requests time out after 10 seconds rather
than blocking the queue indefinitely. The STATUS probe remains the recovery
path for missed events; this does not change the board's inference cadence.
Restart the collector to apply changes. The dashboard uses SSE change notices
plus a one-second fallback query; see `dashboard/README.md` for deployment limits.

Register real channels as `CH0` through `CH7`. ADS8688 straight-binary codes
are converted to the configured bipolar input voltage range (currently
`+/-10.24 V`). Sensor-specific affine calibration is applied by the dashboard,
not by the collector. The persistent upload cursor is stored under `state/`;
it advances only after the dashboard accepts a complete batch.

Environment variables:

- `DASHBOARD_URL`: dashboard server URL, default `http://127.0.0.1:3000`
- `EDGE_API_TOKEN`: optional dashboard ingestion token
- `BOARD_HOST`, `BOARD_PORT`: fixed board address, or a comma-separated list; omit host for discovery
- `BOARD_LABEL`: dashboard label when exactly one fixed `BOARD_HOST` is given
- `BOARD_DISCOVERY_ADDRESS`: LAN broadcast, default `255.255.255.255`
- `BOARD_DISCOVERY_PORT`: default `8764`
- `BOARD_DISCOVERY_INTERVAL_MS`: rediscovery period for new or returning boards, default `2000`
- `BOARD_STATUS_TIMEOUT_MS`: a connected board that leaves the 10 s STATUS probe unanswered this long is dropped and rediscovered, default `8000`
- `COLLECTOR_STATE_DIR`: persistent cursor directory
