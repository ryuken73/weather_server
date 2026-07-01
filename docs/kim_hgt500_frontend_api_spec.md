# KIM HGT500 Frontend API Spec

작성일: 2026-07-01

이 문서는 KIM TXT 기반 500hPa 지위고도 데이터셋을 프론트엔드에서 조회하고 렌더링하기 위한 서버 연동 스펙이다. 실제 구현 기준 문서이며, PRD에 있던 job 생성 API나 dataset 목록 API는 현재 서버 범위에 포함하지 않는다.

## Scope

제공 데이터:

- 모델: KIM
- 변수: 500hPa geopotential height
- 변수명: `hgt`
- 단위: `m`
- 도메인: `glob`
- 소스 포맷: `kim-api-text`
- 기본 생성 주기: KIM 분석시각 `00, 06, 12, 18 UTC`
- 기본 예측 범위: `0h`부터 `72h`
- 기본 출력 간격: `10분`
- 기본 downsample factor: `3`

주의:

- 새 KIM TXT 데이터셋은 `/datasets/...`와 `/api/hgt500/...`로 사용한다.
- 기존 `/kim-hgt500/.../image` 라우트는 기존 KIM NC 기반 이미지용이며, 새 global TXT dataset 연동용이 아니다.

## Base URL

운영 API 호스트를 기준으로 상대 경로를 사용한다.

```text
https://<weather-api-host>
```

예:

```text
GET https://<weather-api-host>/api/hgt500/latest
GET https://<weather-api-host>/datasets/kim-glob-hgt500-2026070100/manifest.json
```

서버 CORS는 `origin: *`로 열려 있다.

## Client Flow

1. `GET /api/hgt500/latest`로 최신 성공 dataset pointer를 조회한다.
2. 응답의 `manifestUrl`을 fetch한다.
3. manifest의 `frames` 배열을 `index` 순서로 사용한다.
4. 각 frame의 `dataPng`, `metadataJson`, `previewPng`, `anomalyPng`를 `/datasets/{datasetId}/` 아래 상대 경로로 조합한다.
5. 실제 수치 렌더링은 `dataPng`와 frame metadata의 `encoding`을 사용해 디코딩한다.
6. anomaly 렌더링은 `anomalyPng`와 metadata의 `anomaly.encoding`을 사용한다.

## Endpoints

### GET `/api/hgt500/latest`

최신 성공 dataset의 pointer를 반환한다.

성공 응답 예:

```json
{
  "datasetId": "kim-glob-hgt500-2026070100",
  "tmfc": "2026070100",
  "status": "succeeded",
  "sourceFormat": "kim-api-text",
  "downsampleFactor": 3,
  "analysisTime": "2026-07-01T00:00:00Z",
  "validTimeStart": "2026-07-01T00:00:00Z",
  "validTimeEnd": "2026-07-04T00:00:00Z",
  "sourceForecastIntervalMinutes": 180,
  "outputFrameIntervalMinutes": 10,
  "frameCount": 433,
  "manifestUrl": "/datasets/kim-glob-hgt500-2026070100/manifest.json"
}
```

상태 코드:

- `200`: 최신 dataset 있음
- `404`: 아직 생성된 dataset 없음
- `500`: 서버 내부 오류

`latest`는 mutable pointer이므로 짧은 주기로 갱신될 수 있다. 프론트엔드에서는 cache를 짧게 두거나, 최신성이 중요하면 no-cache로 조회하는 편이 좋다.

### GET `/datasets/{datasetId}/manifest.json`

dataset manifest JSON을 반환한다.

`datasetId` 형식:

```text
kim-glob-hgt500-{tmfc}
```

`tmfc`는 `YYYYMMDDHH` 형식의 UTC 분석시각이다.

예:

```text
GET /datasets/kim-glob-hgt500-2026070100/manifest.json
```

### GET `/api/hgt500/datasets/{datasetId}/manifest`

manifest로 redirect한다.

정상 요청:

```text
302 Location: /datasets/{datasetId}/manifest.json
```

상태 코드:

- `302`: manifest static URL로 redirect
- `400`: `datasetId` 형식 오류

브라우저 `fetch`는 기본적으로 redirect를 따라가므로 직접 써도 된다. 다만 클라이언트 코드에서는 `/api/hgt500/latest`의 `manifestUrl`을 바로 fetch하는 방식이 가장 단순하다.

### GET `/datasets/{datasetId}/{assetName}`

manifest와 frame metadata에 기록된 asset 파일을 정적으로 제공한다.

예:

```text
GET /datasets/kim-glob-hgt500-2026070100/g576_v091_glob_prs_hgt500_202607010000.png
GET /datasets/kim-glob-hgt500-2026070100/g576_v091_glob_prs_hgt500_202607010000.json
GET /datasets/kim-glob-hgt500-2026070100/g576_v091_glob_prs_hgt500_202607010000_preview.png
GET /datasets/kim-glob-hgt500-2026070100/g576_v091_glob_prs_hgt500_202607010000_anomaly.png
```

