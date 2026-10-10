"""Edge-local normal-only training and scoring; approval, logs and ranges belong to backend."""

from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import random
import tempfile

import joblib
import numpy as np
import sklearn
from sklearn.ensemble import IsolationForest

from anomaly_features import FEATURE_EXTRACTOR_VERSION, extract_window, feature_names, load_profile, load_window


def _json_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def load_manifest(path, profile):
    path = Path(path)
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("profile_id") != profile["profile_id"] or not isinstance(manifest.get("approval_id"), str) or not manifest["approval_id"]:
        raise ValueError("Manifest must identify matching profile_id and backend approval_id")
    if manifest.get("data_label") != "normal":
        raise ValueError("Only explicitly normal-approved data can train this model")
    expected_config_hash = profile.get("sensor_configuration_hash")
    if expected_config_hash is not None and manifest.get("sensor_configuration_hash") != expected_config_hash:
        raise ValueError("Manifest sensor configuration does not match the profile")
    splits, all_paths, group_sets = {}, set(), {}
    for name in ("train", "calibration", "test"):
        entries = manifest.get(name)
        if not isinstance(entries, list) or not entries:
            raise ValueError(f"Manifest needs nonempty {name} list")
        resolved, groups = [], set()
        for item in entries:
            if not isinstance(item, dict) or not isinstance(item.get("path"), str) or not isinstance(item.get("session_id"), str) or not item["session_id"]:
                raise ValueError(f"{name} entries need path and session_id")
            file = (path.parent / item["path"]).resolve()
            if file in all_paths:
                raise ValueError(f"Duplicate window across splits: {file}")
            if not file.is_file() or file.suffix.lower() != ".npz":
                raise ValueError(f"Missing NPZ window: {file}")
            all_paths.add(file)
            groups.add(item["session_id"])
            resolved.append(file)
        splits[name] = resolved
        group_sets[name] = groups
    if any(group_sets[a] & group_sets[b] for a, b in (("train", "calibration"), ("train", "test"), ("calibration", "test"))):
        raise ValueError("session_id leakage across train/calibration/test")
    return manifest, splits


def _select(files, limit, rng):
    if limit < 1:
        raise ValueError("max_windows_per_split must be positive")
    if len(files) <= limit:
        return files
    return [files[i] for i in sorted(rng.sample(range(len(files)), limit))]


def _matrix(files, profile, columns):
    rows = []
    for file in files:
        samples, fs, timestamps = load_window(file, profile)
        features = extract_window(samples, fs, profile, timestamps)
        rows.append([features[name] for name in columns])
    return np.asarray(rows, dtype=np.float32)


