# work/ — 일회성·실험용 작업 공간

이 폴더는 **운영 런타임(`kma_fetch/main_AWS`, `server.js`)에 올리지 않는** 일회성 스크립트와 로컬 입출력용이다.

| 구분 | 경로 | 역할 |
| --- | --- | --- |
| **운영 수집·pack** | `kma_fetch/` | 1분 AWS 수집, today/어제 warm, backfill, QC |
| **HTTP producer** | `server.js` + `docs/openapi.yaml` | `/api/aws/*`, HGT500, IR105 등 |
| **일회성 Hub/원본 변환** | **`work/`** (여기) | 과거 gap 채우기, `#` 원본→JSON, 실험용 out |

운영 서버·재기동·warm runbook은 `skills/aws-min-json-pipeline` / `references/ops-fetch.md`를 본다.

---

## 이 repo(weather_api)와의 관계

`weather_api`는 SBS 기상 시각화용 **producer**다.

- Base: 운영 `https://weather-map.sbs.co.kr` / 로컬 `:3010`
- AWS consumer가 주로 쓰는 것: `GET /api/aws/min/pack`, `/stations`, `/exact`
- Pack 원천 JSON: `in_data/aws/{yyyy-MM-dd}/AWS_MIN_{yyyyMMddHHmm}.json`

`work/`에서 만든 JSON은 **같은 스키마**여야 pack warm·API와 호환된다.  
기본 출력은 가능하면 **운영 JSON 루트**에 맞추고, 로컬 실험만 `work/out`을 쓴다.

---

## 폴더 구조

```text
work/
  README.md                 ← 이 문서
  fetch_aws_apihub.js       ← API Hub nph-aws2_min → AWS_MIN JSON
  convert_aws_raw_to_json.js← 로컬 # 원본 → AWS_MIN JSON
  in/                       ← 로컬 원본 텍스트 (날짜 폴더)
  in/apihub/                ← --save-raw 시 Hub 원문
  out/                      ← --out-dir 미지정·로컬 실험 시 JSON 출력
```

운영 고정 JSON 경로 (production):

```text
/data/node_project/weather_data/in_data/aws/{yyyy-MM-dd}/AWS_MIN_{yyyyMMddHHmm}.json
```

---

## 언제 work/를 쓰고, 언제 kma_fetch를 쓰는가

| 목적 | 권장 |
| --- | --- |
| 실시간/준실시간 수집 | `kma_fetch/main_AWS.js` |
| 며칠~수주 과거 gap (운영 경로) | `kma_fetch/backfill_aws_min.js` 또는 `kma_fetch/run_backfill.sh` |
| DB 없는 과거·Hub만으로 대량 채우기 | **`work/fetch_aws_apihub.js`** 또는 backfill Hub 모드 |
| 서버에 남은 `#` 구분 원본 변환 | **`work/convert_aws_raw_to_json.js`** |
| pack 재생성 | `kma_fetch/warm_aws_min_packs.js` (`--force` / `--variables`) |

과거 Hub fetch + pack 상세: `skills/aws-min-json-pipeline/references/historical-hub-fetch-pack.md`

---

## 1) API Hub에서 받기 (`fetch_aws_apihub.js`)

기업용 `apihub-pub.kma.go.kr` 사용 (일반 `apihub.kma.go.kr`는 403).

- API: `nph-aws2_min`
- `stn=0`(전체 지점)일 때 **구간 최대 10분** → 스크립트가 10분 창으로 순회
- 값 스케일: Hub 물리단위 → MSSQL/`main_AWS` JSON과 동일하게 **×10**
- `STN_NAME` / 좌표: `kma_fetch/config/aws_stn_*_20260811.json`

### 환경

```bash
# API_KEY — 아래 중 하나
set API_KEY=발급키
# 또는 kma_fetch/.env.production 의 API_KEY=
```

운영 경로에 쓰려면:

```bash
NODE_ENV=production USE_API=false   # env 로드 시 API_KEY 검사가 거슬리면 USE_API=false + API_KEY만 별도
```

(`fetch_aws_apihub.js`는 자체 dotenv 로드로 `API_KEY`를 읽는다.)

### 예시

