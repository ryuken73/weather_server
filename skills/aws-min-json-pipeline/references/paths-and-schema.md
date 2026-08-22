# 경로·JSON schema

## 디스크 경로

```text
{resolveBaseDir('in_data')}/aws/{yyyy-MM-dd}/AWS_MIN_{yyyyMMddHHmm}.json
```

1분마다 파일 1개 (홀수분 포함). 예:

```text
.../aws/2026-08-12/AWS_MIN_202608121533.json
```

Pack 출력 (변수별 일파일):

```text
{resolveBaseDir('out_data')}/aws/pack/{slug}/1m/{yyyyMMdd}/{slug}.i16le
(+ 각 디렉터리 manifest.json)

slug: ta, rn_15m, rn_60m, rn_12hr, rn_24hr_rolling, rn_day, ws_ins, ws, wd_ins, wd, hm, td
```

과거 완결일은 backfill/`warm_aws_min_packs.js`/`main_AWS` 어제 워밍으로 미리 쓴다. `variable=FULL` 없음.
`RN_24HR`은 legacy `rn_24hr/` URL을 쓰지 않는다 (immutable cache 충돌 방지).

HTTP binary: `/datasets/aws/{slug}/1m/{yyyyMMdd}/{slug}.i16le`  
override: `AWS_JSON_DIR`, `AWS_PACK_DIR`.

## JSON 항목 shape

| 필드 | 비고 |
| --- | --- |
| `STN_NAME` | 저장 시 stn_inf 코드표 패치 |
| `STN_ID`, `TM` | TM = `YYYYMMDDHHMM` KST |
| `LAT`, `LON`, `HT` | |
| `TA` 등 | ×10 정수 (277 = 27.7℃) |
| `RN_15M` / `RN_60M` / `RN_12HR` | ×10 mm. Hub `RN-15m`/`RN-60m`/`RN-12H` |
| `RN_DAY` | ×10 mm. Hub `RN-DAY` (KST 당일 누적). pack `RN_DAY` |
| `RN_24HR` | JSON legacy mirror of `RN_DAY`. pack `RN_24HR`은 파생 rolling (이 필드를 그대로 쓰지 않음) |
| `WS` / `WS_INS` | ×10 m/s. Hub `WS1` / `WSS` |
| `WD` / `WD_INS` | ×10 deg. Hub `WD1` / `WDS`. 무풍 360.0 → 3600 |
| `HM` | ×10 %. Hub `HM` |
| `TD` | ×10 ℃. Hub `TD`. MSSQL은 `NULL AS TD` → `auto`는 Hub merge로 채움 |
| `RN_1HR` | `RN-60m` 별칭 (호환). pack 이름 아님 |
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
| missing | -32768 (`null`, `-999`, 물리 ≤ -50℃ / ×10 ≤ -500, > 60℃, pack temporal QC) |
| schema | `schemaVersion: 4` + `contractRevision: 7`. 구 pack은 `--force` 재워밍 |
| order | FRAME_MAJOR_STATION_MINOR |
| index | `frameIndex * stationCount + stationIndex` |
| stations | STN_ID ASC (범위 union) |

`byteLength = frameCount × stationCount × 2`

운영 고정 (NODE_ENV production|prod, env override 없을 때):

| | 경로 |
| --- | --- |
| JSON 루트 | `/data/node_project/weather_data/in_data/aws` |
| Pack 루트 | `/data/node_project/weather_data/out_data/aws/pack` |
| Pack 일파일 | `.../pack/{slug}/1m/{yyyyMMdd}/{slug}.i16le`, `manifest.json` |

개발: `{BASE_DIR}/in_data/aws`, `{BASE_DIR}/out_data/aws/pack`. override: `AWS_JSON_DIR`, `AWS_PACK_DIR`.

## HTTP

- 2분 호환·임의 구간 JSON: `/api/aws/min`, `/api/aws/min/range`
- 1분 일 pack: `/api/aws/min/pack` (`variable=TA|RN_60M|WS_INS|...`, comma 복수 가능)
- 1분 단건: `/api/aws/min/exact`, `/api/aws/min?intervalMinutes=1`
- 카탈로그: `/api/aws/stations`

상세: `skills/weather-api-catalog` / `docs/openapi.yaml` / `docs/aws-producer-1min-pack-requirements.md`.