def train(profile_path, manifest_path, output_dir, *, max_windows_per_split=5000, n_estimators=64, target_window_fpr=0.01, seed=42):
    """Create an inactive candidate; backend decides whether/when to activate it."""
    profile = load_profile(profile_path)
    manifest, splits = load_manifest(manifest_path, profile)
    if not 0 < target_window_fpr < 1 or n_estimators < 1:
        raise ValueError("Invalid target_window_fpr or n_estimators")
    output = Path(output_dir).resolve()
    if output.exists():
        raise FileExistsError(f"Candidate output already exists: {output}")
    rng = random.Random(seed)
    selected = {name: _select(files, max_windows_per_split, rng) for name, files in splits.items()}
    minimums = {"train": 20, "calibration": 20, "test": 20}
    for name, minimum in minimums.items():
        if len(selected[name]) < minimum:
            raise ValueError(f"At least {minimum} normal {name} windows are required")
    columns = feature_names(profile)
    matrices = {name: _matrix(files, profile, columns) for name, files in selected.items()}
    model = IsolationForest(n_estimators=n_estimators, max_samples=min(256, len(matrices["train"])), contamination="auto", n_jobs=1, random_state=seed)
    model.fit(matrices["train"])
    calibration_scores = -model.score_samples(matrices["calibration"])
    test_scores = -model.score_samples(matrices["test"])
    threshold = float(np.quantile(calibration_scores, 1 - target_window_fpr))
    test_alerts = test_scores > threshold
    metrics = {
        "normal_only": True,
        "normal_test_windows": len(test_scores),
        "test_false_alert_windows": int(test_alerts.sum()),
        "test_window_false_alert_rate": float(test_alerts.mean()),
        "target_window_false_alert_rate": target_window_fpr,
        "calibration_score_quantiles": {str(q): float(np.quantile(calibration_scores, q)) for q in (0, 0.5, 0.9, 0.99, 1)},
        "test_score_quantiles": {str(q): float(np.quantile(test_scores, q)) for q in (0, 0.5, 0.9, 0.99, 1)},
        "note": "Normal-only test: fault recall/precision and event-level false alarms are not measured.",
    }
    metadata = {
        "model_type": "isolation_forest",
        "model_version": output.name,
        "status": "candidate",
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "approval_id": manifest["approval_id"],
        "profile_id": profile["profile_id"],
        "profile_sha256": _json_hash(profile),
        "feature_extractor_version": FEATURE_EXTRACTOR_VERSION,
        "feature_columns": columns,
        "threshold": threshold,
        "score_direction": "higher_is_more_anomalous",
        "input_counts": {name: len(files) for name, files in splits.items()},
        "sampled_counts": {name: len(files) for name, files in selected.items()},
        "sklearn_version": sklearn.__version__,
        "numpy_version": np.__version__,
        "seed": seed,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{output.name}-", dir=output.parent) as temporary:
        temp = Path(temporary)
        joblib.dump(model, temp / "model.joblib")
        for name, value in (("profile.json", profile), ("metadata.json", metadata), ("metrics.json", metrics)):
            (temp / name).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
        with (temp / "normal_test_scores.csv").open("w", newline="", encoding="utf-8") as stream:
            writer = csv.writer(stream)
            writer.writerow(["source_file", "anomaly_score", "threshold", "is_anomaly"])
            for file, score, alert in zip(selected["test"], test_scores, test_alerts):
                writer.writerow([str(file), float(score), threshold, bool(alert)])
        if output.exists():
            raise FileExistsError(f"Candidate output already exists: {output}")
        temp.rename(output)
    return metadata, metrics


class AnomalyScorer:
    """Load once and reuse for every streaming window."""

    def __init__(self, model_dir):
        model_dir = Path(model_dir)
        self.metadata = json.loads((model_dir / "metadata.json").read_text(encoding="utf-8"))
        self.profile = load_profile(model_dir / "profile.json")
        if self.metadata["sklearn_version"] != sklearn.__version__ or self.metadata["numpy_version"] != np.__version__:
            raise RuntimeError("Model runtime versions differ; retrain on this edge environment")
        if self.metadata["feature_extractor_version"] != FEATURE_EXTRACTOR_VERSION or self.metadata["profile_sha256"] != _json_hash(self.profile) or self.metadata["feature_columns"] != feature_names(self.profile):
            raise ValueError("Model and feature profile mismatch")
        self.model = joblib.load(model_dir / "model.joblib")  # Trusted edge-local artifact only.

    def score(self, samples, sampling_rate_hz, timestamps=None):
        features = extract_window(samples, sampling_rate_hz, self.profile, timestamps)
        vector = np.asarray([[features[name] for name in self.metadata["feature_columns"]]], dtype=np.float32)
        anomaly_score = float(-self.model.score_samples(vector)[0])
        threshold = float(self.metadata["threshold"])
        return {"status": "ok", "profile_id": self.profile["profile_id"], "model_version": self.metadata["model_version"], "anomaly_score": anomaly_score, "threshold": threshold, "is_anomaly": bool(anomaly_score > threshold)}


def score(model_dir, samples, sampling_rate_hz, timestamps=None):
    return AnomalyScorer(model_dir).score(samples, sampling_rate_hz, timestamps)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    fit = commands.add_parser("train", help="Create an inactive candidate from backend-approved normal windows")
    fit.add_argument("--profile", type=Path, required=True)
    fit.add_argument("--manifest", type=Path, required=True)
    fit.add_argument("--output-dir", type=Path, required=True)
    fit.add_argument("--max-windows-per-split", type=int, default=5000)
    fit.add_argument("--n-estimators", type=int, default=64)
    fit.add_argument("--target-window-fpr", type=float, default=0.01)
    fit.add_argument("--seed", type=int, default=42)
    predict = commands.add_parser("score", help="Score one NPZ waveform window")
    predict.add_argument("--model-dir", type=Path, required=True)
    predict.add_argument("--input-npz", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "train":
        metadata, metrics = train(args.profile, args.manifest, args.output_dir, max_windows_per_split=args.max_windows_per_split, n_estimators=args.n_estimators, target_window_fpr=args.target_window_fpr, seed=args.seed)
        print(json.dumps({"candidate": str(args.output_dir), "metadata": metadata, "metrics": metrics}, ensure_ascii=False, indent=2))
    else:
        scorer = AnomalyScorer(args.model_dir)
        samples, fs, timestamps = load_window(args.input_npz, scorer.profile)
        print(json.dumps(scorer.score(samples, fs, timestamps), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
