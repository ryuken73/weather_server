---
name: weather-image-pipeline
description: weather_api와 parse_netcdf 사이 이미지/GFS 파이프라인 경계. Use when working on IR105/GK2A PNG, RDR HSP PNG, AWS legacy rain PNG (/aws-RN_*), GFS fetch or gfs-0p25/gfs_equ/gfs-wind images, sync_image.sh, PM2 watcher_image, or IR105 JSON /fs cleanup.
---

# weather_api ↔ parse_netcdf 이미지 파이프라인

HTTP 계약은 `weather-api-catalog`. 수집·pack은 `aws-min-json-pipeline` / `kma_fetch`.  
**이미지 생성·GFS fetch**는 별도 repo [parse_netcdf](https://gitlabsvr.sbs.co.kr/weather_system/parse_netcdf).

상세 표·다이어그램: [`docs/pipeline-image-flow-draft.md`](../../docs/pipeline-image-flow-draft.md)  
루트 조감: [`README.md`](../../README.md) §4

## 역할 경계

| 구분 | 담당 |
| --- | --- |
| GK2A / RDR / AWS **원천 수신** | weather_api `kma_fetch` (`main.js`, `main_RDR.js`, `main_AWS.js`) → `in_data/` |
| AWS 1분 pack / QC | weather_api (`aws_min_pack`, warm) — **이미지 아님** |
| KIM global TXT HGT500 packed PNG | weather_api (`main_KIM_TXT` + python) |
| KIM EAsia 레거시 `/kim-*/image` | weather_api `main_KIM.js` + `kma_fetch/python/kim_*_png_generator.py` |
| GK2A / RDR / AWS 강수 **시각화 PNG** | **parse_netcdf** folder watchers |
| GFS GRIB fetch + TMP/RH/WIND PNG + wind JSON | **parse_netcdf** (NOAA 직접; weather_api에 fetch 없음) |
| HTTP 서빙 | weather_api `server.js` (`ROOT_DIR` = `out_data`) |

운영: 동일 호스트 `sbs@10.10.16.168`  
- weather_api: `/home/sbs/node_project/weather_server`  
- parse_netcdf: `~/python_project/parse_netcdf`  
- 데이터: `/data/node_project/weather_data/` (`in_data` / `out_data`)  
- `ROOT_DIR_PROD` = `.../out_data`

## parse_netcdf PM2 (이미지·GFS)

| name | script | 산출 |
| --- | --- | --- |
| `watcher_image` | `main_with_watcher_mk_image.py` | GK2A mono/color/equi PNG (`GK2A_MONO_ALPHA_MODE=C`) |
| `watcher_image_rdr` | `main_with_watcher_mk_image_RDR.py` | RDR step/equi/normal PNG |
| `watcher_image_aws` | `main_with_watcher_mk_image_AWS.py` | `AWS_MIN_*_{RN_*}_step1.png` |
| `gfs_fetch_save` | `gfs_fetch_N_save.py` | GFS TMP/RH/WIND PNG (**웹 핵심**) |
| `gfs_wind` | `get_wind.py` | wind JSON (입자/레거시) |
| `watcher` | `main_with_watcher.py` | (구) NC→gzip JSON — **정리 대상** |

RDR 상세: parse_netcdf `skills/weather-rdr-bin-png/`

## Consumer가 쓰는 주 경로

| 데이터 | 권장 API | 생성기 |
| --- | --- | --- |
| 구름 | `/ir105-mono|ir105-color/.../image` | parse_netcdf `watcher_image` |
| 레이더 | `/rdr-hsp/...`, `/rdr-hsp-equi/...` | `watcher_image_rdr` |
| AWS 강수(레거시 이미지) | `/aws-RN_15M|60M/.../image` | `watcher_image_aws` (pack과 **병행**) |
| AWS 수치 | `/api/aws/min/pack` | weather_api only |
| GFS | `/gfs-0p25_*` (`_merc.png`), `/gfs_equ-*` (`.png`), `/gfs-wind_*` (JSON) | parse_netcdf GFS |
| HGT500 | `/api/hgt500/*` | weather_api (레거시 `/kim-hgt500/image`는 EAsia) |

## 개발 도구

[`sync_image.sh`](../../sync_image.sh) — 개발 PC에서 168 `out_data/{gk2a,...}/{date}` 이미지를 로컬 `data/weather/`로 부족분만 scp. 운영 파이프라인 필수 아님. 기본 `targets=gk2a`, gz/step5/step10 제외.

```bash
bash sync_image.sh 2026-09-01
```

## 정리 필요 (legacy debt)

초기 설계는 IR105를 **JSON으로 보내고 client가 이미지화**하는 쪽이었다. 지금은 PNG API가 주력이고 JSON 계열은 **사실상 미사용**이나 생산이 남아 있을 수 있다. 목록: `docs/pipeline-image-flow-draft.md` §9.

| ID | 항목 | 메모 |
| --- | --- | --- |
| L1 | `GET /ir105/.../fs` | `server.js`에 `d:/002.Code/001.python/netcdf/jsonfiles` 하드코드. deprecate/제거 또는 ROOT 기반 복구 |
| L2 | PM2 `watcher` gzip JSON 생산 | L1 폐기 시 함께 결정 |
| L3 | `GET /ir105` · `/batch` (`ir105_json`) | Consumer 사용 여부 확인 |
| L4 | parse_netcdf `DB_insert.py` | L3와 묶음 |

새 기능은 PNG·pack·HGT500 dataset 경로에 두고, 위 JSON API에 의존하지 말 것.

## 장애 시 먼저 볼 곳

| 증상 | 확인 |
| --- | --- |
| 구름/RDR/AWS PNG 없음 | `in_data` 유입 → PM2 `kma_fetch*` → `watcher_image*` |
| RDR만 끊김 + EMFILE | `kma_fetch` RDR FD (이미지 watcher 아님) |
| GFS PNG 없음 | PM2 `gfs_fetch_save`, `in_data/gfs/combined_raw` |
| GFS wind JSON만 이상 | PM2 `gfs_wind` |
| `/ir105/.../fs` 404 | 레거시·하드코드 경로 — §9 L1; 시각화는 PNG 사용 |
