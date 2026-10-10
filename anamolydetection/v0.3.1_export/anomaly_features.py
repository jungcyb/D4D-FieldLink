"""Fixed-schema waveform features for normal-only edge anomaly detection."""

from __future__ import annotations

from fractions import Fraction
import json
from pathlib import Path

import numpy as np
from scipy.signal import resample_poly

from features import extract_features

FEATURE_EXTRACTOR_VERSION = "edge_window_v2"


def load_profile(path):
    profile = json.loads(Path(path).read_text(encoding="utf-8"))
    required = {"profile_id", "feature_schema_version", "feature_mode", "sensor_type", "unit", "channels", "window_seconds", "target_sample_rate_hz", "min_sample_rate_hz", "max_sample_rate_hz", "frequency_bands_hz"}
    missing = required - profile.keys()
    if missing:
        raise ValueError(f"Profile missing fields: {sorted(missing)}")
    channels = profile["channels"]
    if not isinstance(channels, list) or not channels or len(channels) != len(set(channels)) or not all(isinstance(v, str) and v for v in channels):
        raise ValueError("channels must be unique nonempty names")
    for name in ("profile_id", "sensor_type", "unit"):
        if not isinstance(profile[name], str) or not profile[name]:
            raise ValueError(f"{name} must be a nonempty string")
    if profile["feature_schema_version"] != FEATURE_EXTRACTOR_VERSION:
        raise ValueError("Unsupported feature_schema_version")
    if profile["feature_mode"] not in ("waveform", "slow_series"):
        raise ValueError("feature_mode must be waveform or slow_series")
    duration = float(profile["window_seconds"])
    target = float(profile["target_sample_rate_hz"])
    minimum = float(profile["min_sample_rate_hz"])
    maximum = float(profile["max_sample_rate_hz"])
    if not all(np.isfinite(v) for v in (duration, target, minimum, maximum)) or duration <= 0 or target <= 0 or not target <= minimum <= maximum:
        raise ValueError("Invalid duration or sample-rate bounds")
    if abs(duration * target - round(duration * target)) > 1e-8 or duration * target < 4:
        raise ValueError("window_seconds * target_sample_rate_hz must be an integer >= 4")
    bands = profile["frequency_bands_hz"]
    if not isinstance(bands, list):
        raise ValueError("frequency_bands_hz must be a list")
    if profile["feature_mode"] == "slow_series" and bands:
        raise ValueError("slow_series does not use FFT frequency bands")
    for band in bands:
        if not isinstance(band, list) or len(band) != 2 or not all(isinstance(v, (int, float)) and np.isfinite(v) for v in band) or not 0 <= band[0] < band[1] <= target / 2:
            raise ValueError("Frequency bands must fit the common Nyquist range")
    return profile


def feature_names(profile):
    keys = list(_channel_features(np.zeros(int(round(float(profile["window_seconds"]) * float(profile["target_sample_rate_hz"])))), profile))
    return [f"{channel}__{key}" for channel in profile["channels"] for key in keys]


def _channel_features(values, profile):
    if profile["feature_mode"] == "waveform":
        return extract_features(values, float(profile["target_sample_rate_hz"]), profile["frequency_bands_hz"])
    # Low-rate, uniformly sampled sensor history: no fictitious FFT features.
    t = np.arange(len(values), dtype=np.float64) / float(profile["target_sample_rate_hz"])
    slope = float(np.dot(t - t.mean(), values - values.mean()) / np.dot(t - t.mean(), t - t.mean()))
    return {"mean": float(np.mean(values)), "std": float(np.std(values)),
            "minimum": float(np.min(values)), "maximum": float(np.max(values)),
            "last": float(values[-1]), "slope_per_second": slope}


def extract_window(samples, sampling_rate_hz, profile, timestamps=None):
    """Resample one complete, uniformly sampled window to the profile's fixed rate."""
    x = np.asarray(samples, dtype=np.float64)
    if x.ndim != 2 or x.shape[1] != len(profile["channels"]) or not np.isfinite(x).all():
        raise ValueError("samples must be a finite [time, configured_channels] array")
    fs = float(sampling_rate_hz)
    minimum, maximum = float(profile["min_sample_rate_hz"]), float(profile["max_sample_rate_hz"])
    duration, target = float(profile["window_seconds"]), float(profile["target_sample_rate_hz"])
    if not np.isfinite(fs) or not minimum <= fs <= maximum:
        raise ValueError("sampling_rate_hz outside profile bounds")
    if abs(len(x) - duration * fs) > 1.0:
        raise ValueError("Window length disagrees with sampling rate and duration")
    if timestamps is not None:
        t = np.asarray(timestamps, dtype=np.float64)
        if t.shape != (len(x),) or not np.isfinite(t).all() or not np.allclose(np.diff(t), 1 / fs, rtol=0.02, atol=1e-8):
            raise ValueError("Invalid or nonuniform timestamps")
    ratio = Fraction(target / fs).limit_denominator(100000)
    if abs(float(ratio) - target / fs) > 1e-8:
        raise ValueError("Sample-rate ratio cannot be represented accurately")
    resampled = (resample_poly(x, ratio.numerator, ratio.denominator, axis=0,
                               padtype="line" if profile["feature_mode"] == "slow_series" else "constant")
                 if fs != target else x)
    expected = int(round(duration * target))
    if abs(len(resampled) - expected) > 1:
        raise ValueError("Resampling did not produce expected length")
    resampled = resampled[:expected]
    if len(resampled) != expected:
        raise ValueError("Resampling produced too few samples")
    result = {}
    for i, channel in enumerate(profile["channels"]):
        result.update({f"{channel}__{key}": value for key, value in _channel_features(resampled[:, i], profile).items()})
    if not np.isfinite(np.asarray(list(result.values()), dtype=np.float32)).all():
        raise ValueError("Feature float32 overflow")
    return result


def load_window(path, profile):
    """DAQ/backend exchange: NPZ with waveform and required sensor identity."""
    with np.load(path, allow_pickle=False) as data:
        required = {"samples", "sampling_rate_hz", "sensor_type", "unit", "channels", "profile_id"}
        if not required <= set(data.files):
            raise ValueError(f"Window missing fields {sorted(required - set(data.files))}: {path}")
        if str(data["sensor_type"]) != profile["sensor_type"] or str(data["unit"]) != profile["unit"] or str(data["profile_id"]) != profile["profile_id"] or list(data["channels"].astype(str)) != profile["channels"]:
            raise ValueError(f"Window sensor identity/profile mismatch: {path}")
        samples = data["samples"]
        fs = float(data["sampling_rate_hz"])
        timestamps = data["timestamps"] if "timestamps" in data else None
    return samples, fs, timestamps
