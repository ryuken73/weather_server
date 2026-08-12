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

권장 운영(1분 + auto fallback):

```bash
USE_API=true
API_KEY=...
AWS_FETCH_SOURCE=auto   # 생략 가능
```

`USE_API`는 Hub on/off가 아니라 **“API_KEY 필수 검사 on/off”**다. 실제 소스는 `AWS_FETCH_SOURCE`가 결정한다.

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
| `backfill_aws_min.js` | 필요 시 수동 | 과거 gap 메움 + 그날 TA pack 워밍 |
| `warm_aws_ta_pack.js` | 필요 시 수동 | 하루 TA pack만 생성 (`--yesterday` / `--force`) |
| `patch_aws_min_stn_names.js` | 필요 시 수동 | 이미 쌓인 JSON의 STN_NAME만 (LAW는 HTTP enrich) |
| `work/out` 복사 | 수동 | 과거 1분 파일을 `in_data`에 반영 |

재기동만으로는 **이미 디스크에 있는 짝수분-only 히스토리**가 홀수분으로 채워지지 않는다. 과거는 backfill 또는 Hub→복사.

코드·config(`aws_stn_code_*.json`, `aws_stn_catalog.js` 등)는 재기동 **전에** 배포되어 있어야 한다.

## 1분 변수별 pack

- Builder: `kma_fetch/utils/aws_min_pack.js` (`schemaVersion: 2`)
- 변수별 일파일. 지금은 TA만. `variable=FULL` 없음. 이후 `WS` 등은 파일 추가 + `variable=TA,WS`
- API: `GET /api/aws/min/pack?date=YYYYMMDD&variable=TA` (레거시 `from`/`to`)
- Binary: `/datasets/aws/ta/1m/{dayKey}/ta.i16le` (`AWS_PACK_DIR` / `out_data/aws/pack`)
- TA 결측 → `-32768`: `null`, sentinel `-999`, Hub 물리 ≤ -50℃(×10 ≤ -500), > 60℃. 정상 음수 유지
- Cache: 과거 complete binary/manifest → `immutable`+ETag; 오늘/미완 → `no-store`
- 사전생성: backfill 종료, `main_AWS` 어제 워밍, `warm_aws_ta_pack.js` (`--force`로 schema v2 재생성)
- 임의 구간·전 변수 JSON은 range 유지
- Debug: `GET /api/aws/min/exact?timestamp_kor=`
- 원천 1분 파일이 없으면 홀수 peak를 pack이 살릴 수 없다
- 구 pack(`schemaVersion < 2`)은 다음 워밍/요청 시 재빌드 (캐시 무시)

## 누락 진단 체크리스트

1. `USE_API`/`API_KEY`/`AWS_FETCH_SOURCE`가 의도와 맞는지
2. 로그: `download AWS tm` / `no data to save` / `File saved` / `Skipping task` / Hub fallback warn
3. `probe_aws_min_cadence.js` → disk odd / DB odd
4. DB에 있으면 backfill, 없으면 Hub(`auto`/`hub`) 후 `in_data` 확인
5. pack 요청 전 해당일 홀수분 파일 샘플 존재 여부. 과거일은 `warm_aws_ta_pack.js`로 미리 만들 수 있음
