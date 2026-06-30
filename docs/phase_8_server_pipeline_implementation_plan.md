# Phase 8 KIM TXT Server Pipeline Implementation Plan

문서 상태: Draft
작성일: 2026-06-30
기준 문서: `docs/phase_8_server_pipeline_prd.md`
참고 코드: `ref/tools/kim-hgt-converter`

## 1. 목표

KMA API에서 500hPa `hgt` TXT 산출물을 주기적으로 다운로드하고, 클라이언트 globe가 바로 읽을 수 있는 packed PNG sequence와 manifest를 생성해 서비스한다.

현재 `weather_api` 서버는 복잡한 job server가 아니라, 별도 watcher가 파일을 만들고 Fastify 서버가 저장된 파일을 읽어주는 구조다. 따라서 Phase 8의 1차 구현도 기존 구조에 맞춰 아래처럼 간소화한다.

```text
KIM TXT watcher
  -> KMA API TXT download
  -> in_data/kim 저장
  -> Python sequence generator 실행
  -> out_data/kim/datasets/{datasetId} 산출
  -> latest manifest pointer 갱신
  -> Fastify static/API serving
```

PRD의 `POST /api/hgt500/datasets`, job queue, job polling API는 1차 구현 범위에서 제외하고, 생성된 최신 dataset을 조회/서빙하는 최소 API부터 구현한다.

## 2. 고정 제약

- KMA API에서 받은 raw TXT는 반드시 `in_data/kim` 아래에 저장한다.
- TXT 처리 후 생성한 PNG, metadata, manifest는 반드시 `out_data/kim` 아래에 저장한다.
- 기존 NetCDF 기반 KIM PSL/HGT 수집 흐름은 깨지지 않게 유지한다.
- 새 TXT 파이프라인은 기존 `kma_fetch/main_KIM.js`를 크게 뒤섞기보다 별도 watcher로 시작한다.
- ref converter는 그대로 import 가능한 패키지로 배포되어 있지 않으므로, 필요한 코드를 `kma_fetch/python` 아래로 복사/이식해 운영 스크립트로 만든다.

## 3. 디렉터리 구조

운영 기본 구조는 다음으로 둔다.

```text
in_data/
  kim/
    hgt500_txt/
      {tmfc}/
        kim_glob_prs_hgt500_ft000_{tmfc}.txt
        kim_glob_prs_hgt500_ft003_{tmfc}.txt
        ...

out_data/
  kim/
    datasets/
      kim-glob-hgt500-{tmfc}/
        manifest.json
        {frameStem}.png
        {frameStem}.json
        {frameStem}_preview.png
        {frameStem}_anomaly.png
    latest/
      hgt500.json
```

`in_data/kim/hgt500_txt/{tmfc}`는 다운로드 완료 여부 판단에 사용한다. `out_data/kim/datasets/{datasetId}`는 immutable asset directory로 취급한다. `out_data/kim/latest/hgt500.json`은 최신 성공 dataset의 manifest 위치를 알려주는 작은 pointer 파일로 둔다.

## 4. API 다운로드 계획

PRD의 curl 예시를 기준으로 KIM TXT URL builder를 추가한다.

```text
https://apihub-pub.kma.go.kr/api/typ01/cgi-bin/url/nph-kim_nc_xy_txt2
  ?group=KIMG
  &nwp=NE57
  &data=P
  &name=hgt
  &map=F
  &tmfc={YYYYMMDDHH}
  &hf={forecastHour}
  &disp=A
  &help=1
  &level=500
  &authKey={API_KEY}
```

추가할 설정:

- `API_ENDPOINT_KIM_TXT`: 기본값 `https://apihub-pub.kma.go.kr/api/typ01/cgi-bin/url`
- `KIM_TEXT_IN_DIR`: 기본값 `./in_data/kim`
- `KIM_TEXT_OUT_DIR`: 기본값 `./out_data/kim`
- `KIM_TEXT_MAX_HOURS`: 기본값 `72`
- `KIM_TEXT_INTERVAL_MINUTES`: 기본값 `10`
- `KIM_TEXT_DOWNSAMPLE_FACTOR`: 기본값 `3`
- `KIM_TEXT_FORECAST_HOURS`: 기본값 `0,3,6,...,72`

기존 `api.fetchFile()`은 stream을 파일로 안정 저장하는 목적에 부족하므로, TXT용 다운로드는 새 helper를 만든다.

- `.partial` 파일에 stream 저장
- 성공 시 atomic rename
- HTTP header가 TXT 본문 앞에 포함되어도 parser가 처리하도록 그대로 저장
- `Content-Disposition`이 없어도 예상 파일명으로 저장
- 같은 파일이 이미 있고 size가 0보다 크면 skip

## 5. Watcher 구현 계획

새 파일을 추가한다.

