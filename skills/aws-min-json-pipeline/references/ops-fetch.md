# 수집·누락·복구

## 환경변수 (운영)

| 변수 | 역할 |
| --- | --- |
| `AWS_FETCH_SOURCE` | `auto`(기본): **DB → 비면 Hub**. `db`: DB만. `hub`: Hub만 |
| `API_KEY` | Hub(`nph-aws2_min`) 호출용. `auto`/`hub`에서 fallback·Hub 전용 시 필요 |
| `USE_API` | `kma_fetch/config/env.js` 기동 검사. 기본 `true`이면 **`API_KEY` 없으면 프로세스 기동 실패**. Hub를 안 쓰고 DB만이면 `USE_API=false` + `AWS_FETCH_SOURCE=db` 가능 |
| `BASE_DIR` | `in_data` / `out_data` resolve 기준 |
| `AWS_JSON_DIR` | (서버) JSON 루트 override |
| `AWS_PACK_DIR` | (서버) pack 루트 override |
| `AWS_TA_QC` | pack temporal QC. 기본 on. `0`/`false`면 off |
| `AWS_TA_QC_MAX_DELTA_DEGC` | 직전 유효 분 대비 최대 |ΔTA| (기본 3℃) |
| `AWS_TA_QC_SPIKE_NEIGHBOR_MAX_DEGC` | 고립 스파이크: 양 이웃 허용 차 (기본 1.5℃) |
| `AWS_TA_QC_SPIKE_MIN_DEGC` | 고립 스파이크: 가운데 vs 이웃 최소 차 (기본 2.5℃) |

권장 운영(1분 + auto fallback):

```bash
USE_API=true
API_KEY=...
AWS_FETCH_SOURCE=auto   # 생략 가능
```

`USE_API`는 Hub on/off가 아니라 **“API_KEY 필수 검사 on/off”**다. 실제 소스는 `AWS_FETCH_SOURCE`가 결정한다.

운영 스크립트는 repo 루트(`weather_api`)에서 실행한다. `NODE_ENV=production`(또는 `prod`)이면 `kma_fetch/.env.production`을 읽는다.

**운영 고정 경로** (`AWS_JSON_DIR` / `AWS_PACK_DIR` 미설정 시 코드 기본값과 동일):

| 용도 | 경로 |
| --- | --- |
| fetch / backfill JSON | `/data/node_project/weather_data/in_data/aws/{yyyy-MM-dd}/AWS_MIN_{YYYYMMDDHHMM}.json` |
| TA pack | `/data/node_project/weather_server/data/weather/out_data/aws/pack/ta/1m/{YYYYMMDD}/` |

JSON은 `weather_data`, pack은 `weather_server` repo 아래 `data/weather/out_data`에 둔다. override는 env `AWS_JSON_DIR`, `AWS_PACK_DIR`.

## 수작업 runbook: backfill + pack

재기동만으로는 과거 JSON/pack이 채워지지 않는다. 아래 중 **한 경로**를 고른다.

| 상황 | 할 일 |
| --- | --- |
| 운영 `in_data/aws`에 그날 파일이 일부만 있음 (DB/Hub로 gap 메움) | **A.** `backfill_aws_min.js` (끝나면 그날 pack 자동 워밍) |
| 과거 여러 날을 Hub에서 통째로 받을 때 | **B.** `fetch_aws_apihub.js` → `in_data/aws` 복사 → pack |
| JSON은 이미 있고 pack만 만들거나 schema v3로 다시 쓸 때 | **C.** `warm_aws_ta_pack.js` (`--force`면 재빌드) |

날짜는 KST. `backfill_aws_min.js`는 **하루 단위**(1440 슬롯). 여러 날은 날짜를 바꿔 반복하거나 B를 쓴다.

### A. 하루 gap backfill (권장: 운영 서버)

