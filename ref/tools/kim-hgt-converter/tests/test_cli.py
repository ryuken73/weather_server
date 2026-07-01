import pytest
import xarray as xr
import numpy as np

from kim_hgt_converter.cli import main


def test_help_returns_success(capsys):
    with pytest.raises(SystemExit) as exc_info:
        main(["--help"])

    assert exc_info.value.code == 0
    captured = capsys.readouterr()
    assert "kim-hgt-convert" in captured.out
    assert "single" in captured.out
    assert "single-text" in captured.out
    assert "sequence" in captured.out
    assert "inspect" in captured.out


def test_sequence_subcommand_writes_manifest(tmp_path, capsys):
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
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

    assert (
        main(
            [
                "sequence",
                "--input-dir",
                str(input_dir),
                "--tmfc",
                "2026041000",
                "--output-dir",
                str(output_dir),
                "--max-hours",
                "3",
                "--interval",
                "60",
            ]
        )
        == 0
    )
    captured = capsys.readouterr()
    assert "manifest_json=" in captured.out
    assert "frame_count=4" in captured.out


def test_inspect_prints_dataset_info(tmp_path, capsys):
    path = tmp_path / "g576_v091_glob_prs.025deg.2byte.ft015.2026041000.nc"
    _write_test_dataset(path)

    assert main(["inspect", "--input", str(path)]) == 0
    captured = capsys.readouterr()

    assert '"variable_name": "hgt"' in captured.out
    assert '"level_index": 13' in captured.out
    assert '"forecast_hour": 15' in captured.out


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
