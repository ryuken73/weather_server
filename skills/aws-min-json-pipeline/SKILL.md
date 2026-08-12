---
name: aws-min-json-pipeline
description: AWS_MIN station JSON 수집·누락 복구·과거 backfill·1분 TA pack. Use when working with main_AWS.js, backfill_aws_min.js, work/fetch_aws_apihub.js, in_data/aws AWS_MIN_*.json, nph-aws2_min, /api/aws/min/pack, or STN_NAME code table.
---

# AWS_MIN JSON Pipeline

방재 AWS 분 자료를 **시각별 station 배열 JSON**으로 만들고, 1분 TA pack을 제공하는 서버 파이프라인 skill이다. HTTP 조회 계약은 `weather-api-catalog`를 본다.

## 다른 skill과의 경계

| Skill | 역할 |
| --- | --- |
| **aws-min-json-pipeline** (이 skill) | 수집·저장·포맷·backfill·pack 생성 |
| **weather-api-catalog** | `/api/aws/min`, `/pack`, `/stations` HTTP 계약 |
| **weather-external-resource-apis** | 시각화 consumer |

## 빠른 판단

1. 실시간/준실시간 수집·lookback·누락·**운영 env/재기동/복사** → `references/ops-fetch.md`
2. 파일 경로·JSON shape·단위·pack → `references/paths-and-schema.md`
3. `#` 원본 / API 허브 응답 포맷·변환 → `references/formats.md`
4. 과거 한 달 등 → API 허브 `work/fetch_aws_apihub.js` (기본 **all-minutes**) → `work/out`를 `in_data/aws`로 복사
5. HTTP로 읽기만 → `skills/weather-api-catalog`

## 핵심 규칙

- 저장 경로: `{resolveBaseDir(in_data)}/aws/{yyyy-MM-dd}/AWS_MIN_{yyyyMMddHHmm}.json`
- 수집 주기는 **1분** (홀수분 포함). 기존 `/api/aws/min`·`/range`는 **2분 snap**으로 호환 유지.
- `AWS_FETCH_SOURCE=auto|db|hub` (기본 auto = **DB 후 Hub**). Hub에는 `API_KEY` 필요.
- `USE_API=true`(기본)이면 env 로드 시 `API_KEY` 필수. DB-only면 `USE_API=false` + `AWS_FETCH_SOURCE=db`.
- lookback: `candidateMinute:1`, `candiateCount:30`, 최신 2개 drop
- 기업용 API 허브: `apihub-pub.kma.go.kr` / `nph-aws2_min` / `stn=0` 최대 10분 창
- JSON TA는 ×10 정수. pack Int16도 동일 스케일(×0.1℃), missing `-32768` (`-999`·Hub ≤ -50℃ 포함)
- `STN_NAME` 저장 시 패치, `LAW_ADDR_*`는 HTTP enrich / stations / pack stations만
- Pack: 변수별 일파일 (지금은 TA만). `FULL` 없음. backfill 후·어제 워밍으로 미리 생성. 요청은 `variable=TA` (이후 `TA,WS`)
- HTTP: `GET /api/aws/min/pack?date=YYYYMMDD` → binary `/datasets/aws/ta/1m/{day}/ta.i16le`
- 임의 구간 JSON은 `/api/aws/min/range` (2분). 수집 매분에 pack을 다시 만들지 않음
- Gate0: `probe_aws_min_cadence.js` (홀수분). 배포 후 `main_AWS`+`server` 재기동; 과거 파일은 backfill/Hub 복사 별도.
- 운영 체크리스트 상세: `references/ops-fetch.md`

## 관련 원천

- 실시간: `kma_fetch/main_AWS.js`
- Backfill: `kma_fetch/backfill_aws_min.js` (1440 slots/day, 끝나면 TA pack 워밍)
- Hub client: `kma_fetch/services/aws_apihub_min.js`
- Pack: `kma_fetch/utils/aws_min_pack.js`, 수동 `kma_fetch/warm_aws_ta_pack.js`
- HTTP: `server.js` + `aws_min_json.js` + `aws_stn_catalog.js`
- 요건: `docs/aws-producer-1min-pack-requirements.md`