```text
kma_fetch/main_KIM_TXT.js
```

역할:

1. 현재 시각 기준으로 대상 `tmfc` 후보를 만든다.
2. 각 `hf` forecast hour에 대해 TXT 파일 존재 여부를 확인한다.
3. 없는 TXT만 KMA API에서 다운로드한다.
4. 필요한 source frame이 모두 준비되면 Python sequence generator를 실행한다.
5. 성공하면 `out_data/kim/latest/hgt500.json`을 갱신한다.

후보 `tmfc` 정책:

- 1차 구현은 기존 KIM watcher의 단순함을 유지해 `candidateCount = 1`, `delayHours = 12`를 기본값으로 둔다.
- cycle hour는 설정으로 분리한다.
- PRD에는 00/06/12/18이 언급되어 있으나 실제 KMA TXT 제공 cycle이 확정되지 않았으므로, 기본값은 운영 확인 후 `.env`에서 조정 가능하게 한다.

스케줄:

- `kma_fetch/services/scheduler.js`에 `kim_text_custom` 추가
- 초기 기본값: `30 * * * *`
- KIM API 생성 지연이 확인되면 기존 KIM처럼 여러 분대 재시도 cron으로 조정한다.

## 6. Python 변환기 구현 계획

ref의 converter를 바탕으로 운영용 script를 만든다.

```text
kma_fetch/python/kim_hgt_text_sequence_generator.py
kma_fetch/python/kim_hgt_converter/
```

이식 대상:

- `kim_text.py`: TXT parser와 downsample
- `packing.py`: uint16 R/G packed PNG encode/decode
- `metadata.py`: metadata JSON 생성
- `contracts.py`: 값 범위와 공통 상수
- `anomaly.py`: anomaly PNG 생성
- `converter.py`: sequence 보간 로직 참고

새 CLI:

```powershell
python -u kma_fetch/python/kim_hgt_text_sequence_generator.py `
  --input-dir in_data/kim/hgt500_txt/{tmfc} `
  --output-dir out_data/kim/datasets/kim-glob-hgt500-{tmfc} `
  --tmfc {YYYYMMDDHH} `
  --max-hours 72 `
  --interval 10 `
  --downsample 3
```

구현 핵심:

- TXT 파일명보다 `# fname:` 안의 `g576_v091_glob_prs.ftXXX.{tmfc}.nc`를 기준으로 `forecastHour`와 `analysisTime`을 파싱한다.
- 같은 `tmfc`인 source frame만 사용한다.
- forecast hour 오름차순으로 정렬한다.
- source frame 간격은 3시간, output frame 간격은 10분으로 선형 보간한다.
- 각 segment는 다음 source endpoint를 제외하고 생성하고, 마지막 source frame은 별도로 포함한다.
- packed PNG, preview PNG, anomaly PNG, metadata JSON을 frame별로 저장한다.
- sequence 전체에 대해 `manifest.json`을 저장한다.

메모리 정책:

- 120MB TXT를 여러 개 동시에 모두 들고 있지 않는다.
- parser는 frame 단위로 읽고 downsample을 즉시 적용한다.
- 보간은 인접한 두 source frame 중심으로 처리한다.
- `max_hours=72`, `downsample=3` 기준으로 1440x720 float frame을 다루는 것을 기본 운영 단위로 한다.

## 7. 출력 계약

dataset id:

```text
kim-glob-hgt500-{tmfc}
```

manifest:

```text
out_data/kim/datasets/{datasetId}/manifest.json
```

manifest의 frame asset path는 manifest 기준 상대경로로 기록한다.

```json
{
  "datasetId": "kim-glob-hgt500-2026062800",
  "source": {
    "format": "kim-api-text",
    "downsampleFactor": 3
  },
  "frames": [
    {
      "index": 0,
      "forecastHour": 0,
      "validTime": "2026-06-28T00:00:00Z",
      "dataPng": "g576_v091_glob_prs_hgt500_202606280000.png",
      "metadataJson": "g576_v091_glob_prs_hgt500_202606280000.json",
      "previewPng": "g576_v091_glob_prs_hgt500_202606280000_preview.png",
      "anomalyPng": "g576_v091_glob_prs_hgt500_202606280000_anomaly.png"
    }
  ]
}
```

latest pointer:

```json
{
  "datasetId": "kim-glob-hgt500-2026062800",
  "tmfc": "2026062800",
  "status": "succeeded",
  "sourceFormat": "kim-api-text",
  "downsampleFactor": 3,
  "manifestUrl": "/datasets/kim-glob-hgt500-2026062800/manifest.json"
}
```

## 8. Fastify 서빙 계획

`server.js`에 새 정적 serving root를 추가한다.

```text
prefix: /datasets/
root: {KIM_TEXT_OUT_DIR}/datasets
```

최소 API:

```http
GET /api/hgt500/latest
```

