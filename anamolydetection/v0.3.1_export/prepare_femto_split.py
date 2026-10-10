"""Create bearing-disjoint FEMTO reference indexes without extracting signals."""
import argparse
import csv
import json
import re
from pathlib import Path, PurePosixPath
from zipfile import ZipFile


SPLITS = {
    "train": ("Training_set.zip", "Learning_set", ("Bearing1_1", "Bearing2_1", "Bearing3_1")),
    "validation": ("Training_set.zip", "Learning_set", ("Bearing1_2", "Bearing2_2", "Bearing3_2")),
    "test": ("Validation_Set.zip", "Full_Test_Set", (
        "Bearing1_3", "Bearing1_4", "Bearing1_5", "Bearing1_6", "Bearing1_7",
        "Bearing2_3", "Bearing2_4", "Bearing2_5", "Bearing2_6", "Bearing2_7", "Bearing3_3")),
}
FIELDS = ("archive", "member", "asset_id", "signal", "recording_index", "bytes", "crc32")


def build_indexes(data_dir):
    """Inspect ZIP directories only; fail closed on unexpected/missing bearings."""
    data_dir = Path(data_dir).resolve(strict=True)
    rows = {name: [] for name in SPLITS}
    for archive in sorted({spec[0] for spec in SPLITS.values()}):
        specs = {name: spec for name, spec in SPLITS.items() if spec[0] == archive}
        owners = {bearing: name for name, spec in specs.items() for bearing in spec[2]}
        roots = {spec[1] for spec in specs.values()}
        seen = set()
        with ZipFile(data_dir / archive) as z:
            members = z.infolist()
            names = [info.filename for info in members]
            if len(names) != len(set(names)):
                raise ValueError(f"Duplicate ZIP members: {archive}")
            for info in sorted(members, key=lambda item: item.filename):
                if info.is_dir():
                    continue
                parts = PurePosixPath(info.filename).parts
                match = re.fullmatch(r"(acc|temp)_(\d+)\.csv", parts[-1])
                if len(parts) != 3 or parts[0] not in roots or parts[1] not in owners or not match:
                    raise ValueError(f"Unexpected archive member: {archive}:{info.filename}")
                bearing = parts[1]
                if match[1] == "acc":
                    seen.add(bearing)
                rows[owners[bearing]].append(dict(zip(FIELDS, (
                    archive, info.filename, bearing, match[1], int(match[2]),
                    info.file_size, f"{info.CRC:08x}"))))
        if seen != set(owners):
            raise ValueError(f"Missing vibration bearings in {archive}: {sorted(set(owners) - seen)}")
    return rows


def prepare(data_dir, output_dir):
    rows = build_indexes(data_dir)
    output = Path(output_dir).resolve()
    output.mkdir(parents=True, exist_ok=False)
    summary = {
        "schema_version": "femto_reference_split_v1",
        "data_dir": str(Path(data_dir).resolve()),
        "archive_paths_relative_to": "data_dir",
        "split_unit": "bearing_id",
        "contains_rul_labels": False,
        "payload_integrity_checked": False,
        "excluded_archive": "Test_set.zip (truncated histories of the same test bearings)",
        "splits": {},
    }
    for name, records in rows.items():
        with (output / f"{name}.csv").open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=FIELDS)
            writer.writeheader()
            writer.writerows(records)
        summary["splits"][name] = {
            "bearings": sorted({row["asset_id"] for row in records}),
            "csv_count": len(records),
            "vibration_count": sum(row["signal"] == "acc" for row in records),
            "temperature_count": sum(row["signal"] == "temp" for row in records),
        }
    (output / "split_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.data_dir, args.output_dir), indent=2))
