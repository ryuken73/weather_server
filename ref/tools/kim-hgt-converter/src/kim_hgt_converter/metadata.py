"""Metadata and output path helpers."""

from __future__ import annotations

import json
import re
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Any

from kim_hgt_converter.contracts import (
    ANOMALY_VALUE_MAX,
    ANOMALY_VALUE_MIN,
    ASSET_TYPE,
    DOMAIN,
    EXPECTED_LEVEL_INDEX,
    OUTPUT_FRAME_INTERVAL_MINUTES,
    PACKING,
    PNG_MODE,
    SCHEMA_VERSION,
    SOURCE_FORECAST_INTERVAL_MINUTES,
    TARGET_STANDARD_NAME,
    TARGET_UNIT,
    TARGET_VARIABLE,
    VALUE_MAX,
    VALUE_MIN,
)
from kim_hgt_converter.dataset import DatasetInfo
from kim_hgt_converter.packing import PackingStats


def output_stem(input_path: Path, valid_time: str) -> str:
    prefix = re.sub(r"\.ft\d{3}\.\d{10}\.nc$", "", input_path.name)
    if prefix == input_path.name:
        prefix = input_path.stem
    timestamp = _compact_timestamp(valid_time)
    return f"{prefix}_hgt500_{timestamp}"


def build_metadata(
    info: DatasetInfo,
    stats: PackingStats,
    data_png: str,
    preview_png: str,
    anomaly_png: str | None = None,
    anomaly_stats: PackingStats | None = None,
    anomaly_reference: dict[str, Any] | None = None,
    sequence_policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "assetType": ASSET_TYPE,
        "source": {
            "model": "KIM",
            "domain": DOMAIN,
            "inputFile": info.input_file.name,
            "referenceScript": "ref/kim_hgt_png_generator.py",
        },
        "variable": {
            "name": TARGET_VARIABLE,
            "standardName": info.standard_name or TARGET_STANDARD_NAME,
            "unit": info.unit,
            "dims": list(info.dims),
            "levelIndex": info.level_index,
            "levelValue": info.level_value,
            "levelUnit": "hPa",
            "expectedLevelIndex": EXPECTED_LEVEL_INDEX,
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
            "valueMin": VALUE_MIN,
            "valueMax": VALUE_MAX,
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
                "valueMin": ANOMALY_VALUE_MIN,
                "valueMax": ANOMALY_VALUE_MAX,
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
