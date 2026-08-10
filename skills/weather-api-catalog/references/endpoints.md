# weather_api Endpoints

실구현 기준. Schema 세부사항은 `docs/openapi.yaml`을 따른다.

## HGT500

### `GET /api/hgt500/latest`

- 응답: dataset pointer JSON (`datasetId`, `tmfc`, `manifestUrl`, valid window, `frameCount` …)
- `404`: dataset 없음
- `500`: 내부 오류
- `latest`는 자주 바뀌므로 짧게 cache하거나 no-cache

### `GET /api/hgt500/datasets`

Query (모두 optional): `tmfc`, `from`, `to`, `intervalMinutes`, `downsampleFactor`, `sourceFormat`, `status`

- 응답: `{ items: Hgt500DatasetPointer[] }` (`tmfc` 내림차순)
- Header: `Cache-Control: no-store`
- `400`: query 형식 오류
- `from`/`to`는 valid window와 **구간 겹침(inclusive)**

### `GET /api/hgt500/datasets/{datasetId}/manifest`

- `datasetId` pattern: `kim-glob-hgt500-\d{10}`
- `302` → `/datasets/{datasetId}/manifest.json`
- `400`: invalid id

### Static `/datasets/{datasetId}/**`

- `manifest.json`, `dataPng`, `metadataJson`, `previewPng`, `anomalyPng`
- 상세 client flow: `docs/kim_hgt500_frontend_api_spec.md`

## AWS_MIN JSON

파일 원천: `in_data/aws/{yyyy-MM-dd}/AWS_MIN_{YYYYMMDDHHMM}.json` (`main_AWS.js` 산출).  
경로 override: env `AWS_JSON_DIR`. 기본은 `BASE_DIR` → `in_data/aws`.

### `GET /api/aws/min?timestamp_kor=`

- `timestamp_kor` = `YYYYMMDDHHMM` KST 필수, **2분 nearest snap**
- 응답: `{ timestamp_kor, requested_timestamp_kor, count, data[] }`
- `data[]`는 station row (`STN_ID`, `TM`, `LAT`, `LON`, `TA`, `RN_15M`, …)
- Header: `Cache-Control: no-store`
- `400` / `404` (파일 없음) / `500`

### `GET /api/aws/min/range?from=&to=`

- `from`, `to` = `YYYYMMDDHHMM` KST inclusive, 각각 2분 snap
- 2분 간격으로 열거. 최대 360 frames (~12h)
- 존재하는 파일만 `items[]`. 없는 시각은 `missingTimestamps[]`
- 응답: `{ from, to, intervalMinutes: 2, requestedCount, itemCount, missingTimestamps, items }`
- `400` (누락/순서/범위 초과) / `500`

레거시 PNG (`/aws-RN_15M/.../image`)와 별개다. station JSON은 이 API를 사용한다.

## IR105 JSON

### `GET /ir105/{area}/{step}?timestamp_kor=`

- PostgreSQL `ir105_json` 단건
- `timestamp_kor` 필수
- `400` / `404` / `500`

### `GET /ir105/{area}/{step}/batch?timestamps=`

- comma-separated timestamps
- 응답: `[{ observation_time_kor, data }, …]` JSON string

### `GET /ir105/{area}/{step}/fs?timestamp_utc=`

- filesystem gzip JSON (`Content-Encoding: gzip`)
- `timestamp_utc` = `YYYYMMDDHHMM` UTC
- `400` / `404`

## Legacy image / wind

### `GET /{type}/{area}/{step}/image?timestamp_kor=`

`timestamp_kor` = `YYYYMMDDHHMM` KST 필수.

지원 `type`:

| type | 응답 |
| --- | --- |
| `ir105-mono`, `ir105-color` | PNG |
| `rdr-hsp`, `rdr-hsp-equi` | PNG |
| `aws-RN_15M`, `aws-RN_60M` | PNG |
| `gfs-wind_10m`, `gfs-wind_850mb`, `gfs-wind_500mb` | JSON |
| `gfs-0p25_tmp_*`, `gfs-0p25_rh_*` | PNG |
| `gfs_equ-0p25_tmp_*` | PNG |
| `kim-psl`, `kim-hgt500` | PNG (레거시) |

Nearest snap:

| family | 규칙 |
| --- | --- |
| ir105, kim | 입력 그대로 |
| rdr | 5분 nearest |
| aws | 2분 nearest |
| gfs, gfs_equ | hour floor (분→00), 과거 시각 쪽 |

`area=fd` → projection `ge`, 그 외 `lc` (IR105 파일명).

`404` File not found, `400` missing timestamp / unsupported KIM kind.

## Static weather tree

### `GET /weather/**`

`MODE`에 따른 `ROOT_DIR_DEV` / `ROOT_DIR_PROD` 파일 트리.

## 이 서버에 없음

- 태풍 API (`/api/manifest`, `/api/typhoons`, `/api/admin/renew` …)
- HGT500 job API (`POST /api/hgt500/datasets`, `GET /api/hgt500/jobs/{jobId}`)
