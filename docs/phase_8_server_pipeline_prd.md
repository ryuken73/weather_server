# Phase 8 Server Pipeline PRD: KIM API TXT Download, PNG Generate, Image Serving

문서 상태: Draft
작성일: 2026-06-30
대상 구현: 별도 서버 세션

## 1. 목적

Phase 8의 서버는 주기적으로 KIM API에서 500hPa `hgt` 텍스트 산출물을 다운로드하고, 이 TXT 파일을 기준으로 웹 globe가 바로 읽을 수 있는 packed PNG, metadata JSON, manifest JSON을 생성한다.

이전 문서에서는 NetCDF를 기본 입력으로 설명했지만, 실제 운영 입력은 최근 사용한 120MB급 KIM API TXT 파일이다. 따라서 본 문서는 TXT를 primary source로 정의한다. NetCDF 경로는 legacy/reference 또는 fallback으로만 남긴다.

최종 목표는 다음 파이프라인이다.

```text
KIM API TXT download
  -> TXT parse / HGT500 grid extraction
  -> optional downsample
  -> 3-hour source frame sequence grouping
  -> 10-minute linear interpolation
  -> packed PNG + metadata JSON + preview PNG + anomaly PNG
  -> manifest JSON
  -> image/manifest serving API
  -> web timeline playback
```

## 2. 범위

### In Scope

- KIM API TXT 파일 주기적 다운로드
- 120MB급 TXT 파일 저장, 검증, 재시도
- TXT header와 row block parsing
- `hgt`, unit `m`, level `500hPa`, global grid 검증
- forecast cycle별 TXT frame grouping
- 3시간 source frame을 10분 간격으로 선형 보간
- R/G 16-bit packed PNG 생성
- frame metadata JSON 생성
- sequence manifest JSON 생성
- 생성 asset 정적 serving
- 웹 UI가 time range로 요청할 image download API 계약
- job 상태, cache, retention 정책 초안

### Out Of Scope

- Three.js renderer 변경
- WebCodecs MP4 녹화
- XR/Pixotope 송출 연동
- 웹 UI time range selector 구현
- KIM API 인증 상세값 확정
- NetCDF 기반 sequence 운영화

## 3. 기존 소스와 복사 기준

서버 구현 세션은 아래 소스를 우선 복사하거나 패키지로 재사용한다.

Primary TXT path:

- TXT parsing: `tools/kim-hgt-converter/src/kim_hgt_converter/kim_text.py`
- TXT single conversion: `tools/kim-hgt-converter/src/kim_hgt_converter/converter.py::convert_single_text`
- CLI reference: `tools/kim-hgt-converter/src/kim_hgt_converter/cli.py`, `single-text`
- packed PNG encode/decode: `tools/kim-hgt-converter/src/kim_hgt_converter/packing.py`
- metadata/filename 생성: `tools/kim-hgt-converter/src/kim_hgt_converter/metadata.py`
- 공통 상수: `tools/kim-hgt-converter/src/kim_hgt_converter/contracts.py`
- manifest schema: `docs/schemas/manifest.schema.json`
- metadata schema: `docs/schemas/metadata.schema.json`
- 웹 소비 로직: `web/src/timeline/createFrameSequence.ts`, `web/src/data/loaders.ts`, `web/src/data/types.ts`

Legacy/reference path:

- NetCDF extraction reference: `tools/kim-hgt-converter/src/kim_hgt_converter/dataset.py`
- NetCDF sequence reference: `tools/kim-hgt-converter/src/kim_hgt_converter/converter.py::convert_sequence`
- 예전 참고 스크립트: `ref/kim_hgt_png_generator.py`

중요 구현 gap:

- 현재 repo에는 TXT 단일 변환은 있지만 TXT sequence 변환은 별도 command로 완성되어 있지 않다.
- 서버 세션에서는 `convert_text_sequence` 또는 `text-sequence` command를 추가해야 한다.
- 기존 NetCDF `convert_sequence`의 보간/manifest 생성 로직은 재사용하되 source frame loader를 TXT parser로 교체한다.

## 4. KIM API TXT 입력 계약

### 4.1 파일 성격

현재 확인한 TXT 샘플:

```text
data/kim_prs_500_hgt.txt
size: 122,263,924 bytes
```

