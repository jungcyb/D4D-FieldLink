"""Explicit, local candidate validation and activation metadata for anomaly models."""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile

from anomaly import AnomalyScorer
from edge_config import SensorConfig, validate_profile_binding


def validate_candidate(candidate_dir: str | Path, config: SensorConfig) -> dict:
    scorer = AnomalyScorer(candidate_dir)
    validate_profile_binding(scorer.profile, config)
    if scorer.profile.get("sensor_configuration_hash") != config.configuration_hash:
        raise ValueError("Candidate is missing the active sensor configuration binding")
    metadata = scorer.metadata
    if metadata.get("status") != "candidate":
        raise ValueError("Only candidate anomaly models can be activated")
    return {"model_dir": str(Path(candidate_dir).resolve()), "model_version": metadata["model_version"],
            "profile_id": scorer.profile["profile_id"], "configuration_hash": config.configuration_hash,
            "configuration_revision": config.configuration_revision, "activated_utc": datetime.now(timezone.utc).isoformat()}


def activate_candidate(candidate_dir: str | Path, config: SensorConfig, activation_path: str | Path) -> dict:
    """Write an activation record once; never overwrite an existing activation."""
    activation = Path(activation_path)
    if activation.exists():
        raise FileExistsError("Activation record already exists; use a new explicit activation path")
    record = validate_candidate(candidate_dir, config)
    activation.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=activation.parent, delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(record, stream, ensure_ascii=False, indent=2, allow_nan=False)
    temporary.replace(activation)
    return record


def load_active_candidate(activation_path: str | Path, config: SensorConfig) -> AnomalyScorer:
    raw = json.loads(Path(activation_path).read_text(encoding="utf-8"))
    if raw.get("configuration_hash") != config.configuration_hash:
        raise ValueError("Activation belongs to a different sensor configuration")
    scorer = AnomalyScorer(raw.get("model_dir"))
    validate_profile_binding(scorer.profile, config)
    if scorer.metadata.get("model_version") != raw.get("model_version"):
        raise ValueError("Activated candidate version changed on disk")
    return scorer
