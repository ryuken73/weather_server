from __future__ import annotations

import argparse
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from kim_hgt_converter.converter import convert_text_sequence


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Convert KIM API TXT HGT500 frames into a packed PNG sequence.")
    parser.add_argument("--input-dir", required=True, help="Directory containing downloaded KIM TXT files.")
    parser.add_argument("--output-dir", required=True, help="Directory for generated dataset assets.")
    parser.add_argument("--tmfc", required=True, help="Analysis time in YYYYMMDDHH format.")
    parser.add_argument("--max-hours", type=int, default=72, help="Maximum forecast hour to include.")
    parser.add_argument("--interval", type=int, default=10, help="Output frame interval in minutes.")
    parser.add_argument("--downsample", type=int, default=3, help="Mean downsample factor.")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    result = convert_text_sequence(
        input_dir=Path(args.input_dir),
        output_dir=Path(args.output_dir),
        tmfc=str(args.tmfc),
        max_hours=int(args.max_hours),
        interval_minutes=int(args.interval),
        downsample_factor=int(args.downsample),
    )
    print(f"manifest_json={result.manifest_json}")
    print(f"frame_count={result.frame_count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
