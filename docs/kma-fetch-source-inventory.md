# kma_fetch 데이터 소스 인벤토리

`weather_api/kma_fetch` 코드와 로컬에서 확인 가능한 `weather_ops` 운영 문서를 기준으로 정리했다. `.env*`는 읽지 않았으며 URL은 코드 기본값만 사용했다. `weather_typhoon`·`typhoon-api` 구현 저장소는 이 작업 환경에서 찾지 못했으므로 태풍의 코드 미확인 항목은 추정하지 않았다.

### A. 제품 표 (필수)

| catalog_id | 제품 | PM2/엔트리 | primary | fallback | 엔드포인트*또는*경로 | 주기 | 산출물 | consumer | 근거파일 |
|---|---|---|---|---|---|---|---|---|---|
| `gk2a-ir105-web` | GK2A LE1B IR105 EA | `kma_fetch` / `kma_fetch/main.js` | apihub | 101-ftp | `https://apihub-pub.kma.go.kr/api/typ05/api/GK2A/LE1B/IR105/EA/dataList?sDate=...&eDate=...&authKey={API_KEY}` 및 `/data?date=...&authKey={API_KEY}`; FTP는 `{GK2A_FTP_HOST}:{GK2A_FTP_PORT}/{GK2A_FTP_REMOTE_BASE_DIR}/{YYYY-MM-DD}/gk2a/*.nc` | 10min (`5-55/10 * * * *`); FTP 도구 자체 스케줄 없음 | `in_data/gk2a/{YYYY-MM-DD}/gk2a_ami_le1b_ir105_ea020(ge\|lc)_{UTC}_{KST}.nc` | parse_netcdf → weather_api HTTP → weather_studio | `kma_fetch/main.js`; `kma_fetch/services/api.js`; `kma_fetch/services/scheduler.js`; `kma_fetch/python/gk2a_sync/ftp_sync_gk2a.py`; `README.md` |
| `gk2a-ir105-web` | GK2A LE1B IR105 FD | `kma_fetch` / `kma_fetch/main.js` | apihub | 101-ftp | `https://apihub-pub.kma.go.kr/api/typ05/api/GK2A/LE1B/IR105/FD/dataList?...&authKey={API_KEY}` 및 `/data?...&authKey={API_KEY}`; FTP 경로는 위와 같음 | 10min (`5-55/10 * * * *`); FTP 도구 자체 스케줄 없음 | `in_data/gk2a/{YYYY-MM-DD}/gk2a_ami_le1b_ir105_fd020(ge\|lc)_{UTC}_{KST}.nc` | parse_netcdf → weather_api HTTP → weather_studio | 위와 같음 |
| `gk2a-ir105-web` | GK2A LE1B IR105 KO | `kma_fetch` / `kma_fetch/main.js` | apihub | 101-ftp | `https://apihub-pub.kma.go.kr/api/typ05/api/GK2A/LE1B/IR105/KO/dataList?...&authKey={API_KEY}` 및 `/data?...&authKey={API_KEY}`; FTP 경로는 위와 같음 | 2min (`*/2 * * * *`); FTP 도구 자체 스케줄 없음 | `in_data/gk2a/{YYYY-MM-DD}/gk2a_ami_le1b_ir105_ko020(ge\|lc)_{UTC}_{KST}.nc` | parse_netcdf → weather_api HTTP → weather_studio | 위와 같음 |
| `radar-hsp-web` | RDR CMP HSP | `kma_fetch_rdr` / `kma_fetch/main_RDR.js` | apihub | 없음 | `https://apihub-pub.kma.go.kr/api/typ04/url/rdr_cmp_file.php?tm={YYYYMMDDHHmm}&data=bin&cmp=hsp&authKey={API_KEY}` | 5min (`4-59/5 * * * *`) | `in_data/rdr/{YYYY-MM-DD}/RDR_CMP_HSP_PUB_{YYYYMMDDHHmm}.bin` (Hub의 `.gz` 응답을 gunzip 저장) | parse_netcdf → weather_api HTTP | `kma_fetch/main_RDR.js`; `kma_fetch/services/api.js`; `kma_fetch/utils/file.js`; `kma_fetch/services/scheduler.js`; `README.md` |
| `aws-web` | AWS 1분 관측 | `kma_fetch_aws` / `kma_fetch/main_AWS.js` | 미확인 | apihub | 기본 `AWS_FETCH_SOURCE=auto`: MSSQL `wx_AWS_MIN` 우선 후 `https://apihub-pub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min?tm1={TM}&tm2={TM}&stn=0&disp=0&help=0&authKey={API_KEY}` 보충; `hub` 모드는 Hub만 | 1min (`* * * * *`) | `in_data/aws/{YYYY-MM-DD}/AWS_MIN_{YYYYMMDDHHmm}.json`; pack `out_data/aws/pack/...` | weather_api HTTP; parse_netcdf(레거시 강수 PNG) | `kma_fetch/main_AWS.js`; `kma_fetch/services/aws_apihub_min.js`; `kma_fetch/utils/aws_paths.js`; `README.md` |
| `kf-snow-web` | 적설 SD_TOT / 신적설 SD_24H | `kma_fetch_sd` / `kma_fetch/main_SD.js` | apihub | 없음 | 관측 `https://apihub-pub.kma.go.kr/api/typ01/url/kma_snow1.php?sd=tot\|24h&tm={TM}&stn=0&snow=2&authKey={API_KEY}`; 지점 `…/stn_snow.php` | 60min (`4 * * * *`, `SD_FETCH_INTERVAL`); 지점 일 1회 | `in_data/sd/{YYYY-MM-DD}/SD_{YYYYMMDDHHmm}.json`; pack `out_data/sd/pack/...`; HTTP `/api/sd/stations`, `/api/sd/pack` | weather_api HTTP | `kma_fetch/main_SD.js`; `kma_fetch/services/kma_apihub_snow.js`; `kma_fetch/utils/sd_pack.js`; `docs/snow-producer-pack-requirements.md` |
| `kf-aws-hourly-rn` | AWS 시간통계 RN | `kma_fetch_aws` / `kma_fetch/main_AWS.js` | apihub | 없음 | `https://apihub-pub.kma.go.kr/api/typ01/url/awsh.php?var=RN&tm={YYYYMMDDHHmm}&stn=0&help=0&authKey={API_KEY}` | 매시 :12 기본 (`AWS_HOURLY_STAT_MINUTE`, cron `{minute} * * * *`), 기본 6h lookback | `in_data/aws/stat/hourly/rn/{YYYY-MM-DD}/AWS_STAT_RN_{TM}.json`; `out_data/aws/pack/stat/hourly/rn/...` | weather_api HTTP | `kma_fetch/main_AWS.js`; `kma_fetch/services/aws_apihub_hourly.js`; `kma_fetch/utils/aws_hourly_stat.js`; `docs/aws-hourly-stat-rn-consumer-mapping.md` |
| `kf-kim-easia-etc` | KIM EAsia ETC NC | `kim_fetch` / `kma_fetch/main_KIM.js` | apihub | 없음 | `https://apihub-pub.kma.go.kr/api/typ06/url/nwp_file_down.php?nwp=kimgr&sub=etc&tmfc={YYYYMMDDHH}&ef={HOUR}&authKey={API_KEY}` | cron `10,20 * * * *` (매시 :10/:20) | `in_data/kim/{YYYY-MM-DD}/g576_v091_easia_etc.2byte.ft{EF}.{TMFC}.nc`; `out_data/kim/...` PNG | weather_api HTTP | `kma_fetch/main_KIM.js`; `kma_fetch/services/api.js`; `kma_fetch/services/scheduler.js`; `README.md` |
| `kf-kim-easia-prs` | KIM EAsia PRS NC | `kim_fetch` / `kma_fetch/main_KIM.js` | apihub | 없음 | `https://apihub-pub.kma.go.kr/api/typ06/url/nwp_file_down.php?nwp=kimgr&sub=prs&tmfc={YYYYMMDDHH}&ef={HOUR}&authKey={API_KEY}` | cron `15,25 * * * *` (매시 :15/:25) | `in_data/kim/{YYYY-MM-DD}/g576_v091_easia_prs.2byte.ft{EF}.{TMFC}.nc`; `out_data/kim/...` PNG | weather_api HTTP | `kma_fetch/main_KIM.js`; `kma_fetch/services/api.js`; `kma_fetch/services/scheduler.js`; `README.md` |
| `kim-hgt500` | KIM global HGT500 TXT | `kma_fetch_hgt_txt` / `kma_fetch/main_KIM_TXT.js` | apihub | 없음 | `https://apihub-pub.kma.go.kr/api/typ01/cgi-bin/url/nph-kim_nc_xy_txt2?group=KIMG&nwp=NE57&data=P&name=hgt&map=F&tmfc={YYYYMMDDHH}&hf={HOUR}&disp=A&help=1&level=500&authKey={API_KEY}` | cron `15,25 * * * *` (매시 :15/:25); 대상 cycle 기본 00/06/12/18, 12h 지연 | `in_data/kim/hgt500_txt/{TMFC}/kim_glob_prs_hgt500_ft{HF}_{TMFC}.txt`; `out_data/kim/datasets/kim-glob-hgt500-{TMFC}/...` | weather_api HTTP | `kma_fetch/main_KIM_TXT.js`; `kma_fetch/services/api.js`; `kma_fetch/utils/kim_text_paths.js`; `kma_fetch/services/scheduler.js`; `docs/kim_hgt500_frontend_api_spec.md` |
| `typhoon-101` | RTKO63 태풍정보 | 미확인 (`weather_typhoon`·`typhoon-api` 소스 없음) | 101-ftp | 없음 | 호스트는 운영자 확정 `10.4.1.101`; FTP 호스트 변수명·remote dir·파일명 패턴은 코드 미확인 | 미확인 (101 모니터 timeout 30일은 수집 주기가 아님) | 101 원천은 텍스트이나 확장자·로컬 입력 경로 미확인; XR JSON 출력 경로 미확인 | weather_typhoon | `D:/002.Code/weather_ops/data-sync/catalog.md`; `D:/002.Code/weather_ops/data-sync/reception-sw-monitor.md`; 구현 파일 미확인 |