파일 앞부분에는 HTTP response header가 포함될 수 있다.

```text
HTTP/1.1 200 OK
Date: Mon, 29 Jun 2026 12:12:01 GMT
Server: Apache
Content-Type: text/plain
Transfer-Encoding: chunked
```

parser는 이 header를 무시하고 `# fname:` 이후의 KIM data header와 row block만 처리해야 한다.

### 4.2 Header 예시

```text
# fname: /ARCV/RAWD/MODL/GDPS/NE57/202606/28/00/ERLY/FCST/post/g576_v091_glob_prs.ft000.2026062800.nc, fsize: 0byte
# 자료처리 소요시간 = ...
# 변수명 = hgt, unit = m, level =     500, i =    4320, j =    2160, map = F
# j = 1
 4.88923e+03  4.88923e+03 ...
```

필수로 추출해야 하는 값:

- source file: `# fname`의 path
- forecast hour: source file명 안의 `.ft000.`
- analysis time: source file명 안의 `.2026062800.`
- variable: `hgt`
- unit: `m`
- level: `500`
- width: `i = 4320`
- height: `j = 2160`
- map: `F`
- row number: `# j = 1 ... # j = 2160`
- row values: scientific notation float list

### 4.3 Grid 계약

TXT 원본 grid:

- source width: `4320`
- source height: `2160`
- source lon resolution: `360 / 4320 = 1/12 degree`
- source lat resolution: `180 / 2160 = 1/12 degree`
- lon coverage: global
- lat values are interpreted as cell centers

현재 `kim_text.py` 기준 metadata:

```text
lonStart = 0.0
lonEnd = 360.0 - lonResolution
latStart = -90.0 + latResolution / 2
latEnd = 90.0 - latResolution / 2
latOrder = south-to-north
```

기본 downsample 정책:

- 운영 기본값 후보: `downsampleFactor = 3`
- 4320 x 2160 -> 1440 x 720
- downsample 방식: factor x factor block mean
- 이유: 브라우저 렌더링과 전송량 안정화

주의:

- 초기 요구사항의 `3072 x 1728`은 현재 TXT 원본 grid와 정수 factor로 맞지 않는다.
- Phase 8 서버는 우선 원본 grid 유지 또는 factor downsample만 지원한다.
- 3072 x 1728 resampling이 꼭 필요하면 별도 resampling 정책과 검증이 필요하다.

## 5. TXT Parse 알고리즘

기준 구현: `kim_text.py::extract_hgt500_text`

### 5.1 Parsing 절차

1. 파일을 `utf-8`, `errors="replace"`로 연다.
2. 빈 줄은 무시한다.
3. `# fname:` line을 만나면 source file path를 저장한다.
4. grid metadata line을 정규식으로 parsing한다.
   - variable
   - unit
   - level
   - width
   - height
   - map
5. `(height, width)` shape의 `float32` array를 할당한다.
6. `# j = N` line을 만나면 새 row buffer를 시작한다.
7. 숫자 line은 `np.fromstring(line, sep=" ", dtype=np.float32)`로 읽는다.
8. 각 row가 정확히 `width`개 값을 갖는지 확인한다.
9. row number가 `1..height` 범위인지 확인한다.
10. 모든 row가 채워졌는지 확인한다.
11. variable/unit/level을 검증한다.
12. optional downsample을 수행한다.

### 5.2 검증 조건

job 실패 조건:

- grid metadata line 없음
- variable이 `hgt`가 아님
- unit이 `m`이 아님
- level이 `500hPa`가 아님
- width/height 누락
- row 수가 height와 다름
- row별 value 수가 width와 다름
- downsample factor가 width/height를 나누어 떨어뜨리지 않음
- source file명에서 forecast hour 또는 analysis time을 파싱할 수 없음

### 5.3 시간 정보

`# fname`에서 source file명을 추출한다.

예:

```text
g576_v091_glob_prs.ft000.2026062800.nc
```

파싱:

```text
forecastHour = 0
analysisTime = 2026-06-28T00:00:00Z
validTime = analysisTime + forecastHour
```

`ft003`, `ft006` 등은 각각 3시간, 6시간 valid time으로 계산한다.

