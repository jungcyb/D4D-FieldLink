"""Stream verified FEMTO vibration CSVs into NPZ windows and RUL manifests.

Labels mean time to the recorded run end (10-second acquisition cadence),
not transferable equipment lifetime. Bearing1_4 is quarantined: its full/truncated
record counts disagree with the original PHM2012 published remaining life.
"""
import argparse
from collections import defaultdict
import io
import json
from pathlib import Path
import tempfile
import time
from zipfile import ZipFile

import numpy as np

from prepare_femto_split import build_indexes


PROFILE = {
    "profile_id": "femto/vibration/2ch/25600hz/v1",
    "feature_schema_version": "edge_window_v2", "feature_mode": "waveform",
    "sensor_type": "vibration", "unit": "g", "channels": ["horizontal", "vertical"],
    "window_seconds": 0.1, "target_sample_rate_hz": 25600,
    "min_sample_rate_hz": 25600, "max_sample_rate_hz": 25600,
    "frequency_bands_hz": [[0, 1000], [1000, 3000], [3000, 6000], [6000, 12800]],
}
# Table 3 of the original authored IEEE PHM2012 challenge guide, seconds.
PUBLISHED_RUL_SECONDS = {
    "Bearing1_3": 5730, "Bearing1_4": 339, "Bearing1_5": 1610,
    "Bearing1_6": 1460, "Bearing1_7": 7570, "Bearing2_3": 7530,
    "Bearing2_4": 1390, "Bearing2_5": 3090, "Bearing2_6": 1290,
    "Bearing2_7": 580, "Bearing3_3": 820,
}
SOURCE = "https://raw.githubusercontent.com/wkzs111/phm-ieee-2012-data-challenge-dataset/577c77f1d8d284e2eadc8e17fe49d58907d7ad01/IEEEPHM2012-Challenge-Details.pdf"


def parse_vibration(payload):
    text = payload.decode("utf-8-sig")
    first = text.splitlines()[0]
    if ("," in first) == (";" in first):
        raise ValueError("Expected an unambiguous comma or semicolon CSV")
    array = np.loadtxt(io.StringIO(text), delimiter=";" if ";" in first else ",")
    if array.shape != (2560, 6) or not np.isfinite(array).all():
        raise ValueError("Expected finite FEMTO vibration [2560,6] CSV")
    clock = array[:, :4]
    # Some serialized records round 999999.x microseconds to 1000000;
    # arithmetic below carries this into the next second without altering signal.
    if not np.equal(clock, np.floor(clock)).all() or (clock < 0).any() or (clock[:, :3] >= [24, 60, 60]).any() or (clock[:, 3] > 1000000).any():
        raise ValueError("Invalid FEMTO clock columns")
    times = clock @ np.asarray([3600, 60, 1, 1e-6])
    # Original clock fields include decimal serialization quantization (e.g.
    # 30/40us steps), not a high-precision DAQ clock; do not treat them as
    # higher precision uniformly sampled timestamps in the runtime NPZ format.
    steps = np.diff(times) % 86400
    if not np.all((steps >= 19e-6) & (steps <= 61e-6)) or not np.isclose(steps.sum(), 2559/25600, atol=.003, rtol=0):
        raise ValueError("Unexpected within-burst timestamp steps")
    return array[:, 4:].astype(np.float32), float(times[0])


def verify_endpoints(data_dir, rows):
    full = defaultdict(list)
    for row in rows["test"]:
        if row["signal"] == "acc":
            full[row["asset_id"]].append(row["recording_index"])
    truncated = defaultdict(list)
    with ZipFile(Path(data_dir) / "Test_set.zip") as archive:
        for name in archive.namelist():
            parts = name.split("/")
            if len(parts) == 3 and parts[0] == "Test_set" and parts[2].startswith("acc_") and parts[2].endswith(".csv"):
                truncated[parts[1]].append(int(parts[2][4:-4]))
    evidence = {}
    for bearing, published in PUBLISHED_RUL_SECONDS.items():
        for indices in (full[bearing], truncated[bearing]):
            if sorted(indices) != list(range(1, len(indices) + 1)):
                raise ValueError(f"Missing or duplicate acquisition indices: {bearing}")
        derived = (max(full[bearing]) - max(truncated[bearing])) * 10
        evidence[bearing] = {"full_records": len(full[bearing]), "truncated_records": len(truncated[bearing]),
                             "derived_remaining_seconds": derived, "published_remaining_seconds": published,
                             "matches_published": derived == published}
        if bearing != "Bearing1_4" and derived != published:
            raise ValueError(f"Unexpected endpoint discrepancy: {bearing}")
    return evidence


