# KIM HGT Converter

Python CLI package for converting KIM GLOB NetCDF 500hPa geopotential height (`hgt`) data into packed PNG, metadata JSON, manifest JSON, and preview PNG assets.

The converter supports NetCDF inspection, single-file conversion, and Phase 5 sequence conversion.

## Commands

Show CLI help:

```powershell
uv run kim-hgt-convert --help
```

Inspect a NetCDF file:

```powershell
uv run kim-hgt-convert inspect --input ..\..\g576_v091_glob_prs.025deg.2byte.ft015.2026041000.nc
```

Convert one file:

```powershell
uv run kim-hgt-convert single --input <file.nc> --output-dir <dir>
```

Convert one KIM API text file:

```powershell
uv run kim-hgt-convert single-text --input <file.txt> --output-dir <dir> --downsample 3
```

Convert a forecast sequence:

```powershell
uv run kim-hgt-convert sequence --input-dir <dir> --tmfc <YYYYMMDDHH> --output-dir <dir> --interval 10
```

Sequence conversion reads 3-hour forecast NetCDF files for one `tmfc`, writes interpolated packed PNG/metadata/preview frames, and creates `manifest.json`. The default output interval is 10 minutes. `--max-hours` limits the source forecast horizon.

Run tests:

```powershell
uv run pytest
```

## Package Boundaries

- `cli.py`: command-line interface and argument parsing
- `contracts.py`: constants shared by converter modules
- `dataset.py`: NetCDF metadata validation and 500hPa frame extraction
- `kim_text.py`: KIM API text parsing and optional mean downsampling
- `packing.py`: R/G 16-bit packed PNG encode/decode helpers
- `metadata.py`: metadata JSON and output filename helpers
- `converter.py`: single-file and sequence conversion workflows
- `src/kim_hgt_converter/`: production package
- `tests/`: unit tests and future round-trip tests

## Data Contract

- variable: `hgt`
- expected standard name: `geopotential_height`
- unit: `m`
- target pressure level: `500.0 hPa`
- expected sample index: `levs[13]`
- packed PNG: R high byte, G low byte, B unused, alpha unused

## Sample Phase 1 Command

```powershell
uv run kim-hgt-convert single `
  --input ..\..\g576_v091_glob_prs.025deg.2byte.ft015.2026041000.nc `
  --output-dir ..\..\data\derived\phase1-single
```

## Sample Phase 5 Command

```powershell
uv run kim-hgt-convert sequence `
  --input-dir ..\..\data\raw\kim-glob `
  --tmfc 2026041000 `
  --output-dir ..\..\data\derived\kim-glob-hgt500-2026041000 `
  --max-hours 72 `
  --interval 10
```
