---
name: aws-min-json-pipeline
description: AWS_MIN station JSON 수집·누락 복구·과거 backfill·1분 변수별 pack. Use when working with main_AWS.js, backfill_aws_min.js, work/fetch_aws_apihub.js, in_data/aws AWS_MIN_*.json, nph-aws2_min, RN_15M/RN_60M/RN_12HR/RN_24HR/RN_DAY, WS_INS, WD, HM, TD, /api/aws/min/pack, or STN_NAME code table.
---

# AWS_MIN JSON Pipeline

방재 AWS 분 자료를 **시각별 station 배열 JSON**으로 만들고, 1분 변수별 pack을 제공하는 서버 파이프라인 skill이다. HTTP 조회 계약은 `weather-api-catalog`를 본다.

## 다른 skill과의 경계

| Skill | 역할 |
| --- | --- |
| **aws-min-json-pipeline** (이 skill) | 수집·저장·포맷·backfill·pack 생성 |
| **weather-api-catalog** | `/api/aws/min`, `/pack`, `/stations` HTTP 계약 |
| **weather-external-resource-apis** | 시각화 consumer |

## 빠른 판단

1. 실시간/준실시간 수집·lookback·누락·**운영 env/재기동** → `references/ops-fetch.md` (운영: `sbs@10.10.16.168`, repo `/home/sbs/node_project/weather_server`)
   - 수작업 backfill + pack 생성 → 같은 파일 **수작업 runbook**
2. 파일 경로·JSON shape·단위·pack → `references/paths-and-schema.md`
3. `#` 원본 / API 허브 응답 포맷·변환 → `references/formats.md` (Hub 원문 샘플: `assets/nph-aws2_min_202608131200.txt`)
4. **RN_24HR rolling / RN_DAY 분리** → 아래 **RN_24HR / RN_DAY** 절 + `docs/rainfall-producer-rn24-rnday-change-request.md`
5. **과거(1달+ / DB 없음) Hub fetch + pack** → `references/historical-hub-fetch-pack.md` 또는 **`kma_fetch/run_backfill.sh`**
6. HTTP로 읽기만 → `skills/weather-api-catalog`

## 핵심 규칙

- 저장 경로: `{resolveBaseDir(in_data)}/aws/{yyyy-MM-dd}/AWS_MIN_{yyyyMMddHHmm}.json`
- 수집 주기는 **1분** (홀수분 포함). 기존 `/api/aws/min`·`/range`는 **2분 snap**으로 호환 유지.
- `AWS_FETCH_SOURCE=auto|db|hub` (기본 auto = **DB 후, RN_12HR/TD가 전부 없으면 같은 TM Hub 1회 merge**). Hub에는 `API_KEY` 필요.
- `USE_API=true`(기본)이면 env 로드 시 `API_KEY` 필수. DB-only면 `USE_API=false` + `AWS_FETCH_SOURCE=db`.
- lookback: `candidateMinute:1`, `candiateCount:30`, 최신 2개 drop
- 기업용 API 허브: `apihub-pub.kma.go.kr` / `nph-aws2_min` / `stn=0` 최대 10분 창
- JSON TA는 ×10 정수. pack Int16도 동일 스케일(×0.1℃), missing `-32768` (`-999`·Hub ≤ -50℃ 포함)
- Pack temporal QC는 **pack만** (`schemaVersion: 4`). TA에만 적용. 강수·풍속·풍향·습도·이슬점은 QC/smoothing/carry-forward 없음. `/exact`·디스크 JSON은 원천 그대로. `AWS_TA_QC=0`으로 off
- `STN_NAME` 저장 시 패치, `LAW_ADDR_*`는 HTTP enrich / stations / pack stations만
- Hub JSON: `RN-15m→RN_15M`, `RN-60m→RN_60M`(+호환 `RN_1HR` 별칭), `RN-12H→RN_12HR`, `RN-DAY→RN_DAY`(+legacy mirror `RN_24HR`), `WS1→WS`, `WSS→WS_INS`, `WD1→WD`, `WDS→WD_INS`, `HM`, `TD`. pack 이름은 `RN_1HR`를 쓰지 않음
- Pack: 변수별 일파일 `TA, RN_15M, RN_60M, RN_12HR, RN_24HR, RN_DAY, WS_INS, WS, WD_INS, WD, HM, TD`. `FULL` 없음. backfill 후·어제 워밍. HTTP `variable` 기본 `TA`
- HTTP: `GET /api/aws/min/pack?date=YYYYMMDD&variable=TA|RN_60M|RN_24HR|RN_DAY|...` → `/datasets/aws/{slug}/1m/{day}/{slug}-v{sha8}.i16le`
- **오늘(KST) partial pack**: `main_AWS`가 **5분마다** scheduler + 수집 hook debounce로 `warmTodayPacks` (registry 기반 Method B). TA·강수·풍속·풍향·습도·이슬점 포함. API는 manifest-only (요청 경로 rebuild 금지)
- 임의 구간 JSON은 `/api/aws/min/range` (2분). 과거 완결일은 warm/`main_AWS` 어제 워밍으로 사전 생성
- Gate0: `probe_aws_min_cadence.js` (홀수분). 배포 후 `main_AWS`+`server` 재기동; 과거 파일은 backfill/Hub 복사 별도.
- 운영 체크리스트 상세: `references/ops-fetch.md`

