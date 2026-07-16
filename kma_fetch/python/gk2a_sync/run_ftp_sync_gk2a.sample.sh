#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 필수 환경변수입니다. 실제 값은 운영 서버의 shell, crontab,
# 또는 git에 올리지 않는 별도 env 파일에서 주입하세요.
: "${GK2A_FTP_HOST:?Set GK2A_FTP_HOST}"
: "${GK2A_FTP_USER:?Set GK2A_FTP_USER}"
: "${GK2A_FTP_PASSWORD:?Set GK2A_FTP_PASSWORD}"

export BASE_DIR="${BASE_DIR:-/data/node_project/weather_data}"
export GK2A_FTP_PORT="${GK2A_FTP_PORT:-21}"
export GK2A_FTP_REMOTE_BASE_DIR="${GK2A_FTP_REMOTE_BASE_DIR:-/}"
export GK2A_FTP_FINAL_DIR="${GK2A_FTP_FINAL_DIR:-$BASE_DIR/in_data/gk2a}"
export GK2A_FTP_STAGING_DIR="${GK2A_FTP_STAGING_DIR:-$BASE_DIR/.incoming/gk2a}"

# 기본값은 오늘 KST 날짜 폴더입니다. 여러 날짜를 보정할 때는
# GK2A_SYNC_DATES=2026-07-01,2026-07-02 형태로 override하세요.
export GK2A_SYNC_DATES="${GK2A_SYNC_DATES:-$(TZ=Asia/Seoul date +%F)}"

# cron에서 downstream 이미지 생성 작업이 한꺼번에 몰리지 않도록 기본 cap을 둡니다.
# 수동 backfill에서 제한 없이 받고 싶으면 0으로 설정하세요.
export GK2A_FTP_MAX_FILES="${GK2A_FTP_MAX_FILES:-12}"
export GK2A_FTP_SORT="${GK2A_FTP_SORT:-asc}"
export GK2A_FTP_TIMEOUT_SECONDS="${GK2A_FTP_TIMEOUT_SECONDS:-60}"
export GK2A_FTP_VALIDATE_NC_HEADER="${GK2A_FTP_VALIDATE_NC_HEADER:-true}"
export GK2A_FTP_CHECK_REMOTE_SIZE="${GK2A_FTP_CHECK_REMOTE_SIZE:-false}"

python3 "$SCRIPT_DIR/ftp_sync_gk2a.py"
