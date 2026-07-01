"""Command-line interface skeleton for KIM HGT conversion."""

from __future__ import annotations

import argparse
import json
from collections.abc import Sequence
from pathlib import Path

from kim_hgt_converter import __version__
from kim_hgt_converter.converter import convert_sequence, convert_single, convert_single_text
from kim_hgt_converter.dataset import inspect_netcdf
from kim_hgt_converter.metadata import dataset_info_to_dict


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="kim-hgt-convert",
        description="Convert KIM GLOB 500hPa HGT NetCDF data into packed PNG assets.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")

    subparsers = parser.add_subparsers(dest="command")

    inspect_parser = subparsers.add_parser(
        "inspect",
        help="Inspect NetCDF metadata.",
    )
    inspect_parser.add_argument("--input", required=True, help="Path to a KIM NetCDF file.")
    inspect_parser.set_defaults(handler=_inspect)

    single_parser = subparsers.add_parser(
        "single",
        help="Convert one NetCDF file.",
    )
    single_parser.add_argument("--input", required=True, help="Path to a KIM NetCDF file.")
    single_parser.add_argument("--output-dir", required=True, help="Output directory for generated assets.")
    single_parser.set_defaults(handler=_single)

    text_parser = subparsers.add_parser(
        "single-text",
        help="Convert one KIM API text file.",
    )
    text_parser.add_argument("--input", required=True, help="Path to a KIM API text file.")
    text_parser.add_argument("--output-dir", required=True, help="Output directory for generated assets.")
    text_parser.add_argument(
        "--downsample",
        type=int,
        default=1,
        help="Mean downsample factor. Use 3 to convert 1/12 degree source into 0.25 degree web assets.",
    )
    text_parser.set_defaults(handler=_single_text)

    sequence_parser = subparsers.add_parser(
        "sequence",
        help="Convert a forecast sequence. Implementation starts in Phase 5.",
    )
    sequence_parser.add_argument("--input-dir", required=True, help="Directory containing KIM NetCDF files.")
    sequence_parser.add_argument("--tmfc", required=True, help="Analysis time in YYYYMMDDHH format.")
    sequence_parser.add_argument("--output-dir", required=True, help="Output directory for generated assets.")
    sequence_parser.add_argument("--max-hours", type=int, default=372, help="Maximum forecast hour.")
    sequence_parser.add_argument("--interval", type=int, default=10, help="Output frame interval in minutes.")
    sequence_parser.set_defaults(handler=_sequence)

    return parser


def _inspect(args: argparse.Namespace) -> int:
    info = inspect_netcdf(Path(args.input))
    print(json.dumps(dataset_info_to_dict(info), ensure_ascii=False, indent=2))
    return 0


def _single(args: argparse.Namespace) -> int:
    result = convert_single(Path(args.input), Path(args.output_dir))
    print(f"data_png={result.data_png}")
    print(f"metadata_json={result.metadata_json}")
    print(f"preview_png={result.preview_png}")
    print(f"anomaly_png={result.anomaly_png}")
    return 0


def _single_text(args: argparse.Namespace) -> int:
    result = convert_single_text(
        Path(args.input),
        Path(args.output_dir),
        downsample_factor=int(args.downsample),
    )
    print(f"data_png={result.data_png}")
    print(f"metadata_json={result.metadata_json}")
    print(f"preview_png={result.preview_png}")
    print(f"anomaly_png={result.anomaly_png}")
    return 0


def _sequence(args: argparse.Namespace) -> int:
    result = convert_sequence(
        input_dir=Path(args.input_dir),
        output_dir=Path(args.output_dir),
        tmfc=str(args.tmfc),
        max_hours=int(args.max_hours),
        interval_minutes=int(args.interval),
    )
    print(f"manifest_json={result.manifest_json}")
    print(f"frame_count={result.frame_count}")
    return 0


def _not_implemented(args: argparse.Namespace) -> int:
    command = args.command or "unknown"
    print(f"'{command}' is planned but not implemented in Phase 0.")
    return 2


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if not hasattr(args, "handler"):
        parser.print_help()
        return 0

    return int(args.handler(args))


if __name__ == "__main__":
    raise SystemExit(main())
