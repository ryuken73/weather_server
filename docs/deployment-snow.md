# 적설(SD) 수집 및 서비스 파이프라인 운영 배포 가이드

- 대상 서버: `sbs@10.10.16.168`
- 저장소 위치: `/home/sbs/node_project/weather_server`
- 운영 데이터 경로:
  - 관측 JSON: `/data/node_project/weather_data/in_data/sd/{YYYY-MM-DD}/SD_{YYYYMMDDHHmm}.json`
  - Pack binary: `/data/node_project/weather_data/out_data/sd/pack/{slug}/{interval}/{day}/`
- 신규 프로세스: `kma_fetch_sd` (`kma_fetch/main_SD.js`)
- 연동 프로세스: `weather_api` (`server.js` - API 서빙 재기동)

---

## 1. 배포 전 확인 사항

1. **Git Remote 브랜치 상태**:
   - 로컬 작업 커밋이 GitLab/GitHub에 push되어 있는지 확인:
     ```bash
     git status
     git push origin main  # (dual-remote 설정에 따라 GitHub/GitLab 동시 push)
     ```
2. **API허브 키 (`API_KEY`) 권한**:
   - `kma_fetch/.env.production` (또는 루트 `.env`)에 설정된 `API_KEY`가 기상청 API허브의 아래 2개 서비스에 대해 접근 허용되어 있는지 확인:
     - 지점: `https://apihub-pub.kma.go.kr/api/typ01/url/stn_snow.php`
     - 관측: `https://apihub-pub.kma.go.kr/api/typ01/url/kma_snow1.php`
3. **101 수신SW와 충돌 없음**:
   - 10.4.1.101 수신SW의 `kma-snow-101`과 별개 프로세스이며, 파일 및 DB를 공유하지 않고 API허브를 직접 호출함.

---

## 2. 운영 서버 배포 절차

### Step 1. 서버 접속 및 소스 업데이트
```bash
ssh sbs@10.10.16.168
cd /home/sbs/node_project/weather_server

# 원격 소스 pull
git pull origin main
```

### Step 2. 지점 코드표 및 디렉터리 상태 점검
최신 674지점 코드표(`sd_stn_code_20251204.json`)가 정상 반영되었는지 확인합니다:
```bash
node -e "const c = require('./kma_fetch/utils/sd_stn_catalog').loadSdStationCatalog({force:true}); console.log('Loaded:', c.codeFile, 'Stations:', c.stationCount);"
# 정상 출력: Loaded: sd_stn_code_20251204.json Stations: 674
```

### Step 3. (선택/권장) 과거 폭설 표본일 (2025-12-04) 데이터 사전 워밍
운영 저장소에서도 검증 데이터가 즉시 서비스될 수 있도록 하루치 데이터 적재 및 pack을 빌드합니다:
```bash
# 2025-12-04 60분 간격 정시 관측 데이터 수집 (24개 슬롯, 674지점)
NODE_ENV=production node kma_fetch/fetch_snow.js --date 20251204 --interval 60 --force

# 2025-12-04 60m 일별 pack 생성 (SD_TOT, SD_24H)
NODE_ENV=production USE_API=false node kma_fetch/warm_sd_packs.js 20251204 --interval 60 --force
```

### Step 4. Fastify API 서버(`server.js`) 재기동
신규 라우트(`/api/sd/stations`, `/api/sd/pack`, `/datasets/sd/...`)를 활성화하기 위해 PM2 웹 프로세스를 재로드/재시작합니다:
```bash
# 현재 실행 중인 프로세스 이름 확인 (보통 weather_api 또는 weather_server)
pm2 list

# API 서버 재기동 (예: weather_api)
pm2 reload weather_api
# 또는 pm2 restart weather_api
```

### Step 5. 신규 수집 데몬 `kma_fetch_sd` 등록 및 시작
적설 상시 수집 및 오늘자 pack 자동 워밍을 담당하는 watcher 데몬을 PM2에 등록합니다:
```bash
# kma_fetch_sd 프로세스 시작 (매 정시 4분 크론: 4 * * * *)
pm2 start kma_fetch/main_SD.js --name "kma_fetch_sd"

# PM2 프로세스 리스트 영구 저장
pm2 save
```

---

## 3. 운영 환경 검증 체크리스트 (Smoke Test)

### 3.1 HTTP 엔드포인트 응답 검증 (로컬 curl)
```bash
# 1. 지점 목록 (674개 확인)
curl -s http://localhost:3010/api/sd/stations | grep -o '"stationCount":[0-9]*'
# 기대 결과: "stationCount":674

# 2. 2025-12-04 일별 Pack Manifest 조회
curl -s "http://localhost:3010/api/sd/pack?date=20251204&variable=SD_TOT,SD_24H" | grep -o '"frameCount":[0-9]*'
# 기대 결과: "frameCount":24

# 3. Binary Asset 다운로드 검증 (HTTP 200)
curl -sI "http://localhost:3010/datasets/sd/sd_tot/60m/20251204/sd_tot-v88f506f0.i16le" | head -n 5
# 기대 결과: HTTP/1.1 200 OK 및 Content-Type: application/octet-stream
```

