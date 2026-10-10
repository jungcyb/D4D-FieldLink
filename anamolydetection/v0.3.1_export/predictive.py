"""One-window / multi-sensor v0.3 edge inference; no backend networking or policy."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from anomaly import AnomalyScorer
from anomaly_features import load_window
from fault import FaultScorer
from rul import RULScorer


class SensorScorer:
    def __init__(self, anomaly_model_dir, rul_model_dir=None, fault_model_dir=None):
        self.anomaly = AnomalyScorer(anomaly_model_dir)
        self.rul = RULScorer(rul_model_dir) if rul_model_dir else None
        self.fault = FaultScorer(fault_model_dir) if fault_model_dir else None
        for optional in (self.rul, self.fault):
            if optional and optional.profile != self.anomaly.profile:
                raise ValueError("Optional model profile differs from anomaly model profile")

    def score(self, samples, sampling_rate_hz, timestamps=None):
        anomaly = self.anomaly.score(samples, sampling_rate_hz, timestamps)
        return {
            "profile_id": self.anomaly.profile["profile_id"],
            "anomaly_detection": anomaly,
            "rul": self.rul.score(samples, sampling_rate_hz, timestamps) if self.rul else {
                "status": "unavailable", "estimated_rul_hours": None,
                "reason": "no_approved_run_to_failure_model"},
            "fault_classification": self.fault.score(samples, sampling_rate_hz, timestamps) if self.fault else {
                "status": "unavailable", "reason": "no_compatible_labeled_fault_model"},
        }


def score_equipment(manifest_path):
    """Score separately configured sensor windows; never synthesize equipment RUL."""
    path = Path(manifest_path)
    config = json.loads(path.read_text(encoding="utf-8"))
    sensors = config.get("sensors")
    if not isinstance(config.get("equipment_id"), str) or not config["equipment_id"] or not isinstance(sensors, list) or not sensors:
        raise ValueError("equipment_id and nonempty sensors list are required")
    results = {}
    for item in sensors:
        sensor_id = item.get("sensor_id")
        if not isinstance(sensor_id, str) or not sensor_id or sensor_id in results:
            raise ValueError("Each sensor_id must be unique and nonempty")
        scorer = SensorScorer(
            path.parent / item["anomaly_model_dir"],
            path.parent / item["rul_model_dir"] if item.get("rul_model_dir") else None,
            path.parent / item["fault_model_dir"] if item.get("fault_model_dir") else None,
        )
        samples, fs, timestamps = load_window(path.parent / item["input_npz"], scorer.anomaly.profile)
        results[sensor_id] = scorer.score(samples, fs, timestamps)
    return {
        "schema_version": "edge_prediction_v0.3",
        "equipment_id": config["equipment_id"],
        "sensors": results,
        "equipment_rul": {"status": "unavailable", "reason": "no_equipment_level_fusion_model"},
        "maintenance_priority": {"status": "not_computed", "owner": "backend_policy"},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True, help="JSON with equipment_id and sensor window/model paths")
    args = parser.parse_args()
    print(json.dumps(score_equipment(args.manifest), ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
