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