### 3.2 수집 데몬 로그 확인
```bash
pm2 logs kma_fetch_sd --lines 30 --nostream
```
- 로그 확인 포인트:
  - `Snow obs refresh: enabled interval=60m cron=4 * * * * lookback=8`
  - `Snow station catalog: daily refresh enabled`
  - `sd stations refreshed 674 sd_stn_code_YYYYMMDD.json`

---

## 4. 환경변수 옵션 (필요 시 `kma_fetch/.env.production` 또는 PM2 설정)

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `SD_FETCH_INTERVAL` | `60` | 수집 간격(분). 10, 15, 30, 60 지원 |
| `SD_LOOKBACK_SLOTS` | `8` | 수집 시 직전 누락 점검 슬롯 수 (60분 기준 최근 8시간 점검) |
| `SD_FETCH_REFRESH` | `1` | `0`으로 설정 시 주기적 관측 수집 비활성화 |
| `SD_STN_DAILY_REFRESH` | `1` | `0`으로 설정 시 매일 00:00 지점 목록 갱신 비활성화 |
| `SD_JSON_DIR` | `/data/node_project/weather_data/in_data/sd` | JSON 파일 저장 절대경로 override |
| `SD_PACK_DIR` | `/data/node_project/weather_data/out_data/sd/pack` | Binary pack 저장 절대경로 override |

---

## 5. 롤백(Rollback) 절차

만약 배포 직후 문제가 발생할 경우:
```bash
# 1. 수집 프로세스 중지 및 삭제
pm2 stop kma_fetch_sd
pm2 delete kma_fetch_sd
pm2 save

# 2. 이전 커밋으로 소스 롤백
git log -n 5 --oneline
git checkout <배포_이전_커밋_해시>

# 3. API 서버 재기동
pm2 reload weather_api
```
---

## 6. 영향 범위 · 비영향 (구름/바람 daily 포함)

이번 적설 추가는 **additive**다. 기존 라우트·수집 프로세스를 수정하지 않았다.

### 비영향 (코드 경로 분리)

| 영역 | 프로세스 / 경로 | 이유 |
|------|-----------------|------|
| 구름 IR105 PNG | `kma_fetch` `main.js` → parse_netcdf `watcher_image` → `ROOT_DIR` → `/ir105-mono|color/.../image` | `server.js` image 라우트·`ROOT_DIR`·GK2A watcher **미변경** |
| 바람 GFS | parse_netcdf `gfs_fetch_save` / `gfs_wind` → `out_data/gfs` → `/gfs-*` `/gfs-wind_*` | GFS는 weather_api에 fetch 없음. 서빙 경로 미변경 |
| 레이더 HSP PNG | `kma_fetch_rdr` + parse_netcdf RDR watcher | 미변경 |
| AWS 1분 pack | `kma_fetch_aws` · `/api/aws/*` · `/datasets/aws/` | 별 라우트·별 디렉터리. `SD_*`를 AWS pack에 넣지 않음 |
| HGT500 | `kma_fetch_hgt_txt` · `/api/hgt500/*` · `/datasets/kim-glob-hgt500-*` | `/datasets/sd/` prefix를 **그 앞**에 등록(기존 `/datasets/aws/`와 동일 패턴). kim dataset URL 충돌 없음 |
| 디스크 | `in_data/sd`, `out_data/sd/pack` | `in_data/gk2a|rdr|aws|gfs|kim` 와 **형제 디렉터리**. 덮어쓰기 없음 |

### 공유 자원에서만 조심할 것

| 항목 | 영향 | 완화 |
|------|------|------|
| **`pm2 reload weather_api`** | Fastify 재기동 순간 **구름/바람 image API 포함 전 HTTP가 짧게 끊길 수 있음** (기존 AWS pack 배포와 동일) | 방송 피크·스튜디오 생성 중이 아닐 때 reload. reload 후 `/ir105-color/.../image`, `/gfs-wind_10m/.../image` 1회 smoke |
| **`API_KEY` (apihub)** | `kma_fetch_sd`가 같은 키로 Hub 호출 | 부하 미미: 관측 **시간당 2회**(tot+24h) + 지점 **일 1회**. GK2A(수분)와 비교하면 무시 수준 |
| **Node 프로세스 CPU** | `/api/sd/pack`이 miss 시 on-request build 가능 | 운영은 warm CLI / `main_SD`가 미리 생성. 첫 배포 후 12/04 warm까지 끝내면 요청 경로 재빌드 거의 없음 |
| **PM2 등록** | `kma_fetch_sd`는 **신규 프로세스** | 기존 `kma_fetch` / `gfs_*` / `watcher_image*` 이름·script 불변. `pm2 update` 불필요 |

### 배포 후 권장 smoke (적설 + 회귀)

```bash
# 적설
curl -s http://localhost:3010/api/sd/stations | grep -o '"stationCount":[0-9]*'
curl -s "http://localhost:3010/api/sd/pack?date=20251204&variable=SD_TOT" | grep -o '"frameCount":[0-9]*'

# 구름·바람 회귀 (타임스탬프는 당일 존재하는 최근 파일로 교체)
curl -sI "http://localhost:3010/ir105-color/fd/1/image?timestamp_kor=$(date +%Y%m%d)1200" | head -n 1
curl -sI "http://localhost:3010/gfs-wind_10m/fd/1/image?timestamp_kor=$(date +%Y%m%d)1200" | head -n 1
```
