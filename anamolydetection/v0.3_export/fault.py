"""Optional supervised fault classification; requires expert-labelled fault windows."""

from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import json
from pathlib import Path
import random
import tempfile

import joblib
import numpy as np
import sklearn
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, f1_score

from anomaly import _json_hash, _matrix
from anomaly_features import FEATURE_EXTRACTOR_VERSION, extract_window, feature_names, load_profile, load_window


def load_manifest(path, profile):
    """Validate asset-level separation before selecting any training windows."""
    path = Path(path)
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("profile_id") != profile["profile_id"] or not isinstance(manifest.get("approval_id"), str) or not manifest["approval_id"].strip():
        raise ValueError("Manifest requires matching profile_id and backend approval_id")
    splits, paths, assets = {}, set(), {}
    for name in ("train", "test"):
        entries = manifest.get(name)
        if not isinstance(entries, list) or len(entries) < 20:
            raise ValueError(f"At least 20 labelled {name} windows are required")
        resolved, assets[name] = [], set()
        for entry in entries:
            if not isinstance(entry, dict) or any(not isinstance(entry.get(key), str) or not entry[key].strip() for key in ("path", "session_id", "asset_id", "label")):
                raise ValueError(f"{name} entries require path, session_id, asset_id and string label")
            file = (path.parent / entry["path"]).resolve()
            if file in paths:
                raise ValueError(f"Duplicate window across splits: {file}")
            if not file.is_file() or file.suffix.lower() != ".npz":
                raise ValueError(f"Missing NPZ window: {file}")
            paths.add(file)
            assets[name].add(entry["asset_id"])
            resolved.append({**entry, "path": file})
        splits[name] = resolved
    if assets["train"] & assets["test"]:
        raise ValueError("asset_id leakage across train/test")
    train_classes = {entry["label"] for entry in splits["train"]}
    test_classes = {entry["label"] for entry in splits["test"]}
    if len(train_classes) < 2:
        raise ValueError("Optional classifier requires at least two training classes")
    if not test_classes <= train_classes:
        raise ValueError("Test contains classes absent from training")
    return manifest, splits


def _select(entries, limit, rng):
    """Bound RAM while preserving at least one example of each present class."""
    labels = sorted({entry["label"] for entry in entries})
    if limit < max(20, len(labels)):
        raise ValueError("max_windows_per_split must be >=20 and cover all classes")
    if len(entries) <= limit:
        return entries
    required = {rng.choice([i for i, entry in enumerate(entries) if entry["label"] == label]) for label in labels}
    remaining = sorted(set(range(len(entries))) - required)
    selected = required | set(rng.sample(remaining, limit - len(required)))
    return [entries[i] for i in sorted(selected)]


