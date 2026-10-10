"""Train and evaluate one-channel current-only Isolation Forest candidates.

The holdout is motor-disjoint. Fault labels select a configuration on validation
motors only; model fitting and threshold calibration use normal rows only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.metrics import roc_auc_score

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "outputs/aihub/current_train_2000/features.parquet"
PHASES = ("current_1", "current_2", "current_3")
FEATURE_SETS = {
    "all": ("mean", "std", "rms", "peak_to_peak", "crest_factor", "skewness", "kurtosis",
            "dominant_frequency_hz", "spectral_centroid_hz", "spectral_entropy",
            "band_0_relative_energy", "band_1_relative_energy", "band_2_relative_energy"),
    "shape_spectrum": ("crest_factor", "skewness", "kurtosis", "dominant_frequency_hz",
                       "spectral_centroid_hz", "spectral_entropy", "band_0_relative_energy",
                       "band_1_relative_energy", "band_2_relative_energy"),
    "amplitude_spectrum": ("std", "rms", "peak_to_peak", "dominant_frequency_hz",
                           "spectral_centroid_hz", "spectral_entropy", "band_0_relative_energy",
                           "band_1_relative_energy", "band_2_relative_energy"),
}


def split(frame):
    motors = np.array(sorted(frame.motor_id.unique()))
    if len(motors) < 20:
        raise ValueError("Need at least 20 motors for disjoint evaluation")
    np.random.default_rng(42).shuffle(motors)
    groups = {"train": motors[:16], "calibration": motors[16:22],
              "validation": motors[22:26], "test": motors[26:]}
    parts = {name: frame[frame.motor_id.isin(ids)].copy() for name, ids in groups.items()}
    if min((part.label == 0).sum() for part in parts.values()) < 20:
        raise ValueError("Each split needs at least 20 normal recordings")
    return parts


def fit(normal, columns, trees, max_samples):
    x = normal[columns].to_numpy(dtype=np.float32)
    return IsolationForest(n_estimators=trees, max_samples=min(max_samples, len(x)),
                           contamination="auto", random_state=42, n_jobs=1).fit(x)


def score(model, frame, columns):
    return -model.score_samples(frame[columns].to_numpy(dtype=np.float32))


def evaluate(scores, labels, threshold):
    alert = scores > threshold
    normal, fault = labels == 0, labels != 0
    return {"normal_rows": int(normal.sum()), "fault_rows": int(fault.sum()),
            "false_alerts": int((alert & normal).sum()), "detected_fault_rows": int((alert & fault).sum()),
            "false_alert_rate": float(alert[normal].mean()), "fault_recall": float(alert[fault].mean()),
            "roc_auc": float(roc_auc_score(fault, scores)),
            "by_fault_label_recall": {str(i): float(alert[labels == i].mean())
                                      for i in sorted(set(labels)) if i != 0}}


def run(data: Path, output: Path):
    data, output = data.resolve(), output.resolve()
    if output.exists():
        raise FileExistsError(f"Refusing to overwrite {output}")
    frame = pd.read_parquet(data)
    required = {"label", "motor_id", "session_id", "source_file"}
    if not required.issubset(frame):
        raise ValueError("Missing provenance columns")
    parts = split(frame)
    for part in parts.values():
        if not np.isfinite(part.select_dtypes(include="number").to_numpy()).all():
            raise ValueError("Nonfinite input")
    train = parts["train"].query("label == 0")
    cal = parts["calibration"].query("label == 0")
    candidates = []
    for feature_set, names in FEATURE_SETS.items():
        for trees, max_samples in ((64, 256), (128, 256), (128, 512)):
            aucs = []
            for phase in PHASES:
                cols = [f"{phase}__{name}" for name in names]
                model = fit(train, cols, trees, max_samples)
                val = parts["validation"]
                aucs.append(float(roc_auc_score(val.label.ne(0), score(model, val, cols))))
            candidates.append({"feature_set": feature_set, "trees": trees,
                               "max_samples": max_samples, "validation_auc_by_channel": aucs,
                               "mean_validation_auc": float(np.mean(aucs))})
    winner = max(candidates, key=lambda item: (item["mean_validation_auc"], -item["trees"]))
    output.mkdir(parents=True)
    channel_metrics = {}
    for phase in PHASES:
        cols = [f"{phase}__{name}" for name in FEATURE_SETS[winner["feature_set"]]]
        model = fit(train, cols, winner["trees"], winner["max_samples"])
        threshold = float(np.quantile(score(model, cal, cols), .95))
        test = parts["test"]
        test_scores = score(model, test, cols)
        metadata = {"phase": phase, "features": cols, "threshold": threshold,
                    "source_sample_rate_hz": 2000, "window_seconds": 1,
                    "source_units_verified": False, "model_kind": "IsolationForest",
                    "score_convention": "-score_samples; alert if score > threshold"}
        joblib.dump(model, output / f"{phase}.joblib")
        (output / f"{phase}.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
        channel_metrics[phase] = evaluate(test_scores, test.label.to_numpy(), threshold)
        if phase == PHASES[0]:
            predictions = test[["motor_id", "session_id", "source_file", "label"]].copy()
        predictions[f"{phase}_score"] = test_scores
        predictions[f"{phase}_alert"] = test_scores > threshold
    predictions.to_csv(output / "test_predictions.csv", index=False)
    report = {"version": "v0.5-current-only-experimental", "data_sha256": hashlib.sha256(data.read_bytes()).hexdigest(),
              "selection": "maximum mean validation ROC AUC across three one-channel candidates",
              "threshold": "95th percentile of independent normal-only calibration motors",
              "seed": 42, "candidate_search": candidates, "selected": winner,
              "splits": {name: {"motors": sorted(part.motor_id.unique().tolist()), "rows": len(part),
                                "normal": int(part.label.eq(0).sum())} for name, part in parts.items()},
              "test": channel_metrics}
    (output / "results.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=DATA)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = run(args.data, args.output)
    print(json.dumps({"selected": result["selected"], "test": result["test"]}, indent=2))
