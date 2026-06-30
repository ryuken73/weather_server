"""Local anomaly generation for HGT visualization."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


LOCAL_BACKGROUND_OFFSETS_DEGREES: tuple[tuple[float, float], ...] = (
    (-14.0, 0.0),
    (-8.0, 0.0),
    (8.0, 0.0),
    (14.0, 0.0),
    (-14.0, -4.0),
    (14.0, -4.0),
    (-14.0, 4.0),
    (14.0, 4.0),
)


@dataclass(frozen=True)
class AnomalyMetadata:
    reference: str
    background_offsets_degrees: tuple[tuple[float, float], ...]
    smoothing: str


DEFAULT_ANOMALY_METADATA = AnomalyMetadata(
    reference="local-bilinear-offset-background",
    background_offsets_degrees=LOCAL_BACKGROUND_OFFSETS_DEGREES,
    smoothing="separable-1-2-1",
)


def compute_local_anomaly(values: np.ndarray, *, lon_resolution: float, lat_resolution: float) -> np.ndarray:
    if lon_resolution <= 0 or lat_resolution <= 0:
        raise ValueError("lon_resolution and lat_resolution must be greater than zero")

    frame = np.asarray(values, dtype=np.float64)
    if frame.ndim != 2:
        raise ValueError(f"values must be a 2D array, got shape {frame.shape}")

    finite_mask = np.isfinite(frame)
    fill_value = float(np.nanmean(frame)) if np.any(finite_mask) else 0.0
    filled = np.where(finite_mask, frame, fill_value)
    background = np.zeros_like(filled, dtype=np.float64)

    for lon_offset, lat_offset in LOCAL_BACKGROUND_OFFSETS_DEGREES:
        background += _sample_bilinear_wrapped(
            filled,
            x_offset=lon_offset / lon_resolution,
            y_offset=lat_offset / lat_resolution,
        )

    anomaly = filled - (background / len(LOCAL_BACKGROUND_OFFSETS_DEGREES))
    anomaly = _smooth_separable_121(anomaly)
    return np.where(finite_mask, anomaly, np.nan)


def _sample_bilinear_wrapped(values: np.ndarray, *, x_offset: float, y_offset: float) -> np.ndarray:
    height, width = values.shape
    x = (np.arange(width, dtype=np.float64) + x_offset) % width
    y = np.clip(np.arange(height, dtype=np.float64) + y_offset, 0.0, height - 1.0)

    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    x1 = (x0 + 1) % width
    y1 = np.minimum(y0 + 1, height - 1)
    tx = x - x0
    ty = y - y0

    row0 = values[y0[:, None], x0[None, :]] * (1.0 - tx)[None, :]
    row0 += values[y0[:, None], x1[None, :]] * tx[None, :]
    row1 = values[y1[:, None], x0[None, :]] * (1.0 - tx)[None, :]
    row1 += values[y1[:, None], x1[None, :]] * tx[None, :]

    return row0 * (1.0 - ty)[:, None] + row1 * ty[:, None]


def _smooth_separable_121(values: np.ndarray) -> np.ndarray:
    horizontal = (
        np.roll(values, 1, axis=1)
        + values * 2.0
        + np.roll(values, -1, axis=1)
    ) * 0.25
    padded = np.pad(horizontal, ((1, 1), (0, 0)), mode="edge")
    return (padded[:-2] + padded[1:-1] * 2.0 + padded[2:]) * 0.25