def train(profile_path, manifest_path, output_dir, *, max_windows_per_split=5000, n_estimators=64, max_depth=8, seed=42):
    """Create an inactive candidate; approval authentication/activation are backend-owned."""
    profile = load_profile(profile_path)
    manifest, splits = load_manifest(manifest_path, profile)
    if n_estimators < 1 or max_depth < 1:
        raise ValueError("n_estimators and max_depth must be positive")
    output = Path(output_dir).resolve()
    if output.exists():
        raise FileExistsError(f"Candidate output already exists: {output}")
    rng = random.Random(seed)
    selected = {name: _select(entries, max_windows_per_split, rng) for name, entries in splits.items()}
    columns = feature_names(profile)
    matrices = {name: _matrix([entry["path"] for entry in entries], profile, columns) for name, entries in selected.items()}
    targets = {name: np.asarray([entry["label"] for entry in entries]) for name, entries in selected.items()}
    model = RandomForestClassifier(n_estimators=n_estimators, max_depth=max_depth, class_weight="balanced", n_jobs=1, random_state=seed)
    model.fit(matrices["train"], targets["train"])
    predicted = model.predict(matrices["test"])
    classes = model.classes_.tolist()
    metrics = {
        "accuracy": float(accuracy_score(targets["test"], predicted)),
        "macro_f1": float(f1_score(targets["test"], predicted, labels=classes, average="macro", zero_division=0)),
        "weighted_f1": float(f1_score(targets["test"], predicted, labels=classes, average="weighted", zero_division=0)),
        "class_order": classes,
        "confusion_matrix": confusion_matrix(targets["test"], predicted, labels=classes).tolist(),
        "classification_report": classification_report(targets["test"], predicted, labels=classes, output_dict=True, zero_division=0),
        "test_support": {label: int(np.sum(targets["test"] == label)) for label in classes},
        "unrepresented_test_classes": sorted(set(classes) - set(targets["test"].tolist())),
        "evaluation_scope": "held_out_assets; closed_set_fault_classification",
        "probabilities_calibrated": False,
        "note": "No future-failure probability or RUL is inferred; test must not tune this candidate.",
    }
    metadata = {
        "model_type": "random_forest_classifier", "model_version": output.name, "status": "candidate",
        "created_utc": datetime.now(timezone.utc).isoformat(), "approval_id": manifest["approval_id"],
        "profile_id": profile["profile_id"], "profile_sha256": _json_hash(profile),
        "feature_extractor_version": FEATURE_EXTRACTOR_VERSION, "feature_columns": columns,
        "classes": classes, "probabilities_calibrated": False,
        "input_counts": {name: len(entries) for name, entries in splits.items()},
        "sampled_counts": {name: len(entries) for name, entries in selected.items()},
        "class_counts": {name: {label: int(np.sum(targets[name] == label)) for label in classes} for name in targets},
        "asset_counts": {name: len({entry["asset_id"] for entry in entries}) for name, entries in splits.items()},
        "sklearn_version": sklearn.__version__, "numpy_version": np.__version__,
        "n_estimators": n_estimators, "max_depth": max_depth, "seed": seed,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{output.name}-", dir=output.parent) as temporary:
        temp = Path(temporary)
        joblib.dump(model, temp / "model.joblib")
        for name, value in (("profile.json", profile), ("metadata.json", metadata), ("metrics.json", metrics)):
            (temp / name).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
        with (temp / "test_predictions.csv").open("w", newline="", encoding="utf-8") as stream:
            writer = csv.writer(stream)
            writer.writerow(["source_file", "asset_id", "session_id", "label", "predicted_class"])
            for entry, prediction in zip(selected["test"], predicted):
                writer.writerow([str(entry["path"]), entry["asset_id"], entry["session_id"], entry["label"], prediction])
        if output.exists():
            raise FileExistsError(f"Candidate output already exists: {output}")
        temp.rename(output)
    return metadata, metrics


class FaultScorer:
    """Load once; closed-set outputs must not be treated as unknown-fault detection."""

    def __init__(self, model_dir):
        model_dir = Path(model_dir)
        self.metadata = json.loads((model_dir / "metadata.json").read_text(encoding="utf-8"))
        self.profile = load_profile(model_dir / "profile.json")
        if self.metadata.get("model_type") != "random_forest_classifier":
            raise ValueError("Not a fault classifier artifact")
        if self.metadata["sklearn_version"] != sklearn.__version__ or self.metadata["numpy_version"] != np.__version__:
            raise RuntimeError("Model runtime versions differ; retrain on this edge environment")
        if self.metadata["feature_extractor_version"] != FEATURE_EXTRACTOR_VERSION or self.metadata["profile_sha256"] != _json_hash(self.profile) or self.metadata["feature_columns"] != feature_names(self.profile):
            raise ValueError("Model and feature profile mismatch")
        self.model = joblib.load(model_dir / "model.joblib")  # Trusted edge-local artifacts only.
        if not isinstance(self.model, RandomForestClassifier) or self.model.classes_.tolist() != self.metadata["classes"] or self.model.n_features_in_ != len(self.metadata["feature_columns"]):
            raise ValueError("Classifier and metadata mismatch")

    def score(self, samples, sampling_rate_hz, timestamps=None):
        features = extract_window(samples, sampling_rate_hz, self.profile, timestamps)
        vector = np.asarray([[features[name] for name in self.metadata["feature_columns"]]], dtype=np.float32)
        probabilities = self.model.predict_proba(vector)[0]
        classes = self.metadata["classes"]
        return {
            "status": "ok", "profile_id": self.profile["profile_id"], "model_version": self.metadata["model_version"],
            "predicted_class": classes[int(np.argmax(probabilities))],
            "probabilities": {label: float(value) for label, value in zip(classes, probabilities)},
            "probabilities_calibrated": False, "scope": "known_training_classes_only",
        }


def score(model_dir, samples, sampling_rate_hz, timestamps=None):
    return FaultScorer(model_dir).score(samples, sampling_rate_hz, timestamps)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    fit = commands.add_parser("train", help="Create candidate from backend-approved labelled windows")
    fit.add_argument("--profile", type=Path, required=True)
    fit.add_argument("--manifest", type=Path, required=True)
    fit.add_argument("--output-dir", type=Path, required=True)
    fit.add_argument("--max-windows-per-split", type=int, default=5000)
    fit.add_argument("--n-estimators", type=int, default=64)
    fit.add_argument("--max-depth", type=int, default=8)
    fit.add_argument("--seed", type=int, default=42)
    predict = commands.add_parser("score")
    predict.add_argument("--model-dir", type=Path, required=True)
    predict.add_argument("--input-npz", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "train":
        metadata, metrics = train(args.profile, args.manifest, args.output_dir, max_windows_per_split=args.max_windows_per_split, n_estimators=args.n_estimators, max_depth=args.max_depth, seed=args.seed)
        print(json.dumps({"candidate": str(args.output_dir), "metadata": metadata, "metrics": metrics}, ensure_ascii=False, indent=2))
    else:
        scorer = FaultScorer(args.model_dir)
        samples, fs, timestamps = load_window(args.input_npz, scorer.profile)
        print(json.dumps(scorer.score(samples, fs, timestamps), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
