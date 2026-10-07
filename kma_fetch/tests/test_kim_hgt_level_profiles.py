"""Level profile / header validation smoke for KIM HGT converter.

  python kma_fetch/tests/test_kim_hgt_level_profiles.py
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "python"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from kim_hgt_converter.contracts import LEVEL_PROFILES
from kim_hgt_converter.contracts import dataset_id_for
from kim_hgt_converter.contracts import get_level_profile
from kim_hgt_converter.dataset import parse_kim_filename
from kim_hgt_converter.kim_text import extract_hgt_text
from kim_hgt_converter.metadata import output_stem


def _write_tiny_txt(path: Path, *, level: float, analysis: str, forecast: int) -> None:
    # 2x2 grid — downsample factor 1 only
    lines = [
        f"# fname: g576_v091_glob_prs.ft{forecast:03d}.{analysis}.nc",
        f"# = hgt , unit = m , level = {level:g} , i = 2 , j = 2 , map = F",
        "# j = 1",
        "1200.0 1210.0",
        "# j = 2",
        "1190.0 1205.0",
        "",
    ]
    if level == 500.0:
        lines[3] = "5500.0 5510.0"
        lines[5] = "5490.0 5505.0"
    path.write_text("\n".join(lines), encoding="utf-8")


class LevelProfileTests(unittest.TestCase):
    def test_profiles(self):
        p500 = get_level_profile(500)
        p850 = get_level_profile(850)
        self.assertEqual(p500["value_min"], 4500.0)
        self.assertEqual(p500["value_max"], 6500.0)
        self.assertEqual(p850["value_min"], 800.0)
        self.assertEqual(p850["value_max"], 1800.0)
        self.assertEqual(dataset_id_for("2026070100", 850), "kim-glob-hgt850-2026070100")
        self.assertEqual(sorted(LEVEL_PROFILES.keys()), [500, 850])

    def test_parse_txt_filename(self):
        info = parse_kim_filename("kim_glob_prs_hgt850_ft003_2026070100.txt")
        self.assertEqual(info["forecast_hour"], 3)
        self.assertEqual(info["analysis_time"], "2026-07-01T00:00:00Z")

    def test_extract_level_guards(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            f500 = root / "a.txt"
            f850 = root / "b.txt"
            _write_tiny_txt(f500, level=500.0, analysis="2026070100", forecast=0)
            _write_tiny_txt(f850, level=850.0, analysis="2026070100", forecast=0)

            ok500 = extract_hgt_text(f500, level_hpa=500)
            self.assertEqual(ok500.info.level_value, 500.0)
            self.assertAlmostEqual(float(ok500.values.mean()), 5501.25, places=2)

            ok850 = extract_hgt_text(f850, level_hpa=850)
            self.assertEqual(ok850.info.level_value, 850.0)
            self.assertAlmostEqual(float(ok850.values.mean()), 1201.25, places=2)

            with self.assertRaises(ValueError):
                extract_hgt_text(f500, level_hpa=850)

            stem = output_stem(Path("x.ft000.2026070100.nc"), "2026-07-01T00:00:00Z", level_hpa=850)
            self.assertIn("_hgt850_", stem)


if __name__ == "__main__":
    unittest.main()