Dataset asset은 datasetId별 immutable 산출물로 취급해도 된다.

## Manifest Schema

Manifest는 `/datasets/{datasetId}/manifest.json`에 있다.

```ts
interface KimHgt500Manifest {
  schemaVersion: 1;
  datasetId: string;
  variable: "hgt";
  unit: "m";
  domain: "glob";
  defaultColorMap: string;
  defaultValueRange: [number, number];
  defaultAnomalyReference: string;
  sourceForecastIntervalMinutes: number;
  outputFrameIntervalMinutes: number;
  interpolation: "linear";
  sequenceStatistics: {
    frameMin: number;
    frameMax: number;
    frameMean: number;
    frameCount: number;
  };
  source: {
    format: "kim-api-text";
    downsampleFactor: number;
  };
  frames: KimHgt500Frame[];
}

interface KimHgt500Frame {
  index: number;
  forecastHour: number;
  validTime: string;
  dataPng: string;
  metadataJson: string;
  previewPng: string;
  anomalyPng: string;
}
```

Frame asset 경로는 manifest 파일이 있는 dataset directory 기준 상대 경로다.

```ts
const datasetBase = new URL(`/datasets/${manifest.datasetId}/`, apiBaseUrl);
const frame = manifest.frames[0];

const dataPngUrl = new URL(frame.dataPng, datasetBase).toString();
const metadataUrl = new URL(frame.metadataJson, datasetBase).toString();
const previewUrl = new URL(frame.previewPng, datasetBase).toString();
const anomalyUrl = new URL(frame.anomalyPng, datasetBase).toString();
```

## Frame Metadata Schema

각 frame의 `metadataJson`은 해당 frame의 grid, time, encoding, 통계 정보를 담는다.

주요 필드:

```ts
interface KimHgt500FrameMetadata {
  schemaVersion: 1;
  assetType: "kim-hgt500-packed-png";
  source: {
    model: "KIM";
    domain: "glob";
    inputFile: string;
    referenceScript: string;
    format: "kim-api-text";
    sourceFile: string | null;
  };
  variable: {
    name: "hgt";
    standardName: "geopotential_height";
    unit: "m";
    dims: string[];
    levelIndex: number;
    levelValue: number;
    levelUnit: "hPa";
    expectedLevelIndex: number;
    expectedLevelIndexMatches: boolean;
  };
  grid: {
    projection: "equirectangular";
    width: number;
    height: number;
    lonStart: number;
    lonEnd: number;
    lonResolution: number;
    latStart: number;
    latEnd: number;
    latResolution: number;
    latOrder: "south-to-north";
    sourceWidth: number;
    sourceHeight: number;
    sourceLonResolution: number;
    sourceLatResolution: number;
    downsampleFactor: number;
  };
  time: {
    analysisTime: string;
    validTime: string;
    forecastHour: number;
  };
  encoding: PackedPngEncoding;
  statistics: FrameStatistics;
  assets: {
    dataPng: string;
    previewPng: string;
    anomalyPng: string;
  };
  anomaly?: {
    unit: "m";
    reference: string;
    backgroundOffsetsDegrees: Array<{ lon: number; lat: number }>;
    smoothing: string;
    encoding: PackedPngEncoding;
    statistics: FrameStatistics;
  };
  sequencePolicy: {
    sourceForecastIntervalMinutes: number;
    outputFrameIntervalMinutes: number;
    interpolation: "linear";
  };
}

interface PackedPngEncoding {
  format: "png";
  mode: "RGB";
  packing: "uint16-rg-big-endian";
  valueMin: number;
  valueMax: number;
  r: "high_byte";
  g: "low_byte";
  b: "unused";
  alpha: "unused";
  missingValue: null;
  missingValuePolicy: "metadata-sentinel";
}

interface FrameStatistics {
  frameMin: number;
  frameMax: number;
  frameMean: number;
  clippedLowCount: number;
  clippedHighCount: number;
  missingCount: number;
}
```

## Packed PNG Decoding

`dataPng`와 `anomalyPng`는 눈으로 보는 PNG가 아니라 수치 저장용 packed PNG다.

Encoding:

- PNG mode: `RGB`
- Packing: `uint16-rg-big-endian`
- R channel: high byte
- G channel: low byte
- B channel: unused
- alpha: unused

디코딩 공식:

```ts
function decodePackedValue(r: number, g: number, valueMin: number, valueMax: number): number {
  const packed = (r << 8) | g;
  return valueMin + (packed / 65535) * (valueMax - valueMin);
}
```

`dataPng`는 frame metadata의 `encoding.valueMin`, `encoding.valueMax`를 사용한다. 현재 기본값은 `4500`부터 `6500` m이다.

`anomalyPng`는 frame metadata의 `anomaly.encoding.valueMin`, `anomaly.encoding.valueMax`를 사용한다. 현재 기본값은 `-512`부터 `512` m이다.

브라우저 canvas 예:

```ts
async function loadPackedPngValues(
  imageUrl: string,
  width: number,
  height: number,
  valueMin: number,
  valueMax: number
): Promise<Float32Array> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = imageUrl;
  await img.decode();

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas is unavailable");

  ctx.drawImage(img, 0, 0);
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const values = new Float32Array(width * height);

  for (let i = 0, p = 0; i < values.length; i++, p += 4) {
    const r = rgba[p];
    const g = rgba[p + 1];
    values[i] = decodePackedValue(r, g, valueMin, valueMax);
  }

  return values;
}
```

`previewPng`는 사람이 보기 위한 RGB preview다. 수치 복원에는 사용하지 않는다.

## Grid Mapping

Grid는 equirectangular global grid다.

Metadata 기준 좌표 계산:

```ts
const lon = metadata.grid.lonStart + x * metadata.grid.lonResolution;
const lat = metadata.grid.latStart + y * metadata.grid.latResolution;
```

`latOrder`는 `south-to-north`다. 즉 row `0`은 `latStart`에 해당한다. 렌더러가 texture row 0을 북쪽으로 기대한다면 Y축 flip이 필요할 수 있다.

Longitude는 현재 `0..360` 체계다. 필요하면 클라이언트에서 `lon > 180 ? lon - 360 : lon` 방식으로 `-180..180` 체계로 변환한다.

## Time Handling

모든 시간 문자열은 UTC ISO-8601이다.

- `analysisTime`: KIM 분석시각
- `validTime`: 해당 frame의 유효시각
- `forecastHour`: 분석시각 기준 예측 시간. 10분 보간 frame은 소수값이 될 수 있다.

예:

```json
{
  "analysisTime": "2026-07-01T00:00:00Z",
  "validTime": "2026-07-01T00:10:00Z",
  "forecastHour": 0.16666666666666666
}
```

UI 표시 시 KST가 필요하면 클라이언트에서 변환한다.

## Error Handling

권장 처리:

- `/api/hgt500/latest`가 `404`면 아직 생성된 dataset이 없는 상태로 표시한다.
- `manifestUrl` fetch가 `404`면 latest pointer와 static 파일 사이의 일시적 불일치로 보고 재시도한다.
- asset fetch가 `404`면 해당 dataset을 실패 처리하고 latest를 다시 조회한다.
- `manifest.sequenceStatistics.frameCount !== manifest.frames.length`면 manifest를 신뢰하지 말고 오류로 처리한다.
- `schemaVersion !== 1`이면 클라이언트 호환성 검사를 수행한다.

현재 제공하지 않는 API:

- `POST /api/hgt500/datasets`
- `GET /api/hgt500/datasets`
- `GET /api/hgt500/jobs/{jobId}`

프론트엔드는 위 job/list API를 호출하지 않아야 한다.

## Minimal Integration Example

```ts
async function loadLatestKimHgt500(apiBaseUrl: string) {
  const latestRes = await fetch(new URL("/api/hgt500/latest", apiBaseUrl));
  if (!latestRes.ok) {
    throw new Error(`latest request failed: ${latestRes.status}`);
  }

  const latest = await latestRes.json();
  const manifestRes = await fetch(new URL(latest.manifestUrl, apiBaseUrl));
  if (!manifestRes.ok) {
    throw new Error(`manifest request failed: ${manifestRes.status}`);
  }

  const manifest = await manifestRes.json();
  if (manifest.schemaVersion !== 1) {
    throw new Error(`unsupported manifest schema: ${manifest.schemaVersion}`);
  }
  if (manifest.sequenceStatistics.frameCount !== manifest.frames.length) {
    throw new Error("manifest frame count mismatch");
  }

  const datasetBase = new URL(`/datasets/${manifest.datasetId}/`, apiBaseUrl);
  const firstFrame = manifest.frames[0];
  const metadataRes = await fetch(new URL(firstFrame.metadataJson, datasetBase));
  const metadata = await metadataRes.json();

  const values = await loadPackedPngValues(
    new URL(firstFrame.dataPng, datasetBase).toString(),
    metadata.grid.width,
    metadata.grid.height,
    metadata.encoding.valueMin,
    metadata.encoding.valueMax
  );

  return { latest, manifest, metadata, values };
}
```

## Acceptance Checklist

프론트엔드 연동 시 아래가 통과하면 기본 연동은 성공으로 본다.

- `GET /api/hgt500/latest`가 `200`을 반환한다.
- `latest.manifestUrl`이 `200`을 반환한다.
- `manifest.datasetId`가 `kim-glob-hgt500-\d{10}` 형식이다.
- `manifest.frames.length > 0`이다.
- 첫 frame의 `metadataJson`, `dataPng`, `previewPng`, `anomalyPng`가 모두 `200`이다.
- `metadata.encoding.packing === "uint16-rg-big-endian"`이다.
- `dataPng` 디코딩 값이 `metadata.encoding.valueMin..valueMax` 범위에 들어온다.
- 지도 렌더링에서 남북 방향이 반대로 보이면 `metadata.grid.latOrder` 기준으로 Y축을 flip한다.
