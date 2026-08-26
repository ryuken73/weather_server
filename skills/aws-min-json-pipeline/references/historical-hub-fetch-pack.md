# 과거 AWS JSON fetch + pack (Hub, DB 없음)

운영 DB에 **최근 1달도 없고**, 1달 이전·특정 월(예: 한파 검증용 2026-01)을 받을 때의 **확정 runbook**.

## 운영 서버

| 항목 | 값 |
| --- | --- |
| SSH | `sbs@10.10.16.168` |
| repo (weather_api) | `/home/sbs/node_project/weather_server` |
| JSON (fetch 산출) | `/data/node_project/weather_data/in_data/aws/` |
| pack | `/data/node_project/weather_data/out_data/aws/pack/` |

```bash
ssh sbs@10.10.16.168
cd /home/sbs/node_project/weather_server
```

스크립트는 **repo 루트**에서 실행. JSON/pack 파일은 **weather_data** 아래에 쓴다 (`NODE_ENV=production` 기본).

## 한 줄 요약

| 단계 | 도구 | pack 자동? |
| --- | --- | --- |
| **Hub → JSON (운영 in_data)** | `work/fetch_aws_apihub.js` + `NODE_ENV=production` | **아니오** |
| **JSON → pack** | `kma_fetch/warm_aws_min_packs.js` | (이 단계가 pack) |
| **gap/DB 보조 + pack** | `backfill_aws_min.js` (기본 `--skip-pack` 없음) | **예, 일별** |

**rsync는 운영 기본 경로가 아니다.** `--out-dir work/out` 로 로컬에 받을 때만 복사가 필요하다.

## 경로 선택 (먼저 이것만 본다)

```
DB에 그 기간 분 데이터가 있는가?
├─ 예 (일부 gap)     → backfill_aws_min.js  (AWS_FETCH_SOURCE=auto)
└─ 아니오 (1달+ 전)  → fetch_aws_apihub.js  → warm_aws_min_packs.js
```

운영 서버 현실: **1달 이전은 거의 항상 Hub 두 단계**(fetch + warm).

## 빠른 실행: `kma_fetch/run_backfill.sh`

운영에서 **날짜만 바꿔** fetch+pack을 한 번에 돌릴 때. repo에 포함 (`/home/sbs/node_project/weather_server/kma_fetch/run_backfill.sh`).

```bash
ssh sbs@10.10.16.168
cd /home/sbs/node_project/weather_server

# 스크립트 상단 FETCH_* / PACK_* / PACK_VARIABLES 수정 후
bash kma_fetch/run_backfill.sh
```

| env / 스크립트 변수 | 의미 |
| --- | --- |
| `FETCH_FROM` / `FETCH_TO` | Hub JSON fetch 구간 |
| `PACK_FROM` / `PACK_TO` | pack warm 구간 (보통 fetch보다 하루 짧게 시작 가능) |
| `PACK_VARIABLES` | 비우면 전 변수. 예: `TA,TD,HM` |
| `SKIP_FETCH=1` | pack만 |
| `SKIP_PACK=1` | fetch만 |
| `FETCH_DRY_RUN=1` | Hub 창 개수만 확인 |

예 (2026-01 한파, env로 덮어쓰기):

```bash
FETCH_FROM=20251231 FETCH_TO=20260131 \
PACK_FROM=20260101 PACK_TO=20260131 \
PACK_VARIABLES=TA,TD,HM \
bash kma_fetch/run_backfill.sh
```

수동 node 명령과 동일하다. **스크립트만 고치면 되므로** 긴 one-liner 대신 이걸 쓰는 것을 권장.

## Hub fetch — 운영 in_data에 바로 저장

`fetch_aws_apihub.js`는 **`--out-dir`을 생략**하면 `deriveAwsJsonDir` 규칙을 따른다.

- `NODE_ENV=production` → `/data/node_project/weather_data/in_data/aws/{yyyy-MM-dd}/AWS_MIN_{tm}.json`
- Hub API는 **10분 창** 순회 (`stn=0` 제한). backfill `hub` 소스(분당 1 call)보다 **약 10배 적은 호출**.