```bash
cd /path/to/weather_api

# 1) 누락만 확인 (조회/저장 없음)
NODE_ENV=production node kma_fetch/backfill_aws_min.js 20260811 --dry-run

# 2) 홀수분 존재 여부
USE_API=false NODE_ENV=production node kma_fetch/probe_aws_min_cadence.js --day 2026-08-11

# 3) 채우기. auto = DB 후 비면 Hub. 끝나면 그날 TA pack 워밍
AWS_FETCH_SOURCE=auto NODE_ENV=production node kma_fetch/backfill_aws_min.js 20260811

# pack만 나중에: --skip-pack 후 C
```

여러 날 예 (bash):

```bash
for d in 20260809 20260810 20260811; do
  AWS_FETCH_SOURCE=auto NODE_ENV=production node kma_fetch/backfill_aws_min.js "$d"
done
```

### B. Hub 대량 수신 → 운영 경로 복사 → pack

Hub 산출물은 `work/out/{yyyy-MM-dd}/`다. HTTP 서빙 경로는 `in_data/aws`이므로 **복사 후** pack 한다.

```bash
cd /path/to/weather_api
# API_KEY는 셸 또는 .env.production. 키를 문서/git에 넣지 말 것

node work/fetch_aws_apihub.js --from 20260712 --to 20260803 --sleep 300

# 운영 서버 예 (덮어쓰기 전 샘플 확인)
# rsync -av work/out/2026-07-12/ /data/node_project/weather_data/in_data/aws/2026-07-12/

USE_API=false NODE_ENV=production node kma_fetch/probe_aws_min_cadence.js --day 2026-07-12
NODE_ENV=production node kma_fetch/warm_aws_ta_pack.js --from 20260712 --to 20260803
```

복사 없이 `work/out`만 워밍할 때(로컬 검증):

```bash
USE_API=false node kma_fetch/warm_aws_ta_pack.js --from 20260701 --to 20260811 --json-dir work/out
```

이 pack은 운영 `out_data`가 아니다. 운영 서빙하려면 JSON을 `in_data/aws`에 두고 `NODE_ENV=production`으로 다시 워밍한다.

### C. pack만 생성 / schema v3 재빌드

JSON이 `in_data/aws`에 있을 때. 구 pack(`schemaVersion < 3`)은 `--force`가 필요하다.

```bash
cd /path/to/weather_api

NODE_ENV=production node kma_fetch/warm_aws_min_packs.js 20260811
NODE_ENV=production node kma_fetch/warm_aws_ta_pack.js --yesterday   # TA wrapper
NODE_ENV=production node kma_fetch/warm_aws_min_packs.js --from 20260801 --to 20260814 --force
NODE_ENV=production node kma_fetch/warm_aws_min_packs.js --all-json --force
```

기존 JSON에 `RN_12HR`가 없으면 Hub 재수집 후 pack:

```bash
AWS_FETCH_SOURCE=hub NODE_ENV=production node kma_fetch/backfill_aws_min.js \
  --from 20260801 --to 20260813 \
  --refresh-fields RN_12HR \
  --variables RN_15M,RN_60M,RN_12HR,RN_24HR
```

산출:

- JSON: `/data/node_project/weather_data/in_data/aws/{yyyy-MM-dd}/AWS_MIN_*.json`
- Pack: `/data/node_project/weather_server/data/weather/out_data/aws/pack/{slug}/1m/{YYYYMMDD}/`

확인:

```bash
# manifest schemaVersion 3, qc.taTemporal(TA), accumulation(강수), complete
curl -sS "https://weather-map.sbs.co.kr/api/aws/min/pack?date=20260811&variable=TA"
curl -sS "https://weather-map.sbs.co.kr/api/aws/min/pack?date=20260811&variable=RN_60M,WS_INS"
```

`complete:true`여도 schema가 낮으면 `--force`. 오늘(미완)은 요청 시 재빌드되고 `no-store`.

