"""Prepare verified XJTU-SY full bearing runs as a separate RUL candidate.

One CSV is one 1.28-second vibration burst acquired every minute. RUL is
time to the recorded experimental run end, not transferable machine lifetime.
Entire bearings, rather than windows from one bearing, are held out.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import tempfile
import time

import numpy as np


SOURCE = "https://github.com/WangBiaoXJTU/xjtu-sy-bearing-datasets"
ENDPOINT_SOURCE = "https://biaowang.tech/images/table2.jpg"
HEADER = "Horizontal_vibration_signals,Vertical_vibration_signals"
CONDITIONS = {1: "35Hz12kN", 2: "37.5Hz11kN", 3: "40Hz10kN"}
PROFILE = {
    "profile_id": "xjtu_sy/vibration/2ch/25600hz/v1",
    "feature_schema_version": "edge_window_v2", "feature_mode": "waveform",
    "sensor_type": "vibration", "unit": "source_native_unverified", "channels": ["horizontal", "vertical"],
    "window_seconds": 1.28, "target_sample_rate_hz": 25600,
    "min_sample_rate_hz": 25600, "max_sample_rate_hz": 25600,
    "frequency_bands_hz": [[0, 1000], [1000, 3000], [3000, 6000], [6000, 12800]],
}


def parse_vibration(payload):
    text = payload.decode("utf-8-sig")
    lines = text.splitlines()
    if not lines or lines[0].strip() != HEADER:
        raise ValueError("Unexpected XJTU-SY CSV header/channel order")
    values = np.loadtxt(io.StringIO(text), delimiter=",", skiprows=1)
    if values.shape != (32768, 2) or not np.isfinite(values).all():
        raise ValueError("Expected finite XJTU-SY vibration [32768,2] CSV")
    values = values.astype(np.float32)
    if not np.isfinite(values).all():
        raise ValueError("XJTU-SY vibration float32 overflow")
    return values


def build_indexes(data_dir, expected_counts):
    """Require a complete independently verified endpoint inventory."""
    root = Path(data_dir).resolve()
    expected_assets = {f"Bearing{condition}_{number}" for condition in CONDITIONS for number in range(1, 6)}
    if set(expected_counts) != expected_assets or any(type(count) is not int or count < 2 for count in expected_counts.values()):
        raise ValueError("Expected counts must identify all 15 bearings with integer endpoints >=2")
    folders = {}
    for folder in root.rglob("Bearing*_*"):
        if not folder.is_dir():
            continue
        match = re.fullmatch(r"Bearing([123])_([1-5])", folder.name)
        if match is None or folder.name in folders:
            raise ValueError(f"Unexpected or duplicate bearing folder: {folder}")
        if folder.parent.name != CONDITIONS[int(match[1])]:
            raise ValueError(f"Bearing operating condition mismatch: {folder}")
        folders[folder.name] = folder
    if set(folders) != expected_assets:
        raise ValueError("Missing XJTU-SY bearing directories")
    rows = {split: [] for split in ("train", "validation", "test")}
    for bearing, folder in sorted(folders.items()):
        files = {}
        for file in folder.glob("*.csv"):
            if not re.fullmatch(r"[1-9][0-9]*", file.stem):
                raise ValueError(f"Unexpected acquisition filename: {file}")
            files[int(file.stem)] = file
        end = expected_counts[bearing]
        if sorted(files) != list(range(1, end + 1)):
            raise ValueError(f"Missing, extra or noncontiguous acquisitions: {bearing}; expected {end}")
        number = int(bearing.rsplit("_", 1)[1])
        split = "train" if number <= 3 else "validation" if number == 4 else "test"
        rows[split].extend({"asset_id": bearing, "recording_index": index,
                            "path": file, "source_member": file.relative_to(root).as_posix(),
                            "operating_condition": folder.parent.name, "end_index": end}
                           for index, file in sorted(files.items()))
    return rows


def prepare(data_dir, output_dir, approval_id, expected_counts, max_per_bearing=None):
    if not isinstance(approval_id, str) or not approval_id.strip():
        raise ValueError("Explicit training request/approval identifier required")
    if max_per_bearing is not None and (type(max_per_bearing) is not int or max_per_bearing < 20):
        raise ValueError("max_per_bearing must be an integer >=20")
    rows = build_indexes(data_dir, expected_counts)
    output = Path(output_dir).resolve()
    if output.exists():
        raise FileExistsError(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest = {"profile_id": PROFILE["profile_id"], "approval_id": approval_id,
                "data_label": "run_to_failure", "failure_evidence": True,
                "label_definition": "(last_acquisition_index-current_acquisition_index)/60 hours to recorded experimental run end",
                "label_source": SOURCE,
                "endpoint_source": ENDPOINT_SOURCE,
                "split_definition": "Per operating condition: bearings 1/2/3 train, 4 validation, 5 test; whole-bearing holdout"}
    report = {"source": SOURCE, "endpoint_source": ENDPOINT_SOURCE,
              "unit_note": "CSV has no physical-unit metadata; native numeric values retained without claiming g calibration. Do not route g-calibrated sensors into this profile.",
              "profile": PROFILE, "max_per_bearing": max_per_bearing,
              "expected_endpoint_counts": expected_counts, "bearings": {},
              "note": "Separate XJTU-SY profile, not merged with FEMTO. No temperature imputation or fault-type labels. Selected CSV payload SHA256 retained."}
    with tempfile.TemporaryDirectory(prefix=f".{output.name}-", dir=output.parent) as temporary:
        temp = Path(temporary)
        for split, records in rows.items():
            manifest[split] = []
            for bearing in sorted({row["asset_id"] for row in records}):
                entries = [row for row in records if row["asset_id"] == bearing]
                end = entries[-1]["end_index"]
                if max_per_bearing is not None and len(entries) > max_per_bearing:
                    entries = [entries[index] for index in np.linspace(0, len(entries)-1, max_per_bearing, dtype=int)]
                (temp / "windows" / bearing).mkdir(parents=True)
                for entry in entries:
                    payload = entry["path"].read_bytes()
                    samples = parse_vibration(payload)
                    index = entry["recording_index"]
                    relative = Path("windows") / bearing / f"acc_{index:05d}.npz"
                    np.savez(temp / relative, samples=samples, sampling_rate_hz=25600.,
                             sensor_type=PROFILE["sensor_type"], unit=PROFILE["unit"],
                             channels=PROFILE["channels"], profile_id=PROFILE["profile_id"])
                    manifest[split].append({"path": relative.as_posix(), "asset_id": bearing,
                                            "session_id": f"xjtu_sy/{bearing}", "recording_index": index,
                                            "elapsed_hours": (index-1)/60,
                                            "remaining_useful_life_hours": (end-index)/60,
                                            "operating_condition": entry["operating_condition"],
                                            "source_member": entry["source_member"],
                                            "source_sha256": hashlib.sha256(payload).hexdigest()})
                report["bearings"][bearing] = {"split": split, "source_records": end,
                                               "prepared_windows": len(entries),
                                               "recorded_duration_hours": (end-1)/60,
                                               "operating_condition": entries[0]["operating_condition"]}
                print(f"Prepared {split}/{bearing}: {len(entries)} windows", flush=True)
        for name, value in (("profile.json", PROFILE), ("manifest.json", manifest), ("preparation_report.json", report)):
            (temp / name).write_text(json.dumps(value, indent=2, allow_nan=False), encoding="utf-8")
        if output.exists():
            raise FileExistsError(output)
        for attempt in range(6):
            try:
                temp.rename(output)
                break
            except PermissionError:
                if attempt == 5:
                    raise
                time.sleep(.5 * (attempt + 1))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--approval-id", required=True)
    parser.add_argument("--expected-counts", required=True, type=Path,
                        help="JSON bearing-name to independently verified complete acquisition count")
    parser.add_argument("--max-per-bearing", type=int, help="Evenly spaced sample including both full-run endpoints")
    args = parser.parse_args()
    counts = json.loads(args.expected_counts.read_text(encoding="utf-8-sig"))
    prepare(args.data_dir, args.output_dir, args.approval_id, counts, args.max_per_bearing)
