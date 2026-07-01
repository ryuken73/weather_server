"""KIM NetCDF metadata inspection and extraction."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import xarray as xr

from kim_hgt_converter.contracts import (
    EXPECTED_LEVEL_INDEX,
    TARGET_LEVEL_HPA,
    TARGET_STANDARD_NAME,
    TARGET_UNIT,
    TARGET_VARIABLE,
)


@dataclass(frozen=True)
class DatasetInfo:
    input_file: Path
    variable_name: str
    standard_name: str
    unit: str
    dims: tuple[str, ...]
    level_index: int
    level_value: float
    expected_level_index_matches: bool
    width: int
    height: int
    lon_start: float
    lon_end: float
    lon_resolution: float
    lat_start: float
    lat_end: float
    lat_resolution: float
    valid_time: str
    analysis_time: str | None
    forecast_hour: float | int | None


@dataclass(frozen=True)
class ExtractedFrame:
    info: DatasetInfo
    values: np.ndarray


def inspect_netcdf(input_path: Path) -> DatasetInfo:
    with xr.open_dataset(input_path, engine="netcdf4") as ds:
        _validate_dataset(ds)
        level_index = find_target_level_index(ds["levs"].values)
        return _build_dataset_info(input_path, ds, level_index)


def extract_hgt500(input_path: Path) -> ExtractedFrame:
    with xr.open_dataset(input_path, engine="netcdf4") as ds:
        _validate_dataset(ds)
        level_index = find_target_level_index(ds["levs"].values)
        info = _build_dataset_info(input_path, ds, level_index)
        data = ds[TARGET_VARIABLE].isel(levs=level_index)

        if "time" in data.dims:
            data = data.isel(time=0)

        values = np.asarray(data.load().values, dtype=np.float64)

    if values.ndim != 2:
        raise ValueError(f"expected 2D HGT frame after slicing, got shape {values.shape}")

    return ExtractedFrame(info=info, values=values)


def find_target_level_index(levels: np.ndarray, target_level: float = TARGET_LEVEL_HPA) -> int:
    if levels.size == 0:
        raise ValueError("levs coordinate is empty")

    numeric_levels = np.asarray(levels, dtype=np.float64)
    index = int(np.argmin(np.abs(numeric_levels - target_level)))
    if not np.isclose(numeric_levels[index], target_level, atol=0.001):
        raise ValueError(f"500hPa level was not found; nearest level is {numeric_levels[index]}")

    return index


def _validate_dataset(ds: xr.Dataset) -> None:
    missing = [name for name in [TARGET_VARIABLE, "levs", "lats", "lons", "time"] if name not in ds]
    if missing:
        raise ValueError(f"required NetCDF variables or coordinates are missing: {', '.join(missing)}")

    variable = ds[TARGET_VARIABLE]
    for dim in ["time", "levs", "lats", "lons"]:
        if dim not in variable.dims:
            raise ValueError(f"{TARGET_VARIABLE} is missing required dimension: {dim}")

    unit = variable.attrs.get("units")
    if unit and unit != TARGET_UNIT:
        raise ValueError(f"expected {TARGET_VARIABLE} unit '{TARGET_UNIT}', got '{unit}'")


def _build_dataset_info(input_path: Path, ds: xr.Dataset, level_index: int) -> DatasetInfo:
    variable = ds[TARGET_VARIABLE]
    lats = np.asarray(ds["lats"].values, dtype=np.float64)
    lons = np.asarray(ds["lons"].values, dtype=np.float64)
    levels = np.asarray(ds["levs"].values, dtype=np.float64)
    parsed = parse_kim_filename(input_path.name)

    return DatasetInfo(
        input_file=input_path,
        variable_name=TARGET_VARIABLE,
        standard_name=str(variable.attrs.get("standard_name", TARGET_STANDARD_NAME)),
        unit=str(variable.attrs.get("units", TARGET_UNIT)),
        dims=tuple(str(dim) for dim in variable.dims),
        level_index=level_index,
        level_value=float(levels[level_index]),
        expected_level_index_matches=level_index == EXPECTED_LEVEL_INDEX,
        width=int(lons.size),
        height=int(lats.size),
        lon_start=float(lons[0]),
        lon_end=float(lons[-1]),
        lon_resolution=_resolution(lons),
        lat_start=float(lats[0]),
        lat_end=float(lats[-1]),
        lat_resolution=_resolution(lats),
        valid_time=_datetime64_to_iso(ds["time"].values[0]),
        analysis_time=parsed["analysis_time"],
        forecast_hour=parsed["forecast_hour"],
    )


def parse_kim_filename(filename: str) -> dict[str, int | str | None]:
    match = re.search(r"\.ft(?P<forecast>\d{3})\.(?P<analysis>\d{10})\.nc$", filename)
    if not match:
        return {"forecast_hour": None, "analysis_time": None}

    analysis = datetime.strptime(match.group("analysis"), "%Y%m%d%H").replace(tzinfo=timezone.utc)
    return {
        "forecast_hour": int(match.group("forecast")),
        "analysis_time": analysis.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def _resolution(values: np.ndarray) -> float:
    if values.size < 2:
        return 0.0
    return float(abs(values[1] - values[0]))


def _datetime64_to_iso(value: np.datetime64) -> str:
    text = np.datetime_as_string(value, unit="s")
    return f"{text}Z"
