"""Approved normal-window archive and leak-safe manifest generation for v0.4."""
from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Mapping

import numpy as np

from edge_config import SensorConfig
from window_builder import ModelWindow


@dataclass(frozen=True)
class NormalWindowRecord:
    path: str
    session_id: str
    configuration_hash: str
    profile_id: str
    approved: bool
    captured_utc: str


class NormalWindowArchive:
    """Filesystem archive; approval evidence must be supplied by the caller."""

    def __init__(self, directory: str | Path, config: SensorConfig):
        self.directory = Path(directory)
        self.config = config
        self.index_path = self.directory / "normal_windows.jsonl"

    def append(self, window: ModelWindow, *, session_id: str, approval_id: str, approved: bool) -> NormalWindowRecord:
        if not approved:
            raise ValueError("Only explicitly approved normal windows can be archived")
        if not isinstance(approval_id, str) or not approval_id.strip():
            raise ValueError("approval_id is required for normal-window archival")
        if window.configuration_hash != self.config.configuration_hash:
            raise ValueError("Window configuration does not match the archive")
        if not isinstance(session_id, str) or not session_id.strip():
            raise ValueError("session_id is required")
        self.directory.mkdir(parents=True, exist_ok=True)
        count = sum(1 for _ in self._records())
        relative = Path("windows") / f"normal-{count:06d}.npz"
        target = self.directory / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(
            target,
            samples=window.samples.astype(np.float32),
            sampling_rate_hz=window.sampling_rate_hz,
            timestamps=window.timestamps,
            sensor_type=self.config.sensor_type,
            unit=self.config.canonical_unit,
            channels=np.asarray(self.config.channels),
            profile_id=self.config.profile_id,
            sensor_configuration_hash=self.config.configuration_hash,
            sensor_configuration_revision=self.config.configuration_revision,
            approval_id=approval_id,
        )
        record = NormalWindowRecord(
            path=relative.as_posix(), session_id=session_id.strip(),
            configuration_hash=self.config.configuration_hash, profile_id=self.config.profile_id,
            approved=True, captured_utc=datetime.now(timezone.utc).isoformat(),
        )
        with self.index_path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(asdict(record), ensure_ascii=False, allow_nan=False) + "\n")
        return record

    def build_manifest(self, *, approval_id: str, split_by_session: Mapping[str, str], output_path: str | Path) -> Path:
        if not isinstance(approval_id, str) or not approval_id.strip():
            raise ValueError("approval_id is required")
        allowed = {"train", "calibration", "test"}
        records = list(self._records())
        if not records:
            raise ValueError("No approved normal windows are archived")
        manifest = {"profile_id": self.config.profile_id, "approval_id": approval_id.strip(),
                    "data_label": "normal", "sensor_configuration_hash": self.config.configuration_hash,
                    "sensor_configuration_revision": self.config.configuration_revision,
                    "train": [], "calibration": [], "test": []}
        seen_paths: set[str] = set()
        sessions: dict[str, str] = {}
        for record in records:
            if not record.approved or record.configuration_hash != self.config.configuration_hash or record.profile_id != self.config.profile_id:
                continue
            split = split_by_session.get(record.session_id)
            if split not in allowed:
                raise ValueError(f"Each archived session needs train/calibration/test assignment: {record.session_id}")
            if record.session_id in sessions and sessions[record.session_id] != split:
                raise ValueError("A session cannot appear in multiple splits")
            sessions[record.session_id] = split
            if record.path in seen_paths:
                raise ValueError("Duplicate archived window path")
            seen_paths.add(record.path)
            manifest[split].append({"path": record.path, "session_id": record.session_id})
        if any(not manifest[name] for name in allowed):
            raise ValueError("Each split needs at least one approved window")
        output = Path(output_path)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
        return output

    def _records(self):
        if not self.index_path.is_file():
            return []
        records: list[NormalWindowRecord] = []
        for line in self.index_path.read_text(encoding="utf-8").splitlines():
            try:
                raw = json.loads(line)
                records.append(NormalWindowRecord(**raw))
            except (json.JSONDecodeError, TypeError) as exc:
                raise ValueError("Invalid normal-window archive index") from exc
        return records