`aws-web`의 `primary`가 `미확인`인 이유는 표의 허용값에 `MSSQL`이 없고, 코드 기본 `AWS_FETCH_SOURCE=auto`가 DB를 먼저 조회한 뒤 행이 없거나 일부 필드가 비면 API허브를 사용하기 때문이다. 운영 환경의 실제 `AWS_FETCH_SOURCE` 값은 `.env*`를 읽지 않아 확정하지 않았다.

### B. API허브 base URL (필수)

아래는 환경별 override 값을 읽지 않은 코드 기본값이다.

| 변수명/상수명 | 코드 기본 URL | 근거파일 |
|---|---|---|
| `API_ENDPOINT` | `https://apihub-pub.kma.go.kr/api/typ05/api/GK2A` | `kma_fetch/config/env.js` |
| `API_ENDPOINT_RDR` | `https://apihub-pub.kma.go.kr/api/typ04/url` | `kma_fetch/config/env.js` |
| `API_ENDPOINT_KIM` | `https://apihub-pub.kma.go.kr/api/typ06/url` | `kma_fetch/config/env.js` |
| `API_ENDPOINT_KIM_TXT` | `https://apihub-pub.kma.go.kr/api/typ01/cgi-bin/url` | `kma_fetch/config/env.js` |
| `API_BASE` (AWS 1분) | `https://apihub-pub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min` | `kma_fetch/services/aws_apihub_min.js` |
| `API_BASE` (AWS 시간통계) | `https://apihub-pub.kma.go.kr/api/typ01/url/awsh.php` | `kma_fetch/services/aws_apihub_hourly.js` |
| `SNOW_OBS_BASE` | `https://apihub-pub.kma.go.kr/api/typ01/url/kma_snow1.php` | `kma_fetch/services/kma_apihub_snow.js` |
| `STN_SNOW_BASE` | `https://apihub-pub.kma.go.kr/api/typ01/url/stn_snow.php` | `kma_fetch/services/kma_apihub_snow.js` |