## 6. PNG Generate 알고리즘

### 6.1 값 범위와 packing

기준 구현: `contracts.py`, `packing.py`

고도장 packed PNG:

- `VALUE_MIN = 4500.0`
- `VALUE_MAX = 6500.0`
- `PNG_MODE = "RGB"`
- `PACKING = "uint16-rg-big-endian"`
- R 채널: high byte
- G 채널: low byte
- B 채널: unused, `0`
- alpha: unused
- missing value: alpha를 쓰지 않고 metadata의 `missingCount`와 sentinel 정책으로 처리

인코딩 공식:

```python
finite_values = np.where(np.isfinite(values), values, VALUE_MIN)
clipped = np.clip(finite_values, VALUE_MIN, VALUE_MAX)
normalized = (clipped - VALUE_MIN) / (VALUE_MAX - VALUE_MIN)
encoded = (normalized * 65535.0).astype(np.uint16)
rgb[..., 0] = (encoded >> 8) & 0xFF
rgb[..., 1] = encoded & 0xFF
rgb[..., 2] = 0
```

디코딩 공식:

```python
encoded = (r << 8) | g
value = encoded / 65535.0 * (VALUE_MAX - VALUE_MIN) + VALUE_MIN
```

허용 오차:

```text
(VALUE_MAX - VALUE_MIN) / 65535 ~= 0.03052 m
```

### 6.2 Preview PNG

- preview는 사람이 확인하기 위한 RGB 컬러 PNG다.
- 브라우저의 실제 수치 렌더링은 preview가 아니라 packed PNG를 사용한다.
- 기준 구현: `packing.py::save_preview_png`

### 6.3 Anomaly PNG

- anomaly는 선택 기능이지만 현재 converter는 생성한다.
- 기준 구현: `anomaly.py::compute_local_anomaly`
- packing 방식은 HGT와 동일하되 value range만 다르다.

```text
ANOMALY_VALUE_MIN = -512.0
ANOMALY_VALUE_MAX = 512.0
```

metadata의 `anomaly` 객체에 reference, value range, statistics를 기록한다.

## 7. TXT Sequence Generate 알고리즘

서버 구현 세션에서 새로 구현해야 하는 핵심 기능이다.

제안 함수:

```python
convert_text_sequence(
    input_dir: Path,
    output_dir: Path,
    tmfc: str,
    max_hours: int = 72,
    interval_minutes: int = 10,
    downsample_factor: int = 3,
) -> SequenceConversionResult
```

제안 CLI:

```powershell
uv run kim-hgt-convert text-sequence `
  --input-dir <downloaded_txt_dir> `
  --tmfc <YYYYMMDDHH> `
  --output-dir <derived_dataset_dir> `
  --max-hours 72 `
  --interval 10 `
  --downsample 3
```

### 7.1 Source frame grouping

TXT 파일은 `# fname` 안의 source file명 기준으로 group한다.

필수:

- 같은 `analysisTime`을 가진 frame만 하나의 sequence에 포함한다.
- `forecastHour` 기준 오름차순 정렬한다.
- `forecastHour <= max_hours`만 포함한다.
- frame shape, source shape, downsample factor가 모두 동일해야 한다.

파일명 자체가 API download 이름이라 forecast hour가 없을 수 있으므로, 반드시 `# fname`을 기준으로 파싱한다.

### 7.2 Interpolation

source forecast interval:

```text
180 minutes
```

output frame interval:

```text
default 10 minutes
```

보간 공식:

```python
ratio = offset_minutes / segment_minutes
values = current.values * (1.0 - ratio) + next_frame.values * ratio
valid_time = current.valid_time + offset_minutes
forecast_hour = current.forecast_hour + offset_minutes / 60
```

중복 방지:

- 각 segment는 다음 source endpoint를 제외하고 생성한다.
- 마지막 source forecast valid time은 별도 frame으로 포함한다.

예:

```text
ft000, ft003, interval=10
=> 00:00, 00:10, ..., 02:50, 03:00
```

## 8. Metadata JSON 계약

metadata는 각 frame별로 생성한다.

TXT source metadata는 기존 metadata schema에 추가 필드를 포함한다. schema는 `additionalProperties: true`이므로 아래 확장을 허용한다.

예:

