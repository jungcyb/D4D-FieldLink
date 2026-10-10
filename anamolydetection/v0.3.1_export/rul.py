"""Optional supervised RUL candidate: requires verified run-to-failure labels, not normal-only data.

This estimator is conditional on the equipment and operating conditions represented
in training. It is not a guaranteed lifetime or a calibrated confidence interval.
Approval authentication, candidate activation and rollback belong to the backend.
"""

from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import json
from pathlib import Path
import random
import sys
import tempfile
from time import perf_counter
from itertools import combinations

import joblib
import numpy as np
import sklearn
from sklearn.ensemble import RandomForestRegressor

from anomaly import _json_hash, _matrix, _select
from anomaly_features import FEATURE_EXTRACTOR_VERSION, extract_window, feature_names, load_profile, load_window


def load_manifest(path, profile):
    """Validate explicit end-of-life evidence and asset-disjoint evaluation."""
    path = Path(path)
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("profile_id") != profile["profile_id"] or not isinstance(manifest.get("approval_id"), str) or not manifest["approval_id"].strip():
        raise ValueError("Manifest needs matching profile_id and backend approval_id")
    if manifest.get("data_label") != "run_to_failure" or manifest.get("failure_evidence") is not True:
        raise ValueError("RUL requires run_to_failure labels and failure_evidence=true; normal-only data cannot train RUL")
    splits, paths, assets, sessions = {}, set(), {}, {}
    split_names = ("train", "validation", "test") if "validation" in manifest else ("train", "test")
    for split in split_names:
        entries = manifest.get(split)
        if not isinstance(entries, list) or len(entries) < 20:
            raise ValueError(f"At least 20 {split} windows are required")
        resolved, assets[split], sessions[split] = [], set(), set()
        for entry in entries:
            if not isinstance(entry, dict) or not all(isinstance(entry.get(key), str) and entry[key].strip() for key in ("path", "asset_id", "session_id")):
                raise ValueError("RUL entries need nonempty path, asset_id and session_id")
            label = entry.get("remaining_useful_life_hours")
            if isinstance(label, bool) or not isinstance(label, (int, float)) or not np.isfinite(label) or label < 0:
                raise ValueError("remaining_useful_life_hours must be finite and nonnegative")
            file = (path.parent / entry["path"]).resolve()
            if file in paths:
                raise ValueError(f"Duplicate window across splits: {file}")
            if not file.is_file() or file.suffix.lower() != ".npz":
                raise ValueError(f"Missing NPZ window: {file}")
            paths.add(file)
            assets[split].add(entry["asset_id"])
            sessions[split].add(entry["session_id"])
            resolved.append({**entry, "path": file})
        if len(assets[split]) < 2:
            raise ValueError(f"At least 2 assets per {split} split are required")
        splits[split] = resolved
    for first, second in combinations(split_names, 2):
        if assets[first] & assets[second]:
            raise ValueError(f"asset_id leakage across {first}/{second}")
        if sessions[first] & sessions[second]:
            raise ValueError(f"session_id leakage across {first}/{second}; use globally unique session identifiers")
    return manifest, splits


def _errors(actual, prediction):
    difference = np.asarray(actual, dtype=np.float64) - prediction
    return {"mae_hours": float(np.mean(np.abs(difference))), "rmse_hours": float(np.sqrt(np.mean(difference ** 2)))}


def _evaluate(entries, actual, predicted, baseline, split, prediction_seconds):
    per_asset = []
    for asset in sorted({entry["asset_id"] for entry in entries}):
        mask = np.asarray([entry["asset_id"] == asset for entry in entries])
        per_asset.append({"asset_id": asset, "windows": int(mask.sum()),
                          **_errors(actual[mask], predicted[mask]),
                          "baseline_mae_hours": _errors(actual[mask], baseline)["mae_hours"]})
    return {
        f"{split}_windows": len(predicted), **_errors(actual, predicted),
        "baseline_train_mean_hours": baseline, "baseline": _errors(actual, baseline),
        "asset_macro_mae_hours": float(np.mean([row["mae_hours"] for row in per_asset])),
        "per_asset": per_asset,
        "batch_prediction_seconds": prediction_seconds,
        "batch_prediction_ms_per_window": prediction_seconds * 1000 / len(predicted),
        "timing_note": "Batch model prediction only; excludes NPZ loading and feature extraction, not edge single-window latency.",
        "note": "Held-out assets only; no calibrated uncertainty or proof of applicability to other equipment/operating conditions.",
    }