## 오늘 partial pack 자동 갱신 (Method B, registry)

`docs/producer-today-all-variable-pack-refresh-request.md` 대응. (강수-only 선행: `docs/rainfall-producer-today-pack-refresh-request.md`)

| 항목 | 내용 |
| --- | --- |
| Trigger | `main_AWS` **5분** scheduler (즉시, env로 변경 가능) + download tick (debounce 5~15초) |
| Registry | `TODAY_PACK_REGISTRY` in `aws_min_pack.js` — `refreshToday`, `sourceFields`, `dependencies` |
| 변수 | `TA`, `RN_15M`~`RN_DAY`, `RN_24HR`(RN_DAY 의존), `WS_INS`, `WS`, `WD_INS`, `WD`, `HM`, `TD` |
| Lock | day+variables single-flight + 변수별 `getOrBuildAwsVariablePack` single-flight |
| `to` | 디스크 최신 `AWS_MIN_*.json` 시각 (미래 프레임 없음) |
| `complete` | 항상 `false` |
| 원천 미전진 | `unchanged` — binary 재생성 없음 |
| Publish | binary → qc-v → **manifest 마지막** (atomic rename) |
| API | `GET /api/aws/min/pack` = manifest-only. miss → `404 PACK_NOT_WARMED` / stale → `PACK_STALE` |
| Disable | `AWS_TODAY_PACK_REFRESH=0` (legacy `AWS_TODAY_RAIN_PACK_REFRESH=0`) |
| Debounce | `AWS_TODAY_PACK_DEBOUNCE_MS` (기본 10000, 5000~15000) — 수집 hook만 |
| Scheduler | `AWS_TODAY_PACK_INTERVAL` (기본 `5min`, 허용 `1min`/`2min`/`5min`/`10min`) |

코드: `warmTodayPacks`, `getTodayPackRefreshVariables` in `kma_fetch/utils/aws_min_pack.js`. rain-only alias: `warmTodayRainPacks`. Consumer: `docs/rainfall-consumer-today-pack-guide.md`.

## RN_24HR / RN_DAY (필수)

시간이 이름에 있는 `RN_15M`·`RN_60M`·`RN_12HR`·`RN_24HR`는 모두 **rolling**. `RN_DAY`만 KST 당일 00시~현재 **day** 누적.

| pack | 원천 | accumulation | binary slug / URL |
| --- | --- | --- | --- |
| `RN_24HR` | `RN_DAY(D,t)+RN_DAY(D-1,23:59)-RN_DAY(D-1,t)` | `{ type: rolling, windowMinutes: 1440 }` | **`rn_24hr_rolling`** → `/datasets/aws/rn_24hr_rolling/1m/{day}/...` |
| `RN_DAY` | JSON `RN_DAY ?? legacy RN_24HR` (APIHUB `RN-DAY`) | `{ type: day, timezone: Asia/Seoul, resetTime: 00:00 }` | **`rn_day`** |

