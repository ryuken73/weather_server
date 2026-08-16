---
name: aws-min-json-pipeline
description: AWS_MIN station JSON 수집·누락 복구·과거 backfill·1분 변수별 pack. Use when working with main_AWS.js, backfill_aws_min.js, work/fetch_aws_apihub.js, in_data/aws AWS_MIN_*.json, nph-aws2_min, RN_15M/RN_60M/RN_12HR/RN_24HR, WS_INS, WD, HM, TD, /api/aws/min/pack, or STN_NAME code table.
---

# AWS_MIN JSON Pipeline

방재 AWS 분 자료를 **시각별 station 배열 JSON**으로 만들고, 1분 변수별 pack을 제공하는 서버 파이프라인 skill이다. HTTP 조회 계약은 `weather-api-catalog`를 본다.

## 다른 skill과의 경계

| Skill | 역할 |
| --- | --- |
| **aws-min-json-pipeline** (이 skill) | 수집·저장·포맷·backfill·pack 생성 |
| **weather-api-catalog** | `/api/aws/min`, `/pack`, `/stations` HTTP 계약 |
| **weather-external-resource-apis** | 시각화 consumer |

## 빠른 판단

1. 실시간/준실시간 수집·lookback·누락·**운영 env/재기동/복사** → `references/ops-fetch.md`
   - 수작업 backfill + pack 생성 → 같은 파일 **수작업 runbook**
2. 파일 경로·JSON shape·단위·pack → `references/paths-and-schema.md`
3. `#` 원본 / API 허브 응답 포맷·변환 → `references/formats.md` (Hub 원문 샘플: `assets/nph-aws2_min_202608131200.txt`)
4. 과거 한 달 등 → API 허브 `work/fetch_aws_apihub.js` (기본 **all-minutes**) → `work/out`를 `in_data/aws`로 복사
5. HTTP로 읽기만 → `skills/weather-api-catalog`

## 핵심 규칙

- 저장 경로: `{resolveBaseDir(in_data)}/aws/{yyyy-MM-dd}/AWS_MIN_{yyyyMMddHHmm}.json`
- 수집 주기는 **1분** (홀수분 포함). 기존 `/api/aws/min`·`/range`는 **2분 snap**으로 호환 유지.
- `AWS_FETCH_SOURCE=auto|db|hub` (기본 auto = **DB 후, RN_12HR/TD가 전부 없으면 같은 TM Hub 1회 merge**). Hub에는 `API_KEY` 필요.
- `USE_API=true`(기본)이면 env 로드 시 `API_KEY` 필수. DB-only면 `USE_API=false` + `AWS_FETCH_SOURCE=db`.
- lookback: `candidateMinute:1`, `candiateCount:30`, 최신 2개 drop
- 기업용 API 허브: `apihub-pub.kma.go.kr` / `nph-aws2_min` / `stn=0` 최대 10분 창
- JSON TA는 ×10 정수. pack Int16도 동일 스케일(×0.1℃), missing `-32768` (`-999`·Hub ≤ -50℃ 포함)
- Pack temporal QC는 **pack만** (`schemaVersion: 3`). TA에만 적용. 강수·풍속·풍향·습도·이슬점은 QC/smoothing/carry-forward 없음. `/exact`·디스크 JSON은 원천 그대로. `AWS_TA_QC=0`으로 off
- `STN_NAME` 저장 시 패치, `LAW_ADDR_*`는 HTTP enrich / stations / pack stations만
- Hub JSON: `RN-15m→RN_15M`, `RN-60m→RN_60M`(+호환 `RN_1HR` 별칭), `RN-12H→RN_12HR`, `RN-DAY→RN_24HR`, `WS1→WS`, `WSS→WS_INS`, `WD1→WD`, `WDS→WD_INS`, `HM`, `TD`. pack 이름은 `RN_1HR`를 쓰지 않음
- Pack: 변수별 일파일 `TA, RN_15M, RN_60M, RN_12HR, RN_24HR, WS_INS, WS, WD_INS, WD, HM, TD`. `FULL` 없음. backfill 후·어제 워밍. HTTP `variable` 기본 `TA`
- HTTP: `GET /api/aws/min/pack?date=YYYYMMDD&variable=TA|RN_60M|WS_INS|...` → `/datasets/aws/{slug}/1m/{day}/{slug}.i16le`
- 임의 구간 JSON은 `/api/aws/min/range` (2분). 수집 매분에 pack을 다시 만들지 않음
- Gate0: `probe_aws_min_cadence.js` (홀수분). 배포 후 `main_AWS`+`server` 재기동; 과거 파일은 backfill/Hub 복사 별도.
- 운영 체크리스트 상세: `references/ops-fetch.md`

## 관련 원천

- 실시간: `kma_fetch/main_AWS.js`
- Backfill: `kma_fetch/backfill_aws_min.js` (1440 slots/day, `--refresh-fields RN_12HR,TD` 는 Hub merge, 빈/부분 Hub로 덮어쓰지 않음)
- Hub client: `kma_fetch/services/aws_apihub_min.js`
- Pack: `kma_fetch/utils/aws_min_pack.js`, `kma_fetch/warm_aws_min_packs.js` (`warm_aws_ta_pack.js`는 TA wrapper)
- HTTP: `server.js` + `aws_min_json.js` + `aws_stn_catalog.js`
- 요건: `docs/aws-producer-1min-pack-requirements.md`
