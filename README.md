# weather_api

SBS 기상 시각화용 **Producer**입니다.  
원천을 수집·가공해 HTTP API·binary pack·정적 이미지/JSON으로 제공하고, Consumer(지도·재생 UI)가 이를 소비합니다.

| | |
| --- | --- |
| Production | `https://weather-map.sbs.co.kr` |
| Local | `http://localhost:3010` |
| OpenAPI UI | [`/docs`](https://weather-map.sbs.co.kr/docs) |
| Spec | [`docs/openapi.yaml`](docs/openapi.yaml) |
| HTTP 입구 skill | [`skills/weather-api-catalog`](skills/weather-api-catalog/SKILL.md) |

**Git**

- GitHub `origin` fetch: `https://github.com/ryuken73/weather_server.git`
- GitLab: `https://gitlabsvr.sbs.co.kr/weather_system/weather_api.git`
- `git push origin` → GitHub + GitLab 동시 push

운영 서버(요약): `sbs@10.10.16.168` · repo `/home/sbs/node_project/weather_server`  
데이터 루트(요약): `/data/node_project/weather_data/` (`in_data` / `out_data`)

---

## 1. 이 repo가 하는 일

```text
  원천 (KMA Hub / MSSQL / FTP·API / NOAA GFS …)
           │
           ▼
  ┌─────────────────────────────────────────────────┐
  │  weather_api                                    │
  │  · kma_fetch : 수집 watcher                     │
  │  · (일부) python : KIM packed / EAsia PNG       │
  │  · server.js : HTTP / static                    │
  └─────────────────────────────────────────────────┘
           │ in_data 공유
           ▼
  parse_netcdf (별도 repo) — 구름/RDR/AWS PNG · GFS fetch+PNG
           │
           ▼
  Consumer (기상 지도·재생 — 별도 repo)
```

\* 구름(IR105)·레이더(RDR)·AWS 레거시 강수 PNG·GFS는 **이미지 생성(및 GFS fetch)이 [`parse_netcdf`](https://gitlabsvr.sbs.co.kr/weather_system/parse_netcdf)** 입니다. GK2A/RDR/AWS **원천 수신만** `kma_fetch`. 상세·PM2·경로는 [`docs/pipeline-image-flow-draft.md`](docs/pipeline-image-flow-draft.md).

| 프로세스 | 역할 |
| --- | --- |
| `server.js` | Fastify API · `/datasets` · `/weather` · legacy image |
| `kma_fetch/main_AWS.js` | AWS 1분 JSON + today/어제 pack warm |
| `kma_fetch/main.js` | GK2A IR105 NetCDF 수집 |
| `kma_fetch/main_RDR.js` | 레이더 HSP binary 수집 |
| `kma_fetch/main_KIM.js` | KIM EAsia NC 수집 + (레거시) PNG 생성 호출 |
| `kma_fetch/main_KIM_TXT.js` | KIM global TXT HGT500 → packed PNG dataset |

HTTP와 수집은 **별 프로세스**입니다. Pack QC/계약 배포 시 **`server` + AWS watcher 둘 다** 재기동하세요.

---

## 2. 서비스하는 데이터 (API catalog 기준)

상세 path·쿼리·에러 코드는 [`skills/weather-api-catalog/references/endpoints.md`](skills/weather-api-catalog/references/endpoints.md)와 OpenAPI를 권위로 둡니다.

### 2.1 AWS (방재 자동기상관측) — 1분 station JSON / pack

| API | 용도 |
| --- | --- |
| `GET /api/aws/stations` | 지점 마스터 (이름·위경도·시도/구군) |
| `GET /api/aws/min/pack?date=&variable=` | **권장** — 하루 1분 Int16 binary (재생·TOP·극값) |
| `GET /api/aws/min/exact` | 1분 exact JSON (원천 대조) |
| `GET /api/aws/min` | 단건 JSON (기본 **2분** snap, 호환) |
| `GET /api/aws/min/range` | 구간 JSON (2분, max ~12h, 호환) |
| Static `/datasets/aws/...` | pack binary · RN/TA qc-v sidecar |

**Pack 변수** (`FULL` 없음):  
`TA`, `RN_15M`, `RN_60M`, `RN_12HR`, `RN_24HR`(rolling → slug `rn_24hr_rolling`), `RN_DAY`(당일 누적), `WS`/`WS_INS`, `WD`/`WD_INS`, `HM`, `TD`

| 구분 | 의미 |
| --- | --- |
| `RN_*` (시간 창이 이름에 있는 것) | rolling — “직전 N분/시간 누적” |
| `RN_DAY` | KST 00시~현재 당일 누적 |
| Binary | Int16 LE, scale 보통 `0.1`, 결측 `-32768` |
| QC | TA temporal/sparse (`contractRevision` 9). RN spike/suspect (`rnDayQcLogicRevision`, contract 8) |

원천 파일: `in_data/aws/{yyyy-MM-dd}/AWS_MIN_{yyyyMMddHHmm}.json`  
Skill: [`aws-min-json-pipeline`](skills/aws-min-json-pipeline/SKILL.md)

### 2.2 KIM HGT500 (500hPa 지위고도) — packed PNG dataset

| API | 용도 |
| --- | --- |
| `GET /api/hgt500/latest` | 최신 dataset **pointer** (mutable) |
| `GET /api/hgt500/datasets` | dataset 목록 (`Cache-Control: no-store`) |
| `GET /api/hgt500/datasets/{id}/manifest` | `302` → `/datasets/{id}/manifest.json` |
| Static `/datasets/{datasetId}/**` | `manifest`, `dataPng`, `anomalyPng`, `previewPng`, metadata |

Animation은 `latest`만으로 만들지 말고 **manifest `frames`**를 사용합니다.  
Client 복호화: [`docs/kim_hgt500_frontend_api_spec.md`](docs/kim_hgt500_frontend_api_spec.md) · skill [`kim-hgt500-png-pipeline`](skills/kim-hgt500-png-pipeline/SKILL.md)

레거시 PNG: `GET /kim-hgt500/.../image`, `/kim-psl/.../image` (EAsia NC 경로 — 신규 global TXT는 `/api/hgt500/*` 권장)

### 2.3 IR105 (천리안 적외) — JSON / PNG

| API | 용도 |
| --- | --- |
| `GET /ir105/{area}/{step}?timestamp_kor=` | PostgreSQL `ir105_json` 단건 (**정리 필요** — 레거시 JSON 계열) |
| `GET /ir105/{area}/{step}/batch?timestamps=` | 배치 (동일, 정리 필요) |
| `GET /ir105/{area}/{step}/fs?timestamp_utc=` | 파일 gzip JSON — **사실상 미사용**, 경로 하드코드 (**정리 필요**) |
| `GET /ir105-mono|ir105-color/{area}/{step}/image` | PNG (디스크 트리) — **현재 주력** |

수집은 `main.js`(GK2A NetCDF). **PNG는 parse_netcdf `watcher_image`**, DB/gzip JSON은 구형 `watcher`/`DB_insert` 계열 (§4.2).

### 2.4 레이더 (RDR HSP) — PNG

| API | 용도 |
| --- | --- |
| `GET /rdr-hsp/{area}/{step}/image` | HSP PNG |
| `GET /rdr-hsp-equi/.../image` | equirectangular 등 |

수집: `main_RDR.js` → `in_data/rdr/` binary(gz). PNG: parse_netcdf `watcher_image_rdr` (§4.3). Snap: **5분** nearest.

### 2.5 GFS (바람·온도·습도) — JSON / PNG

| type 예 | 응답 |
| --- | --- |
| `gfs-wind_10m`, `gfs-wind_850mb`, `gfs-wind_500mb` | **JSON** |
| `gfs-0p25_tmp_*`, `gfs-0p25_rh_*` | PNG |
| `gfs_equ-0p25_tmp_*` | PNG |

공통: `GET /{type}/{area}/{step}/image?timestamp_kor=`  
Snap: **시(hour) floor**. fetch·PNG/JSON 생성은 **parse_netcdf** (`gfs_fetch_save` / `gfs_wind`). 이 repo는 `out_data/gfs` 서빙만 (§4.5).

### 2.6 정적 트리

| API | 용도 |
| --- | --- |
| `GET /weather/**` | `MODE`별 `ROOT_DIR_DEV` / `ROOT_DIR_PROD` 파일 트리 |

### 2.7 이 서버에 없음

- 태풍 API (`/api/typhoons`, admin renew 등)
- HGT500 job API (`POST /api/hgt500/datasets`, `GET .../jobs/{jobId}`) — 미구현, 호출 금지

---

## 3. Consumer가 API를 고르는 법 (요약)

| 하고 싶은 일 | 쓸 API |
| --- | --- |
| 지점명·시도/구군 | `/api/aws/stations` |
| 하루 기온/강수/바람 재생·순위·극값 (1분) | `/api/aws/min/pack` |
| 임의 구간 전 변수 표/JSON (2분) | `/api/aws/min/range` |
| pack vs 원천 1분 대조 | `/api/aws/min/exact` |
| HGT500 애니메이션 | `/api/hgt500/latest` → manifest `frames` → `/datasets/...` |
| 구름/레이더/GFS 레거시 레이어 | `/{type}/{area}/{step}/image` |

---

## 4. 데이터 수집·가공 흐름

권위 상세: [`docs/pipeline-image-flow-draft.md`](docs/pipeline-image-flow-draft.md) · [parse_netcdf README](https://gitlabsvr.sbs.co.kr/weather_system/parse_netcdf)

운영: 동일 호스트(`10.10.16.168`)에서 PM2로 `kma_fetch*` + parse_netcdf image watchers + `weather_api`가 함께 돈다.  
데이터 루트: `/data/node_project/weather_data/` (`in_data` / `out_data`). `ROOT_DIR_PROD` = `.../out_data`.

### 4.1 AWS (이 repo에서 pack까지 end-to-end)

```text
MSSQL wx_AWS_MIN  ──┐
                    ├──► main_AWS (AWS_FETCH_SOURCE=auto|db|hub)
API Hub nph-aws2_min┘         │
                              ▼
              in_data/aws/.../AWS_MIN_{tm}.json
                              │
              warmTodayPacks / warm_aws_min_packs.js
                              ▼
              out_data/aws/pack/  + qc-v sidecar
                              │
                              ▼
              server: /api/aws/min/pack , /datasets/aws/...
```

- Lookback·today 5분 refresh·QC: `skills/aws-min-json-pipeline`, [`kma_fetch/README.md`](kma_fetch/README.md)
- 과거 gap: `backfill_aws_min.js` / `run_backfill.sh` / [`work/`](work/README.md) Hub fetch
- 레거시 강수 PNG (`/aws-RN_15M|60M/.../image`): 같은 JSON을 parse_netcdf `watcher_image_aws`가 contour PNG로 → `out_data/aws/` (**pack과 병행**)

### 4.2 IR105 / 구름 (수집 = 이 repo, PNG = parse_netcdf)

```text
KMA GK2A API
      │
      ▼
main.js  →  in_data/gk2a/{date}/*.nc   (LE1B IR105, EA/FD/KO)
      │
      ├──────────────────────────────────┐
      ▼                                  ▼
parse_netcdf watcher_image            (구) watcher = main_with_watcher.py
  gk2a_image_worker.py                  → gzip JSON (+ DB_insert → ir105_json)
  mono/color + equi PNG
      │                                  │
      ▼                                  ▼
out_data/gk2a/{date}/             /ir105/... DB·/fs JSON
  *_step{n}_{mono|color}[_equi].png
      │
      ▼
GET /ir105-mono|ir105-color/.../image
```

- PM2: `watcher_image` (`GK2A_MONO_ALPHA_MODE=C`). Consumer 주력은 **PNG**.
- JSON/`/fs`/`ir105_json`은 초기 “client 이미지화” 구상 잔재 → **정리 필요** ([§9](docs/pipeline-image-flow-draft.md#9-정리-필요-legacy--debt)).
- 개발용 과거 이미지 pull: 루트 [`sync_image.sh`](sync_image.sh) (168 `out_data` → 로컬 `data/weather`, 운영 필수 아님).

### 4.3 레이더 RDR (수집 = 이 repo, PNG = parse_netcdf)

```text
KMA RDR API (HSP)
      │
      ▼
main_RDR.js  →  in_data/rdr/RDR_CMP_HSP_PUB_{tm}.bin(.gz)
      │
      ▼
parse_netcdf watcher_image_rdr
  (read_RDR_bin → reproject → equi + normal → resize)
      │
      ▼
out_data/rdr/{date}/RDR_CMP_HSP_PUB_{tm}_step{n}[_equi].png
      │
      ▼
GET /rdr-hsp/.../image , /rdr-hsp-equi/.../image
```

- Snap: **5분**. step1 = 원본 해상도, step5/10 = 축소본. 상세: parse_netcdf `skills/weather-rdr-bin-png/`

### 4.4 KIM

**A. Global TXT HGT500 (신규, 이 repo python까지)**

```text
KIM TXT API
      │
      ▼
main_KIM_TXT.js  →  in (TXT) → kim_hgt_text_sequence_generator.py
      │
      ▼
out_data/.../datasets/kim-glob-hgt500-{tmfc}/
  manifest.json, dataPng, anomalyPng, previewPng, ...
      │
      ▼
/api/hgt500/*  +  /datasets/{datasetId}/**
```

**B. EAsia NC + 레거시 PNG (이 repo `kma_fetch/python`)**

```text
KIM NC API
      │
      ▼
main_KIM.js  →  in_data/.../easia NC
      │
      ▼
KIM_PSL_PNG_GENERATOR / KIM_HGH_PNG_GENERATOR
  (기본: python/kim_png_generator.py, kim_hgt_png_generator.py)
      │
      ▼
GET /kim-hgt500/.../image , /kim-psl/.../image
```

신규 consumer는 **A** (`/api/hgt500/*`) 권장. B는 레거시 이미지 유지.

### 4.5 GFS (fetch·렌더 = parse_netcdf, 서빙 = 이 repo)

```text
NOAA NOMADS GFS 0.25°
      │
      ▼
parse_netcdf
  gfs_fetch_N_save.py  (+ gfs_gen_image.py)  → TMP/RH/WIND PNG
  get_wind.py                                 → wind JSON (입자/레거시)
      │
      ├─ in_data/gfs/combined_raw/  (GRIB)
      └─ out_data/gfs/{date}/
           gfs_*_{utc}_{kst}_merc.png   → /gfs-0p25_*/.../image
           gfs_*_{utc}_{kst}.png        → /gfs_equ-*/.../image
           gfs_wind_*.json              → /gfs-wind_*/.../image
      │
      ▼
server.js (ROOT_DIR = out_data)
```

weather_api에는 GFS fetch가 없다. PM2: `gfs_fetch_save`, `gfs_wind`.

### 4.6 전체 조감

```text
                    ┌─ main_AWS ──────────────► AWS JSON + pack ──► /api/aws/*
kma_fetch watchers ─┼─ main.js (GK2A) ──┐
                    ├─ main_RDR ────────┤
                    ├─ main_KIM / TXT ──┼─► TXT HGT + EAsia 레거시 PNG (이 repo python)
                    └───────────────────┘
                                        │ in_data/{gk2a,rdr,aws}
                                        ▼
parse_netcdf (PM2) ─ watcher_image* ───► out_data PNG (구름·RDR·AWS 강수)
                 └─ gfs_fetch_save / gfs_wind ─► out_data/gfs (NOAA 직접)
                                        │
                    server.js ◄─────────┴─► HTTP + /weather + /datasets
```

---

## 5. 디렉터리

| 경로 | 설명 |
| --- | --- |
| [`server.js`](server.js) | HTTP API |
| [`kma_fetch/`](kma_fetch/README.md) | 수집 watcher, backfill, pack warm, python HGT |
| [`docs/`](docs/README.md) | OpenAPI, QC·합의 문서 |
| [`skills/`](skills/README.md) | Agent/온보딩 skill |
| [`work/`](work/README.md) | 일회성 Hub / `#` 원본 변환 |
| `data/` | 로컬 `BASE_DIR` 데이터 |
| `ref/` | 참고 도구 |

---

## 6. 빠른 시작

```bash
yarn install

# env: kma_fetch/.env.* 또는 루트 .env (MODE, BASE_DIR, API_KEY, MSSQL, ROOT_DIR_*)
node server.js
# → http://localhost:3010/docs
```

Watcher 예:

```bash
bash kma_fetch/run_kmaWatcher_dev_AWS.sh
bash kma_fetch/run_kmaWatcher_dev_KIM.sh
# prod: run_kmaWatcher_prod.sh 등
```

### Pack warm

```bash
NODE_ENV=production USE_API=false node kma_fetch/warm_aws_min_packs.js 20260901 \
  --variables RN_DAY,RN_15M,RN_60M,RN_12HR,RN_24HR --force

NODE_ENV=production USE_API=false node kma_fetch/warm_aws_min_packs.js \
  --from 20260819 --to 20260901 --force
```

과거 Hub + warm: `bash kma_fetch/run_backfill.sh`

---

## 7. 문서 찾는 법

| 궁금한 것 | 어디 |
| --- | --- |
| HTTP path / 응답 shape | `docs/openapi.yaml`, `skills/weather-api-catalog` |
| AWS 수집·재기동·warm | `skills/aws-min-json-pipeline`, `kma_fetch/README.md` |
| RN/TA QC·consumer 합의 | `docs/README.md` 인덱스 |
| HGT500 PNG·복호화 | `skills/kim-hgt500-png-pipeline`, `docs/kim_hgt500_frontend_api_spec.md` |
| 일회성 Hub/`#` | `work/README.md` |
| 이미지화(parse_netcdf) | [`skills/weather-image-pipeline`](skills/weather-image-pipeline/SKILL.md) · [GitLab](https://gitlabsvr.sbs.co.kr/weather_system/parse_netcdf) · [`docs/pipeline-image-flow-draft.md`](docs/pipeline-image-flow-draft.md) |
| 개발용 이미지 sync | [`sync_image.sh`](sync_image.sh) (168 → 로컬, 수동) |
| IR105 JSON/`/fs` | **정리 필요** — 동 문서 §9 |

README는 **입구**입니다. 세부 진실 원천은 OpenAPI · skill · `docs/` 합의 md입니다.

---

## 8. 개발 메모

- Node + Fastify 5, Luxon(KST), mssql, optional Hub `API_KEY`, PostgreSQL(IR105 JSON)
- Pack/QC: `kma_fetch/utils/aws_min_pack.js`
- 관측소 마스터: `kma_fetch/config/aws_stn_code_*.json` (`stn_inf` 스냅샷). 방재에만 있는 신규 지점은 pack에 없을 수 있음
- 테스트: `node kma_fetch/tests/test_aws_min_pack.js` 등
- `tmp_*.json`, `work/out`, 대용량 원천은 커밋하지 않음

---

## 관련 README

| 문서 | 내용 |
| --- | --- |
| [kma_fetch/README.md](kma_fetch/README.md) | watcher, env, warm, backfill |
| [docs/README.md](docs/README.md) | 계약·QC 문서 인덱스 |
| [skills/README.md](skills/README.md) | skill 목록 (`weather-image-pipeline` 포함) |
| [work/README.md](work/README.md) | 일회성 Hub / 원본 변환 |
