"""KIM HGT conversion workflows."""

from __future__ import annotations

from dataclasses import dataclass
from dataclasses import replace
from datetime import datetime
from datetime import timedelta
from datetime import timezone
from pathlib import Path
from typing import Any

import numpy as np

from kim_hgt_converter.anomaly import DEFAULT_ANOMALY_METADATA, compute_local_anomaly
from kim_hgt_converter.contracts import (
    ANOMALY_VALUE_MAX,
    ANOMALY_VALUE_MIN,
    DOMAIN,
    INTERPOLATION,
    OUTPUT_FRAME_INTERVAL_MINUTES,
    SCHEMA_VERSION,
    SOURCE_FORECAST_INTERVAL_MINUTES,
    TARGET_VARIABLE,
    TARGET_UNIT,
)
from kim_hgt_converter.dataset import ExtractedFrame, extract_hgt500
from kim_hgt_converter.kim_text import TextExtractedFrame
from kim_hgt_converter.kim_text import extract_hgt500_text
from kim_hgt_converter.metadata import build_metadata, output_stem, write_json
from kim_hgt_converter.packing import save_packed_png, save_preview_png


@dataclass(frozen=True)
class ConversionResult:
    data_png: Path
    metadata_json: Path
    preview_png: Path
    anomaly_png: Path


@dataclass(frozen=True)
class SequenceConversionResult:
    manifest_json: Path
    frame_count: int
    data_pngs: tuple[Path, ...]
    metadata_jsons: tuple[Path, ...]
    preview_pngs: tuple[Path, ...]
    anomaly_pngs: tuple[Path, ...]


def convert_single(input_path: Path, output_dir: Path) -> ConversionResult:
    frame = extract_hgt500(input_path)
    return _write_single_frame(frame, output_dir)


def convert_single_text(input_path: Path, output_dir: Path, downsample_factor: int = 1) -> ConversionResult:
    frame = extract_hgt500_text(input_path, downsample_factor=downsample_factor)
    return _write_single_frame(frame, output_dir)


def _write_single_frame(frame: ExtractedFrame | TextExtractedFrame, output_dir: Path) -> ConversionResult:
    stem = output_stem(frame.info.input_file, frame.info.valid_time)

    data_png = output_dir / f"{stem}.png"
    metadata_json = output_dir / f"{stem}.json"
    preview_png = output_dir / f"{stem}_preview.png"
    anomaly_png = output_dir / f"{stem}_anomaly.png"

    stats = save_packed_png(frame.values, data_png)
    anomaly_values = compute_local_anomaly(
        frame.values,
        lon_resolution=frame.info.lon_resolution,
        lat_resolution=frame.info.lat_resolution,
    )
    anomaly_stats = save_packed_png(
        anomaly_values,
        anomaly_png,
        value_min=ANOMALY_VALUE_MIN,
        value_max=ANOMALY_VALUE_MAX,
    )
    save_preview_png(frame.values, preview_png)
    metadata = build_metadata(
        frame.info,
        stats,
        data_png=data_png.name,
        preview_png=preview_png.name,
        anomaly_png=anomaly_png.name,
        anomaly_stats=anomaly_stats,
        anomaly_reference=_anomaly_reference_payload(),
    )
    if isinstance(frame, TextExtractedFrame):
        metadata["source"]["format"] = "kim-api-text"
        metadata["source"]["sourceFile"] = frame.source.source_file
        metadata["grid"]["sourceWidth"] = frame.source.source_width
        metadata["grid"]["sourceHeight"] = frame.source.source_height
        metadata["grid"]["sourceLonResolution"] = frame.source.source_lon_resolution
        metadata["grid"]["sourceLatResolution"] = frame.source.source_lat_resolution
        metadata["grid"]["downsampleFactor"] = frame.source.downsample_factor
    write_json(metadata_json, metadata)

    return ConversionResult(
        data_png=data_png,
        metadata_json=metadata_json,
        preview_png=preview_png,
        anomaly_png=anomaly_png,
    )