```json
{
  "schemaVersion": 1,
  "assetType": "kim-hgt500-packed-png",
  "source": {
    "model": "KIM",
    "domain": "glob",
    "inputFile": "kim_prs_500_hgt_ft000_2026062800.txt",
    "referenceScript": "tools/kim-hgt-converter/src/kim_hgt_converter/kim_text.py",
    "format": "kim-api-text",
    "sourceFile": "g576_v091_glob_prs.ft000.2026062800.nc"
  },
  "variable": {
    "name": "hgt",
    "standardName": "geopotential_height",
    "unit": "m",
    "dims": ["time", "levs", "lats", "lons"],
    "levelIndex": 13,
    "levelValue": 500.0,
    "levelUnit": "hPa",
    "expectedLevelIndex": 13,
    "expectedLevelIndexMatches": true
  },
  "grid": {
    "projection": "equirectangular",
    "width": 1440,
    "height": 720,
    "lonStart": 0.0,
    "lonEnd": 359.75,
    "lonResolution": 0.25,
    "latStart": -89.875,
    "latEnd": 89.875,
    "latResolution": 0.25,
    "latOrder": "south-to-north",
    "sourceWidth": 4320,
    "sourceHeight": 2160,
    "sourceLonResolution": 0.08333333333333333,
    "sourceLatResolution": 0.08333333333333333,
    "downsampleFactor": 3
  },
  "time": {
    "analysisTime": "2026-06-28T00:00:00Z",
    "validTime": "2026-06-28T00:00:00Z",
    "forecastHour": 0
  },
  "encoding": {
    "format": "png",
    "mode": "RGB",
    "packing": "uint16-rg-big-endian",
    "valueMin": 4500.0,
    "valueMax": 6500.0,
    "r": "high_byte",
    "g": "low_byte",
    "b": "unused",
    "alpha": "unused",
    "missingValue": null,
    "missingValuePolicy": "metadata-sentinel"
  },
  "statistics": {
    "frameMin": 4801.0,
    "frameMax": 5930.0,
    "frameMean": 5530.89,
    "clippedLowCount": 0,
    "clippedHighCount": 0,
    "missingCount": 0
  },
  "assets": {
    "dataPng": "frame.png",
    "previewPng": "frame_preview.png",
    "anomalyPng": "frame_anomaly.png"
  },
  "sequencePolicy": {
    "sourceForecastIntervalMinutes": 180,
    "outputFrameIntervalMinutes": 10,
    "interpolation": "linear"
  }
}
```

주의:

- TXT downsample 결과는 `1440 x 720`일 수 있다.
- 기존 NetCDF sample의 `1440 x 721`과 다르지만 metadata grid 계약이 정확하면 웹 decoder/renderer는 width/height를 metadata 기준으로 처리해야 한다.
- frame 간 width/height가 섞이면 안 된다.

## 9. Manifest JSON 계약

manifest는 sequence 전체에 대해 하나 생성한다.

```json
{
  "schemaVersion": 1,
  "datasetId": "kim-glob-hgt500-2026062800",
  "variable": "hgt",
  "unit": "m",
  "domain": "glob",
  "defaultColorMap": "rainbow-geoid",
  "defaultValueRange": [4801.0, 5930.0],
  "defaultAnomalyReference": "sequenceMean",
  "sourceForecastIntervalMinutes": 180,
  "outputFrameIntervalMinutes": 10,
  "interpolation": "linear",
  "sequenceStatistics": {
    "frameMin": 4801.0,
    "frameMax": 5930.0,
    "frameMean": 5530.89,
    "frameCount": 433
  },
  "source": {
    "format": "kim-api-text",
    "downsampleFactor": 3
  },
  "frames": [
    {
      "index": 0,
      "forecastHour": 0,
      "validTime": "2026-06-28T00:00:00Z",
      "dataPng": "frame.png",
      "metadataJson": "frame.json",
      "previewPng": "frame_preview.png",
      "anomalyPng": "frame_anomaly.png"
    }
  ]
}
```

권장 dataset id:

```text
kim-glob-hgt500-{tmfc}
```

예:

```text
kim-glob-hgt500-2026062800
```

주의:

