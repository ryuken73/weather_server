#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Required environment variables. Set real values in the service environment,
# crontab, or a separate non-committed env file before running this script.
: "${GK2A_FTP_HOST:?Set GK2A_FTP_HOST}"
: "${GK2A_FTP_USER:?Set GK2A_FTP_USER}"
: "${GK2A_FTP_PASSWORD:?Set GK2A_FTP_PASSWORD}"

export BASE_DIR="${BASE_DIR:-/data/node_project/weather_data}"
export GK2A_FTP_PORT="${GK2A_FTP_PORT:-21}"
export GK2A_FTP_REMOTE_BASE_DIR="${GK2A_FTP_REMOTE_BASE_DIR:-/}"
export GK2A_FTP_FINAL_DIR="${GK2A_FTP_FINAL_DIR:-$BASE_DIR/in_data/gk2a}"
export GK2A_FTP_STAGING_DIR="${GK2A_FTP_STAGING_DIR:-$BASE_DIR/.incoming/gk2a}"

# Default to today's KST folder. Override with GK2A_SYNC_DATES=2026-07-01,2026-07-02
# when backfilling more than one date.
export GK2A_SYNC_DATES="${GK2A_SYNC_DATES:-$(TZ=Asia/Seoul date +%F)}"

# Use a small cap in cron to avoid flooding the downstream image generator.
# Set to 0 for unlimited manual backfills.
export GK2A_FTP_MAX_FILES="${GK2A_FTP_MAX_FILES:-12}"
export GK2A_FTP_SORT="${GK2A_FTP_SORT:-asc}"
export GK2A_FTP_TIMEOUT_SECONDS="${GK2A_FTP_TIMEOUT_SECONDS:-60}"
export GK2A_FTP_VALIDATE_NC_HEADER="${GK2A_FTP_VALIDATE_NC_HEADER:-true}"
export GK2A_FTP_CHECK_REMOTE_SIZE="${GK2A_FTP_CHECK_REMOTE_SIZE:-false}"

python3 "$SCRIPT_DIR/ftp_sync_gk2a.py"
