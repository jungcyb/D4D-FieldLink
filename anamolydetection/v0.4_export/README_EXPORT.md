# FieldLink v0.4 edge-AI source export

This archive is a self-contained v0.4 **source snapshot**. v0.3/v0.3.1 added
experimental RUL candidates, but the hackathon lacks the compatible field
failure histories, verified end-of-life labels, and installation-matched data
needed to make an honest remaining-useful-life prediction. v0.4 therefore
focuses the hackathon delivery on normal-data-based anomaly detection.

The delivered path is: bind one explicit sensor configuration, collect and
approve normal windows, keep train/calibration/test sessions separate, train
an anomaly candidate, activate it explicitly, and run continuous local anomaly
scoring. Its valid output is an anomaly score/threshold/state--not an invented
fault class or remaining-life hours.

The archive also preserves optional fault/RUL source code for future work, but
does not include or imply a field-ready fault/RUL model. It includes explicit
sensor configuration/profile checks, approved-normal-data archive, candidate
activation, and long-lived local anomaly runtime.

## Deliberately excluded

No trained model weights, raw data, approval records, calibration values,
backend credentials, `.venv`, or CUDA packages are included. In particular,
this export does not establish field readiness or provide a working fault/RUL
model. A model can only be trained and activated from compatible approved data.

## Windows / PowerShell

```powershell
python .\verify_bundle.py
python -m venv .venv
& .\.venv\Scripts\python.exe -m pip install -r .\requirements-train.txt
```

For the caller contract, read `AI_P0_USAGE.md`; for limitations and profiles,
read `README.md`. The `requirements-edge.txt` file is for edge inference
environments. Install packages appropriate to the target platform; do not
assume CUDA support.

`verify_bundle.py` validates archive contents after extraction. The adjacent
`.sha256` file validates the ZIP itself. Neither is a publisher signature.