- `frames[*].metadataJson`, `dataPng`, `previewPng`, `anomalyPng`는 manifest URL 기준 상대경로를 권장한다.
- 웹의 `resolveAssetUrl()`은 manifest 또는 metadata URL 기준으로 상대경로를 해석한다.
- `defaultValueRange`와 `sequenceStatistics`는 timeline playback 중 색상, 필터, displacement 기준을 고정하는 데 사용한다.

## 10. 출력 파일 구조

한 dataset은 아래 구조로 serving 가능해야 한다.

```text
/datasets/{datasetId}/
  manifest.json
  {frameStem}.png
  {frameStem}.json
  {frameStem}_preview.png
  {frameStem}_anomaly.png
```

웹 앱의 기본 정적 manifest 경로는 `/datasets/kim-glob-hgt500/manifest.json`이다. 운영 서버는 alias 또는 latest symlink 개념으로 아래 중 하나를 제공한다.

- `/datasets/kim-glob-hgt500/manifest.json` -> 최신 또는 운영자가 pin한 dataset manifest
- `/datasets/{datasetId}/manifest.json` -> 특정 forecast cycle manifest

## 11. 서버 기능 요구사항

### 11.1 TXT Download Scheduler

서버는 주기적으로 KIM API에서 forecast frame별 TXT를 다운로드한다.

요구사항:

- cycle id: `tmfc` 형식 `YYYYMMDDHH`
- forecast hour: `ft000`, `ft003`, `ft006`, ...
- variable: `hgt`
- level: `500hPa`
- file size: 120MB급 frame 처리
- 다운로드 완료 전에는 변환 job을 시작하지 않는다.
- 부분 다운로드 파일은 `.partial` 또는 임시 경로에 저장 후 atomic rename한다.
- HTTP header가 파일에 포함되어도 parser가 처리 가능해야 한다.
- 같은 frame 재다운로드 시 checksum, size, mtime 중 하나로 동일성 확인

설정 예:

```json
{
  "kimTextApiBaseUrl": "https://internal-kim-api.example",
  "pollIntervalMinutes": 10,
  "forecastCycles": ["00", "06", "12", "18"],
  "forecastHours": [0, 3, 6, 9, 12, 15, 18, 21, 24],
  "maxForecastHour": 72,
  "rawStorageDir": "/data/kim/raw-text",
  "derivedStorageDir": "/data/kim/derived",
  "downsampleFactor": 3
}
```

KIM API URL/query schema는 아직 미정이다. 서버 구현 세션에서 실제 내부 API 계약을 확인해 아래 정보를 확정한다.

- endpoint URL
- auth 필요 여부
- request parameter 이름
- forecast hour 지정 방식
- timeout/retry 정책

### 11.2 Generate Job

서버는 다운로드된 한 forecast cycle에 대해 TXT sequence 변환 job을 실행한다.

기본 옵션:

- source format: `kim-api-text`
- variable: `hgt`
- level: `500hPa`
- source interval: `180`분
- output interval: `10`분
- interpolation: `linear`
- downsample factor: `3`
- value range: `4500..6500m`
- anomaly range: `-512..512m`

job 상태:

- `queued`
- `downloading`
- `running`
- `succeeded`
- `failed`
- `cancelled`

job은 idempotent해야 한다. 같은 `tmfc`, `maxForecastHour`, `outputFrameIntervalMinutes`, `downsampleFactor` 조합의 dataset이 이미 성공 상태면 기존 결과를 재사용한다.

### 11.3 Asset Serving

서버는 생성 asset을 정적 파일처럼 빠르게 제공해야 한다.

권장 cache 정책:

- immutable dataset asset:
  - `Cache-Control: public, max-age=31536000, immutable`
  - 대상: 특정 `{datasetId}` 아래 PNG/metadata/manifest
- latest alias:
  - `Cache-Control: no-store` 또는 짧은 max-age
  - 대상: `/datasets/kim-glob-hgt500/manifest.json`, `/api/hgt500/latest`

권장 CORS:

```text
Access-Control-Allow-Origin: <web-origin>
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
```

## 12. Image Download API 계약

API는 동기 생성과 비동기 생성을 모두 지원할 수 있어야 한다. 120MB급 TXT source와 긴 forecast sequence를 고려하면 비동기 job 방식을 기본으로 권장한다.

