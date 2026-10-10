"""Long-lived normal-only anomaly runtime without transport or backend ownership."""
from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
from typing import Any

from activation import load_active_candidate
from edge_config import SensorConfig
from window_builder import RawChunk, WindowBuilder


class AnomalyRuntime:
    """Keeps scorer/buffer alive and returns bounded local result records."""

    def __init__(self, config: SensorConfig, activation_path: str, *, max_pending_results: int = 64,
                 max_buffer_windows: int = 4):
        if not isinstance(max_pending_results, int) or max_pending_results < 1:
            raise ValueError("max_pending_results must be a positive integer")
        self.config = config
        self.scorer = load_active_candidate(activation_path, config)
        self.builder = WindowBuilder(config, max_buffer_windows=max_buffer_windows)
        self.pending: deque[dict[str, Any]] = deque(maxlen=max_pending_results)
        self.max_pending_results = max_pending_results
        self.stats = {"windows_scored": 0, "score_errors": 0, "pending_dropped": 0}

    def ingest(self, chunk: RawChunk) -> list[dict[str, Any]]:
        windows, events = self.builder.ingest(chunk)
        results: list[dict[str, Any]] = []
        for event in events:
            results.append(self._result("error", event.get("reason", "input_quality_error"), None))
        for window in windows:
            try:
                anomaly = self.scorer.score(window.samples, window.sampling_rate_hz, window.timestamps)
                result = self._result("ok", None, anomaly, window=window)
                self.stats["windows_scored"] += 1
            except (ValueError, RuntimeError) as exc:
                result = self._result("error", str(exc), None, window=window)
                self.stats["score_errors"] += 1
            results.append(result)
        for result in results:
            if len(self.pending) == self.max_pending_results:
                self.stats["pending_dropped"] += 1
            self.pending.append(result)
        return results

    def drain_pending(self, limit: int | None = None) -> list[dict[str, Any]]:
        if limit is not None and (not isinstance(limit, int) or limit < 0):
            raise ValueError("limit must be a nonnegative integer")
        result = []
        while self.pending and (limit is None or len(result) < limit):
            result.append(self.pending.popleft())
        return result

    def _result(self, status: str, reason: str | None, anomaly: dict | None, *, window=None) -> dict[str, Any]:
        result: dict[str, Any] = {
            "status": status, "reason": reason, "sensor_id": self.config.sensor_id,
            "daq_uuid": self.config.daq_uuid, "equipment_id": self.config.equipment_id,
            "profile_id": self.config.profile_id, "configuration_hash": self.config.configuration_hash,
            "configuration_revision": self.config.configuration_revision,
            "emitted_utc": datetime.now(timezone.utc).isoformat(),
        }
        if window is not None:
            result.update({"sampling_rate_hz": window.sampling_rate_hz,
                           "window_start_timestamp_s": float(window.timestamps[0]),
                           "window_end_timestamp_s": float(window.timestamps[-1]),
                           "sequence_start": window.sequence_start})
        if anomaly is not None:
            result["anomaly_detection"] = anomaly
        return result
