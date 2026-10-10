# Dashboard operations UX (2026-10-10)

## Sensor monitor

- Raw is the default view. Channel selector is compact; the selected plot uses the full panel width.
- Hover or keyboard arrows inspect retained sample index, relative time and calibrated value.
- X zoom, previous/next range, reset, fullscreen, grid and automatic Y scale are available. Disabling automatic Y scale locks the current Y limits.
- Zoom/pan pauses only this browser's plot. It does not send any acquisition command.
- View polling: 1/2/5/10 seconds, independent of the acquisition SPS. Delayed batches have an explicit age warning; identical values have a flat-data notice.
- CSV uses the batch already displayed, including while paused. A range export remains under Connection / Data Recovery.

## DAQ acquisition

- GET `/api/daqs/{uuid}/acquisition`: short TCP connection, HELLO identity verification, STATUS.
- POST same URL: JSON `{ "action": "start" }`, `{ "action": "stop" }` or `{ "action": "rate", "rate": 1000 }`.
- ADS8688 supports integer 10–2000 scans/s: each scan samples all eight channels, so this is SPS **per channel**. Total conversion count is eight times the configured rate.
- No arbitrary IP or port is accepted from a control request. The registered board address is used; its HELLO UUID must match before a command is sent.
- Each command waits for MCU ACK and then reads back status. Five-second timeout; no automatic retry of a possibly applied command. Conflicting in-process commands are rejected.
- Confirmation explains the effect on all eight channels. Stop ends new ADC acquisition/local recording, not merely browser updates; historical files remain untouched.
- Successful and unconfirmed control attempts are recorded in operating logs. These endpoints use the existing trusted-LAN server access model, not a new authentication/role system.

## Product cleanup

- Removed public performance page, benchmark worker and synthetic-data API; test data generators remain private to automated tests.
- Removed simulated disconnect/replay buttons and their public write endpoints.
- Repeated fleet KPIs appear only on Overview. Dark instrument panel, neutral surfaces, higher-contrast text and semantic warning/error colors.
- Default startup mode is external. Existing stored equipment names, sensor configuration, calibration and raw/history files are preserved.

## Verification

- 46 dashboard tests, 4 collector tests; production build and TypeScript validation passed.
- Fake TCP peer checks read-only requests, start/stop/rate ACK/readback, fragmented frames, wrong UUID, rejected commands and disconnects. No synthetic data is written to the real repository.
- Browser: all seven navigation destinations loaded without console errors; plot zoom/reset, sample keyboard readout, trend view and DAQ confirmation/cancel checked.
- Real board read-only check: acquiring=true, 1000 SPS/channel, sequence_gaps_total=0. Actual start/stop/rate writes were deliberately not exercised against the live board.
- Observed existing telemetry delivery delay around 20 seconds; it is now visible in the UI, not resolved by the polling control. Current identical input samples remain a flat plot.