### 12.1 최신 dataset 조회

```http
GET /api/hgt500/latest
```

응답:

```json
{
  "datasetId": "kim-glob-hgt500-2026062800",
  "tmfc": "2026062800",
  "sourceFormat": "kim-api-text",
  "downsampleFactor": 3,
  "status": "succeeded",
  "analysisTime": "2026-06-28T00:00:00Z",
  "validTimeStart": "2026-06-28T00:00:00Z",
  "validTimeEnd": "2026-07-01T00:00:00Z",
  "sourceForecastIntervalMinutes": 180,
  "outputFrameIntervalMinutes": 10,
  "frameCount": 433,
  "manifestUrl": "/datasets/kim-glob-hgt500-2026062800/manifest.json"
}
```

### 12.2 dataset 검색

```http
GET /api/hgt500/datasets?tmfc=2026062800&from=2026-06-28T00:00:00Z&to=2026-06-29T00:00:00Z&intervalMinutes=10&sourceFormat=kim-api-text
```

query:

- `tmfc`: optional, forecast cycle id
- `from`: optional, ISO valid time start
- `to`: optional, ISO valid time end
- `intervalMinutes`: optional, default `10`
- `maxForecastHour`: optional
- `downsampleFactor`: optional, default `3`
- `sourceFormat`: optional, default `kim-api-text`
- `status`: optional, default `succeeded`

응답:

```json
{
  "items": [
    {
      "datasetId": "kim-glob-hgt500-2026062800",
      "tmfc": "2026062800",
      "sourceFormat": "kim-api-text",
      "downsampleFactor": 3,
      "status": "succeeded",
      "analysisTime": "2026-06-28T00:00:00Z",
      "validTimeStart": "2026-06-28T00:00:00Z",
      "validTimeEnd": "2026-07-01T00:00:00Z",
      "frameCount": 433,
      "manifestUrl": "/datasets/kim-glob-hgt500-2026062800/manifest.json"
    }
  ]
}
```

### 12.3 dataset 생성 요청

```http
POST /api/hgt500/datasets
Content-Type: application/json
```

요청:

```json
{
  "tmfc": "2026062800",
  "sourceFormat": "kim-api-text",
  "validTimeStart": "2026-06-28T00:00:00Z",
  "validTimeEnd": "2026-06-29T00:00:00Z",
  "maxForecastHour": 72,
  "outputFrameIntervalMinutes": 10,
  "downsampleFactor": 3,
  "includePreview": true,
  "includeAnomaly": true,
  "forceRegenerate": false
}
```

응답 200, 이미 생성됨:

```json
{
  "status": "succeeded",
  "datasetId": "kim-glob-hgt500-2026062800",
  "manifestUrl": "/datasets/kim-glob-hgt500-2026062800/manifest.json"
}
```

응답 202, 생성 필요:

```json
{
  "status": "queued",
  "jobId": "job_2026062800_hgt500_text_10m_ds3_72h",
  "datasetId": "kim-glob-hgt500-2026062800",
  "statusUrl": "/api/hgt500/jobs/job_2026062800_hgt500_text_10m_ds3_72h"
}
```

### 12.4 job 상태 조회

```http
GET /api/hgt500/jobs/{jobId}
```

응답:

```json
{
  "jobId": "job_2026062800_hgt500_text_10m_ds3_72h",
  "datasetId": "kim-glob-hgt500-2026062800",
  "sourceFormat": "kim-api-text",
  "status": "running",
  "progress": {
    "stage": "generate",
    "currentFrame": 128,
    "totalFrames": 433,
    "percent": 29.6
  },
  "createdAt": "2026-06-30T01:00:00Z",
  "updatedAt": "2026-06-30T01:03:20Z",
  "manifestUrl": null,
  "error": null
}
```

성공 응답:

```json
{
  "jobId": "job_2026062800_hgt500_text_10m_ds3_72h",
  "datasetId": "kim-glob-hgt500-2026062800",
  "sourceFormat": "kim-api-text",
  "status": "succeeded",
  "progress": {
    "stage": "done",
    "currentFrame": 433,
    "totalFrames": 433,
    "percent": 100
  },
  "manifestUrl": "/datasets/kim-glob-hgt500-2026062800/manifest.json",
  "error": null
}
```

