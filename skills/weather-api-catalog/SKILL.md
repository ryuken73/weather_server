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
- **AWS**: `GET /api/aws/stations`, `/api/aws/min`, `/api/aws/min/range` (2분 호환), `/api/aws/min/pack` (1분 TA), `/api/aws/min/exact`
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

## 핵심 규칙

- `/api/hgt500/latest`는 mutable pointer다. animation은 `manifestUrl`의 `frames`를 쓴다.
- 새 KIM global TXT HGT500은 `/api/hgt500/*` + `/datasets/*`만 사용한다. `/kim-hgt500/.../image`는 레거시 NC 이미지다.
- `GET /api/hgt500/datasets`는 `Cache-Control: no-store`.
- GFS wind (`gfs-wind_*`)는 JSON, 대부분 다른 image type은 PNG.
- API를 추가·변경하면 **같은 작업에서** `docs/openapi.yaml`과 이 skill을 갱신한다 (`.cursor/rules/api-docs-sync.mdc`).
