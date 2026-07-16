#!/usr/bin/env python3
import argparse
import errno
import os
import re
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from ftplib import FTP
from pathlib import Path
from typing import List, Optional


GK2A_FILE_PATTERN = re.compile(r"^(gk2a_ami_le1b_ir105_.*_)(\d{12})\.nc$", re.IGNORECASE)
NC_MAGIC_HEADERS = (b"CDF\x01", b"CDF\x02", b"\x89HDF")
KST = timezone(timedelta(hours=9))
ATOMIC_PUBLISH_ERROR_NUMBERS = {errno.EXDEV, errno.EPERM, errno.EACCES}
for optional_errno in ("ENOTSUP", "EOPNOTSUPP"):
    value = getattr(errno, optional_errno, None)
    if value is not None:
        ATOMIC_PUBLISH_ERROR_NUMBERS.add(value)


@dataclass
class SyncConfig:
    ftp_host: str
    ftp_port: int
    ftp_user: str
    ftp_password: str
    remote_base_dir: str
    final_base_dir: Path
    staging_base_dir: Path
    dates: List[str]
    max_files: int
    sort_order: str
    timeout_seconds: int
    validate_nc_header: bool
    check_remote_size: bool


@dataclass
class SyncStats:
    downloaded: int = 0
    skipped_existing: int = 0
    skipped_unmatched: int = 0
    failed: int = 0


def env(name: str, default: Optional[str] = None) -> Optional[str]:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    return value


def required_env(*names: str) -> str:
    for name in names:
        value = env(name)
        if value:
            return value
    raise ValueError(f"Missing required environment variable: {' or '.join(names)}")


def env_int(name: str, default: int) -> int:
    value = env(name)
    if value is None:
        return default
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {value!r}") from exc
    if parsed < 0:
        raise ValueError(f"{name} must be zero or greater")
    return parsed


