"""Metadata and output path helpers."""

from __future__ import annotations

import json
import re
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Any

from kim_hgt_converter.contracts import ANOMALY_VALUE_MAX
from kim_hgt_converter.contracts import ANOMALY_VALUE_MIN
from kim_hgt_converter.contracts import DOMAIN
from kim_hgt_converter.contracts import OUTPUT_FRAME_INTERVAL_MINUTES
from kim_hgt_converter.contracts import PACKING
from kim_hgt_converter.contracts import PNG_MODE
from kim_hgt_converter.contracts import SCHEMA_VERSION
from kim_hgt_converter.contracts import SOURCE_FORECAST_INTERVAL_MINUTES
from kim_hgt_converter.contracts import TARGET_STANDARD_NAME
from kim_hgt_converter.contracts import TARGET_UNIT
from kim_hgt_converter.contracts import TARGET_VARIABLE
from kim_hgt_converter.contracts import get_level_profile
from kim_hgt_converter.dataset import DatasetInfo
from kim_hgt_converter.packing import PackingStats


def output_stem(input_path: Path, valid_time: str, *, level_hpa: float | int = 500) -> str:
    profile = get_level_profile(level_hpa)
    slug = str(profile["slug"])
    prefix = re.sub(r"\.ft\d{3}\.\d{10}\.nc$", "", input_path.name)
    if prefix == input_path.name:
        prefix = input_path.stem
    timestamp = _compact_timestamp(valid_time)
    return f"{prefix}_{slug}_{timestamp}"


def build_metadata(
    info: DatasetInfo,
    stats: PackingStats,
    data_png: str,
    preview_png: str,
    anomaly_png: str | None = None,
    anomaly_stats: PackingStats | None = None,
    anomaly_reference: dict[str, Any] | None = None,
    sequence_policy: dict[str, Any] | None = None,
    *,
    level_hpa: float | int | None = None,
) -> dict[str, Any]:
    profile = get_level_profile(level_hpa if level_hpa is not None else info.level_value)
    asset_type = str(profile["asset_type"])
    value_min = float(profile["value_min"])
    value_max = float(profile["value_max"])
    anomaly_min = float(profile.get("anomaly_value_min", ANOMALY_VALUE_MIN))
    anomaly_max = float(profile.get("anomaly_value_max", ANOMALY_VALUE_MAX))
    expected_index = int(profile["expected_level_index"])

    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "assetType": asset_type,
        "source": {
            "model": "KIM",
            "domain": DOMAIN,
            "inputFile": info.input_file.name,
            "referenceScript": "kma_fetch/python/kim_hgt_text_sequence_generator.py",
        },
        "variable": {
            "name": TARGET_VARIABLE,
            "standardName": info.standard_name or TARGET_STANDARD_NAME,
            "unit": info.unit,
            "dims": list(info.dims),
            "levelIndex": info.level_index,
            "levelValue": info.level_value,
            "levelUnit": "hPa",
            "expectedLevelIndex": expected_index,
            "expectedLevelIndexMatches": info.expected_level_index_matches,
        },
        "grid": {
            "projection": "equirectangular",
            "width": info.width,
            "height": info.height,
            "lonStart": info.lon_start,
            "lonEnd": info.lon_end,
            "lonResolution": info.lon_resolution,
            "latStart": info.lat_start,
            "latEnd": info.lat_end,
            "latResolution": info.lat_resolution,
            "latOrder": "south-to-north",
        },
        "time": {
            "analysisTime": info.analysis_time,
            "validTime": info.valid_time,
            "forecastHour": info.forecast_hour,
        },
        "encoding": {
            "format": "png",
            "mode": PNG_MODE,
            "packing": PACKING,
            "valueMin": value_min,
            "valueMax": value_max,
            "r": "high_byte",
            "g": "low_byte",
            "b": "unused",
            "alpha": "unused",
            "missingValue": None,
            "missingValuePolicy": "metadata-sentinel",
        },
        "statistics": {
            "frameMin": stats.frame_min,
            "frameMax": stats.frame_max,
            "frameMean": stats.frame_mean,
            "clippedLowCount": stats.clipped_low_count,
            "clippedHighCount": stats.clipped_high_count,
            "missingCount": stats.missing_count,
        },
        "assets": {
            "dataPng": data_png,
            "previewPng": preview_png,
        },
        "sequencePolicy": sequence_policy
        or {
            "sourceForecastIntervalMinutes": SOURCE_FORECAST_INTERVAL_MINUTES,
            "outputFrameIntervalMinutes": OUTPUT_FRAME_INTERVAL_MINUTES,
            "interpolation": "linear",
        },
    }

    if anomaly_png and anomaly_stats:
        payload["assets"]["anomalyPng"] = anomaly_png
        payload["anomaly"] = {
            "unit": TARGET_UNIT,
            "reference": (anomaly_reference or {}).get("reference", "local-bilinear-offset-background"),
            "backgroundOffsetsDegrees": (anomaly_reference or {}).get("backgroundOffsetsDegrees", []),
            "smoothing": (anomaly_reference or {}).get("smoothing", "none"),
            "encoding": {
                "format": "png",
                "mode": PNG_MODE,
                "packing": PACKING,
                "valueMin": anomaly_min,
                "valueMax": anomaly_max,
                "r": "high_byte",
                "g": "low_byte",
                "b": "unused",
                "alpha": "unused",
                "missingValue": None,
                "missingValuePolicy": "metadata-sentinel",
            },
            "statistics": {
                "frameMin": anomaly_stats.frame_min,
                "frameMax": anomaly_stats.frame_max,
                "frameMean": anomaly_stats.frame_mean,
                "clippedLowCount": anomaly_stats.clipped_low_count,
                "clippedHighCount": anomaly_stats.clipped_high_count,
                "missingCount": anomaly_stats.missing_count,
            },
        }

    return payload


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def dataset_info_to_dict(info: DatasetInfo) -> dict[str, Any]:
    payload = asdict(info)
    payload["input_file"] = str(info.input_file)
    return payload


def _compact_timestamp(valid_time: str) -> str:
    clean = valid_time.removesuffix("Z")
    try:
        dt = datetime.fromisoformat(clean)
        return dt.strftime("%Y%m%d%H%M")
    except ValueError:
        return re.sub(r"\D", "", valid_time)[:12]
