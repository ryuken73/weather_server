"""Packed PNG encoding and decoding helpers."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from kim_hgt_converter.contracts import VALUE_MAX, VALUE_MIN


@dataclass(frozen=True)
class PackingStats:
    frame_min: float
    frame_max: float
    frame_mean: float
    clipped_low_count: int
    clipped_high_count: int
    missing_count: int


def compute_stats(values: np.ndarray, value_min: float = VALUE_MIN, value_max: float = VALUE_MAX) -> PackingStats:
    finite_mask = np.isfinite(values)
    finite_values = values[finite_mask]

    if finite_values.size == 0:
        frame_min = float("nan")
        frame_max = float("nan")
        frame_mean = float("nan")
    else:
        frame_min = float(np.min(finite_values))
        frame_max = float(np.max(finite_values))
        frame_mean = float(np.mean(finite_values))

    return PackingStats(
        frame_min=frame_min,
        frame_max=frame_max,
        frame_mean=frame_mean,
        clipped_low_count=int(np.count_nonzero(finite_values < value_min)),
        clipped_high_count=int(np.count_nonzero(finite_values > value_max)),
        missing_count=int(values.size - finite_values.size),
    )


def encode_values_to_uint16(
    values: np.ndarray,
    value_min: float = VALUE_MIN,
    value_max: float = VALUE_MAX,
) -> np.ndarray:
    finite_values = np.where(np.isfinite(values), values, value_min)
    clipped = np.clip(finite_values, value_min, value_max)
    normalized = (clipped - value_min) / (value_max - value_min)
    return (normalized * 65535.0).astype(np.uint16)


def pack_uint16_to_rgb(encoded: np.ndarray) -> np.ndarray:
    if encoded.dtype != np.uint16:
        raise TypeError("encoded array must use dtype uint16")

    rgb = np.zeros((*encoded.shape, 3), dtype=np.uint8)
    rgb[..., 0] = (encoded >> 8) & 0xFF
    rgb[..., 1] = encoded & 0xFF
    return rgb


def decode_rgb_to_values(
    rgb: np.ndarray,
    value_min: float = VALUE_MIN,
    value_max: float = VALUE_MAX,
) -> np.ndarray:
    if rgb.ndim != 3 or rgb.shape[-1] < 2:
        raise ValueError("rgb array must have shape (height, width, channels>=2)")

    high = rgb[..., 0].astype(np.uint16)
    low = rgb[..., 1].astype(np.uint16)
    encoded = (high << 8) | low
    normalized = encoded.astype(np.float64) / 65535.0
    return normalized * (value_max - value_min) + value_min


def save_packed_png(
    values: np.ndarray,
    output_path: Path,
    value_min: float = VALUE_MIN,
    value_max: float = VALUE_MAX,
) -> PackingStats:
    stats = compute_stats(values, value_min=value_min, value_max=value_max)
    encoded = encode_values_to_uint16(values, value_min=value_min, value_max=value_max)
    rgb = pack_uint16_to_rgb(encoded)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgb, mode="RGB").save(output_path)
    return stats


def load_packed_png(
    input_path: Path,
    value_min: float = VALUE_MIN,
    value_max: float = VALUE_MAX,
) -> np.ndarray:
    with Image.open(input_path) as image:
        rgb = np.asarray(image.convert("RGB"), dtype=np.uint8)
    return decode_rgb_to_values(rgb, value_min=value_min, value_max=value_max)


def make_preview_rgb(values: np.ndarray) -> np.ndarray:
    finite_values = np.where(np.isfinite(values), values, VALUE_MIN)
    normalized = np.clip((finite_values - VALUE_MIN) / (VALUE_MAX - VALUE_MIN), 0.0, 1.0)
    return _rainbow(normalized)


def save_preview_png(values: np.ndarray, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(make_preview_rgb(values), mode="RGB").save(output_path)


def _rainbow(t: np.ndarray) -> np.ndarray:
    stops = np.array(
        [
            [34, 52, 145],
            [44, 145, 214],
            [51, 190, 109],
            [236, 226, 80],
            [237, 128, 43],
            [202, 43, 38],
        ],
        dtype=np.float64,
    )
    scaled = np.clip(t, 0.0, 1.0) * (len(stops) - 1)
    left = np.floor(scaled).astype(np.int32)
    right = np.clip(left + 1, 0, len(stops) - 1)
    frac = scaled - left
    rgb = stops[left] * (1.0 - frac[..., None]) + stops[right] * frac[..., None]
    return rgb.astype(np.uint8)