실패 응답:

```json
{
  "jobId": "job_2026062800_hgt500_text_10m_ds3_72h",
  "datasetId": "kim-glob-hgt500-2026062800",
  "sourceFormat": "kim-api-text",
  "status": "failed",
  "progress": {
    "stage": "parse",
    "currentFrame": 2,
    "totalFrames": 25,
    "percent": 8
  },
  "manifestUrl": null,
  "error": {
    "code": "KIM_TEXT_ROW_INCOMPLETE",
    "message": "row j=913 has fewer values than expected width=4320",
    "details": {
      "tmfc": "2026062800",
      "forecastHour": 6,
      "row": 913
    }
  }
}
```

### 12.5 manifest 직접 조회

```http
GET /api/hgt500/datasets/{datasetId}/manifest
```

권장:

```http
302 Location: /datasets/{datasetId}/manifest.json
```

또는:

```http
200 Content-Type: application/json
```

### 12.6 image/metadata asset 조회

정적 serving 권장:

```http
GET /datasets/{datasetId}/{assetName}
```

예:

```http
GET /datasets/kim-glob-hgt500-2026062800/g576_v091_glob_prs_hgt500_202606280000.png
GET /datasets/kim-glob-hgt500-2026062800/g576_v091_glob_prs_hgt500_202606280000.json
```

응답 header:

```text
Content-Type: image/png
Cache-Control: public, max-age=31536000, immutable
```

```text
Content-Type: application/json; charset=utf-8
Cache-Control: public, max-age=31536000, immutable
```

## 13. 웹 연동 기대 동작

Phase 8 웹 UI는 다음 흐름으로 연동한다.

1. 사용자가 time range 또는 forecast cycle을 선택한다.
2. 웹은 `POST /api/hgt500/datasets`로 dataset 생성을 요청한다.
3. 200이면 즉시 `manifestUrl`을 로드한다.
4. 202이면 `statusUrl`을 polling한다.
5. job이 `succeeded`가 되면 `manifestUrl`을 `createFrameSequence()`에 전달한다.
6. manifest frame의 metadata/PNG는 기존 lazy loading/cache 로직으로 로드한다.
7. API 실패 시 기존 정적 fallback manifest 또는 명확한 오류 UI로 전환한다.

현재 웹 loader의 중요한 제약:

- JSON fetch는 `cache: "no-store"`를 사용한다.
- packed PNG texture는 `NoColorSpace`, `NearestFilter`, `flipY=false`로 로드한다.
- metadata의 `assets.dataPng`는 metadata JSON URL 기준 상대경로로 해석한다.
- manifest의 `frames[*].metadataJson`은 manifest URL 기준 상대경로로 해석한다.

## 14. 운영 정책

### 14.1 저장소

권장 디렉터리:

```text
/data/kim/raw-text/{tmfc}/
/data/kim/derived/{datasetId}/
/data/kim/jobs/
```

원본 TXT와 생성 PNG는 git 추적 대상이 아니다.

### 14.2 Retention

초안:

- raw TXT: 7일
- derived dataset: 14일
- latest alias: 항상 최신 succeeded dataset 또는 운영자가 pin한 dataset
- pinned dataset: 수동 삭제 전까지 유지

방송/발표에 사용한 dataset은 pinned 처리해 자동 삭제에서 제외한다.

### 14.3 동시성/메모리

- 다운로드 worker와 변환 worker를 분리한다.
- 동일 `tmfc` job은 하나만 실행한다.
- 120MB TXT 여러 개를 동시에 모두 메모리에 올리지 않는다.
- source frame parsing은 순차 처리하고, interpolation에 필요한 인접 frame 2개 위주로 유지한다.
- downsample을 가능한 early stage에서 수행해 이후 frame memory를 줄인다.
- PNG 저장은 frame 단위로 즉시 write한다.

## 15. 검증 요구사항

### 15.1 TXT parser 검증

- 120MB급 TXT 1개 parse 성공
- HTTP response header가 포함되어도 parse 성공
- `# fname`에서 analysis time/forecast hour 추출
- `hgt`, unit `m`, level `500` 검증
- `i=4320`, `j=2160` grid 검증
- 모든 row가 정확히 width 개수 값을 갖는지 확인
- downsample factor 3 적용 시 `1440 x 720` 생성