동작:

- `out_data/kim/latest/hgt500.json`을 읽어 반환한다.
- 파일이 없으면 404를 반환한다.

선택 API:

```http
GET /api/hgt500/datasets/:datasetId/manifest
```

동작:

- `/datasets/{datasetId}/manifest.json`으로 redirect하거나 JSON 파일을 직접 반환한다.

1차 구현에서는 `POST /api/hgt500/datasets`와 job polling API를 만들지 않는다. 현재 서버에는 queue, job store, background worker 관리 구조가 없고, PRD의 이 부분을 그대로 넣으면 기존 구조 대비 지나치게 무겁다. 필요해지면 latest/static serving이 안정화된 뒤 2차로 추가한다.

## 9. 기존 KIM 서빙 보정

현재 `server.js`의 KIM 파일명은 `etc.2byte`가 하드코딩되어 있다.

```js
fileName = `g576_v091_${area}_etc.2byte_${dataKind}_${timestamp}.png`;
```

이미 생성된 `prs.2byte_hgt500` 파일을 서빙하려면 이 부분도 정리해야 한다. Phase 8 작업 중 같이 보정한다.

제안:

```js
const kimTypeMap = {
  psl: { sub: 'etc', suffix: 'psl' },
  hgt500: { sub: 'prs', suffix: 'hgt500' }
};
```

새 TXT 기반 `glob` dataset은 `/datasets/...`로 서비스하므로 기존 `/:type/:area/:step/image` 라우트에 억지로 끼우지 않는다.

## 10. 구현 순서

1. 설정 추가
   - `kma_fetch/config/env.js`
   - `.env.development`, `.env.production` 운영값은 로컬에만 반영

2. KIM TXT URL builder와 stream 저장 helper 추가
   - `kma_fetch/services/api.js`
   - `kma_fetch/utils/file.js` 또는 새 `kma_fetch/utils/download.js`

3. Python converter 이식
   - `kma_fetch/python/kim_hgt_converter/*`
   - `kma_fetch/python/kim_hgt_text_sequence_generator.py`
   - `text-sequence` 기능 구현

4. TXT watcher 추가
   - `kma_fetch/main_KIM_TXT.js`
   - `scheduler.js`에 `kim_text_custom` 추가

5. Fastify serving 추가
   - `/datasets/` static
   - `/api/hgt500/latest`
   - 선택적으로 manifest redirect API

6. 기존 KIM 파일명 map 보정
   - `kim-psl`
   - `kim-hgt500`

7. 검증
   - 단일 TXT parse
   - source frame 2개로 10분 보간 sequence 생성
   - manifest relative path 실제 존재 확인
   - `node --check`
   - Python smoke test

## 11. 검증 체크리스트

TXT parser:

- HTTP response header가 앞에 붙은 TXT도 parse된다.
- `# fname`에서 `tmfc`와 `ftXXX`를 파싱한다.
- `hgt`, `m`, `500hPa`, `4320x2160`, `map=F`를 검증한다.
- `downsample=3` 결과가 `1440x720`이다.

Sequence:

- `ft000`, `ft003` 입력에서 00:00부터 03:00까지 19개 frame이 생성된다.
- 마지막 source frame이 포함된다.
- frame index가 0부터 연속된다.
- metadata와 manifest의 asset path가 실제 파일과 일치한다.

Server:

- `/api/hgt500/latest`가 latest pointer를 반환한다.
- `/datasets/{datasetId}/manifest.json`가 반환된다.
- manifest 안의 PNG/JSON relative URL이 브라우저에서 접근 가능하다.
- 기존 `/kim-psl/.../image` 동작이 유지된다.
- `/kim-hgt500/.../image`가 `prs.2byte` 파일을 찾도록 보정된다.

## 12. 보류 항목

아래는 PRD에는 있지만 현재 서버 수준에 맞춰 1차에서 보류한다.

- `POST /api/hgt500/datasets`
- job queue와 job polling API
- job 상태 영속 저장
- dataset 검색 API
- retention 자동 삭제
- 운영자 pin/latest 관리 UI
- 3072x1728 resampling
- NetCDF fallback 운영화

이 항목들은 TXT 다운로드, sequence 생성, latest/static serving이 안정화된 뒤 별도 phase로 진행한다.

## 13. 미확정 사항

- KMA TXT API가 실제로 제공하는 cycle hour 목록
- 운영 기본 `maxForecastHour`
- 운영 기본 `downsampleFactor`
- `in_data/kim`과 `out_data/kim`의 절대 경로
- latest가 항상 최신 성공 cycle을 가리킬지, 운영자가 pin한 cycle을 가리킬지
- raw TXT와 derived dataset retention 기간

1차 구현은 이 값들을 `.env`로 조정 가능하게 만들고, 코드 기본값은 보수적으로 둔다.
