"""Versioned AI-side sensor configuration and profile compatibility checks.

This module deliberately consumes a configuration snapshot from another system.
It does not invent DAQ identities, calibration, or physical units.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from typing import Any, Mapping

import numpy as np

SUPPORTED_SENSOR_TYPES = frozenset({"vibration", "temperature", "current", "pressure"})


def _canonical_hash(value: Mapping[str, Any]) -> str:
    encoded = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _text(value: Any, name: str, *, limit: int = 300) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError(f"{name} must be a nonempty string up to {limit} characters")
    return value.strip()


def _finite(value: Any, name: str, *, lower: float | None = None, strict_lower: bool = False) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not np.isfinite(value):
        raise ValueError(f"{name} must be finite")
    result = float(value)
    if lower is not None and (result <= lower if strict_lower else result < lower):
        comparator = ">" if strict_lower else ">="
        raise ValueError(f"{name} must be {comparator} {lower}")
    return result


@dataclass(frozen=True)
class SensorConfig:
    """Immutable input contract for one physical sensor/profile deployment."""

    daq_uuid: str
    equipment_id: str
    sensor_id: str
    sensor_type: str
    source_unit: str
    canonical_unit: str
    calibration_scale: float
    calibration_offset: float
    channels: tuple[str, ...]
    position_id: str
    profile_id: str
    configuration_revision: str
    min_sampling_rate_hz: float
    max_sampling_rate_hz: float
    window_seconds: float
    stride_seconds: float
    input_min: float | None = None
    input_max: float | None = None

    @classmethod
    def from_mapping(cls, raw: Mapping[str, Any]) -> "SensorConfig":
        if not isinstance(raw, Mapping):
            raise ValueError("sensor configuration must be an object")
        sensor_type = _text(raw.get("sensor_type"), "sensor_type", limit=40)
        if sensor_type not in SUPPORTED_SENSOR_TYPES:
            raise ValueError(f"Unsupported sensor_type: {sensor_type}")
        channels_raw = raw.get("channels")
        if not isinstance(channels_raw, list) or not channels_raw:
            raise ValueError("channels must be a nonempty list")
        channels = tuple(_text(item, "channel", limit=100) for item in channels_raw)
        if len(set(channels)) != len(channels):
            raise ValueError("channels must be unique")
        minimum = _finite(raw.get("min_sampling_rate_hz"), "min_sampling_rate_hz", lower=0, strict_lower=True)
        maximum = _finite(raw.get("max_sampling_rate_hz"), "max_sampling_rate_hz", lower=minimum)
        window = _finite(raw.get("window_seconds"), "window_seconds", lower=0, strict_lower=True)
        stride = _finite(raw.get("stride_seconds"), "stride_seconds", lower=0, strict_lower=True)
        if stride > window:
            raise ValueError("stride_seconds cannot exceed window_seconds")
        scale = _finite(raw.get("calibration_scale"), "calibration_scale")
        if abs(scale) < 1e-12:
            raise ValueError("calibration_scale cannot be zero")
        input_min = raw.get("input_min")
        input_max = raw.get("input_max")
        if input_min is not None:
            input_min = _finite(input_min, "input_min")
        if input_max is not None:
            input_max = _finite(input_max, "input_max")
        if input_min is not None and input_max is not None and input_min >= input_max:
            raise ValueError("input_min must be lower than input_max")
        return cls(
            daq_uuid=_text(raw.get("daq_uuid"), "daq_uuid"),
            equipment_id=_text(raw.get("equipment_id"), "equipment_id"),
            sensor_id=_text(raw.get("sensor_id"), "sensor_id"),
            sensor_type=sensor_type,
            source_unit=_text(raw.get("source_unit"), "source_unit", limit=40),
            canonical_unit=_text(raw.get("canonical_unit"), "canonical_unit", limit=40),
            calibration_scale=scale,
            calibration_offset=_finite(raw.get("calibration_offset"), "calibration_offset"),
            channels=channels,
            position_id=_text(raw.get("position_id"), "position_id"),
            profile_id=_text(raw.get("profile_id"), "profile_id"),
            configuration_revision=_text(raw.get("configuration_revision"), "configuration_revision"),
            min_sampling_rate_hz=minimum,
            max_sampling_rate_hz=maximum,
            window_seconds=window,
            stride_seconds=stride,
            input_min=input_min,
            input_max=input_max,
        )

    def canonical_mapping(self) -> dict[str, Any]:
        return {
            "daq_uuid": self.daq_uuid,
            "equipment_id": self.equipment_id,
            "sensor_id": self.sensor_id,
            "sensor_type": self.sensor_type,
            "source_unit": self.source_unit,
            "canonical_unit": self.canonical_unit,
            "calibration_scale": self.calibration_scale,
            "calibration_offset": self.calibration_offset,
            "channels": list(self.channels),
            "position_id": self.position_id,
            "profile_id": self.profile_id,
            "configuration_revision": self.configuration_revision,
            "min_sampling_rate_hz": self.min_sampling_rate_hz,
            "max_sampling_rate_hz": self.max_sampling_rate_hz,
            "window_seconds": self.window_seconds,
            "stride_seconds": self.stride_seconds,
            "input_min": self.input_min,
            "input_max": self.input_max,
        }

    @property
    def configuration_hash(self) -> str:
        return _canonical_hash(self.canonical_mapping())


def validate_profile_binding(profile: Mapping[str, Any], config: SensorConfig) -> None:
    """Reject a model/profile when its physical input contract changed."""
    expected = {
        "profile_id": config.profile_id,
        "sensor_type": config.sensor_type,
        "unit": config.canonical_unit,
        "channels": list(config.channels),
        "window_seconds": config.window_seconds,
    }
    for key, value in expected.items():
        if profile.get(key) != value:
            raise ValueError(f"Profile {key} differs from active sensor configuration")
    minimum = float(profile["min_sample_rate_hz"])
    maximum = float(profile["max_sample_rate_hz"])
    if minimum < config.min_sampling_rate_hz or maximum > config.max_sampling_rate_hz:
        raise ValueError("Profile sample-rate range exceeds active sensor configuration")
    bound_hash = profile.get("sensor_configuration_hash")
    if bound_hash is not None and bound_hash != config.configuration_hash:
        raise ValueError("Profile was trained for a different sensor configuration")


def bind_profile(profile: Mapping[str, Any], config: SensorConfig) -> dict[str, Any]:
    """Return a profile explicitly bound to the immutable sensor snapshot."""
    result = dict(profile)
    validate_profile_binding(result, config)
    result["sensor_configuration_hash"] = config.configuration_hash
    result["sensor_configuration_revision"] = config.configuration_revision
    return result
