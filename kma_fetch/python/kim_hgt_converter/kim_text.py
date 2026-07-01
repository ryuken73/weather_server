"""KIM API TXT extraction helpers."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from datetime import timedelta
from datetime import timezone
from pathlib import Path

import numpy as np

from kim_hgt_converter.contracts import EXPECTED_LEVEL_INDEX
from kim_hgt_converter.contracts import TARGET_LEVEL_HPA
from kim_hgt_converter.contracts import TARGET_STANDARD_NAME
from kim_hgt_converter.contracts import TARGET_UNIT
from kim_hgt_converter.contracts import TARGET_VARIABLE
from kim_hgt_converter.dataset import DatasetInfo
from kim_hgt_converter.dataset import parse_kim_filename


_FNAME_RE = re.compile(r"^#\s*fname:\s*(?P<fname>[^,]+)")
_GRID_RE = re.compile(
    r"^#.*=\s*(?P<variable>[A-Za-z_]\w*)\s*,\s*"
    r"unit\s*=\s*(?P<unit>[^,]+)\s*,\s*"
    r"level\s*=\s*(?P<level>[-+0-9.eE]+)\s*,\s*"
    r"i\s*=\s*(?P<width>\d+)\s*,\s*"
    r"j\s*=\s*(?P<height>\d+)\s*,\s*"
    r"map\s*=\s*(?P<map>[A-Za-z0-9_]+)"
)
_ROW_RE = re.compile(r"^#\s*j\s*=\s*(?P<row>\d+)")
_NUMERIC_LINE_RE = re.compile(r"^[\s+\-0-9.eE]+$")


@dataclass(frozen=True)
class KimTextSourceInfo:
    source_file: str | None
    source_width: int
    source_height: int
    source_lon_resolution: float
    source_lat_resolution: float
    downsample_factor: int


@dataclass(frozen=True)
class TextExtractedFrame:
    info: DatasetInfo
    values: np.ndarray
    source: KimTextSourceInfo


@dataclass(frozen=True)
class _ParsedKimText:
    source_file: str | None
    width: int
    height: int
    values: np.ndarray


def extract_hgt500_text(input_path: Path, downsample_factor: int = 1) -> TextExtractedFrame:
    if downsample_factor <= 0:
        raise ValueError("downsample_factor must be greater than zero")

    parsed = _parse_kim_text(input_path)
    values = parsed.values

    if downsample_factor > 1:
        values = _downsample_mean(values, downsample_factor)

    source_width = parsed.width
    source_height = parsed.height
    source_lon_resolution = 360.0 / source_width
    source_lat_resolution = 180.0 / source_height
    lon_resolution = source_lon_resolution * downsample_factor
    lat_resolution = source_lat_resolution * downsample_factor
    source_file_name = Path(parsed.source_file).name if parsed.source_file else input_path.name
    filename_info = parse_kim_filename(source_file_name)
    analysis_time = filename_info["analysis_time"]
    forecast_hour = filename_info["forecast_hour"]
    valid_time = _valid_time_from_analysis(analysis_time, forecast_hour)

    info = DatasetInfo(
        input_file=input_path,
        variable_name=TARGET_VARIABLE,
        standard_name=TARGET_STANDARD_NAME,
        unit=TARGET_UNIT,
        dims=("time", "levs", "lats", "lons"),
        level_index=EXPECTED_LEVEL_INDEX,
        level_value=TARGET_LEVEL_HPA,
        expected_level_index_matches=True,
        width=int(values.shape[1]),
        height=int(values.shape[0]),
        lon_start=0.0,
        lon_end=360.0 - lon_resolution,
        lon_resolution=lon_resolution,
        lat_start=-90.0 + lat_resolution / 2.0,
        lat_end=90.0 - lat_resolution / 2.0,
        lat_resolution=lat_resolution,
        valid_time=valid_time,
        analysis_time=str(analysis_time) if analysis_time is not None else None,
        forecast_hour=forecast_hour,
    )

    return TextExtractedFrame(
        info=info,
        values=values,
        source=KimTextSourceInfo(
            source_file=parsed.source_file,
            source_width=source_width,
            source_height=source_height,
            source_lon_resolution=source_lon_resolution,
            source_lat_resolution=source_lat_resolution,
            downsample_factor=downsample_factor,
        ),
    )


def _parse_kim_text(input_path: Path) -> _ParsedKimText:
    source_file: str | None = None
    variable: str | None = None
    unit: str | None = None
    level: float | None = None
    width: int | None = None
    height: int | None = None
    values: np.ndarray | None = None
    row_buffer: np.ndarray | None = None
    row_number: int | None = None
    row_offset = 0
    rows_seen = 0

    def finalize_row() -> None:
        nonlocal row_buffer, row_number, row_offset, rows_seen

        if row_number is None:
            return

        if width is None or height is None or values is None or row_buffer is None:
            raise ValueError("KIM text row appeared before grid metadata")

        if row_offset != width:
            raise ValueError(f"row j={row_number} has {row_offset} values; expected {width}")

        if row_number < 1 or row_number > height:
            raise ValueError(f"row j={row_number} is outside expected 1..{height}")

        values[row_number - 1, :] = row_buffer
        rows_seen += 1
        row_buffer = None
        row_number = None
        row_offset = 0

    with input_path.open("r", encoding="utf-8", errors="replace") as file:
        for raw_line in file:
            line = raw_line.strip()

            if not line:
                continue

            fname_match = _FNAME_RE.match(line)
            if fname_match:
                source_file = fname_match.group("fname").strip()
                continue

            grid_match = _GRID_RE.match(line)
            if grid_match:
                variable = grid_match.group("variable").strip()
                unit = grid_match.group("unit").strip()
                level = float(grid_match.group("level"))
                width = int(grid_match.group("width"))
                height = int(grid_match.group("height"))
                values = np.empty((height, width), dtype=np.float32)
                continue

            row_match = _ROW_RE.match(line)
            if row_match:
                finalize_row()

                if width is None:
                    raise ValueError("KIM text row appeared before grid metadata")

                row_number = int(row_match.group("row"))
                row_buffer = np.empty(width, dtype=np.float32)
                row_offset = 0
                continue

            if row_number is None:
                continue

            if not _NUMERIC_LINE_RE.match(line):
                continue

            if row_buffer is None or width is None:
                raise ValueError("KIM text parser is missing the active row buffer")

            numbers = np.fromstring(line, sep=" ", dtype=np.float32)
            if numbers.size == 0:
                continue

            next_offset = row_offset + int(numbers.size)
            if next_offset > width:
                raise ValueError(f"row j={row_number} has more than {width} values")

            row_buffer[row_offset:next_offset] = numbers
            row_offset = next_offset

    finalize_row()

    if variable != TARGET_VARIABLE:
        raise ValueError(f"expected variable '{TARGET_VARIABLE}', got '{variable}'")

    if unit != TARGET_UNIT:
        raise ValueError(f"expected unit '{TARGET_UNIT}', got '{unit}'")

    if level is None or not np.isclose(level, TARGET_LEVEL_HPA, atol=0.001):
        raise ValueError(f"expected level {TARGET_LEVEL_HPA:g}hPa, got {level}")

    if width is None or height is None or values is None:
        raise ValueError("KIM text grid metadata was not found")

    if rows_seen != height:
        raise ValueError(f"KIM text has {rows_seen} rows; expected {height}")

    return _ParsedKimText(
        source_file=source_file,
        width=width,
        height=height,
        values=values,
    )


def _downsample_mean(values: np.ndarray, factor: int) -> np.ndarray:
    height, width = values.shape

    if width % factor != 0 or height % factor != 0:
        raise ValueError(f"grid shape {width}x{height} is not evenly divisible by downsample factor {factor}")

    return values.reshape(height // factor, factor, width // factor, factor).mean(axis=(1, 3))


def _valid_time_from_analysis(analysis_time: int | str | None, forecast_hour: int | float | None) -> str:
    if isinstance(analysis_time, str):
        analysis = datetime.strptime(analysis_time, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        valid = analysis + timedelta(hours=float(forecast_hour or 0))
        return valid.strftime("%Y-%m-%dT%H:%M:%SZ")

    return "1970-01-01T00:00:00Z"
