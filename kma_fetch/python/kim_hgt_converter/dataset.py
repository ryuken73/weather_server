"""Small dataset metadata helpers shared by the TXT converter."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from datetime import timezone
from pathlib import Path


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


def parse_kim_filename(filename: str) -> dict[str, int | str | None]:
    name = Path(filename).name
    match = re.search(r"\.ft(?P<forecast>\d{3})\.(?P<analysis>\d{10})\.nc$", name)
    if not match:
        # API TXT downloads: kim_glob_prs_hgt500_ft000_2026070100.txt
        match = re.search(
            r"_ft(?P<forecast>\d{3})_(?P<analysis>\d{10})(?:\.txt)?$",
            name,
            flags=re.IGNORECASE,
        )
    if not match:
        return {"forecast_hour": None, "analysis_time": None}

    analysis = datetime.strptime(match.group("analysis"), "%Y%m%d%H").replace(tzinfo=timezone.utc)
    return {
        "forecast_hour": int(match.group("forecast")),
        "analysis_time": analysis.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
