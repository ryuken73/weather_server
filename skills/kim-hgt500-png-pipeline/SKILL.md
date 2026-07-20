---
name: kim-hgt500-png-pipeline
description: KIM 500hPa 지위고도(hgt500) 데이터를 NetCDF/TXT 원천에서 보간 frame, RGB packed PNG, metadata/manifest로 변환하거나 프론트엔드에서 복호화/렌더링할 때 사용한다. Use when working with kma_fetch/python/kim_hgt_png_generator.py, kim_hgt_text_sequence_generator.py, kim_hgt_converter, docs/kim_hgt500_frontend_api_spec.md, KIM HGT500 packed PNG, forecast interpolation, manifest API, client decoding, or weather visualization handoff.
---

# KIM HGT500 PNG Pipeline

이 skill은 KIM 500hPa 지위고도(`hgt`, `500hPa`)를 3시간 예측 원천에서 더 촘촘한 시간 간격으로 선형 보간하고, 수치 복원이 가능한 RGB packed PNG로 저장하는 서버/클라이언트 작업을 돕는다.

## 빠른 판단

- 서버 변환 로직, 입력 파일, 보간, PNG packing, manifest/metadata를 다루면 `references/server-pipeline.md`를 읽는다.
- 프론트엔드 API 연동, packed PNG 복호화, WebGL/Canvas 렌더링, animation 재생을 다루면 `references/client-decoding.md`를 읽는다.
- 샘플 TXT 데이터나 작은 변환 fixture가 필요하면 `references/sample-data.md`를 읽고 `assets/sample-data/`의 archive를 사용한다.
- 실제 repo 안에서 작업할 때는 이 skill보다 로컬의 최신 `kma_fetch/python/*`, `kma_fetch/python/kim_hgt_converter/*`, `docs/kim_hgt500_frontend_api_spec.md`를 우선 확인한다.

## 핵심 규칙

- `dataPng`와 `anomalyPng`는 사람이 보는 이미지가 아니라 수치 저장용 PNG다. 시각 확인은 `previewPng`를 사용한다.
- packed PNG는 `uint16-rg-big-endian`이다. R은 상위 8비트, G는 하위 8비트, B/alpha는 사용하지 않는다.
- 값 복원 범위는 하드코딩하지 말고 frame metadata의 `encoding.valueMin`, `encoding.valueMax`를 사용한다.
- TXT global dataset은 manifest의 `frames`를 `index` 순서로 사용하고, frame별 metadata를 함께 읽어 grid/time/encoding을 결정한다.
- grid의 `latOrder`는 `south-to-north`다. 렌더러가 북쪽 row를 0으로 기대하면 Y축 flip 여부를 검토한다.
- 보간 정책은 원천 3시간 간격 frame 사이를 선형 보간하는 방식이다. 기본 output interval은 10분이다.
- `/api/hgt500/latest`는 최신 dataset pointer일 뿐이다. animation은 latest 응답만으로 만들지 말고 manifest의 frame 목록을 사용한다.

## 관련 원천

- NC/EAsia legacy 변환: `kma_fetch/python/kim_hgt_png_generator.py`
- TXT/Global dataset 변환 entrypoint: `kma_fetch/python/kim_hgt_text_sequence_generator.py`
- TXT parser/packing/metadata: `kma_fetch/python/kim_hgt_converter/`
- 프론트엔드 API spec: `docs/kim_hgt500_frontend_api_spec.md`