def convert_sequence(
    input_dir: Path,
    output_dir: Path,
    tmfc: str,
    max_hours: int = 372,
    interval_minutes: int = OUTPUT_FRAME_INTERVAL_MINUTES,
) -> SequenceConversionResult:
    if interval_minutes <= 0:
        raise ValueError("interval_minutes must be greater than zero")

    source_frames = _find_source_frames(input_dir, tmfc, max_hours)

    if not source_frames:
        raise ValueError(f"no source NetCDF files found for tmfc={tmfc} in {input_dir}")

    _validate_sequence_frames(source_frames)

    frame_entries: list[dict[str, Any]] = []
    data_pngs: list[Path] = []
    metadata_jsons: list[Path] = []
    preview_pngs: list[Path] = []
    anomaly_pngs: list[Path] = []
    frame_means: list[float] = []
    sequence_min = float("inf")
    sequence_max = float("-inf")

    output_index = 0

    for source_index, current in enumerate(source_frames):
        if source_index + 1 < len(source_frames):
            next_frame = source_frames[source_index + 1]
            segment_minutes = _minutes_between(current.info.valid_time, next_frame.info.valid_time)

            if segment_minutes % interval_minutes != 0:
                raise ValueError("interval_minutes must evenly divide each source forecast interval")

            for offset_minutes in range(0, segment_minutes, interval_minutes):
                ratio = offset_minutes / segment_minutes
                valid_time = _add_minutes(current.info.valid_time, offset_minutes)
                forecast_hour = _interpolated_forecast_hour(current.info.forecast_hour, offset_minutes)
                values = current.values * (1.0 - ratio) + next_frame.values * ratio
                output_index = _write_sequence_frame(
                    current=current,
                    values=values,
                    valid_time=valid_time,
                    forecast_hour=forecast_hour,
                    output_dir=output_dir,
                    output_index=output_index,
                    frame_entries=frame_entries,
                    data_pngs=data_pngs,
                    metadata_jsons=metadata_jsons,
                    preview_pngs=preview_pngs,
                    anomaly_pngs=anomaly_pngs,
                    frame_means=frame_means,
                    interval_minutes=interval_minutes,
                )
        else:
            output_index = _write_sequence_frame(
                current=current,
                values=current.values,
                valid_time=current.info.valid_time,
                forecast_hour=current.info.forecast_hour,
                output_dir=output_dir,
                output_index=output_index,
                frame_entries=frame_entries,
                data_pngs=data_pngs,
                metadata_jsons=metadata_jsons,
                preview_pngs=preview_pngs,
                anomaly_pngs=anomaly_pngs,
                frame_means=frame_means,
                interval_minutes=interval_minutes,
            )

    for entry in frame_entries:
        metadata = _read_json(output_dir / entry["metadataJson"])
        stats = metadata["statistics"]
        sequence_min = min(sequence_min, float(stats["frameMin"]))
        sequence_max = max(sequence_max, float(stats["frameMax"]))

    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "datasetId": f"kim-glob-hgt500-{tmfc}",
        "variable": TARGET_VARIABLE,
        "unit": TARGET_UNIT,
        "domain": DOMAIN,
        "defaultColorMap": "rainbow-geoid",
        "defaultValueRange": [sequence_min, sequence_max],
        "defaultAnomalyReference": "sequenceMean",
        "sourceForecastIntervalMinutes": SOURCE_FORECAST_INTERVAL_MINUTES,
        "outputFrameIntervalMinutes": interval_minutes,
        "interpolation": INTERPOLATION,
        "sequenceStatistics": {
            "frameMin": sequence_min,
            "frameMax": sequence_max,
            "frameMean": float(np.mean(frame_means)) if frame_means else float("nan"),
            "frameCount": len(frame_entries),
        },
        "frames": frame_entries,
    }
    manifest_json = output_dir / "manifest.json"
    write_json(manifest_json, manifest)

    return SequenceConversionResult(
        manifest_json=manifest_json,
        frame_count=len(frame_entries),
        data_pngs=tuple(data_pngs),
        metadata_jsons=tuple(metadata_jsons),
        preview_pngs=tuple(preview_pngs),
        anomaly_pngs=tuple(anomaly_pngs),
    )


def _find_source_frames(input_dir: Path, tmfc: str, max_hours: int) -> list[ExtractedFrame]:
    paths = sorted(input_dir.glob(f"*.ft*.{tmfc}.nc"))
    selected: list[tuple[int, ExtractedFrame]] = []

    for path in paths:
        frame = extract_hgt500(path)
        forecast_hour = frame.info.forecast_hour

        if forecast_hour is not None and forecast_hour <= max_hours:
            selected.append((int(forecast_hour), frame))

    return [frame for _, frame in sorted(selected, key=lambda item: item[0])]


