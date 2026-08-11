# 경로·JSON schema

## 디스크 경로

```text
{resolveBaseDir('in_data')}/aws/{yyyy-MM-dd}/AWS_MIN_{yyyyMMddHHmm}.json
```

예 (운영):

```text
/data/node_project/weather_data/in_data/aws/2026-08-10/AWS_MIN_202608100006.json
```

`BASE_DIR`가 `in_data` / `out_data` / 상위 weather root 중 무엇이든 `file.resolveBaseDir('in_data')` 규칙을 따른다.  
서버 HTTP는 `AWS_JSON_DIR` 또는 동일 derive (`kma_fetch/utils/aws_min_json.js`).

레거시 PNG (`/aws-RN_15M/.../image`)와 station JSON은 별개다.

## JSON 항목 shape (MSSQL fetch / 서빙)

`main_AWS`가 저장하는 배열 원소:

| 필드 | 비고 |
| --- | --- |
| `STN_NAME` | `wx_AWS_Area` 조인. 원본/API에는 없음 |
| `STN_ID`, `TM` | TM = `YYYYMMDDHHMM` KST |
| `LAT`, `LON`, `HT` | |
| `WD`, `WS`, `TA`, `HM`, `PA`, `PS` | 내부 정수 스케일(대체로 물리값×10) |
| `RN_YN`, `RN_1HR`, `RN_15M`, `RN_60M`, `RN_24HR` | |
| `RN_6HR`, `RN_12HR`, `RN_48HR` | SQL에서 NULL |
| `WD_INS`, `WS_INS` | 순간 풍향/풍속 |

코드표(이름·좌표 보강):

- `kma_fetch/config/aws_stn_name_map_20260811.json`
- `kma_fetch/config/aws_stn_code_20260811.json` (`STN_ID`, `STN_NAME`, `LAT`, `LON`, `HT`)

2026-08-11 DB 기준 750지점 중 일부는 조인 실패로 `STN_NAME`이 null일 수 있다.

## HTTP

- `GET /api/aws/min?timestamp_kor=`
- `GET /api/aws/min/range?from=&to=`

상세는 `skills/weather-api-catalog` / `docs/openapi.yaml`.
