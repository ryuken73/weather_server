# 경로·JSON schema

## 디스크 경로

```text
{resolveBaseDir('in_data')}/aws/{yyyy-MM-dd}/AWS_MIN_{yyyyMMddHHmm}.json
```

1분마다 파일 1개 (홀수분 포함). 예:

```text
.../aws/2026-08-12/AWS_MIN_202608121533.json
```

Pack 출력:

```text
{resolveBaseDir('out_data')}/aws/pack/ta/1m/{yyyyMMdd}/ta.i16le
{resolveBaseDir('out_data')}/aws/pack/ta/1m/{yyyyMMdd}/manifest.json
```

HTTP binary: `/datasets/aws/ta/1m/{yyyyMMdd}/ta.i16le`  
override: `AWS_JSON_DIR`, `AWS_PACK_DIR`.

## JSON 항목 shape

| 필드 | 비고 |
| --- | --- |
| `STN_NAME` | 저장 시 stn_inf 코드표 패치 |
| `STN_ID`, `TM` | TM = `YYYYMMDDHHMM` KST |
| `LAT`, `LON`, `HT` | |
| `TA` 등 | ×10 정수 (277 = 27.7℃) |
| `LAW_ADDR_*` | **디스크에 없음**. HTTP enrich / pack stations / `/stations` |

코드표:

- `stn_inf_aws_*.txt` → `_build_stn_code_from_stn_inf.js`
- `aws_stn_code_*.json` (`LAW_ADDR_SIDO`, `LAW_ADDR_GUGUN` 포함)
- `aws_stn_name_map_*.json`

## TA pack binary

| 항목 | 값 |
| --- | --- |
| dtype | int16 LE |
| scale | 0.1 ℃ |
| missing | -32768 |
| order | FRAME_MAJOR_STATION_MINOR |
| index | `frameIndex * stationCount + stationIndex` |
| stations | STN_ID ASC (범위 union) |

`byteLength = frameCount × stationCount × 2`

## HTTP

- 2분 호환: `/api/aws/min`, `/api/aws/min/range`
- 1분: `/api/aws/min/pack`, `/api/aws/min/exact`, `/api/aws/min?intervalMinutes=1`
- 카탈로그: `/api/aws/stations`

상세: `skills/weather-api-catalog` / `docs/openapi.yaml` / `docs/aws-producer-1min-pack-requirements.md`.
