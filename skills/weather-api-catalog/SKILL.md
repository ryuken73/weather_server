---
name: weather-api-catalog
description: weather_api 서버가 노출하는 HTTP API 카탈로그(producer). Use when calling or documenting /api/hgt500, /api/aws/min, /api/aws/min/pack, /api/aws/stations, /datasets, /ir105, /{type}/{area}/{step}/image, GFS wind, AWS_MIN JSON, IR105 image, OpenAPI, Swagger /docs, Postman/Apidog import, or weather_api base URL contracts.
---

# weather_api Catalog (Producer)

이 skill은 **weather_api 서버 HTTP 계약**의 진실 원천 요약이다. 상세 path/schema는 `docs/openapi.yaml`과 런타임 `/docs`를 우선한다.

## 다른 skill과의 경계

| Skill | 역할 |
| --- | --- |
| **weather-api-catalog** (이 skill) | Producer: 이 서버 endpoint·timestamp·응답·샘플 URL |
| **weather-external-resource-apis** (시스템) | Consumer: 시각화 프로젝트가 태풍+바람+구름 등 여러 외부를 어떻게 쓰는지 |
| **aws-min-json-pipeline** | AWS_MIN 수집·파일 포맷·누락 복구·API 허브 과거 backfill |
| **kim-hgt500-png-pipeline** | HGT500 변환/보간/packed PNG 복호화 (HTTP 외) |

바람/구름 URL이 겹치면 **이 catalog / OpenAPI를 권위 스펙으로** 따른다. 태풍·admin API는 이 서버에 없다.

## Base URL

- Listen: `0.0.0.0:3010`
- Local: `http://localhost:3010`
- Production: `https://weather-map.sbs.co.kr`
- CORS: `origin: *`
- OpenAPI UI: `GET /docs` → `https://weather-map.sbs.co.kr/docs`
- OpenAPI JSON: `GET /docs/json` (Postman/Apidog import)
- Repo YAML: `docs/openapi.yaml`

## Endpoint 요약

상세는 `references/endpoints.md`.

- **HGT500**: `GET /api/hgt500/latest`, `GET /api/hgt500/datasets`, `GET /api/hgt500/datasets/{id}/manifest` (302), static `/datasets/{id}/**`
- **AWS**: `GET /api/aws/stations`, `/api/aws/min`, `/api/aws/min/range` (2분·임의 구간 JSON), `/api/aws/min/pack` (1분 변수별 binary, 기본 TA), `/api/aws/min/exact`
- **IR105 JSON**: `GET /ir105/{area}/{step}`, `/batch`, `/fs`
- **레거시 image/wind**: `GET /{type}/{area}/{step}/image?timestamp_kor=`
- **Static**: `/weather/**`

미구현(호출 금지): `POST /api/hgt500/datasets`, `GET /api/hgt500/jobs/{jobId}`.

## 빠른 판단

1. HTTP path·query·응답 shape → `references/endpoints.md` 또는 `docs/openapi.yaml`
2. timestamp rounding → `references/timestamps.md`
3. 샘플 URL / Postman·Apidog → `references/samples.md`
4. HGT500 클라이언트 플로우·manifest frame schema → `docs/kim_hgt500_frontend_api_spec.md`
5. packed PNG 복호화·렌더링 → `skills/kim-hgt500-png-pipeline`
6. AWS_MIN 파일 채우기·과거 분 확보 → `skills/aws-min-json-pipeline`

## AWS API 선택 (consumer)

| 하고 싶은 일 | 쓸 API |
| --- | --- |
| 지점명·시도/구군 lookup | `GET /api/aws/stations` |
| 하루 기온 재생, 일최고/최저, 임계 돌파 (1분) | `GET /api/aws/min/pack?date={YYYYMMDD}&variable=TA` 후 `data.url` binary |
| 하루 강수 누적 (15분/60분/12시간/24시간 rolling / 당일) | `GET /api/aws/min/pack?date={YYYYMMDD}&variable=RN_60M` (또는 `RN_15M`,`RN_12HR`,`RN_24HR`,`RN_DAY`) |
| 하루 순간풍속 | `variable=WS_INS` (`WS`/`WD`/`WD_INS`/`HM`/`TD` 동일) |
| 여러 변수 하루 timeline | 같은 pack, `variable=TA,RN_60M,WS_INS` → `{variables, items[]}` (binary는 변수별). `FULL` 없음 |
| 임의 시각 구간, 전 변수 표/JSON, 2분 호환 | `GET /api/aws/min/range?from=&to=` (max 12h) |
| 한 시각 전 지점 JSON | `GET /api/aws/min?timestamp_kor=` (기본 2분 snap) |
| pack 값 vs 원본 1분 대조 | `GET /api/aws/min/exact` 또는 `intervalMinutes=1` |

일 pack은 서버가 어제/backfill 후 디스크에 만든다. 첫 요청 전에 워밍되면 바로 binary만 받는다. 오늘은 미완이라 요청 시 재빌드.

Pack binary 계약 (consumer):

- 결측은 모두 Int16 `-32768`. TA: `null`/`-999`/Hub ≤ -50℃/temporal QC. 강수: `null`/음수/Hub ≤ -50mm. **0 mm는 0**. 풍향 0–360(무풍 360). 통계에서 sentinel 제외
- Temporal QC는 **TA pack만**. 강수·바람·습도·이슬점 pack에는 적용하지 않음. `/exact`·디스크 JSON은 원천 그대로
- 과거 `complete:true`는 timestamp 파일 완결. 값 coverage는 `coverage.status` (`ok|degraded|empty`) / `dataComplete`. 전부 결측 pack을 정상으로 보지 말 것
- `schemaVersion: 4` / `contractRevision: 7`
- **강수 변수 구분 (필수)**
  - `RN_15M`/`RN_60M`/`RN_12HR`/`RN_24HR` → rolling. UI: “직전 N분/시간 누적”
  - `RN_DAY` → KST 당일 00시~현재. UI: “오늘 00시부터 누적”
  - `RN_24HR` manifest: `accumulation.type=rolling`, `windowMinutes=1440`, `sourceField=derived:RN-DAY`
  - `RN_DAY` manifest: `accumulation.type=day`, `timezone=Asia/Seoul`
  - binary URL: `RN_24HR` → **`/datasets/aws/rn_24hr_rolling/...`만**. legacy `/datasets/aws/rn_24hr/...`는 과거 day-total이므로 **사용·하드코딩 금지**
  - `RN_DAY` → `/datasets/aws/rn_day/...`
  - Hub가 00:00에 전일 총량을 남기면 producer가 **00:00→0 정규화** (RN_DAY·RN_24HR 공통). 자정 스파이크를 일최대/순위에 쓰지 말 것
  - RN_DAY upward spike: extreme/soft는 후보, reject는 복수 신호만. `suspect-retained`는 원값 보존 (`qc.rnDayQc`). equality·20mm/min 단독 reject 금지

## 핵심 규칙

- `/api/hgt500/latest`는 mutable pointer다. animation은 `manifestUrl`의 `frames`를 쓴다.
- 새 KIM global TXT HGT500은 `/api/hgt500/*` + `/datasets/*`만 사용한다. `/kim-hgt500/.../image`는 레거시 NC 이미지다.
- `GET /api/hgt500/datasets`는 `Cache-Control: no-store`.
- GFS wind (`gfs-wind_*`)는 JSON, 대부분 다른 image type은 PNG.
- API를 추가·변경하면 **같은 작업에서** `docs/openapi.yaml`과 이 skill을 갱신한다 (`.cursor/rules/api-docs-sync.mdc`).
