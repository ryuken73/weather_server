#!/usr/bin/env bash
# Hub fetch → warm (운영 in_data / out_data pack)
# 운영: ssh sbs@10.10.16.168 && cd /home/sbs/node_project/weather_server
#
#   bash kma_fetch/run_backfill.sh
#   FETCH_DRY_RUN=1 bash kma_fetch/run_backfill.sh
#   SKIP_FETCH=1 bash kma_fetch/run_backfill.sh   # pack only
#   SKIP_PACK=1 bash kma_fetch/run_backfill.sh   # fetch only
#
# 상위 변수만 바꿔서 쓰면 된다. 상세: skills/aws-min-json-pipeline/references/historical-hub-fetch-pack.md

set -euo pipefail

# --- edit (또는 env override) ---
FETCH_FROM="${FETCH_FROM:-20251231}"   # Hub fetch 시작 (RN_24HR 전일 포함 시 전날)
FETCH_TO="${FETCH_TO:-20260131}"       # Hub fetch 끝
PACK_FROM="${PACK_FROM:-20260101}"     # pack warm 시작
PACK_TO="${PACK_TO:-20260131}"         # pack warm 끝
SLEEP_MS="${SLEEP_MS:-300}"            # Hub 호출 간격 ms
PACK_VARIABLES="${PACK_VARIABLES:-}"     # 비우면 전 변수. 예: TA,TD,HM
FORCE_PACK="${FORCE_PACK:-1}"          # 1 = --force
SKIP_FETCH="${SKIP_FETCH:-0}"
SKIP_PACK="${SKIP_PACK:-0}"
FETCH_DRY_RUN="${FETCH_DRY_RUN:-0}"
# ---

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
export NODE_ENV="${NODE_ENV:-production}"

echo "=== run_backfill.sh ==="
echo "repo       : $REPO_ROOT"
echo "NODE_ENV   : $NODE_ENV"
echo "FETCH      : $FETCH_FROM -> $FETCH_TO (skip=$SKIP_FETCH dry=$FETCH_DRY_RUN sleep=${SLEEP_MS}ms)"
echo "PACK       : $PACK_FROM -> $PACK_TO (skip=$SKIP_PACK force=$FORCE_PACK vars=${PACK_VARIABLES:-all})"

if [[ "$SKIP_FETCH" != "1" ]]; then
  fetch_args=(--from "$FETCH_FROM" --to "$FETCH_TO" --sleep "$SLEEP_MS")
  [[ "$FETCH_DRY_RUN" == "1" ]] && fetch_args+=(--dry-run)
  node work/fetch_aws_apihub.js "${fetch_args[@]}"
fi

if [[ "$SKIP_PACK" != "1" ]]; then
  if [[ "$FETCH_DRY_RUN" == "1" ]]; then
    echo "skip pack (FETCH_DRY_RUN=1)"
    exit 0
  fi
  pack_args=(--from "$PACK_FROM" --to "$PACK_TO")
  [[ -n "$PACK_VARIABLES" ]] && pack_args+=(--variables "$PACK_VARIABLES")
  [[ "$FORCE_PACK" == "1" ]] && pack_args+=(--force)
  node kma_fetch/warm_aws_min_packs.js "${pack_args[@]}"
fi

echo "=== done ==="
