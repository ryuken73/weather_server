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

파일 원천: `in_data/aws/{yyyy-MM-dd}/AWS_MIN_{YYYYMMDDHHMM}.json` (`main_AWS.js` 산출, **1분** 보존).  
경로 override: env `AWS_JSON_DIR`. 기본은 `BASE_DIR` → `in_data/aws`.  
지점 코드표: `kma_fetch/config/aws_stn_code_YYYYMMDD.json` (stn_inf).  
Pack binary: `out_data/aws/pack/` → `/datasets/aws/...` (env `AWS_PACK_DIR`).

### `GET /api/aws/stations`

- 응답: `{ source, generatedAt, codeFile, stationCount, stations[] }`
- `stations[]`: `STN_ID`, `STN_NAME`, `LAT`, `LON`, `HT`, `LAW_ADDR_SIDO`, `LAW_ADDR_GUGUN`
- Header: `Cache-Control: public, max-age=3600`

### `GET /api/aws/min/pack?date=&variable=TA`

- **권장**: `date=YYYYMMDD` (또는 `YYYY-MM-DD`) → 서버가 KST `0000–2359` 하루로 펼침
- 레거시: `from`/`to` (YYYYMMDDHHMM)도 허용
- 1분 exact, 최대 1440 frame
- `variable` 기본 `TA`. `FULL` 없음. 이후 `variable=TA,WS`처럼 복수 → 요청한 변수 url만
- 디스크: 변수별 `{var}.i16le` + 공유 `stations[]` (지금은 `ta.i16le`만)
- 응답: pack manifest (`intervalMinutes:1`, `stations[]`, `data.url`, `sha256`, `missingTimestamps`, `complete`)
- Binary: `GET {data.url}` → Int16 LE, scale 0.1℃, missing `-32768`, FRAME_MAJOR
- 생성: backfill 종료 후, `main_AWS`가 어제 하루 워밍, 또는 `warm_aws_ta_pack.js`. 오늘은 요청 시 재빌드
- 과거 `complete:true` → 디스크 캐시 + immutable / today → `no-store`
- `400` (`FULL`·미지원 변수·date 누락) / `404` (원자료 전무) / `500`

### `GET /api/aws/min/exact?timestamp_kor=`

- 1분 exact 단건 (debug/parity). enrich 포함

### `GET /api/aws/min?timestamp_kor=`

- 기본 **2분 nearest snap** (호환)
- `intervalMinutes=1`이면 exact
- 응답: `{ timestamp_kor, requested_timestamp_kor, intervalMinutes, count, data[] }`
- enrich: `STN_NAME`, `LAW_ADDR_SIDO`, `LAW_ADDR_GUGUN`
- `400` / `404` / `500`

### `GET /api/aws/min/range?from=&to=`

- 2분 간격, max 360 frames (~12h) — 호환 API
- 서버: 파일 병렬 read + parsed LRU. `enrich=0`이면 LAW 부착 생략
- **과거 구간** (`to` 날짜 < 오늘 KST): stringify 결과 메모리 캐시, `Cache-Control: public, max-age=86400`, `ETag`, 헤더 `X-AWS-Range-Cache: hit|miss`
- **오늘 포함**: `Cache-Control: no-store`
- 클라이언트가 `fetch(..., { cache: 'no-store' })`면 브라우저 캐시가 무시된다. 과거 날짜는 `cache: 'default'` 권장
- 임의 `from`/`to`·전 변수 JSON용으로 유지. 일단위 1분 기온/통계는 `/api/aws/min/pack`
- 12시간 JSON은 응답이 큼 (~7MB+). 과거일은 payload 메모리 캐시 + `max-age=86400`

레거시 PNG (`/aws-RN_15M/.../image`)와 별개다.

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
