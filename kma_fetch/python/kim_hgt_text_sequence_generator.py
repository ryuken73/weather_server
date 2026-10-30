from __future__ import annotations

import argparse
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from kim_hgt_converter.contracts import LEVEL_PROFILES
from kim_hgt_converter.contracts import PRODUCT_PROFILES
from kim_hgt_converter.converter import convert_text_sequence


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Convert KIM API TXT frames into a packed PNG sequence."
    )
    parser.add_argument("--input-dir", required=True, help="Directory containing downloaded KIM TXT files.")
    parser.add_argument("--output-dir", required=True, help="Directory for generated dataset assets.")
    parser.add_argument("--tmfc", required=True, help="Analysis time in YYYYMMDDHH format.")
    parser.add_argument("--max-hours", type=int, default=72, help="Maximum forecast hour to include.")
    parser.add_argument("--interval", type=int, default=10, help="Output frame interval in minutes.")
    parser.add_argument("--downsample", type=int, default=3, help="Mean downsample factor.")
    parser.add_argument(
        "--product",
        choices=sorted(PRODUCT_PROFILES.keys()),
        default=None,
        help="Product slug (hgt500, hgt850, tmp500). Preferred over --level.",
    )
    parser.add_argument(
        "--level",
        type=int,
        default=None,
        choices=sorted(LEVEL_PROFILES.keys()),
        help="Deprecated HGT-only alias: maps to product hgt{level}.",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    product = args.product
    level_hpa = args.level
    if product is None and level_hpa is None:
        product = "hgt500"
    if product is None and level_hpa is not None:
        product = f"hgt{int(level_hpa)}"

    result = convert_text_sequence(
        input_dir=Path(args.input_dir),
        output_dir=Path(args.output_dir),
        tmfc=str(args.tmfc),
        max_hours=int(args.max_hours),
        interval_minutes=int(args.interval),
        downsample_factor=int(args.downsample),
        product=str(product),
    )
    print(f"manifest_json={result.manifest_json}")
    print(f"frame_count={result.frame_count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
