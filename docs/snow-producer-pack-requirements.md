# Snow producer · pack 계약 (요약)

Consumer/OpenAPI 상세: `docs/openapi.yaml`, `skills/weather-api-catalog`.

## 수집

| 항목 | 계약 |
|------|------|
| Hub | `kma_snow1.php` `sd=tot` + `sd=24h`, `snow=2`, `stn=0` |
| JSON | `in_data/sd/{yyyy-MM-dd}/SD_{YYYYMMDDHHMM}.json` |
| row | `STN_ID`, `TM`, `SD_TOT`, `SD_24H` (×10 cm 정수, 결측 `null`) |
| CLI | `kma_fetch/fetch_snow.js --from … --to … --interval 60` |
| watcher | `kma_fetch/main_SD.js` (PM2 `kma_fetch_sd`, cron `4 * * * *`) |

## 지점

| 항목 | 계약 |
|------|------|
| 원천 | `stn_snow.php` (674지점) |
| 코드표 | `kma_fetch/config/sd_stn_code_YYYYMMDD.json` |
| 주소 | AWS STN 조인(625개) → 실패 시 `LAW_ID`→시도/구군(49개) (`law_code_sido_sigungu.json`) |
| HTTP | `GET /api/sd/stations` (디스크 JSON에는 `LAW_ADDR_*` 미저장) |

## Pack

| 항목 | 계약 |
|------|------|
| 변수 | `SD_TOT` (instantaneous), `SD_24H` (rolling 1440분) |
| Binary | Int16 LE (`data.dtype=int16`, `data.endianness=little`), `data.order=FRAME_MAJOR_STATION_MINOR`, scale `0.1` cm, missing `-32768`, **0cm=0** |
| 경로 | `out_data/sd/pack/{sd_tot\|sd_24h}/{Nm}/{day}/{slug}-v{sha8}.i16le` |
| 기본 interval | **60**분 (하루 24프레임) |
| HTTP | `GET /api/sd/pack?date=YYYYMMDD&variable=SD_TOT,SD_24H` (단수=manifest, 복수=`{variables,items[]}`) |
| Static | `/datasets/sd/...` |
| Warm | `kma_fetch/warm_sd_packs.js` / `main_SD` lookback 후 today warm |

QC: 강수형 non-negative encode만. TA temporal QC 없음.