```bash
cd /home/sbs/node_project/weather_server

# dry-run: 창 개수만
NODE_ENV=production node work/fetch_aws_apihub.js \
  --from 20260101 --to 20260131 --dry-run

# fetch (API_KEY는 .env.production 또는 셸)
NODE_ENV=production node work/fetch_aws_apihub.js \
  --from 20260101 --to 20260131 --sleep 300
```

로컬 검증만 `--out-dir work/out` → 이때만 `in_data`로 rsync/cp.

## pack — fetch 다음 필수 (별도 명령)

`fetch_aws_apihub.js`는 **JSON만** 쓴다. pack은 항상 `warm_aws_min_packs.js`.

```bash
# 전 변수 (기본)
NODE_ENV=production node kma_fetch/warm_aws_min_packs.js \
  --from 20260101 --to 20260131 --force

# 한파·기온 검증만 (빠름)
NODE_ENV=production node kma_fetch/warm_aws_min_packs.js \
  --from 20260101 --to 20260131 \
  --variables TA,TD,HM --force
```

JSON만 먼저 받고 pack은 나중에 돌려도 된다. **반대로 pack만으로는 JSON이 생기지 않는다.**

## backfill — fetch+pack 한 번에 (Hub는 비추)

`backfill_aws_min.js`는 **날짜마다 pack warm 기본 on** (`--skip-pack`으로 끔).

```bash
# DB gap + auto (DB 없으면 Hub fallback, 분당 1 call — 대량 과거에는 느림)
AWS_FETCH_SOURCE=auto NODE_ENV=production node kma_fetch/backfill_aws_min.js \
  --from 20260101 --to 20260131

# Hub 강제 + fetch+pack 일체 (API 호출 많음 — 대량 과거 비추)
AWS_FETCH_SOURCE=hub NODE_ENV=production node kma_fetch/backfill_aws_min.js \
  --from 20260101 --to 20260131 --force-refetch
```

| | `fetch_aws_apihub.js` | `backfill` + `hub` |
| --- | --- | --- |
| Hub 호출/일 | ~144 (10분 창) | ~1440 (분당) |
| pack | **수동** warm | **일별 자동** |
| 운영 대량 과거 | **권장** | 비추 |

## RN_24HR / 전일 JSON

`RN_24HR` rolling pack은 **전일 23:59 RN_DAY**가 필요하다. 1월 1일 품질을 올리려면 **전날도 fetch**:

```bash
NODE_ENV=production node work/fetch_aws_apihub.js \
  --from 20251231 --to 20260131 --sleep 300
```

## 검증

```bash
USE_API=false NODE_ENV=production node kma_fetch/probe_aws_min_cadence.js --day 2026-01-15

curl -sS "https://weather-map.sbs.co.kr/api/aws/min/pack?date=20260115&variable=TA" \
  | jq '{variable, complete, frameCount, to, stationCount}'
```

`complete: true`, `frameCount: 1440` → 해당일 pack OK.

## 운영 주의

- 장시간 작업: `tmux`/`screen`. 31일 fetch+warm은 수 시간.
- 부하: `main_AWS` today pack warm과 겹치면 RSS 부담 → 필요 시 `AWS_TODAY_PACK_REFRESH=0` 후 재기동.
- `API_KEY`를 git/문서에 넣지 말 것. `kma_fetch/.env.production` 사용.

## 예: 2026년 1월 한파 검증 (복붙)

```bash
ssh sbs@10.10.16.168
cd /home/sbs/node_project/weather_server

# run_backfill.sh 상단 날짜 확인 후
bash kma_fetch/run_backfill.sh
```

수동:

```bash
ssh sbs@10.10.16.168
cd /home/sbs/node_project/weather_server

NODE_ENV=production node work/fetch_aws_apihub.js \
  --from 20251231 --to 20260131 --sleep 300

NODE_ENV=production node kma_fetch/warm_aws_min_packs.js \
  --from 20260101 --to 20260131 --force
```

TA만:

```bash
NODE_ENV=production node kma_fetch/warm_aws_min_packs.js \
  --from 20260101 --to 20260131 --variables TA,TD,HM --force
```