```bash
# 창 목록만 확인
node work/fetch_aws_apihub.js --from 20260712 --to 20260803 --dry-run

# 로컬 실험 출력
node work/fetch_aws_apihub.js --from 20260712 --to 20260803 --out-dir work/out --sleep 300

# 운영 JSON 루트에 저장 (권장: production)
NODE_ENV=production node work/fetch_aws_apihub.js --from 20260712 --to 20260803 --sleep 300

# 짝수분만 / 원문 보관 / 덮어쓰기
node work/fetch_aws_apihub.js --from 20260712 --to 20260803 --even-only --save-raw --force
```

| 옵션 | 설명 |
| --- | --- |
| `--from` / `--to` | `YYYYMMDD` · `YYYY-MM-DD` · `YYYYMMDDHHmm` |
| `--out-dir` | JSON 루트 override (미지정 시 `AWS_JSON_DIR` / 운영 / `BASE_DIR` 규칙) |
| `--sleep N` | 호출 간격 ms (기본 300) |
| `--even-only` | 짝수분만 |
| `--all-minutes` | 모든 분 (기본) |
| `--save-raw` | `work/in/apihub/{date}/`에 원문 |
| `--force` | 기존 JSON 덮어쓰기 |
| `--dry-run` | HTTP 없이 창 목록만 |

예상 호출 수: 하루 ≈ 144회(10분 창), 30일 ≈ 4,300회.

---

## 2) 로컬 `#` 원본 변환 (`convert_aws_raw_to_json.js`)

서버에 남아 있는 `#` 구분 AWS_MIN 텍스트가 있을 때:

```bash
node work/convert_aws_raw_to_json.js --dry-run
node work/convert_aws_raw_to_json.js
node work/convert_aws_raw_to_json.js --odd-minutes   # 기본은 짝수분만
```

- 입력: `work/in/{yyyy-MM-dd}/AWS_MIN_{yyyyMMddHHmm}` (확장자 없어도 됨)
- 출력: `work/out/{yyyy-MM-dd}/AWS_MIN_{yyyyMMddHHmm}.json`

원본 줄 형식:

```text
STN_ID#TM#LAT#LON#HT#WD#WS#TA#HM#PA#PS#RN_YN#RN_1HR#RN_24HR#RN_15M#RN_60M#WD_INS#WS_INS#=
```

---

## JSON 생성 후 (pack)

JSON만으로는 consumer pack이 안 바뀐다. 운영 반영 예:

```bash
# 강수 관련만 최근 구간 재생성
NODE_ENV=production USE_API=false node kma_fetch/warm_aws_min_packs.js \
  --from 20260712 --to 20260803 \
  --variables RN_DAY,RN_15M,RN_60M,RN_12HR,RN_24HR \
  --force

# 또는 JSON이 있는 날 전부
NODE_ENV=production USE_API=false node kma_fetch/warm_aws_min_packs.js --all-json --force
```

배포·재기동: **`server` + `run_watcher_prod_AWS.sh`(`main_AWS`)** 둘 다.

---

## 주의

- `work/` 산출물·`tmp_*.json`은 **git에 커밋하지 않는다** (대용량·일회성).
- Hub `stn=0` 호출은 rate limit·키 쿼터를 본다. `--sleep`을 너무 낮추지 말 것.
- 관측소 마스터는 `stn_inf` 스냅샷(`aws_stn_code_*.json`)이다. 방재 구간통계에만 있는 신규 지점(예: 4자리 `STN_ID`)은 Hub/JSON에 없으면 pack에도 없다.
- RN_DAY QC·`rnDayQcLogicRevision` 등은 `kma_fetch/utils/aws_min_pack.js` / `docs/` 계약 문서를 본다. `work/`는 JSON 채우기만 담당한다.

---

## 관련 문서

| 문서 | 내용 |
| --- | --- |
| `skills/aws-min-json-pipeline/SKILL.md` | 수집·pack 파이프라인 입구 |
| `skills/aws-min-json-pipeline/references/historical-hub-fetch-pack.md` | 과거 Hub + pack |
| `skills/aws-min-json-pipeline/references/ops-fetch.md` | 운영 fetch·재기동 |
| `skills/weather-api-catalog/SKILL.md` | HTTP producer 계약 |
| `docs/openapi.yaml` | OpenAPI |
| `kma_fetch/backfill_aws_min.js` | 운영 backfill CLI |