def prepare(data_dir, output_dir, approval_id, max_per_bearing=None):
    if not approval_id.strip():
        raise ValueError("Explicit training request/approval identifier required")
    if max_per_bearing is not None and max_per_bearing < 20:
        raise ValueError("max_per_bearing must be >=20")
    rows = build_indexes(data_dir)
    evidence = verify_endpoints(data_dir, rows)
    output = Path(output_dir).resolve()
    if output.exists():
        raise FileExistsError(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest = {"profile_id": PROFILE["profile_id"], "approval_id": approval_id,
                "data_label": "run_to_failure", "failure_evidence": True,
                "label_definition": "(last_acquisition_index-current_acquisition_index)*10/3600 hours to recorded run end",
                "label_source": SOURCE, "excluded_assets": {"Bearing1_4": "Published RUL339s vs archive-derived2890s; quarantined, not relabeled"}}
    report = {"endpoint_evidence": evidence, "source": SOURCE, "profile": PROFILE,
              "max_per_bearing": max_per_bearing, "bearings": {}, "rejected_windows": [], "note": "All selected CSV payloads read with ZIP CRC verification. No temperature imputation. No failure-type labels generated."}
    with tempfile.TemporaryDirectory(prefix=f".{output.name}-", dir=output.parent) as temporary:
        temp = Path(temporary)
        for split, records in rows.items():
            manifest[split] = []
            grouped = defaultdict(list)
            for row in records:
                if row["signal"] == "acc" and row["asset_id"] != "Bearing1_4":
                    grouped[row["asset_id"]].append(row)
            for bearing, entries in sorted(grouped.items()):
                entries.sort(key=lambda entry: entry["recording_index"])
                indices = [entry["recording_index"] for entry in entries]
                if indices != list(range(1, len(entries) + 1)):
                    raise ValueError(f"Noncontiguous acquisition indices: {bearing}")
                end = indices[-1]
                if max_per_bearing is not None and len(entries) > max_per_bearing:
                    entries = [entries[index] for index in np.linspace(0, len(entries)-1, max_per_bearing, dtype=int)]
                folder = temp / "windows" / bearing
                folder.mkdir(parents=True)
                first_clock = None
                rejected = 0
                with ZipFile(Path(data_dir) / entries[0]["archive"]) as archive:
                    for entry in entries:
                        samples, clock = parse_vibration(archive.read(entry["member"]))
                        index = entry["recording_index"]
                        if first_clock is None:
                            first_clock = clock
                        elapsed = (clock - first_clock) % 86400
                        if not np.isclose(elapsed, (index-1)*10, atol=0.01, rtol=0):
                            # Do not silently retime corrupted/repeated CSVs. Exclude
                            # isolated anomalies and retain exact source evidence.
                            if index in (1, end):
                                raise ValueError(f"Invalid endpoint clock: {bearing}/{index}")
                            report["rejected_windows"].append({"asset_id": bearing, "member": entry["member"],
                                                               "reason": "clock_disagrees_with_acquisition_index",
                                                               "observed_elapsed_seconds": elapsed,
                                                               "expected_elapsed_seconds": (index-1)*10})
                            rejected += 1
                            continue
                        relative = Path("windows") / bearing / f"acc_{index:05d}.npz"
                        np.savez(temp / relative, samples=samples, sampling_rate_hz=25600.,
                                 sensor_type=PROFILE["sensor_type"], unit=PROFILE["unit"],
                                 channels=PROFILE["channels"], profile_id=PROFILE["profile_id"])
                        manifest[split].append({"path": relative.as_posix(), "asset_id": bearing,
                                                "session_id": f"femto/{bearing}", "recording_index": index,
                                                "elapsed_hours": (index-1)*10/3600,
                                                "remaining_useful_life_hours": (end-index)*10/3600,
                                                "source_archive": entry["archive"], "source_member": entry["member"],
                                                "source_crc32": entry["crc32"]})
                if rejected > max(2, len(entries)*.01):
                    raise ValueError(f"Too many clock anomalies: {bearing}/{rejected}")
                report["bearings"][bearing] = {"split": split, "source_records": end,
                                               "prepared_windows": len(entries)-rejected, "rejected_clock_windows": rejected,
                                               "recorded_duration_hours": (end-1)*10/3600}
                print(f"Prepared {split}/{bearing}: {len(entries)-rejected} windows, rejected {rejected}", flush=True)
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
    parser.add_argument("--max-per-bearing", type=int, help="Evenly spaced smoke sample including both run endpoints")
    args = parser.parse_args()
    prepare(args.data_dir, args.output_dir, args.approval_id, args.max_per_bearing)