금지·주의:

- **legacy URL `/datasets/aws/rn_24hr/...` 를 rolling으로 쓰지 말 것** (과거 day-total immutable cache). 새 pack은 반드시 `rn_24hr_rolling`.
- JSON의 `RN_24HR` 필드는 마이그레이션용 **일 누적 mirror**일 뿐. pack `RN_24HR`에 그대로 넣지 않는다.
- `RN_12HR` 두 값 합산·`RN_60M` 반복 합산으로 24h를 만들지 않는다 (window 중복).
- **Hub RN-DAY는 00:01에 reset**되는 경우가 많다. pack은 **00:00 프레임을 0으로 정규화**한다 (결측은 결측 유지). RN_24HR derive의 당일/전일 00:00에도 동일 적용.
- **날짜 중간 RN_DAY 감소**는 counter-regression. **RN_DAY pack은 missing**, RN_24HR 계산은 **직전 accepted RN_DAY로 대체** (원천 결측은 fill 금지). offset stitching 없음.
- **비정상 양의 급상승**: soft/extreme은 **후보**만. reject는 `mechanical_repeat`·`isolated_peak_reset`만. extreme+장시간 missing 단독 reject 금지. `suspect-retained`는 원값 보존. RN_24HR last-confirmed substitution ≤30분.
- **cross-window isolated spike** (Hub JSON / STN 574): stored JSON에서 `RN_DAY`는 일 누적(예: spike 후 **280=28.0mm 유지**), `RN_15M/RN_60M/RN_12HR`만 **0→245→0**. RN_DAY만 보면 `0→245→280`이라 기존 `isolated_peak_reset` 미매칭 → `suspect-retained`. producer는 **short-window cross가 dry로 reset**이면 reject (`isCrossWindowPeakReset`). 상세·검증: `references/rainfall-spike-qc-stn574.md`
- 결측/counter 감소/음수/overflow → `-32768`. 0으로 clamp·carry-forward 금지.
- 전일 JSON 없으면 해당 날짜 `RN_24HR`만 `dependency-missing` (다른 변수 성공분 유지).
- `schemaVersion: 4`, `contractRevision: 8`. sparse QC: `qcDetailUrl`=`qc-v{sha16}.json` + `qcDetailSha256`. consumer: `docs/aws-rn-qc-consumer-schema.md`.

워밍 예:

```bash
node kma_fetch/warm_aws_min_packs.js \
  --from 20260701 --to 20260817 \
  --variables RN_24HR,RN_DAY \
  --force
```

변경 요청서: `docs/rainfall-producer-rn24-rnday-change-request.md`. 포맷 상세: `references/formats.md`.

## 관련 원천

- 실시간: `kma_fetch/main_AWS.js` (어제 전변수 warm + **오늘 전 변수 5분 scheduler + 수집 debounce warm**)
- Backfill: `kma_fetch/backfill_aws_min.js` (1440 slots/day, `--refresh-fields RN_12HR,TD` 는 Hub merge, 빈/부분 Hub로 덮어쓰지 않음)
- Hub client: `kma_fetch/services/aws_apihub_min.js`
- Pack: `kma_fetch/utils/aws_min_pack.js` (`warmTodayPacks`, `warmTodayRainPacks`, `warmAwsDayPack`), `kma_fetch/warm_aws_min_packs.js`
- HTTP: `server.js` + `aws_min_json.js` + `aws_stn_catalog.js`
- 요건: `docs/aws-producer-1min-pack-requirements.md`, `docs/producer-today-all-variable-pack-refresh-request.md`, `docs/rainfall-producer-rn24-rnday-change-request.md`, `docs/rainfall-producer-today-pack-refresh-request.md`, `docs/rainfall-producer-stn574-repeated-spike-qc-request.md`
- Consumer 오늘 pack: `docs/rainfall-consumer-today-pack-guide.md`
