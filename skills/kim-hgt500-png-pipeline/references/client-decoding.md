# 클라이언트 복호화와 렌더링

## API 흐름

프론트엔드는 최신 dataset pointer를 받은 뒤 manifest를 기준으로 frame asset을 로딩한다.

```ts
const latest = await fetch(`${apiBaseUrl}/api/hgt500/latest`).then((r) => r.json());
const manifest = await fetch(new URL(latest.manifestUrl, apiBaseUrl)).then((r) => r.json());
const datasetBase = new URL(`/datasets/${manifest.datasetId}/`, apiBaseUrl);
```

animation은 `latest`만으로 만들지 말고 `manifest.frames`를 `index` 순서로 사용한다. 특정 기간 재생은 `frame.validTime`으로 필요한 frame을 filter한다.

## Asset 선택

- `dataPng`: 수치 복원용 packed PNG
- `metadataJson`: grid/time/encoding/statistics
- `previewPng`: 사람이 보기 위한 preview
- `anomalyPng`: anomaly 수치 복원용 packed PNG

`dataPng`와 `anomalyPng`는 색상 이미지가 아니다. 화면 색상은 복원된 float 값을 color ramp에 매핑해서 만든다.

## Packed PNG 복호화

Packing은 `uint16-rg-big-endian`이다.

```ts
function decodePackedValue(r: number, g: number, valueMin: number, valueMax: number): number {
  const packed = (r << 8) | g;
  return valueMin + (packed / 65535) * (valueMax - valueMin);
}
```

`dataPng`는 `metadata.encoding.valueMin/valueMax`를 사용한다.

`anomalyPng`는 `metadata.anomaly.encoding.valueMin/valueMax`를 사용한다.

## Canvas 로딩 예

```ts
async function decodePackedPng(
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
  if (!ctx) throw new Error("2D canvas unavailable");

  ctx.drawImage(img, 0, 0);
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const values = new Float32Array(width * height);

  for (let i = 0, p = 0; i < values.length; i++, p += 4) {
    values[i] = decodePackedValue(rgba[p], rgba[p + 1], valueMin, valueMax);
  }
  return values;
}
```

## Frame 로딩 예

```ts
async function loadFrame(apiBaseUrl: string, manifest: any, frame: any) {
  const datasetBase = new URL(`/datasets/${manifest.datasetId}/`, apiBaseUrl);
  const metadata = await fetch(new URL(frame.metadataJson, datasetBase)).then((r) => r.json());

  const values = await decodePackedPng(
    new URL(frame.dataPng, datasetBase).toString(),
    metadata.grid.width,
    metadata.grid.height,
    metadata.encoding.valueMin,
    metadata.encoding.valueMax
  );

  return { metadata, values };
}
```

## Grid mapping

Metadata의 grid를 사용한다.

```ts
const lon = metadata.grid.lonStart + x * metadata.grid.lonResolution;
const lat = metadata.grid.latStart + y * metadata.grid.latResolution;
```

현재 TXT/Global grid는 equirectangular이고 longitude는 `0..360` 체계다. `-180..180`이 필요하면:

```ts
const lon180 = lon > 180 ? lon - 360 : lon;
```

`latOrder`는 `south-to-north`다. WebGL texture나 지도 엔진이 row 0을 북쪽으로 해석하면 y축 flip이 필요하다.

## Animation 구현 지침

- `manifest.frames`를 시간 순서 source of truth로 둔다.
- UI 기간 선택은 `validTime` 기준으로 filter한다.
- frame asset을 매번 즉시 decode하면 부담이 크므로 sliding window cache를 둔다.
- 10분 간격 72시간 dataset은 보통 433 frame이다. 모든 frame을 한 번에 디코딩하면 메모리 사용량이 커질 수 있다.
- 재생 FPS와 데이터 시간 간격은 분리한다. 예를 들어 30fps 렌더링에서 data frame은 5fps로 advance할 수 있다.
- `previewPng`는 빠른 timeline thumbnail에 유용하지만 수치 렌더링에는 쓰지 않는다.

## 오류 처리

- `/api/hgt500/latest`가 404면 아직 dataset이 없는 상태다.
- manifest fetch가 404면 latest pointer와 static asset 사이 일시 불일치일 수 있으므로 짧게 재시도한다.
- frame asset이 누락되면 해당 dataset을 실패 처리하고 latest를 다시 조회한다.
- `schemaVersion !== 1`이면 호환성 검사를 수행한다.
- `manifest.sequenceStatistics.frameCount !== manifest.frames.length`이면 manifest를 신뢰하지 않는다.
