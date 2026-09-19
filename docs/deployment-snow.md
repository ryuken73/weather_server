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
*(기존 AWS, RDR, KIM 등 타 수집 프로세스 및 엔드포인트에는 영향을 주지 않음)*