## Gate0: 홀수분(1분) 존재 probe

pack/exact가 의미 있으려면 디스크·DB에 **홀수분**이 있어야 한다.

```bash
# env.js API_KEY 검사를 피하려면 USE_API=false (probe만)
USE_API=false NODE_ENV=production node kma_fetch/probe_aws_min_cadence.js
USE_API=false NODE_ENV=production node kma_fetch/probe_aws_min_cadence.js --day 2026-08-11
```

판정:

- `verdict.diskHasOdd` / `verdict.dbHasOdd`
- disk만 짝수면 → 수집기를 1분·auto/hub로 돌리거나 Hub backfill 후 재확인
- DB에 홀수분이 없으면 auto는 매번 Hub로 넘어감 (`API_KEY` 필수)

## 실시간: `main_AWS.js`

- 스케줄: `1min` (`* * * * *`) — **모든 분** 보존 (pack/exact용)
- 후보: `mkFetchCandidate(1, 30)` 후 **최신 2개 drop**
- `AWS_FETCH_SOURCE=auto`: 시각마다 MSSQL → row 없으면 Hub
- `jsonData.length === 0` → `no data to save` 후 continue
- 저장: `in_data/aws/{yyyy-MM-dd}/AWS_MIN_{tm}.json`
- 저장 전 `patchAwsRowsForSave` (STN_NAME). `LAW_ADDR_*`는 디스크에 안 넣음
- 매분 pack을 만들지 않음. 틱마다 **어제** `0000–2359` TA pack을 한 번 워밍 (`warmAwsDayPack`)

## 일단위 backfill: `backfill_aws_min.js`

```bash
NODE_ENV=production node kma_fetch/backfill_aws_min.js 20260810 --dry-run
AWS_FETCH_SOURCE=auto NODE_ENV=production node kma_fetch/backfill_aws_min.js 20260810
NODE_ENV=production node kma_fetch/backfill_aws_min.js 20260810 --skip-pack
```

- 하루 **1440** 슬롯(1분). 소스 정책은 `main_AWS`와 동일
- JSON 채운 뒤(또는 이미 전부 있으면) 그날 TA pack 워밍. `--skip-pack`이면 생략

## 과거 API 허브 → 운영 반영

```bash
set API_KEY=...
node work/fetch_aws_apihub.js --from 20260712 --to 20260803 --sleep 300
# 짝수분만: --even-only
```

- 출력: `work/out/{yyyy-MM-dd}/AWS_MIN_*.json` (기본 **모든 분**)
- 운영 서빙 경로는 `in_data/aws`이므로 **복사 필요** (날짜 폴더 단위, 덮어쓰기 전 dry-run/샘플 확인)

```bash
# 예: 운영 서버에서 (경로·권한은 환경에 맞게)
# work/out/2026-07-12/ → $BASE_DIR/in_data/aws/2026-07-12/
rsync -av work/out/2026-07-12/ /data/node_project/weather_data/in_data/aws/2026-07-12/
```

복사 후 `probe_aws_min_cadence.js --day 2026-07-12`로 odd 건수 확인. 이어서 pack 워밍:

```bash
NODE_ENV=production node kma_fetch/warm_aws_ta_pack.js 20260712
NODE_ENV=production node kma_fetch/warm_aws_ta_pack.js --from 20260701 --to 20260712
# Hub 산출물(work/out)에서:
USE_API=false node kma_fetch/warm_aws_ta_pack.js --from 20260701 --to 20260811 --json-dir work/out
NODE_ENV=production node kma_fetch/warm_aws_ta_pack.js --yesterday
```

기본 JSON 루트는 `in_data/aws`다. `work/out`에만 있으면 `--json-dir work/out` 또는 운영 경로로 복사 후 워밍.

## 배포·재기동 범위