인증 환경변수는 `API_KEY`이며 AWS 코드 일부는 `KMA_API_KEY`도 대체 이름으로 허용한다. 값은 기록하지 않는다.

### C. 101 fallback 상세 (필수)

#### GK2A IR105 EA/FD/KO

- 조건: `main.js`의 API 요청 실패·`USE_API`·파일 없음과 자동 연결된 fallback이 아니다. 별도 `ftp_sync_gk2a.py`를 운영자가 수동 또는 외부 cron/PM2로 실행하며, 목적 파일이 이미 있으면 skip하고 없는 파일만 FTP GET한다.
- 프로토콜: FTP (`ftplib.FTP`), 기본 port 21.
- 호스트/계정 변수명: `GK2A_FTP_HOST`, `GK2A_FTP_PORT`, `GK2A_FTP_USER` 또는 `GK2A_FTP_USERNAME`, `GK2A_FTP_PASSWORD` 또는 `GK2A_FTP_PASS`.
- 원격 경로: `{GK2A_FTP_REMOTE_BASE_DIR}/{YYYY-MM-DD}/gk2a/*.nc`; base 기본값은 `/`, 따라서 기본 조합은 `/{YYYY-MM-DD}/gk2a/*.nc`이다. `D:\OUT_DATA` 문자열과 `10.4.1.101`은 이 코드에 하드코딩되어 있지 않으므로, 이것이 101 `OUT_DATA`의 FTP 노출 경로인지는 운영 설정으로만 확정 가능하다.
- 로컬 발행: `GK2A_FTP_FINAL_DIR`, 기본 `{BASE_DIR}/in_data/gk2a`; staging은 `GK2A_FTP_STAGING_DIR`, 기본 `{BASE_DIR}/.incoming/gk2a`.
- 근거: `kma_fetch/python/gk2a_sync/ftp_sync_gk2a.py`, `kma_fetch/python/gk2a_sync/run_ftp_sync_gk2a.sample.sh`.

