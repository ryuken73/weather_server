"""Shared constants / product profiles for KIM TXT packed-PNG conversion."""

from __future__ import annotations

from typing import Any

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

# Product profiles keyed by slug. Hub TXT name may differ from store variable/unit.
PRODUCT_PROFILES: dict[str, dict[str, Any]] = {
    "hgt500": {
        "slug": "hgt500",
        "hub_name": "hgt",
        "variable": "hgt",
        "standard_name": "geopotential_height",
        "source_unit": "m",
        "store_unit": "m",
        "value_offset": 0.0,
        "level_hpa": 500.0,
        "dataset_prefix": "kim-glob-hgt500",
        "asset_type": "kim-hgt500-packed-png",
        "value_min": 4500.0,
        "value_max": 6500.0,
        "anomaly_enabled": True,
        "anomaly_value_min": ANOMALY_VALUE_MIN,
        "anomaly_value_max": ANOMALY_VALUE_MAX,
        "expected_level_index": _LEVEL_INDEX_500,
        "input_subdir": "hgt500_txt",
        "latest_pointer": "hgt500.json",
        "default_colormap": "rainbow-geoid",
    },
    "hgt850": {
        "slug": "hgt850",
        "hub_name": "hgt",
        "variable": "hgt",
        "standard_name": "geopotential_height",
        "source_unit": "m",
        "store_unit": "m",
        "value_offset": 0.0,
        "level_hpa": 850.0,
        "dataset_prefix": "kim-glob-hgt850",
        "asset_type": "kim-hgt850-packed-png",
        "value_min": 800.0,
        "value_max": 1800.0,
        "anomaly_enabled": True,
        "anomaly_value_min": ANOMALY_VALUE_MIN,
        "anomaly_value_max": ANOMALY_VALUE_MAX,
        "expected_level_index": _LEVEL_INDEX_850,
        "input_subdir": "hgt850_txt",
        "latest_pointer": "hgt850.json",
        "default_colormap": "rainbow-geoid",
    },
    "tmp500": {
        "slug": "tmp500",
        "hub_name": "T",
        "variable": "T",
        "standard_name": "air_temperature",
        "source_unit": "K",
        "store_unit": "Cel",
        # Pack as °C for broadcast UI: store = source + offset
        "value_offset": -273.15,
        "level_hpa": 500.0,
        "dataset_prefix": "kim-glob-tmp500",
        "asset_type": "kim-tmp500-packed-png",
        "value_min": -70.0,
        "value_max": 5.0,
        "anomaly_enabled": False,
        "anomaly_value_min": ANOMALY_VALUE_MIN,
        "anomaly_value_max": ANOMALY_VALUE_MAX,
        "expected_level_index": _LEVEL_INDEX_500,
        "input_subdir": "tmp500_txt",
        "latest_pointer": "tmp500.json",
        "default_colormap": "temp-absolute",
    },
}

# Backward-compatible HGT-only level map (level → product).
LEVEL_PROFILES: dict[int, dict[str, Any]] = {
    500: PRODUCT_PROFILES["hgt500"],
    850: PRODUCT_PROFILES["hgt850"],
}

# Backward-compatible aliases for HGT500 defaults.
TARGET_VARIABLE = "hgt"
TARGET_STANDARD_NAME = "geopotential_height"
TARGET_UNIT = "m"
TARGET_LEVEL_HPA = float(LEVEL_PROFILES[500]["level_hpa"])
EXPECTED_LEVEL_INDEX = int(LEVEL_PROFILES[500]["expected_level_index"])
VALUE_MIN = float(LEVEL_PROFILES[500]["value_min"])
VALUE_MAX = float(LEVEL_PROFILES[500]["value_max"])
ASSET_TYPE = str(LEVEL_PROFILES[500]["asset_type"])


def get_product_profile(slug: str) -> dict[str, Any]:
    key = str(slug).strip()
    profile = PRODUCT_PROFILES.get(key)
    if profile is None:
        supported = ", ".join(sorted(PRODUCT_PROFILES))
        raise ValueError(f"unsupported KIM product={slug!r}; supported: {supported}")
    return profile


def get_level_profile(level: int | float | str) -> dict[str, Any]:
    """Resolve HGT level profile (500/850). Prefer get_product_profile for new code."""
    key = int(float(level))
    profile = LEVEL_PROFILES.get(key)
    if profile is None:
        supported = ", ".join(str(k) for k in sorted(LEVEL_PROFILES))
        raise ValueError(f"unsupported HGT level={level!r}; supported: {supported}")
    return profile


def resolve_product(
    *,
    product: str | None = None,
    level_hpa: int | float | str | None = None,
) -> dict[str, Any]:
    if product:
        return get_product_profile(product)
    if level_hpa is not None:
        return get_level_profile(level_hpa)
    return get_product_profile("hgt500")


def dataset_id_for(
    tmfc: str,
    level: int | float | str | None = None,
    *,
    product: str | None = None,
) -> str:
    if product:
        profile = get_product_profile(product)
    elif level is not None:
        profile = get_level_profile(level)
    else:
        profile = get_level_profile(500)
    return f"{profile['dataset_prefix']}-{tmfc}"


def apply_store_transform(values, profile: dict[str, Any]):
    """Convert Hub source units into packed store units (in-place safe copy)."""
    import numpy as np

    offset = float(profile.get("value_offset") or 0.0)
    if offset == 0.0:
        return values
    return np.asarray(values, dtype=np.float32) + np.float32(offset)