def _validate_sequence_frames(source_frames: list[ExtractedFrame]) -> None:
    first = source_frames[0]

    for frame in source_frames[1:]:
        if frame.values.shape != first.values.shape:
            raise ValueError("all source frames must use the same grid shape")

        if frame.info.analysis_time != first.info.analysis_time:
            raise ValueError("all source frames must share the same analysis time")


def _write_sequence_frame(
    *,
    current: ExtractedFrame,
    values: np.ndarray,
    valid_time: str,
    forecast_hour: float | int | None,
    output_dir: Path,
    output_index: int,
    frame_entries: list[dict[str, Any]],
    data_pngs: list[Path],
    metadata_jsons: list[Path],
    preview_pngs: list[Path],
    anomaly_pngs: list[Path],
    frame_means: list[float],
    interval_minutes: int,
) -> int:
    info = replace(
        current.info,
        valid_time=valid_time,
        forecast_hour=forecast_hour,
    )
    stem = output_stem(info.input_file, valid_time)
    data_png = output_dir / f"{stem}.png"
    metadata_json = output_dir / f"{stem}.json"
    preview_png = output_dir / f"{stem}_preview.png"
    anomaly_png = output_dir / f"{stem}_anomaly.png"
    stats = save_packed_png(values, data_png)
    anomaly_values = compute_local_anomaly(
        values,
        lon_resolution=info.lon_resolution,
        lat_resolution=info.lat_resolution,
    )
    anomaly_stats = save_packed_png(
        anomaly_values,
        anomaly_png,
        value_min=ANOMALY_VALUE_MIN,
        value_max=ANOMALY_VALUE_MAX,
    )

    save_preview_png(values, preview_png)
    write_json(
        metadata_json,
        build_metadata(
            info,
            stats,
            data_png=data_png.name,
            preview_png=preview_png.name,
            anomaly_png=anomaly_png.name,
            anomaly_stats=anomaly_stats,
            anomaly_reference=_anomaly_reference_payload(),
            sequence_policy={
                "sourceForecastIntervalMinutes": SOURCE_FORECAST_INTERVAL_MINUTES,
                "outputFrameIntervalMinutes": interval_minutes,
                "interpolation": INTERPOLATION,
            },
        ),
    )
    frame_entries.append(
        {
            "index": output_index,
            "forecastHour": forecast_hour,
            "validTime": valid_time,
            "dataPng": data_png.name,
            "metadataJson": metadata_json.name,
            "previewPng": preview_png.name,
            "anomalyPng": anomaly_png.name,
        },
    )
    data_pngs.append(data_png)
    metadata_jsons.append(metadata_json)
    preview_pngs.append(preview_png)
    anomaly_pngs.append(anomaly_png)
    frame_means.append(stats.frame_mean)

    return output_index + 1


def _anomaly_reference_payload() -> dict[str, Any]:
    return {
        "reference": DEFAULT_ANOMALY_METADATA.reference,
        "backgroundOffsetsDegrees": [
            {"lon": lon_offset, "lat": lat_offset}
            for lon_offset, lat_offset in DEFAULT_ANOMALY_METADATA.background_offsets_degrees
        ],
        "smoothing": DEFAULT_ANOMALY_METADATA.smoothing,
    }


def _minutes_between(start: str, end: str) -> int:
    minutes = int((_parse_iso(end) - _parse_iso(start)).total_seconds() / 60)

    if minutes <= 0:
        raise ValueError("source frame valid times must be strictly increasing")

    return minutes


def _add_minutes(valid_time: str, minutes: int) -> str:
    return _format_iso(_parse_iso(valid_time) + timedelta(minutes=minutes))


def _interpolated_forecast_hour(forecast_hour: float | int | None, offset_minutes: int) -> float | int | None:
    if forecast_hour is None:
        return None

    value = float(forecast_hour) + offset_minutes / 60

    return int(value) if value.is_integer() else value


def _parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.removesuffix("Z")).replace(tzinfo=timezone.utc)


def _format_iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _read_json(path: Path) -> dict[str, Any]:
    import json

    return json.loads(path.read_text(encoding="utf-8"))
