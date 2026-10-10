# v0.4 edge AI: anomaly detection first, explicit sensor profiles

## Why v0.4 changes direction

v0.3 and v0.3.1 added experimental run-to-failure (RUL) candidates for FEMTO
and XJTU-SY bearing datasets. Those candidates require failure-endpoint labels,
the same asset class, installation context, sampling profile, and held-out
failure histories. The hackathon has none of the compatible field failure data
needed to honestly train or validate a remaining-life predictor. A numeric RUL
for the demo would therefore be an unsupported claim rather than a product
result.

For that reason, v0.4 makes **normal-data-based anomaly detection** the
hackathon delivery focus: register one explicit sensor configuration, collect
and approve normal windows, train/evaluate an anomaly candidate with
session-separated data, activate it explicitly, then run continuous local
scoring. It can report an anomaly score/threshold/state, not invented fault
classes or remaining-life hours.

The v0.3.1 normal-only anomaly, labeled fault-classification, and RUL source
pipelines remain in this snapshot for compatibility and future work.
`predictive.py` can run any nonempty compatible subset and returns explicit
`unavailable` states for missing models. **No new field-trained weights are
included.** The existing v0.1 XGBoost artifacts remain separate; they are not
silently treated as v0.4 models. The output wire contract remains
`edge_prediction_v0.3`, which the current dashboard accepts; v0.4 is the
software version, not a new wire schema.

## Dynamic inputs are bounded, not arbitrary

Each approved profile fixes sensor type, physical unit, ordered channels,
window duration, operating/installation context in its `profile_id`, feature
mode, target SPS, allowed source SPS range, and frequency bands. The source
window carries its **measured** SPS. Within the profile's range, the existing
`resample_poly` extractor anti-aliases/downsamples to the target SPS. Input
below target SPS, nonuniform timestamps, changed units/channel order/profile,
or unsupported rates must not be relabeled or upsampled into a model result.
Use distinct profiles and trained candidates for materially different rate
bands, sensor locations, units, or operating regimes.

The existing 25,600-SPS FEMTO/XJTU RUL candidates cannot score a 10–2,000-SPS
ADS8688 stream. A new 1,000-SPS profile and newly approved, compatible training
data can produce an anomaly candidate. It **cannot** turn normal-only data into
fault labels or actual remaining-life hours. Fault classification requires
expert-labeled examples; RUL training requires verified failure endpoints and
time-to-failure labels from the same relevant asset class and installation
context. Until then, those heads return `unavailable`.

## P0 AI implementation

The AI-only P0 path is implemented in `edge_config.py`, `window_builder.py`,
`normal_data.py`, `activation.py`, and `runtime.py`. It binds a normal-data
candidate to one immutable sensor configuration, rejects incomplete/mixed raw
windows, archives explicitly approved normal data, requires session-separated
training splits, and makes activation an explicit non-overwriting operation.
See [AI_P0_USAGE.md](AI_P0_USAGE.md) for the exact caller contract. Network
transport and backend configuration delivery remain outside this module.

## Candidate workflow

1. Register DAQ UUID and sensors in the dashboard. Confirm actual SPS, sensor
   type, physical unit, channel order, calibration, attachment position, and
   operating regime. Preserve these as versioned profile/installation metadata.
2. Convert raw batches into finite, uniformly sampled NPZ windows with keys
   `samples`, `sampling_rate_hz`, `sensor_type`, `unit`, `channels`, and
   `profile_id`; optional `timestamps` are seconds on the same time base.
3. Split approved normal windows by session into train/calibration/test and
   run `anomaly.py train --profile ... --manifest ... --output-dir ...`.
   Independently run `fault.py train` only with expert fault labels and
   `rul.py train` only with run-to-failure labels. Never overwrite an active
   model directory; evaluate and activate candidates separately.
4. Run `predictive.py --manifest ...` for one or more registered sensors. The
   manifest selects model directories independently for each sensor. Reuse
   loaded scorers in a continuous stream rather than reloading for every
   window. Do not combine unequal profiles into a single sensor result.
5. A separate transport adapter adds the existing `daqUuid`, registered
   `equipment_id`, sensor ID/channel mapping, stable `frameId`, and timestamp,
   then POSTs to `/api/edge/predictions`. On retry keep the same frame ID and
   original timestamp. The model does not invent backend identities.

## What is still needed for a field-ready deployment

- Backend: accept `pressure` as a sensor type; expose revisioned sensor
  calibration/units/position/rate/model-activation metadata to the edge;
  approve datasets and candidate activation/rollback; retain provenance in
  predictions. Current DAQ UUID and registered sensor ID/channel can be reused.
- Edge bridge: connect the existing collector's actual raw stream to
  per-sensor calibration, gap-aware window buffers, profile selection,
  long-running scorer instances, durable outbound queue, and HTTP transport.
- Evaluation: test normal false-alarm rate on held-out sessions/assets,
  labeled-fault classification per class, and RUL against held-out failure
  histories and a simple baseline. Validate each rate band and attachment
  position separately. Synthetic windows are software smoke tests only.

Photos can document installation and help a human assign an attachment-position
category; a photo alone does not create a calibrated RUL model. Without
failure histories, a trend-to-threshold *health indicator* may be reported as
such, but not as actual remaining useful life in hours.
