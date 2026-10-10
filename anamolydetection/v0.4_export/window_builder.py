"""Gap-aware, bounded conversion from calibrated raw chunks to model windows."""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Iterable

import numpy as np

from edge_config import SensorConfig


@dataclass(frozen=True)
class RawChunk:
    samples: np.ndarray
    sampling_rate_hz: float
    sequence_start: int
    start_timestamp_s: float
    configuration_hash: str


@dataclass(frozen=True)
class ModelWindow:
    samples: np.ndarray
    sampling_rate_hz: float
    timestamps: np.ndarray
    sequence_start: int
    configuration_hash: str


class WindowBuilder:
    """One-sensor buffer. Rate/config/sequence discontinuities never mix windows."""

    def __init__(self, config: SensorConfig, *, max_buffer_windows: int = 4):
        if not isinstance(max_buffer_windows, int) or max_buffer_windows < 1:
            raise ValueError("max_buffer_windows must be a positive integer")
        self.config = config
        self.max_buffer_windows = max_buffer_windows
        self._samples = np.empty((0, len(config.channels)), dtype=np.float64)
        self._timestamps = np.empty((0,), dtype=np.float64)
        self._sampling_rate_hz: float | None = None
        self._next_sequence: int | None = None
        self._next_timestamp_s: float | None = None
        self.stats = {"accepted_chunks": 0, "dropped_chunks": 0, "dropped_partial_windows": 0,
                      "windows_emitted": 0, "quality_errors": 0, "saturated_samples": 0}

    def reset(self, reason: str) -> dict[str, str | int]:
        dropped = len(self._samples)
        if dropped:
            self.stats["dropped_partial_windows"] += 1
        self._samples = np.empty((0, len(self.config.channels)), dtype=np.float64)
        self._timestamps = np.empty((0,), dtype=np.float64)
        self._sampling_rate_hz = None
        self._next_sequence = None
        self._next_timestamp_s = None
        return {"status": "buffer_reset", "reason": reason, "discarded_samples": dropped}

    def ingest(self, chunk: RawChunk) -> tuple[list[ModelWindow], list[dict[str, str | int]]]:
        events: list[dict[str, str | int]] = []
        try:
            raw, fs, timestamps = self._validate_and_calibrate(chunk)
        except ValueError as exc:
            self.stats["dropped_chunks"] += 1
            self.stats["quality_errors"] += 1
            events.append({"status": "error", "reason": str(exc)})
            return [], events
        if chunk.configuration_hash != self.config.configuration_hash:
            events.append(self.reset("configuration_changed"))
            self.stats["dropped_chunks"] += 1
            events.append({"status": "error", "reason": "configuration_hash_mismatch"})
            return [], events
        if self._sampling_rate_hz is not None and not np.isclose(fs, self._sampling_rate_hz, rtol=0, atol=1e-9):
            events.append(self.reset("sampling_rate_changed"))
        if self._next_sequence is not None and chunk.sequence_start != self._next_sequence:
            events.append(self.reset("sequence_discontinuity"))
        elif self._next_timestamp_s is not None and not np.isclose(
                float(chunk.start_timestamp_s), self._next_timestamp_s, rtol=0, atol=max(1e-6, 0.02 / fs)):
            events.append(self.reset("timestamp_discontinuity"))
        self._sampling_rate_hz = fs
        self._next_sequence = chunk.sequence_start + len(raw)
        self._next_timestamp_s = float(chunk.start_timestamp_s) + len(raw) / fs
        self._samples = np.concatenate((self._samples, raw), axis=0)
        self._timestamps = np.concatenate((self._timestamps, timestamps))
        self.stats["accepted_chunks"] += 1
        window_samples = int(round(self.config.window_seconds * fs))
        stride_samples = int(round(self.config.stride_seconds * fs))
        if window_samples < 4 or stride_samples < 1:
            raise RuntimeError("Validated configuration does not produce usable sample counts")
        max_samples = self.max_buffer_windows * window_samples
        if len(self._samples) > max_samples:
            # Keep a bounded latest segment. This is loss, never an implicit window.
            excess = len(self._samples) - max_samples
            self._samples = self._samples[excess:]
            self._timestamps = self._timestamps[excess:]
            self.stats["dropped_partial_windows"] += 1
            events.append({"status": "error", "reason": "buffer_overflow", "discarded_samples": excess})
        windows: list[ModelWindow] = []
        while len(self._samples) >= window_samples:
            sequence_start = self._next_sequence - len(self._samples)
            windows.append(ModelWindow(
                samples=self._samples[:window_samples].copy(),
                sampling_rate_hz=fs,
                timestamps=self._timestamps[:window_samples].copy(),
                sequence_start=sequence_start,
                configuration_hash=self.config.configuration_hash,
            ))
            self._samples = self._samples[stride_samples:]
            self._timestamps = self._timestamps[stride_samples:]
            self.stats["windows_emitted"] += 1
        return windows, events

    def _validate_and_calibrate(self, chunk: RawChunk) -> tuple[np.ndarray, float, np.ndarray]:
        if not isinstance(chunk.sequence_start, int) or chunk.sequence_start < 0:
            raise ValueError("sequence_start must be a nonnegative integer")
        fs = float(chunk.sampling_rate_hz)
        if not np.isfinite(fs) or not self.config.min_sampling_rate_hz <= fs <= self.config.max_sampling_rate_hz:
            raise ValueError("sampling_rate_hz outside active sensor configuration")
        raw = np.asarray(chunk.samples, dtype=np.float64)
        if raw.ndim != 2 or raw.shape[0] == 0 or raw.shape[1] != len(self.config.channels):
            raise ValueError("samples must be nonempty [time, configured_channels]")
        if not np.isfinite(raw).all():
            raise ValueError("samples contain non-finite values")
        below_min = raw < self.config.input_min if self.config.input_min is not None else np.zeros(raw.shape, dtype=bool)
        above_max = raw > self.config.input_max if self.config.input_max is not None else np.zeros(raw.shape, dtype=bool)
        if np.any(below_min | above_max):
            self.stats["saturated_samples"] += int(np.count_nonzero(below_min | above_max))
            raise ValueError("samples outside configured input range")
        expected_seconds = len(raw) / fs
        if expected_seconds > self.config.window_seconds * self.max_buffer_windows:
            raise ValueError("chunk exceeds bounded buffer capacity")
        start = float(chunk.start_timestamp_s)
        if not np.isfinite(start):
            raise ValueError("start_timestamp_s must be finite")
        timestamps = start + np.arange(len(raw), dtype=np.float64) / fs
        calibrated = raw * self.config.calibration_scale + self.config.calibration_offset
        return calibrated, fs, timestamps