def env_bool(name: str, default: bool) -> bool:
    value = env(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def parse_dates(value: Optional[str]) -> List[str]:
    if not value:
        return [datetime.now(KST).strftime("%Y-%m-%d")]

    dates = [item.strip() for item in value.split(",") if item.strip()]
    if not dates:
        raise ValueError("GK2A_SYNC_DATES must contain at least one YYYY-MM-DD value")

    for date_str in dates:
        try:
            datetime.strptime(date_str, "%Y-%m-%d")
        except ValueError as exc:
            raise ValueError(f"Invalid sync date {date_str!r}; expected YYYY-MM-DD") from exc
    return dates


def build_config(args: argparse.Namespace) -> SyncConfig:
    base_dir = Path(env("BASE_DIR", "./data/weather")).expanduser()

    sync_dates = args.dates or env("GK2A_SYNC_DATES") or env("GK2A_SYNC_DATE")
    sort_order = env("GK2A_FTP_SORT", "asc").lower()
    if sort_order not in {"asc", "desc"}:
        raise ValueError("GK2A_FTP_SORT must be either 'asc' or 'desc'")

    return SyncConfig(
        ftp_host=required_env("GK2A_FTP_HOST"),
        ftp_port=env_int("GK2A_FTP_PORT", 21),
        ftp_user=required_env("GK2A_FTP_USER", "GK2A_FTP_USERNAME"),
        ftp_password=required_env("GK2A_FTP_PASSWORD", "GK2A_FTP_PASS"),
        remote_base_dir=env("GK2A_FTP_REMOTE_BASE_DIR", "/"),
        final_base_dir=Path(env("GK2A_FTP_FINAL_DIR", str(base_dir / "in_data" / "gk2a"))).expanduser(),
        staging_base_dir=Path(env("GK2A_FTP_STAGING_DIR", str(base_dir / ".incoming" / "gk2a"))).expanduser(),
        dates=parse_dates(sync_dates),
        max_files=env_int("GK2A_FTP_MAX_FILES", 0),
        sort_order=sort_order,
        timeout_seconds=env_int("GK2A_FTP_TIMEOUT_SECONDS", 60),
        validate_nc_header=env_bool("GK2A_FTP_VALIDATE_NC_HEADER", True),
        check_remote_size=env_bool("GK2A_FTP_CHECK_REMOTE_SIZE", False),
    )


def build_remote_dir(remote_base: str, date_str: str) -> str:
    suffix = f"{date_str}/gk2a"
    normalized = (remote_base or "/").strip()
    if normalized in {"", "/"}:
        return f"/{suffix}"
    return f"{normalized.rstrip('/')}/{suffix}"


def get_kst_filename(original_filename: str) -> Optional[str]:
    match = GK2A_FILE_PATTERN.match(original_filename)
    if not match:
        return None

    prefix = match.group(1)
    utc_str = match.group(2)

    try:
        utc_time = datetime.strptime(utc_str, "%Y%m%d%H%M")
    except ValueError:
        return None

    kst_str = (utc_time + timedelta(hours=9)).strftime("%Y%m%d%H%M")
    return f"{prefix}{utc_str}_{kst_str}.nc"


def ensure_same_filesystem(staging_base_dir: Path, final_base_dir: Path) -> None:
    staging_base_dir.mkdir(parents=True, exist_ok=True)
    final_base_dir.mkdir(parents=True, exist_ok=True)

    staging_device = staging_base_dir.stat().st_dev
    final_device = final_base_dir.stat().st_dev
    if staging_device != final_device:
        raise ValueError(
            "GK2A_FTP_STAGING_DIR and GK2A_FTP_FINAL_DIR must be on the same filesystem "
            "so the final publish step is atomic"
        )


def connect_ftp(config: SyncConfig) -> FTP:
    print(f"[GK2A-FTP] Connecting to {config.ftp_host}:{config.ftp_port}")
    ftp = FTP(timeout=config.timeout_seconds)
    ftp.connect(config.ftp_host, config.ftp_port)
    ftp.login(config.ftp_user, config.ftp_password)
    ftp.voidcmd("TYPE I")
    return ftp


def list_remote_nc_files(ftp: FTP, remote_dir: str, sort_order: str) -> List[str]:
    print(f"[GK2A-FTP] Remote directory: {remote_dir}")
    ftp.cwd(remote_dir)

    files = []
    for item in ftp.nlst():
        filename = item.rsplit("/", 1)[-1]
        if filename.endswith(".nc"):
            files.append(filename)

    files = sorted(files, reverse=(sort_order == "desc"))
    print(f"[GK2A-FTP] Found {len(files)} remote NC files")
    return files


def get_remote_size(ftp: FTP, remote_file: str) -> Optional[int]:
    try:
        size = ftp.size(remote_file)
    except Exception:
        return None
    return int(size) if size is not None else None


def unlink_missing_ok(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def validate_download(path: Path, remote_size: Optional[int], validate_nc_header: bool) -> None:
    local_size = path.stat().st_size
    if local_size <= 0:
        raise ValueError(f"Downloaded file is empty: {path}")

    if remote_size is not None and local_size != remote_size:
        raise ValueError(f"Downloaded size mismatch: local={local_size}, remote={remote_size}")

    if not validate_nc_header:
        return

    with path.open("rb") as file:
        header = file.read(4)

    if not any(header.startswith(magic) for magic in NC_MAGIC_HEADERS):
        raise ValueError(f"Downloaded file does not look like NetCDF/HDF5: {path}")


def publish_file(partial_path: Path, final_path: Path) -> bool:
    final_path.parent.mkdir(parents=True, exist_ok=True)

    if final_path.exists():
        unlink_missing_ok(partial_path)
        return False

    try:
        os.link(partial_path, final_path)
    except FileExistsError:
        unlink_missing_ok(partial_path)
        return False
    except OSError as exc:
        if exc.errno in ATOMIC_PUBLISH_ERROR_NUMBERS:
            raise RuntimeError(
                "Could not atomically publish the file with os.link(). "
                "Check that staging and final directories are on the same local filesystem."
            ) from exc
        raise

    unlink_missing_ok(partial_path)
    return True


def download_one(
    ftp: FTP,
    remote_file: str,
    final_name: str,
    staging_dir: Path,
    final_dir: Path,
    config: SyncConfig,
) -> str:
    final_path = final_dir / final_name
    if final_path.exists():
        return "skipped_existing"

    staging_dir.mkdir(parents=True, exist_ok=True)
    partial_name = f"{final_name}.partial.{os.getpid()}.{uuid.uuid4().hex}"
    partial_path = staging_dir / partial_name

    remote_size = get_remote_size(ftp, remote_file) if config.check_remote_size else None
    print(f"[GK2A-FTP] Downloading {remote_file} -> {partial_path.name}")

    try:
        with partial_path.open("wb") as file:
            ftp.retrbinary(f"RETR {remote_file}", file.write)

        validate_download(partial_path, remote_size, config.validate_nc_header)

        if publish_file(partial_path, final_path):
            print(f"[GK2A-FTP] Published {final_path}")
            return "downloaded"

        print(f"[GK2A-FTP] Skipped existing {final_path}")
        return "skipped_existing"
    except Exception:
        unlink_missing_ok(partial_path)
        raise


def process_date(ftp: FTP, config: SyncConfig, date_str: str) -> SyncStats:
    stats = SyncStats()
    remote_dir = build_remote_dir(config.remote_base_dir, date_str)
    final_dir = config.final_base_dir / date_str
    staging_dir = config.staging_base_dir / date_str

    final_dir.mkdir(parents=True, exist_ok=True)
    staging_dir.mkdir(parents=True, exist_ok=True)

    remote_files = list_remote_nc_files(ftp, remote_dir, config.sort_order)

    for remote_file in remote_files:
        final_name = get_kst_filename(remote_file)
        if not final_name:
            stats.skipped_unmatched += 1
            continue

        if config.max_files and stats.downloaded >= config.max_files:
            break

        try:
            result = download_one(ftp, remote_file, final_name, staging_dir, final_dir, config)
            if result == "downloaded":
                stats.downloaded += 1
            else:
                stats.skipped_existing += 1
        except Exception as exc:
            stats.failed += 1
            print(f"[GK2A-FTP] ERROR downloading {remote_file}: {exc}", file=sys.stderr)

    return stats


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Sync GK2A IR105 NetCDF files from FTP into the weather data input directory."
    )
    parser.add_argument(
        "--dates",
        help="Comma-separated YYYY-MM-DD dates. Overrides GK2A_SYNC_DATES/GK2A_SYNC_DATE.",
    )
    return parser.parse_args()


def main() -> int:
    try:
        config = build_config(parse_args())
        ensure_same_filesystem(config.staging_base_dir, config.final_base_dir)
    except Exception as exc:
        print(f"[GK2A-FTP] Configuration error: {exc}", file=sys.stderr)
        return 2

    total = SyncStats()
    ftp = None

    try:
        ftp = connect_ftp(config)
        for date_str in config.dates:
            print(f"[GK2A-FTP] Sync date: {date_str}")
            stats = process_date(ftp, config, date_str)
            total.downloaded += stats.downloaded
            total.skipped_existing += stats.skipped_existing
            total.skipped_unmatched += stats.skipped_unmatched
            total.failed += stats.failed
    except Exception as exc:
        print(f"[GK2A-FTP] FTP sync failed: {exc}", file=sys.stderr)
        return 1
    finally:
        if ftp is not None:
            try:
                ftp.quit()
            except Exception:
                ftp.close()

    print(
        "[GK2A-FTP] Done. "
        f"downloaded={total.downloaded}, "
        f"skipped_existing={total.skipped_existing}, "
        f"skipped_unmatched={total.skipped_unmatched}, "
        f"failed={total.failed}"
    )

    return 1 if total.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