### 15.2 PNG round-trip 검증

- single TXT frame packed PNG 생성
- generated PNG decode round-trip 오차 `<= 0.031m`
- metadata schema validation 통과
- missing/clipped count 기록

### 15.3 Sequence 검증

- TXT source frame들이 같은 `tmfc`로 grouping됨
- source 3시간 간격이 10분 output으로 정확히 보간됨
- 마지막 source frame이 포함됨
- frame index가 0부터 연속됨
- `sequenceStatistics.frameCount`와 실제 frame 수 일치
- `defaultValueRange`가 전체 sequence min/max 기준
- manifest의 모든 relative asset path가 실제 존재
- manifest schema validation 통과

### 15.4 웹 호환 검증

서버가 생성한 manifest를 웹 `public/datasets/kim-glob-hgt500/manifest.json` 또는 API URL로 연결한 뒤 아래를 통과해야 한다.

```powershell
cd web
yarn.cmd build
yarn.cmd verify:browser-decode
yarn.cmd verify:globe-render
```

converter 패키지를 그대로 쓸 경우:

```powershell
cd tools/kim-hgt-converter
uv run pytest
```

## 16. Error Code 초안

```text
KIM_TEXT_SOURCE_UNAVAILABLE
KIM_TEXT_DOWNLOAD_FAILED
KIM_TEXT_EMPTY_RESPONSE
KIM_TEXT_HEADER_MISSING
KIM_TEXT_GRID_MISSING
KIM_TEXT_VARIABLE_MISMATCH
KIM_TEXT_UNIT_MISMATCH
KIM_TEXT_LEVEL_MISMATCH
KIM_TEXT_ROW_OUT_OF_RANGE
KIM_TEXT_ROW_INCOMPLETE
KIM_TEXT_ROW_OVERFLOW
KIM_TEXT_ROW_COUNT_MISMATCH
KIM_TEXT_DOWNSAMPLE_INVALID
KIM_TEXT_FORECAST_TIME_MISSING
KIM_GRID_MISMATCH
HGT_GENERATE_FAILED
HGT_SCHEMA_INVALID
HGT_ASSET_NOT_FOUND
JOB_CANCELLED
INTERNAL_ERROR
```

Legacy NetCDF error code는 서버가 NetCDF fallback을 구현할 때만 추가한다.

## 17. 결정 필요 항목

- KIM TXT API URL, 인증 방식, request parameter 이름
- forecast hour별 TXT를 어떤 URL/query로 받을지
- 운영 forecast cycle 목록
- 최대 forecast hour 기본값
- output interval을 항상 10분으로 고정할지
- downsample factor 기본값을 3으로 고정할지, full-res도 지원할지
- `1440 x 720` TXT downsample 결과를 웹 기본으로 확정할지
- 3072 x 1728 target이 여전히 필요한지
- API 인증 필요 여부
- latest alias가 최신 cycle을 자동 가리킬지, 운영자가 pin한 cycle을 가리킬지
- raw/derived retention 기간

## 18. 완료 기준

- 특정 `tmfc`에 대해 KIM API TXT 다운로드부터 `manifest.json` serving까지 자동 수행된다.
- 120MB급 TXT source가 안정적으로 parse된다.
- 생성된 manifest/metadata/PNG가 기존 웹 renderer에서 추가 변환 없이 재생된다.
- time range 요청 API가 200 또는 202 job flow로 안정적으로 동작한다.
- job 실패 시 재시도 가능한 오류 정보가 남는다.
- 메모리/시간/디스크 사용량이 운영 로그에 기록된다.
- 운영자가 latest dataset을 웹 앱에 연결하는 절차가 문서화되어 있다.

## 소스 TXT 다운로드 주소
- 아래 curl 명령 참조
```
curl -i "https://apihub-pub.kma.go.kr/api/typ01/cgi-bin/url/nph-kim_nc_xy_txt2?group=KIMG&nwp=NE57&data=P&name=hgt&map=F&tmfc=2026062400&hf=0&disp=A&help=1&level=500&authKey=" -o kim_prs_500_hgt_0624.txt
```
