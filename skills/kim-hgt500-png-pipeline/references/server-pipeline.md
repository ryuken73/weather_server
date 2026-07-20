# 서버 변환 파이프라인

## 전체 그림

KIM HGT500 PNG 파이프라인은 `hgt` 500hPa 값을 forecast source frame 사이에서 선형 보간하고, 각 output frame을 RGB PNG에 16-bit 정수로 packing한다.

두 계열이 있다.

- NC/EAsia: `kma_fetch/python/kim_hgt_png_generator.py`
- TXT/Global: `kma_fetch/python/kim_hgt_text_sequence_generator.py`와 `kim_hgt_converter/*`

## NC/EAsia 변환

Entry point:

```bash
OUT_PATH_KIM=/data/node_project/weather_data/out_data/kim \
python kma_fetch/python/kim_hgt_png_generator.py \
  --in_dir /data/node_project/weather_data/in_data/kim/2026-07-01 \
  --tmfc 2026070100 \
  --max_hours 372 \
  --interval 10 \
  --workers 8
```

동작:

- 입력 파일 패턴은 `*_prs.*.{tmfc}.nc`다.
- filename의 `ftNNN`을 forecast hour로 읽고 `max_hours` 이하만 사용한다.
- `xarray`로 `ds["hgt"].isel(levs=13)`을 읽는다. `levs=13`은 기존 코드가 기대하는 500hPa level index다.
- 인접한 forecast hour 사이를 `interval` 분 단위로 선형 보간한다.
- 마지막 source frame은 정확한 시각의 output frame으로 한 장 더 저장한다.
- 출력 폴더는 `OUT_PATH_KIM/{valid-date}`이고 파일명은 `g576_v091_easia_prs.2byte_hgt500_YYYYMMDDHHmm.png`다.

NC/EAsia 스크립트는 metadata/manifest를 만들지 않는 legacy 경로다. 클라이언트 복호화에는 range와 grid 정보를 별도 계약으로 알아야 한다.

## TXT/Global 변환

Entry point:

```bash
python kma_fetch/python/kim_hgt_text_sequence_generator.py \
  --input-dir /data/node_project/weather_data/in_data/kim/hgt500_txt/2026070100 \
  --output-dir /data/node_project/weather_data/out_data/kim/datasets/kim-glob-hgt500-2026070100 \
  --tmfc 2026070100 \
  --max-hours 72 \
  --interval 10 \
  --downsample 3
```

동작:

- `kim_hgt_text_sequence_generator.py`는 `kim_hgt_converter.converter.convert_text_sequence()`의 얇은 CLI wrapper다.
- `input_dir/*.txt`를 파싱하고, `# fname:` 안의 원본 KIM filename에서 `ftNNN`과 `tmfc`를 읽는다.
- TXT grid metadata에서 `variable=hgt`, `unit=m`, `level=500`, `i=width`, `j=height`를 검증한다.
- `downsample > 1`이면 mean pooling으로 grid를 줄인다. source width/height와 downsample factor는 metadata에 남긴다.
- source frame의 analysis time이 요청 `tmfc`와 다르면 제외한다.
- source forecast interval은 3시간이고, 기본 output interval은 10분이다.
- 결과는 dataset directory 안에 `manifest.json`, frame별 `dataPng`, `metadataJson`, `previewPng`, `anomalyPng`를 만든다.

## 보간 정책

인접 source frame `A`, `B`가 있고 두 frame 사이가 `segmentMinutes`일 때:

```text
ratio = offsetMinutes / segmentMinutes
value = A * (1 - ratio) + B * ratio
```

`offsetMinutes`는 `0, interval, 2*interval, ... segmentMinutes-interval`이다. 마지막 source frame은 별도 output frame으로 저장한다. 예를 들어 0h부터 72h까지 3시간 source frame을 10분 간격으로 만들면 `72*60/10 + 1 = 433` frame이 된다.

## PNG packing

수치 범위:

- HGT 기본: `4500.0..6500.0 m`
- anomaly 기본: `-512.0..512.0 m`

Encoding:

```text
clipped = clamp(value, valueMin, valueMax)
packed = uint16((clipped - valueMin) / (valueMax - valueMin) * 65535)
R = packed >> 8
G = packed & 0xff
B = 0
```

TXT/Global 경로는 frame metadata의 `encoding`에 range와 packing을 기록한다. 클라이언트는 반드시 metadata를 신뢰해야 한다.

## Anomaly PNG

TXT/Global 경로는 `compute_local_anomaly()` 결과도 별도 packed PNG로 저장한다. anomaly는 `anomaly.encoding`의 `valueMin/valueMax`로 복호화한다. 일반 `encoding` range를 anomaly에 재사용하면 안 된다.

## 운영 주의

- KMA API가 `200`으로 오류 TXT를 줄 수 있다. parser는 `variable`, `unit`, `level`, row count 검증으로 이런 파일을 실패시킨다.
- source frame shape, analysis time, downsample factor가 모두 같아야 sequence 변환이 가능하다.
- manifest `sequenceStatistics.frameCount`와 `frames.length`가 다르면 dataset을 불완전한 것으로 취급한다.
- 기존 API spec에 없는 job/list endpoint를 임의로 추가했다고 가정하지 않는다.
