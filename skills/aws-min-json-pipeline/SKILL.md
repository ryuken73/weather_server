---
name: aws-min-json-pipeline
description: AWS_MIN station JSON 수집·누락 복구·과거 backfill 파이프라인. Use when working with main_AWS.js, backfill_aws_min.js, work/fetch_aws_apihub.js, in_data/aws AWS_MIN_*.json, nph-aws2_min, STN_NAME code table, # raw AWS text, or /api/aws/min gaps.
---

# AWS_MIN JSON Pipeline

방재 AWS 분 자료를 **시각별 station 배열 JSON**으로 만들고 유지하는 서버 파이프라인 skill이다. HTTP 조회 계약은 `weather-api-catalog`를 본다.

## 다른 skill과의 경계

| Skill | 역할 |
| --- | --- |
| **aws-min-json-pipeline** (이 skill) | 수집·저장·포맷·backfill·누락 원인 |
| **weather-api-catalog** | `GET /api/aws/min`, `/range` 등 HTTP 계약 |
| **weather-external-resource-apis** | 시각화 consumer (태풍+다중 소스) |

## 빠른 판단

1. 실시간/준실시간 수집·lookback·누락 → `references/ops-fetch.md`
2. 파일 경로·JSON shape·단위 → `references/paths-and-schema.md`
3. `#` 원본 / API 허브 응답 포맷·변환 → `references/formats.md`
4. 과거 한 달 등 MSSQL/서버 원본에 없을 때 → API 허브 `work/fetch_aws_apihub.js`
5. HTTP로 읽기만 할 때 → `skills/weather-api-catalog`

## 핵심 규칙

- 저장 경로: `{resolveBaseDir(in_data)}/aws/{yyyy-MM-dd}/AWS_MIN_{yyyyMMddHHmm}.json`
- 운영 파이프라인 주기는 **2분**(짝수분). 1분 원본이 있어도 짝수분만 쓰는 것이 기본이다.
- `main_AWS.js`는 MSSQL `wx_AWS_MIN`만 조회한다. API 허브 실시간 pull은 아니다.
- lookback이 짧으면 DB 지연 시 `no data to save` 후 **영구 누락**된다. `candiateCount`와 일단위 backfill을 함께 본다.
- 기업용 API 허브 도메인은 `apihub-pub.kma.go.kr`다. 일반 `apihub.kma.go.kr`는 403이 날 수 있다.
- `nph-aws2_min` + `stn=0` 구간은 **최대 10분**. 하루 ≈ 144 호출.
- API 허브 값은 물리단위, MSSQL/`AWS_MIN_*.json`은 대체로 ×10 정수 스케일이다. 혼용하지 말 것.
- `STN_NAME`은 원본 `#`/API 분 자료에 없다. `kma_fetch/config/aws_stn_name_map_20260811.json` (또는 code 표)로 붙인다.

## 관련 원천

- 실시간 수집: `kma_fetch/main_AWS.js`
- 일단위 DB backfill: `kma_fetch/backfill_aws_min.js`
- SQL: `kma_fetch/utils/db.js` (`queryAwsMin`)
- HTTP 서빙: `server.js` + `kma_fetch/utils/aws_min_json.js`
- 지점 코드표: `kma_fetch/config/aws_stn_code_20260811.json`, `aws_stn_name_map_20260811.json`
- 일회성 도구: `work/fetch_aws_apihub.js`, `work/convert_aws_raw_to_json.js`, `work/README.md`