#### RDR·AWS·KIM NC·KIM TXT

코드에 101 fallback 없음. 운영자 진술의 “일부 fallback”은 이 저장소에서 GK2A 별도 FTP 도구만 확인되며, RDR/AWS/KIM 엔트리에는 `10.4.1.101`, `OUT_DATA`, `WEATHER_RCV`, FTP 전환 로직이 없다.

`USE_API`는 fallback 선택 스위치가 아니라 `config/env.js`에서 `API_KEY` 필수 여부를 검사하는 값이다. AWS의 실제 소스 선택은 `AWS_FETCH_SOURCE=auto|db|hub`가 담당하며, 여기서 DB는 MSSQL이고 101 FTP/OUT fallback은 아니다.

### D. 태풍 (필수)

- 101 원천: 운영자 확정상 텍스트이며 모니터 코드는 `RTKO63`. 정확한 확장자와 파일명 glob은 로컬에서 `weather_typhoon`·`typhoon-api`·태풍용 `ftp_sync` 구현을 찾지 못해 **미확인**이다.
- 가져가는 방법: 운영자 확정상 kma_fetch 계열이 `10.4.1.101`에서 FTP GET. FTP 호스트 환경변수명과 remote dir은 구현 파일 부재로 **미확인**이다.
- `weather_typhoon` 입력/출력: 텍스트 입력 → XR용 JSON 출력이라는 운영 흐름만 확인. 로컬 상대경로는 **미확인**이다.
- XR 접근: 8뉴스 XR 태풍 consumer라는 운영 문서만 확인되며 HTTP endpoint/파일 경로는 **미확인**이다.
- secondary: 운영자 확정은 **없음**. 이를 반박하는 코드는 현재 로컬 소스에서 발견되지 않았지만, 태풍 구현 저장소 자체가 없어 코드 수준 재검증은 하지 못했다.
- 근거: `D:/002.Code/weather_ops/data-sync/catalog.md`, `D:/002.Code/weather_ops/data-sync/reception-sw-monitor.md`; 찾아야 할 구현 파일 `weather_typhoon`, `typhoon-api/app/services/ftp_sync.py`, `merge_typhoon.py`는 이 작업 환경에 없음.

### E. kma_fetch가 아닌 것 (짧게)

- `gfs`: parse_netcdf `gfs_fetch_save`가 NOAA에서 직접 수집하므로 표 A 제외; catalog의 별도 `gfs` 행 유지.
- `kma-snow-101`: 101 수신SW가 같은 Hub `kma_snow1.php`를 치지만 **별축**. web 서비스는 표 A `kf-snow-web` (`kma_fetch_sd`).

### F. 병합 메모 (5줄 이내)

1. `gk2a-ir105-web`을 EA 10분, FD 10분, KO 2분으로 명시하고 fallback은 “별도 FTP sync, 자동 전환 아님”으로 고친다.
2. `radar-hsp-web`의 primary를 API허브로 확정하고 101 fallback은 `없음`으로 고친다.
3. `aws-web`은 기본 `auto`의 MSSQL 우선/API허브 보충을 기록하고, 시간통계 `awsh.php`는 `kf-aws-hourly-rn`으로 분리한다.
4. `kim-hgt500`은 global TXT와 EAsia ETC/PRS NC를 분리하고 코드의 실제 cron(`10,20`/`15,25 * * * *`)을 적는다.
5. `typhoon-101`의 FTP 변수·remote dir·확장자·입출력 경로는 구현 저장소 확보 전까지 `미확인`을 유지한다.
