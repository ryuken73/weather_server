import json

import numpy as np

from kim_hgt_converter.contracts import ANOMALY_VALUE_MAX, ANOMALY_VALUE_MIN
from kim_hgt_converter.converter import convert_single_text
from kim_hgt_converter.kim_text import extract_hgt500_text
from kim_hgt_converter.packing import load_packed_png


def test_extract_hgt500_text_downsamples_by_mean(tmp_path):
    input_path = tmp_path / "kim_prs_500_hgt.txt"
    _write_text_fixture(input_path)

    frame = extract_hgt500_text(input_path, downsample_factor=2)

    expected = np.array(
        [
            [4503.5, 4505.5, 4507.5],
            [4515.5, 4517.5, 4519.5],
        ],
        dtype=np.float32,
    )
    assert frame.values.shape == (2, 3)
    assert np.allclose(frame.values, expected)
    assert frame.info.analysis_time == "2026-06-28T00:00:00Z"
    assert frame.info.valid_time == "2026-06-28T00:00:00Z"
    assert frame.info.forecast_hour == 0
    assert frame.info.width == 3
    assert frame.info.height == 2
    assert frame.info.lon_resolution == 120.0
    assert frame.info.lat_resolution == 90.0
    assert frame.source.source_width == 6
    assert frame.source.source_height == 4
    assert frame.source.downsample_factor == 2


def test_convert_single_text_writes_assets_and_metadata(tmp_path):
    input_path = tmp_path / "kim_prs_500_hgt.txt"
    output_dir = tmp_path / "out"
    _write_text_fixture(input_path)

    result = convert_single_text(input_path, output_dir, downsample_factor=2)

    assert result.data_png.exists()
    assert result.metadata_json.exists()
    assert result.preview_png.exists()
    assert result.anomaly_png.exists()

    metadata = json.loads(result.metadata_json.read_text(encoding="utf-8"))
    assert metadata["source"]["format"] == "kim-api-text"
    assert metadata["source"]["sourceFile"].endswith("g576_v091_glob_prs.ft000.2026062800.nc")
    assert metadata["grid"]["width"] == 3
    assert metadata["grid"]["height"] == 2
    assert metadata["grid"]["sourceWidth"] == 6
    assert metadata["grid"]["sourceHeight"] == 4
    assert metadata["grid"]["downsampleFactor"] == 2
    assert metadata["assets"]["anomalyPng"].endswith("_anomaly.png")
    assert metadata["anomaly"]["reference"] == "local-bilinear-offset-background"

    decoded = load_packed_png(result.data_png)
    expected = np.array([[4503.5, 4505.5, 4507.5], [4515.5, 4517.5, 4519.5]])
    assert decoded.shape == (2, 3)
    assert np.max(np.abs(decoded - expected)) <= (2000.0 / 65535.0)

    anomaly = load_packed_png(result.anomaly_png, value_min=ANOMALY_VALUE_MIN, value_max=ANOMALY_VALUE_MAX)
    assert anomaly.shape == (2, 3)


def _write_text_fixture(path):
    rows = np.arange(4500, 4524, dtype=np.float32).reshape(4, 6)
    lines = [
        "HTTP/1.1 200 OK",
        "Content-Type: text/plain",
        "# fname: /ARCV/RAWD/MODL/GDPS/NE57/202606/28/00/ERLY/FCST/post/g576_v091_glob_prs.ft000.2026062800.nc, fsize: 0byte",
        "# 변수명 = hgt, unit = m, level =     500, i =       6, j =       4, map = F",
    ]

    for row_index, row in enumerate(rows, start=1):
        lines.append(f"# j = {row_index}")
        lines.append(" ".join(f"{value:.1f}" for value in row[:3]))
        lines.append(" ".join(f"{value:.1f}" for value in row[3:]))

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
