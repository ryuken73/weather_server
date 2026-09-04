# 이미지·외부 파이프라인 수집 흐름

작성일: 2026-09-04  
상태: **`parse_netcdf` README 반영 완료**  
권위: [parse_netcdf README](https://gitlabsvr.sbs.co.kr/weather_system/parse_netcdf)  
관련: 루트 [`README.md`](../README.md) §4

**경계 한 줄**

> weather_api(`kma_fetch`) = GK2A/RDR/AWS **원천 수신** + AWS pack/HGT500 dataset + HTTP 서빙.  
> parse_netcdf = **NetCDF/bin/JSON → 시각화 PNG**(및 구형 IR105 gzip JSON).  
> GFS는 parse_netcdf가 NOAA에서 **직접 fetch**한다.

---

## 0. 이 repo만으로 end-to-end인 것

| 영역 | 수집 | 가공 | 서빙 |
| --- | --- | --- | --- |
| AWS JSON + pack | `main_AWS` (MSSQL/Hub) | `aws_min_pack.js` warm/QC | `/api/aws/*`, `/datasets/aws/*` |
| KIM global TXT HGT500 | `main_KIM_TXT` | `kim_hgt_text_sequence_generator.py` 등 | `/api/hgt500/*`, `/datasets/kim-glob-hgt500-*` |

위 두 줄은 이미지 파이프라인 문서의 주 대상이 **아님**.

---

## 1. IR105 / 구름 (GK2A)

| # | 질문 | 파악 |
| --- | --- | --- |
| A1 | NetCDF 수집 watcher | **OK** — `kma_fetch/main.js` → `in_data/gk2a/{날짜}/*.nc` (LE1B IR105, EA/FD/KO) |
| A2 | NC → mono/color PNG | **parse_netcdf** `main_with_watcher_mk_image.py` → subprocess `gk2a_image_worker.py`. 핵심: `parseWithVectorNC.py`, equi: `to_epsg3857_keep_size.py` |
| A3 | PNG 출력 경로 | prod: `OUT_PATH` = `/data/node_project/weather_data/out_data/gk2a/{날짜}/`. 대표: `*_step1_mono.png`, `*_step1_color.png`, `*_mono_equi.png`, `*_color_equi.png` (+ step5/10 축소본) |
| A4 | PostgreSQL `ir105_json` | **parse_netcdf** 구형 계열: PM2 `watcher` = `main_with_watcher.py`(NC→gzip JSON). DB 적재 `DB_insert.py` → `ir105_json`. PNG 경로와 분리. **정리 필요** (아래 §9) |
| A5 | `/ir105/.../fs` gzip JSON | 초기 설계: JSON을 client에 주고 client가 이미지화. **현재 Consumer는 거의 미사용**. 생산(watcher/gzip)은 아직 돌 수 있음. `server.js`는 경로가 `d:/002.Code/001.python/netcdf/jsonfiles`로 **하드코드** — **정리 필요** (§9) |
| A6 | 기동·스케줄 | PM2 `watcher_image` (`GK2A_MONO_ALPHA_MODE=C`). 입력 watch: `WATCH_PATH`=`in_data/gk2a/` |
| A7 | Consumer 주 경로 | **PNG** (`/ir105-mono|ir105-color/.../image`)가 시각화 주력. DB·`/fs` JSON은 레거시 |

```text
KMA GK2A API
  → kma_fetch main.js → in_data/gk2a/{date}/*.nc
  → parse_netcdf watcher_image (gk2a_image_worker)
  → out_data/gk2a/{date}/*_step{n}_{mono|color}[_equi].png
  → weather_api ROOT_DIR(=out_data) → /ir105-*/.../image
```

---

## 2. 레이더 RDR HSP

| # | 질문 | 파악 |
| --- | --- | --- |
| B1 | binary 수집 | **OK** — `main_RDR.js` → `in_data/rdr/RDR_CMP_HSP_PUB_{tm}.bin(.gz)`, 5분 |
| B2 | bin → PNG | **parse_netcdf** `main_with_watcher_mk_image_RDR.py` — `read_RDR_bin` / `reproject_RDR` / `create_normal_map_for_rdr` |
| B3 | `_equi` PNG | **같은 파이프라인** — step1 저장 후 `to_epsg3857_keep_size.convert_to_equi_rectangle('rdr', …)` + normal map |
| B4 | 출력 경로 | prod: `OUT_PATH_RDR` = `/data/node_project/weather_data/out_data/rdr/{날짜}/` — `*_step1.png`, `*_step1_equi.png`, `*_step1_equi_normal.png`, step5/10 |
| B5 | 기동 | PM2 `watcher_image_rdr`. Skill: parse_netcdf `skills/weather-rdr-bin-png/` |
| B6 | step 의미 | **step1 = 원본 해상도**, step5/10 = `resize_image` 축소본 (샘플 stride가 아님) |

```text
KMA RDR → main_RDR.js → in_data/rdr/*.bin
  → watcher_image_rdr → out_data/rdr/{date}/*_step{n}[_equi].png
  → /rdr-hsp/.../image , /rdr-hsp-equi/.../image
```

수신 장애(`EMFILE` 등)는 이미지 watcher가 아니라 **`kma_fetch` RDR FD**를 먼저 본다.

---

## 3. GFS (바람 JSON · 온도/습도 PNG)

| # | 질문 | 파악 |
| --- | --- | --- |
| C1 | 원천 | **parse_netcdf가 NOAA NOMADS 직접 fetch** (GFS 0.25°, `filter_gfs_0p25.pl`). weather_api에 GFS fetch 없음 |
| C2 | `gfs-wind_*` JSON | PM2 `gfs_wind` = `get_wind.py` (wind-only / 입자·레거시) |
| C3 | `gfs-0p25_tmp_*` / `rh_*` PNG | PM2 `gfs_fetch_save` = `gfs_fetch_N_save.py` + `gfs_gen_image.py` — TMP/RH/WIND 통합 (**웹/이미지 핵심**) |
| C4 | `gfs_equ-*` vs merc | `gfs_gen_image`가 equi(기본 `.png`)와 웹용 `_merc.png`를 구분 저장. API: `gfs_equ-*` → `{stem}.png`, `gfs-0p25_*` → `{stem}_merc.png` (`server.js`) |
| C5 | 경로 | GRIB: `WATCH_PATH_WIND`=`in_data/gfs/`(`combined_raw/`). 산출: `OUT_PATH_WIND`=`out_data/gfs/{날짜}/` |
| C6 | 기동 | 위 두 PM2. 주기: `.env.prod` `WIND_FETCH_INTERVAL`(예: 600초) + 스크립트 `SLEEP_TIME` |
| C7 | weather_api 경계 | **서빙만** (`ROOT_DIR`/`out_data/gfs` 읽기). 수집·렌더는 parse_netcdf |

---

## 4. 레거시 AWS 강수 PNG

| # | 질문 | 파악 |
| --- | --- | --- |
| D1 | `/aws-RN_15M`, `/aws-RN_60M` PNG | **parse_netcdf** `main_with_watcher_mk_image_AWS.py` (`parseAWSJson.py`, `configAWSColors.py`). 필드: `RN_15M`, `RN_60M`, `RN_24HR` |
| D2 | 1분 pack과의 관계 | **병행**. pack=`/api/aws/min/pack`이 신규 consumer 권장 경로. 디스크 PNG는 레거시 이미지 API용으로 유지 |
| D3 | 파일명 | `AWS_MIN_{tm}_{RN_*}_step1.png` → `OUT_PATH_AWS`=`out_data/aws/{날짜}/`. 배치: `batch_run.py {date}` |

---

## 5. KIM EAsia 레거시 PNG (`/kim-psl`, `/kim-hgt500` image)

| # | 질문 | 파악 |
| --- | --- | --- |
| E1 | NC 수집 후 PNG | **운영 주경로는 weather_api `kma_fetch`**. `main_KIM.js`가 env PNG generator를 호출. parse_netcdf의 `kim_png_generator.py`는 도구/샘플 성격 — README도 “운영 주축은 kim_fetch / kma_fetch_hgt_txt”로 명시 |
| E2 | env 경로 | 기본값(상대 `kma_fetch/`): `KIM_PSL_PNG_GENERATOR=python/kim_png_generator.py`, `KIM_HGH_PNG_GENERATOR=python/kim_hgt_png_generator.py` |
| E3 | global TXT 이후 | 신규는 `/api/hgt500/*` + `/datasets/kim-glob-hgt500-*`. 레거시 `/kim-*/.../image`는 서빙 유지 |

---

## 6. 공통·인프라

| # | 질문 | 파악 |
| --- | --- | --- |
| F1 | GitLab path | `https://gitlabsvr.sbs.co.kr/weather_system/parse_netcdf.git` (+ GitHub `ryuken73/parse_netcdf`) |
| F2 | 이미지 job 호스트 | **동일 운영 박스(168)**. parse_netcdf: `~/python_project/parse_netcdf`, weather_api: `/home/sbs/node_project/weather_server`. **같은 PM2**에 fetch·image·API가 함께 등록 |
| F3 | `ROOT_DIR_PROD` | `/data/node_project/weather_data/out_data` (PM2 `weather_api` env와 일치). `in_data` / `out_data` 형제 |
| F4 | `sync_image.sh` | **있음** — repo 루트 [`sync_image.sh`](../sync_image.sh). 개발 PC에서 운영(168) `out_data`의 **과거 이미지를 날짜 단위로 scp**할 때 쓰는 수동 도구. 운영 파이프라인 필수 단계는 아님(실시간은 공유 디스크). 기본 `targets=gk2a`, gz/step5/step10 제외 |
| F5 | “parse_netcdf”로 묶는 범위 | **GK2A PNG, RDR PNG(+equi), AWS 레거시 강수 PNG, GFS fetch+PNG/wind JSON**. KIM packed HGT500·AWS pack은 **weather_api** |

### parse_netcdf PM2 (이 repo 코드)

| name | script | 역할 |
| --- | --- | --- |
| `watcher_image` | `main_with_watcher_mk_image.py` | GK2A 구름 PNG |
| `watcher_image_rdr` | `main_with_watcher_mk_image_RDR.py` | RDR PNG |
| `watcher_image_aws` | `main_with_watcher_mk_image_AWS.py` | AWS 강수 PNG |
| `gfs_fetch_save` | `gfs_fetch_N_save.py` | GFS TMP/RH/WIND |
| `gfs_wind` | `get_wind.py` | wind-only |
| `watcher` | `main_with_watcher.py` | (구) NC→gzip JSON |

업스트림 `kma_fetch*` / `weather_api` / `kim_fetch` 도 같은 ecosystem에 등록되나 **소스는 weather_api**.

---

## 7. README §4 반영 체크리스트

- [x] A~F 표 채움 (`parse_netcdf` README 2026-09 기준)
- [x] 루트 `README.md` §4.2~4.6 다이어그램·문구 확정
- [x] `docs/`·`skills/README`에 parse_netcdf 포인터
- [ ] OpenAPI/catalog legacy image type ↔ 생성기 매핑 표 (선택 — endpoints.md와 중복 시 생략 가능)

---

## 8. 변경 이력

| 날짜 | 내용 |
| --- | --- |
| 2026-09-04 | 불완전 항목 드래프트 작성 |
| 2026-09-04 | `weather_system/parse_netcdf` README로 A~F·§4 반영 |
| 2026-09-04 | IR105 JSON/`/fs`를 **정리 필요**로 정의. `sync_image.sh` 역할 정정 |

---

## 9. 정리 필요 (legacy / debt)

운영이 당장 깨지진 않지만, 역할이 애매하거나 경로가 낡은 항목.

| ID | 항목 | 현황 | 정리 방향 (제안) |
| --- | --- | --- | --- |
| L1 | `GET /ir105/{area}/{step}/fs` | 초기: JSON → client 이미지화 구상용. **현재 Consumer는 사실상 미사용**. `server.js`에 `d:/002.Code/001.python/netcdf/jsonfiles` 하드코드 | deprecate 표기(OpenAPI/README) → 사용처 확인 후 라우트 제거 또는 `ROOT_DIR`/설정 기반으로 복구 |
| L2 | IR105 gzip JSON 생산 (`main_with_watcher` / PM2 `watcher`) | PNG 주력인데 **생산은 아직** 돌 수 있음 | L1 폐기 확정 시 watcher·산출물 보관 정책 함께 결정 |
| L3 | `GET /ir105/...` · `/batch` (PostgreSQL `ir105_json`) | DB 경로. `/fs`와 같은 초기 JSON 계열 | Consumer 사용 여부 확인 후 유지/축소. 유지 시 `/fs`와 역할 문서화 |
| L4 | `DB_insert.py` | JSON → `ir105_json` 적재 스크립트 | L3와 묶어서 운영 여부 명시 |

**참고 (정리가 아니라 도구):** repo 루트 `sync_image.sh` — 개발에서 날짜 `$1` 기준으로 168의 `out_data/{gk2a,...}` 이미지를 로컬 `data/weather/`로 부족분만 scp. 파이프라인 필수 아님.
