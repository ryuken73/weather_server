# Snow Hub probe — 2025-12-02~04 (실측 확정)

적설 파이프라인 Phase 0 결과. API허브 실측을 통해 권장 `intervalMinutes`·필드·지점망을 확정했다.

## 원천

| API | URL | 비고 |
|-----|-----|------|
| 지점 | `GET …/stn_snow.php` | `LAW_ID`(법정동 10자리), `STN_KO`, LAT/LON/HT, `STN_CD`, `STN_AD`, `FCT_ID` |
| 관측 | `GET …/kma_snow1.php?sd=tot|24h&tm=&stn=0&snow=2` | `snow=2` 필수 (0cm 포함) |

구현: `kma_fetch/services/kma_apihub_snow.js`, CLI `kma_fetch/probe_snow.js`.

## 실측 probe 실행 결과 (2025-12-04 폭설 구간)

```bash
node kma_fetch/probe_snow.js --from 202512040000 --to 202512042330 --interval 30
```

- 산출 로그 및 raw 요약: `work/out/snow/probe_summary.json`

### 1. 갱신 주기: 1시간 (60분) 확정
- 30분 간격으로 48개 슬롯(`00:00`~`23:30`)을 probe한 결과:
  - **`:30` 슬롯 (24개)**: 직전 `:00`과 비교해 값이 **100% 동일** (`changedFromPrev: false`)
  - **`:00` 정시 슬롯 (24개)**: 23회 연속으로 **정시에만 값이 변함** (`changedFromPrev: true`)
- **결론**: API허브 적설 관측(`kma_snow1.php`)은 **1시간 간격(매 정시)** 생산 자료다.
- **권장 `intervalMinutes`**: **60** (pack slug `60m`, scheduler cron `4 * * * *`)

### 2. 지점망: 674개 지점
| 항목 | 실측값 | 비고 |
|------|--------|------|
| 전체 지점 수 | **674** | 초기 샘플 50개 대비 전국 관측망 망라 |
| `LAW_ID` 보유 | **674** (100%) | 전 지점 법정동코드 존재 |
| 지점명(`STN_KO`) | **674** (100%) | |
| AWS 지점 교집합 | **625 / 674** (92.7%) | 745개 AWS 중 625개 일치 → `aws_join` |
| 법정동코드 단독 해석 | **49 / 674** (7.3%) | `law_code_sido_sigungu.json`으로 시도/구군 해석 (`law_code`) |
| 주소 매핑 실패(`null`) | **0** (0%) | 674 전 지점 시도/구군 매핑 완료 |

- 최신 지점 코드표: `kma_fetch/config/sd_stn_code_20251204.json`

### 3. 관측값 분포 및 품질 (2025-12-04 실측치)
- `SD_TOT` / `SD_24H` 동시 응답 지점: 슬롯당 **668개** 정상 수신
- 0cm 지점 정상 수신: 슬롯당 약 590~600개 지점이 0cm로 수신되어 **0cm와 결측이 명확히 구분됨** (`snow=2` 정상 동작)
- 결측 지점: 슬롯당 2~3개에 불과
- 최대 관측치:
  - 적설(`SD_TOT`): 최대 **23.1 cm**
  - 24시간 신적설(`SD_24H`): 최대 **21.2 cm**

---

## 파이프라인 기본 계약 반영

| 항목 | 설정값 | 비고 |
|------|--------|------|
| 지점 코드표 | `sd_stn_code_20251204.json` (674지점) | `sd_stn_catalog.js` latest 자동 로딩 |
| 기본 수집 주기 | **60분** (`SD_FETCH_INTERVAL=60`) | cron `4 * * * *` (매시 4분) |
| 기본 Pack interval | **60m** (하루 24프레임) | slug `60m`, 필요시 `10/15/30/60` query 가능 |
| Pack Binary | Int16 LE, scale 0.1 cm, missing -32768, 0cm=0 | FRAME_MAJOR_STATION_MINOR |
| 엔드포인트 | `GET /api/sd/stations`, `GET /api/sd/pack?date=YYYYMMDD&variable=SD_TOT,SD_24H` | AWS 1분 pack과 별축 |
