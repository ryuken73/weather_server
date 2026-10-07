"""Shared constants for KIM HGT TXT conversion."""

from __future__ import annotations

from typing import Any

TARGET_VARIABLE = "hgt"
TARGET_STANDARD_NAME = "geopotential_height"
TARGET_UNIT = "m"
DOMAIN = "glob"

SCHEMA_VERSION = 1
SOURCE_FORECAST_INTERVAL_MINUTES = 180
OUTPUT_FRAME_INTERVAL_MINUTES = 10
INTERPOLATION = "linear"

PACKING = "uint16-rg-big-endian"
PNG_MODE = "RGB"

ANOMALY_VALUE_MIN = -512.0
ANOMALY_VALUE_MAX = 512.0

# NC pressure-axis indices (informational; TXT path validates header level).
_LEVEL_INDEX_500 = 13
_LEVEL_INDEX_850 = 6

LEVEL_PROFILES: dict[int, dict[str, Any]] = {
    500: {
        "level_hpa": 500.0,
        "slug": "hgt500",
        "dataset_prefix": "kim-glob-hgt500",
        "asset_type": "kim-hgt500-packed-png",
        "value_min": 4500.0,
        "value_max": 6500.0,
        "anomaly_value_min": ANOMALY_VALUE_MIN,
        "anomaly_value_max": ANOMALY_VALUE_MAX,
        "expected_level_index": _LEVEL_INDEX_500,
        "input_subdir": "hgt500_txt",
        "latest_pointer": "hgt500.json",
    },
    850: {
        "level_hpa": 850.0,
        "slug": "hgt850",
        "dataset_prefix": "kim-glob-hgt850",
        "asset_type": "kim-hgt850-packed-png",
        "value_min": 800.0,
        "value_max": 1800.0,
        "anomaly_value_min": ANOMALY_VALUE_MIN,
        "anomaly_value_max": ANOMALY_VALUE_MAX,
        "expected_level_index": _LEVEL_INDEX_850,
        "input_subdir": "hgt850_txt",
        "latest_pointer": "hgt850.json",
    },
}

# Backward-compatible aliases for HGT500 defaults.
TARGET_LEVEL_HPA = float(LEVEL_PROFILES[500]["level_hpa"])
EXPECTED_LEVEL_INDEX = int(LEVEL_PROFILES[500]["expected_level_index"])
VALUE_MIN = float(LEVEL_PROFILES[500]["value_min"])
VALUE_MAX = float(LEVEL_PROFILES[500]["value_max"])
ASSET_TYPE = str(LEVEL_PROFILES[500]["asset_type"])


def get_level_profile(level: int | float | str) -> dict[str, Any]:
    key = int(float(level))
    profile = LEVEL_PROFILES.get(key)
    if profile is None:
        supported = ", ".join(str(k) for k in sorted(LEVEL_PROFILES))
        raise ValueError(f"unsupported HGT level={level!r}; supported: {supported}")
    return profile


def dataset_id_for(tmfc: str, level: int | float | str = 500) -> str:
    profile = get_level_profile(level)
    return f"{profile['dataset_prefix']}-{tmfc}"