| 대상 | 재기동/실행 | 효과 |
| --- | --- | --- |
| `main_AWS.js` | 재기동 | 이후 **새 분**부터 1분 수집·STN_NAME 패치·auto/Hub |
| `server.js` | 재기동 | `/api/aws/min/pack`, `/exact`, stations enrich, 2분 min/range |
| `backfill_aws_min.js` | 필요 시 수동 | 과거 gap 메움 / `--refresh-fields RN_12HR` / `--force-refetch` + pack 워밍 |
| `warm_aws_min_packs.js` | 필요 시 수동 | 전 변수 pack (`--all-json`, `--force`). `warm_aws_ta_pack.js`는 TA wrapper |
| `patch_aws_min_stn_names.js` | 필요 시 수동 | 이미 쌓인 JSON의 STN_NAME만 (LAW는 HTTP enrich) |
| `work/out` 복사 | 수동 | 과거 1분 파일을 `in_data`에 반영 |

재기동만으로는 **이미 디스크에 있는 짝수분-only 히스토리**가 홀수분으로 채워지지 않는다. 과거는 backfill 또는 Hub→복사.

코드·config(`aws_stn_code_*.json`, `aws_stn_catalog.js` 등)는 재기동 **전에** 배포되어 있어야 한다.

## 1분 변수별 pack

- Builder: `kma_fetch/utils/aws_min_pack.js` (`schemaVersion: 3`)
- 변수별 일파일: `TA, RN_15M, RN_60M, RN_12HR, RN_24HR, WS_INS, WS, WD_INS, WD, HM, TD`. `variable=FULL` 없음. `RN_1HR`/`RN_6HR`/`RN_48HR`/`RN_YN` 제외
- API: `GET /api/aws/min/pack?date=YYYYMMDD&variable=TA|RN_60M|WS_INS|...` (레거시 `from`/`to`, comma 복수)
- Binary: `/datasets/aws/{slug}/1m/{dayKey}/{slug}.i16le`
- TA 결측 → `-32768`: `null`, sentinel `-999`, Hub 물리 ≤ -50℃(×10 ≤ -500), > 60℃. 정상 음수 유지
- 강수 결측 → `-32768`: `null`, Hub ≤ -50mm, 음수, Int16 overflow. **0 mm는 0**. TA QC 없음
- 풍속 0 유효. 풍향 0–360(무풍 360). 습도 0–100%. 이슬점 TA QC 없음
- **Pack temporal QC** (TA만, 기본 on, `AWS_TA_QC=0`으로 off): 1분 |ΔTA| > 3℃ 또는 고립 스파이크 → `-32768`. `/exact`·디스크 JSON은 원천 그대로
- Cache: 과거 complete binary/manifest → `immutable`+ETag; 오늘/미완 → `no-store`
- 사전생성: backfill 종료, `main_AWS` 어제 워밍(전 변수), `warm_aws_min_packs.js`
- 기존 JSON의 `RN_12HR` null → `--refresh-fields RN_12HR` (Hub). 15/60분 합산으로 12시간을 만들지 말 것
- 임의 구간·전 변수 JSON은 range 유지
- Debug: `GET /api/aws/min/exact?timestamp_kor=`
- 원천 1분 파일이 없으면 홀수 peak를 pack이 살릴 수 없다
- 구 pack(`schemaVersion < 3`)은 다음 워밍/요청 시 재빌드 (캐시 무시)

## 누락 진단 체크리스트

1. `USE_API`/`API_KEY`/`AWS_FETCH_SOURCE`가 의도와 맞는지
2. 로그: `download AWS tm` / `no data to save` / `File saved` / `Skipping task` / Hub fallback warn
3. `probe_aws_min_cadence.js` → disk odd / DB odd
4. DB에 있으면 backfill, 없으면 Hub(`auto`/`hub`) 후 `in_data` 확인
5. pack 요청 전 해당일 홀수분 파일 샘플 존재 여부. 과거일은 `warm_aws_ta_pack.js`로 미리 만들 수 있음
