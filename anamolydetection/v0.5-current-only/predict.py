"""Research-only single-current-channel CSV scorer (2,000 samples at 2,000 Hz)."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

import joblib
import numpy as np

try:
    from features import extract_features
except ModuleNotFoundError:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from features import extract_features


def predict(model_dir: Path, phase: str, csv_path: Path) -> dict:
    if phase not in {"current_1", "current_2", "current_3"}:
        raise ValueError("Choose current_1, current_2, or current_3")
    metadata = json.loads((model_dir / f"{phase}.json").read_text(encoding="utf-8"))
    samples = np.loadtxt(csv_path, delimiter=",", ndmin=1)
    if samples.shape != (2000,) or not np.isfinite(samples).all():
        raise ValueError("Expected one CSV column of exactly 2,000 finite current samples")
    features = extract_features(samples, 2000, [(0, 250), (250, 500), (500, 1000)])
    x = np.array([[features[key.split("__", 1)[1]] for key in metadata["features"]]], dtype=np.float32)
    model = joblib.load(model_dir / f"{phase}.joblib")
    anomaly_score = float(-model.score_samples(x)[0])
    return {"phase": phase, "anomaly_score": anomaly_score,
            "threshold": metadata["threshold"], "alert": anomaly_score > metadata["threshold"],
            "status": "research_only_not_field_validated"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--phase", choices=["current_1", "current_2", "current_3"], required=True)
    parser.add_argument("--csv", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(predict(args.model_dir, args.phase, args.csv), indent=2))
