# v0.3.1 experimental candidate export

Release v0.3.1 packages the v0.3.1 snapshot derived from v0.3, including the new XJTU-SY adapter;
it is not a separately trained v0.3.1 classifier.
XJTU-SY is a separate RUL candidate, not merged with FEMTO: profiles are incompatible.
The FEMTO weights are existing v0.3 artifacts, not retrained by this export.
No trained anomaly detector or fault classifier is included. Integrated predictive.py
inference needs separately trained, compatible components; use rul.py directly here.

## Recorded evaluation (not field approval)
- xjtu_rul_v1: validation MAE 8.124376 h vs baseline 7.553238 h; held-out test MAE 6.030350 h vs baseline 13.755381 h.
- femto_rul_v1: validation MAE 2.069990 h vs baseline 1.509804 h; held-out test MAE 1.956012 h vs baseline 1.687890 h.

These are recorded held-out experimental bearing results, not guaranteed equipment
lifetime. Export validates metric structure/counts and runs synthetic inference;
it does not recompute accuracy from raw data. Synthetic examples are NOT accuracy tests.
The XJTU validation MAE is worse than its simple baseline even though its test MAE is better;
do not present test-only improvement as stable generalization or field readiness.
No calibrated uncertainty, board latency, or field applicability is established.
XJTU uses 25.6 kHz, 1.28 s, two axes, source_native_unverified amplitude units;
FEMTO uses 25.6 kHz, 0.1 s, two axes, native g. Do not substitute low-rate IMU data.

Raw datasets, full caches, prediction CSVs, .venv and CUDA are excluded.
Load joblib artifacts only from trusted sources; SHA256 is integrity, not authentication.

## Windows / PowerShell (inside extracted v0.3.1_export)
```powershell
python .\verify_bundle.py
python -m venv .venv
& .\.venv\Scripts\python.exe -m pip install --only-binary=:all: -r .\requirements-runtime.lock.txt
& .\.venv\Scripts\python.exe .\rul.py score --model-dir .\models\xjtu_rul_v1 --input-npz .\examples\synthetic_xjtu_rul_v1.npz
& .\.venv\Scripts\python.exe .\rul.py score --model-dir .\models\femto_rul_v1 --input-npz .\examples\synthetic_femto_rul_v1.npz
```
