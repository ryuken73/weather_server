import json

import numpy as np
import xarray as xr

from kim_hgt_converter.contracts import ANOMALY_VALUE_MAX, ANOMALY_VALUE_MIN
from kim_hgt_converter.converter import convert_sequence, convert_single
from kim_hgt_converter.dataset import find_target_level_index
from kim_hgt_converter.packing import load_packed_png


def test_find_target_level_index_uses_500hpa_value():
    levels = np.array([1000.0, 700.0, 500.0, 300.0])

    assert find_target_level_index(levels) == 2


def test_single_conversion_writes_assets_and_decodes_values(tmp_path):
    input_path = tmp_path / "g576_v091_glob_prs.025deg.2byte.ft015.2026041000.nc"
    output_dir = tmp_path / "out"
    _write_test_dataset(input_path)

    result = convert_single(input_path, output_dir)

    assert result.data_png.exists()
    assert result.metadata_json.exists()
    assert result.preview_png.exists()
    assert result.anomaly_png.exists()

    metadata = json.loads(result.metadata_json.read_text(encoding="utf-8"))
    assert metadata["variable"]["name"] == "hgt"
    assert metadata["variable"]["levelIndex"] == 13
    assert metadata["variable"]["expectedLevelIndexMatches"] is True
    assert metadata["encoding"]["packing"] == "uint16-rg-big-endian"
    assert metadata["statistics"]["clippedLowCount"] == 1
    assert metadata["statistics"]["clippedHighCount"] == 1
    assert metadata["statistics"]["missingCount"] == 1
    assert metadata["assets"]["anomalyPng"].endswith("_anomaly.png")
    assert metadata["anomaly"]["encoding"]["valueMin"] == ANOMALY_VALUE_MIN
    assert metadata["anomaly"]["encoding"]["valueMax"] == ANOMALY_VALUE_MAX

    decoded = load_packed_png(result.data_png)
    expected = np.array(
        [
            [4500.0, 5000.0, 6500.0],
            [4500.0, 4500.0, 6500.0],
        ]
    )
    assert decoded.shape == expected.shape
    assert np.max(np.abs(decoded - expected)) <= (2000.0 / 65535.0)


def test_sequence_conversion_interpolates_frames_and_writes_manifest(tmp_path):
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "out"
    input_dir.mkdir()
    _write_test_dataset(
        input_dir / "g576_v091_glob_prs.025deg.2byte.ft000.2026041000.nc",
        valid_time="2026-04-10T00:00:00",
        hgt_values=np.full((2, 3), 5000.0),
    )
    _write_test_dataset(
        input_dir / "g576_v091_glob_prs.025deg.2byte.ft003.2026041000.nc",
        valid_time="2026-04-10T03:00:00",
        hgt_values=np.full((2, 3), 5300.0),
    )

    result = convert_sequence(
        input_dir=input_dir,
        output_dir=output_dir,
        tmfc="2026041000",
        max_hours=3,
        interval_minutes=60,
    )

    assert result.manifest_json.exists()
    assert result.frame_count == 4
    assert len(result.data_pngs) == 4
    assert len(result.metadata_jsons) == 4
    assert len(result.preview_pngs) == 4
    assert len(result.anomaly_pngs) == 4

    manifest = json.loads(result.manifest_json.read_text(encoding="utf-8"))
    assert manifest["datasetId"] == "kim-glob-hgt500-2026041000"
    assert manifest["defaultValueRange"] == [5000.0, 5300.0]
    assert manifest["sequenceStatistics"]["frameCount"] == 4
    assert [frame["forecastHour"] for frame in manifest["frames"]] == [0, 1, 2, 3]
    assert all(frame["anomalyPng"].endswith("_anomaly.png") for frame in manifest["frames"])
    assert [frame["validTime"] for frame in manifest["frames"]] == [
        "2026-04-10T00:00:00Z",
        "2026-04-10T01:00:00Z",
        "2026-04-10T02:00:00Z",
        "2026-04-10T03:00:00Z",
    ]

    decoded_mid = load_packed_png(output_dir / manifest["frames"][1]["dataPng"])
    assert np.max(np.abs(decoded_mid - 5100.0)) <= (2000.0 / 65535.0)

    frame_metadata = json.loads((output_dir / manifest["frames"][1]["metadataJson"]).read_text(encoding="utf-8"))
    assert frame_metadata["sequencePolicy"]["outputFrameIntervalMinutes"] == 60
    decoded_anomaly = load_packed_png(
        output_dir / manifest["frames"][1]["anomalyPng"],
        value_min=ANOMALY_VALUE_MIN,
        value_max=ANOMALY_VALUE_MAX,
    )
    assert np.max(np.abs(decoded_anomaly)) <= ((ANOMALY_VALUE_MAX - ANOMALY_VALUE_MIN) / 65535.0)


def _write_test_dataset(path, valid_time="2026-04-10T15:00:00", hgt_values=None):
    levels = np.array(
        [
            1000,
            975,
            950,
            925,
            900,
            875,
            850,
            800,
            750,
            700,
            650,
            600,
            550,
            500,
            450,
            400,
            350,
            300,
            250,
            200,
            150,
            100,
            70,
            50,
        ],
        dtype=np.float32,
    )
    values = np.zeros((1, levels.size, 2, 3), dtype=np.float64)
    values[:, :, :, :] = 5000.0
    values[0, 13, :, :] = (
        hgt_values
        if hgt_values is not None
        else np.array(
            [
                [4500.0, 5000.0, 6500.0],
                [np.nan, 4400.0, 6600.0],
            ]
        )
    )
    ds = xr.Dataset(
        {
            "hgt": (
                ("time", "levs", "lats", "lons"),
                values,
                {"standard_name": "geopotential_height", "units": "m"},
            )
        },
        coords={
            "time": [np.datetime64(valid_time)],
            "levs": levels,
            "lats": np.array([-0.25, 0.0], dtype=np.float32),
            "lons": np.array([0.0, 0.25, 0.5], dtype=np.float32),
        },
    )
    ds.to_netcdf(path, engine="netcdf4")
