"""Deterministic features for explicitly configured, uniformly sampled signals."""
from __future__ import annotations

import numpy as np
from scipy import stats


def extract_features(values, sampling_rate_hz: float, bands=None) -> dict[str, float]:
    """Extract one channel; reject invalid samples instead of silently imputing."""
    x = np.asarray(values, dtype=np.float64)
    if x.ndim != 1 or len(x) < 4 or not np.isfinite(x).all():
        raise ValueError("A window needs >=4 finite, one-dimensional samples")
    if not np.isfinite(sampling_rate_hz) or sampling_rate_hz <= 0:
        raise ValueError("sampling_rate_hz must be positive")
    rms = float(np.sqrt(np.mean(x * x)))
    flat = float(np.ptp(x)) <= 1e-12 * max(1.0, float(np.max(np.abs(x))))
    std = 0.0 if flat else float(np.std(x))
    result = {
        "mean": float(np.mean(x)), "std": std, "rms": rms,
        "peak_to_peak": float(np.ptp(x)),
        "crest_factor": float(np.max(np.abs(x)) / rms) if rms else 0.0,
        "skewness": float(stats.skew(x, bias=False)) if not flat else 0.0,
        "kurtosis": float(stats.kurtosis(x, fisher=True, bias=False)) if not flat else 0.0,
    }
    # Remove DC and apply Hann taper; frequency features describe AC content.
    spectrum = np.fft.rfft((x - np.mean(x)) * np.hanning(len(x)))
    power = np.abs(spectrum) ** 2
    frequency = np.fft.rfftfreq(len(x), 1.0 / sampling_rate_hz)
    total = float(power.sum())
    probabilities = power / total if total else np.zeros_like(power)
    positive = probabilities[probabilities > 0]
    result.update({
        "dominant_frequency_hz": float(frequency[np.argmax(power)]) if total else 0.0,
        "spectral_centroid_hz": float(np.dot(frequency, probabilities)),
        "spectral_entropy": float(-np.sum(positive * np.log2(positive)) / np.log2(len(power))) if total else 0.0,
    })
    for index, (low, high) in enumerate(bands or []):
        if not 0 <= low < high <= sampling_rate_hz / 2:
            raise ValueError("Frequency bands must lie between zero and Nyquist")
        mask = (frequency >= low) & (frequency < high)
        if high == sampling_rate_hz / 2:
            mask |= frequency == high
        result[f"band_{index}_relative_energy"] = float(probabilities[mask].sum())
    if not all(np.isfinite(v) for v in result.values()):
        raise ValueError("Feature calculation overflowed; check signal scale")
    return result