def _save_evaluation(directory, split, entries, actual, predicted, metrics):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    (directory / f"metrics_{split}.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    with (directory / f"rul_{split}_predictions.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(["source_file", "asset_id", "session_id", "actual_rul_hours", "estimated_rul_hours"])
        for entry, label, estimate in zip(entries, actual, predicted):
            writer.writerow([str(entry["path"]), entry["asset_id"], entry["session_id"], float(label), float(estimate)])
    with (directory / f"rul_{split}_asset_metrics.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(metrics["per_asset"][0]))
        writer.writeheader()
        writer.writerows(metrics["per_asset"])
    plots = directory / "plots" / split
    plots.mkdir(parents=True)
    fig, ax = plt.subplots(figsize=(6, 5))
    ax.scatter(actual, predicted, s=6, alpha=.35)
    upper = max(float(actual.max()), float(predicted.max()))
    ax.plot([0, upper], [0, upper], "k--", label="Perfect prediction")
    ax.set(xlabel="Actual RUL (hours)", ylabel="Estimated RUL (hours)", title=f"{split}: held-out bearings")
    ax.legend()
    fig.tight_layout()
    fig.savefig(plots / "actual_vs_predicted.png", dpi=140)
    plt.close(fig)
    for index, asset in enumerate(sorted({entry["asset_id"] for entry in entries})):
        mask = np.asarray([entry["asset_id"] == asset for entry in entries])
        labels, estimates = actual[mask], predicted[mask]
        order = np.argsort(-labels, kind="stable")
        labels, estimates = labels[order], estimates[order]
        elapsed = labels.max() - labels
        fig, ax = plt.subplots(figsize=(8, 4))
        ax.plot(elapsed, labels, label="Actual")
        ax.plot(elapsed, estimates, label="Estimated", alpha=.8)
        ax.set(xlabel="Elapsed from first evaluated window (hours)", ylabel="RUL (hours)", title=f"{split}: {asset}")
        ax.legend()
        fig.tight_layout()
        # Numeric filenames prevent untrusted asset identifiers becoming paths.
        fig.savefig(plots / f"asset_{index:03d}.png", dpi=140)
        plt.close(fig)


def train(profile_path, manifest_path, output_dir, *, max_windows_per_split=5000, n_estimators=64, seed=42):
    """Create an inactive candidate atomically; never modify an existing model."""
    if isinstance(n_estimators, bool) or not isinstance(n_estimators, int) or not 1 <= n_estimators <= 256:
        raise ValueError("n_estimators must be an integer between 1 and 256")
    if isinstance(max_windows_per_split, bool) or not isinstance(max_windows_per_split, int) or not 20 <= max_windows_per_split <= 50000:
        raise ValueError("max_windows_per_split must be between 20 and 50000")
    profile = load_profile(profile_path)
    manifest, splits = load_manifest(manifest_path, profile)
    output = Path(output_dir).resolve()
    if output.exists():
        raise FileExistsError(f"Candidate output already exists: {output}")
    rng = random.Random(seed)
    selected = {name: _select(entries, max_windows_per_split, rng) for name, entries in splits.items()}
    for name, entries in selected.items():
        if len({entry["asset_id"] for entry in entries}) < 2:
            raise ValueError(f"Sampling retained fewer than 2 {name} assets; revise manifest or sampling cap")
    columns = feature_names(profile)
    matrices = {}
    for name, entries in selected.items():
        print(f"Extracting {name} features: {len(entries)} windows", file=sys.stderr, flush=True)
        matrices[name] = _matrix([entry["path"] for entry in entries], profile, columns)
        print(f"Finished {name} features", file=sys.stderr, flush=True)
    labels = {name: np.asarray([entry["remaining_useful_life_hours"] for entry in entries], dtype=np.float64) for name, entries in selected.items()}
    if np.ptp(labels["train"]) <= 0:
        raise ValueError("Training requires varying run-to-failure RUL labels")
    model = RandomForestRegressor(n_estimators=n_estimators, max_depth=8, min_samples_leaf=2, n_jobs=1, random_state=seed)
    fit_started = perf_counter()
    model.fit(matrices["train"], labels["train"])
    fit_seconds = perf_counter() - fit_started
    baseline = float(np.mean(labels["train"]))
    predictions, evaluations = {}, {}
    for name in selected:
        if name == "train":
            continue
        started = perf_counter()
        predictions[name] = model.predict(matrices[name])
        elapsed = perf_counter() - started
        evaluations[name] = _evaluate(selected[name], labels[name], predictions[name], baseline, name, elapsed)
    # Preserve the historical return value and metrics.json as final-test metrics.
    metrics = evaluations["test"]
    metadata = {
        "model_type": "random_forest_rul", "model_version": output.name,
        "status": "candidate", "created_utc": datetime.now(timezone.utc).isoformat(),
        "approval_id": manifest["approval_id"], "profile_id": profile["profile_id"],
        "profile_sha256": _json_hash(profile), "feature_extractor_version": FEATURE_EXTRACTOR_VERSION,
        "feature_columns": columns, "sklearn_version": sklearn.__version__, "numpy_version": np.__version__,
        "label_unit": "hours", "failure_evidence": True, "data_label": "run_to_failure",
        "input_counts": {name: len(entries) for name, entries in splits.items()},
        "sampled_counts": {name: len(entries) for name, entries in selected.items()},
        "asset_counts": {name: len({entry["asset_id"] for entry in entries}) for name, entries in selected.items()},
        "training_label_range_hours": [float(labels["train"].min()), float(labels["train"].max())],
        "seed": seed, "training_seconds": fit_seconds,
        "manifest_sha256": _json_hash(manifest),
        "label_definition": manifest.get("label_definition", "Verified dataset remaining useful life in hours"),
        "label_source": manifest.get("label_source"),
        "excluded_assets": manifest.get("excluded_assets", {}),
        "selection_policy": "Fixed hyperparameters; fit train only; validation and test never used for fitting or selection.",
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{output.name}-", dir=output.parent) as temporary:
        temp = Path(temporary)
        joblib.dump(model, temp / "model.joblib")
        metadata["model_size_bytes"] = (temp / "model.joblib").stat().st_size
        for name, value in (("profile.json", profile), ("metadata.json", metadata), ("metrics.json", metrics)):
            (temp / name).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
        for name, evaluation in evaluations.items():
            _save_evaluation(temp, name, selected[name], labels[name], predictions[name], evaluation)
        if output.exists():
            raise FileExistsError(f"Candidate output already exists: {output}")
        temp.rename(output)
    return metadata, metrics


class RULScorer:
    """Load once, only from trusted edge-local joblib artifacts."""

    def __init__(self, model_dir):
        model_dir = Path(model_dir)
        self.metadata = json.loads((model_dir / "metadata.json").read_text(encoding="utf-8"))
        self.profile = load_profile(model_dir / "profile.json")
        if self.metadata.get("model_type") != "random_forest_rul" or self.metadata.get("failure_evidence") is not True or self.metadata.get("label_unit") != "hours":
            raise ValueError("Not a verified run-to-failure RUL model")
        if self.metadata["sklearn_version"] != sklearn.__version__ or self.metadata["numpy_version"] != np.__version__:
            raise RuntimeError("Model runtime versions differ; retrain on this edge environment")
        if self.metadata["feature_extractor_version"] != FEATURE_EXTRACTOR_VERSION or self.metadata["profile_sha256"] != _json_hash(self.profile) or self.metadata["feature_columns"] != feature_names(self.profile):
            raise ValueError("Model and feature profile mismatch")
        self.model = joblib.load(model_dir / "model.joblib")
        if not isinstance(self.model, RandomForestRegressor):
            raise ValueError("Artifact is not a RandomForestRegressor")

    def score(self, samples, sampling_rate_hz, timestamps=None):
        features = extract_window(samples, sampling_rate_hz, self.profile, timestamps)
        vector = np.asarray([[features[name] for name in self.metadata["feature_columns"]]], dtype=np.float32)
        estimate = float(self.model.predict(vector)[0])
        if not np.isfinite(estimate) or estimate < 0:
            raise ValueError("Invalid RUL prediction")
        return {
            "status": "available", "profile_id": self.profile["profile_id"],
            "model_version": self.metadata["model_version"], "estimated_rul_hours": estimate,
            "label_definition": self.metadata.get("label_definition", "Verified dataset remaining useful life in hours"),
            "uncertainty_status": "not_calibrated", "prediction_interval_hours": None,
            "note": "Conditional run-to-failure estimate, not guaranteed lifetime; only for training-equivalent equipment and operating conditions.",
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    fit = commands.add_parser("train", help="Create inactive RUL candidate using approved run-to-failure labels")
    fit.add_argument("--profile", type=Path, required=True)
    fit.add_argument("--manifest", type=Path, required=True)
    fit.add_argument("--output-dir", type=Path, required=True)
    fit.add_argument("--max-windows-per-split", type=int, default=5000)
    fit.add_argument("--n-estimators", type=int, default=64)
    fit.add_argument("--seed", type=int, default=42)
    predict = commands.add_parser("score", help="Score one NPZ waveform window with an optional verified RUL model")
    predict.add_argument("--model-dir", type=Path, required=True)
    predict.add_argument("--input-npz", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "train":
        metadata, metrics = train(args.profile, args.manifest, args.output_dir, max_windows_per_split=args.max_windows_per_split, n_estimators=args.n_estimators, seed=args.seed)
        print(json.dumps({"candidate": str(args.output_dir), "metadata": metadata, "metrics": metrics}, ensure_ascii=False, indent=2, allow_nan=False))
    else:
        scorer = RULScorer(args.model_dir)
        samples, fs, timestamps = load_window(args.input_npz, scorer.profile)
        print(json.dumps(scorer.score(samples, fs, timestamps), ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
