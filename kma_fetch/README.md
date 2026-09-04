# kma_fetch

기상 원천 **수집·변환·pack 생성** 모듈입니다. HTTP 서빙은 repo 루트 `server.js`가 담당합니다.

| 프로세스 | 역할 |
| --- | --- |
| `main_AWS.js` | AWS 1분 JSON 수집 + today/어제 pack warm |
| `main_KIM.js` / `main_KIM_TXT.js` | KIM HGT500 관련 수집·변환 트리거 |
| `main_RDR.js` | 레이더 등 |
| `warm_aws_min_packs.js` | 일/구간 pack 사전 생성 |
| `backfill_aws_min.js` | 과거 JSON gap 채우기 |
| `server.js` (루트) | API·static·pack manifest |

온보딩·운영 상세: [`../skills/aws-min-json-pipeline`](../skills/aws-min-json-pipeline/SKILL.md)

---

## 디렉터리

```text
kma_fetch/
  main_AWS.js              # AWS watcher 엔트리
  main_KIM*.js / main_RDR.js
  warm_aws_min_packs.js    # pack warm CLI
  warm_aws_ta_pack.js      # TA-only wrapper
  backfill_aws_min.js
  run_backfill.sh          # Hub fetch + warm 원샷
  run_kmaWatcher_*.sh      # dev/prod watcher 기동
  config/                  # env, stn_inf → aws_stn_code_*.json
  utils/                   # aws_min_pack, aws_min_json, paths, ...
  services/                # apihub, scheduler, api
  tests/                   # test_aws_min_pack.js 등
  python/                  # KIM HGT PNG / TXT 변환
```

---

## 환경

| 파일 | 용도 |
| --- | --- |
| `.env.production` / `.env.development` | `BASE_DIR`, MSSQL, `API_KEY`, pack refresh 등 |
| `USE_API=false` | env 로드 시 `API_KEY` 검사 회피 (운영 warm/backfill에서 자주 사용) |
| `AWS_FETCH_SOURCE` | `auto` (기본: DB 후 Hub merge) / `db` / `hub` |
| `AWS_TODAY_PACK_REFRESH` | `0`이면 today pack 주기 warm 끔 |
| `AWS_TODAY_PACK_INTERVAL` | 기본 `5min` (`1min`/`2min`/`5min`/`10min`) |
| `AWS_TODAY_PACK_DEBOUNCE_MS` | 수집 후 debounce (기본 10000) |

운영 데이터 경로 (production 고정 경향):

```text
JSON: /data/node_project/weather_data/in_data/aws/{yyyy-MM-dd}/AWS_MIN_{tm}.json
pack: /data/node_project/weather_data/out_data/aws/pack/
```

로컬은 `BASE_DIR` / `deriveAwsJsonDir` / `deriveAwsPackDir` 규칙을 따릅니다.

---

## Watcher 기동

```bash
# 개발 — AWS만
bash kma_fetch/run_kmaWatcher_dev_AWS.sh

# 개발 — KIM / RDR
bash kma_fetch/run_kmaWatcher_dev_KIM.sh
bash kma_fetch/run_kmaWatcher_dev_RDR.sh

# 운영 (서버)
bash kma_fetch/run_kmaWatcher_prod.sh
```

사이트에 `run_watcher_prod_AWS.sh` 등 별칭이 있을 수 있습니다. **pack 계약/QC 배포 후에는 API(`server`)와 AWS watcher를 함께 재기동**하세요.

---

## Pack warm

```bash
# 하루, 강수 변수만
NODE_ENV=production USE_API=false node kma_fetch/warm_aws_min_packs.js 20260901 \
  --variables RN_DAY,RN_15M,RN_60M,RN_12HR,RN_24HR --force

# 구간, 전 변수
NODE_ENV=production USE_API=false node kma_fetch/warm_aws_min_packs.js \
  --from 20260819 --to 20260901 --force

# JSON이 있는 모든 날
NODE_ENV=production USE_API=false node kma_fetch/warm_aws_min_packs.js --all-json --force

# TA만
NODE_ENV=production USE_API=false node kma_fetch/warm_aws_ta_pack.js --from 20260828 --to 20260828 --force
```

| 옵션 | 설명 |
| --- | --- |
| `--variables LIST` | 콤마 목록. 생략 시 지원 변수 전부 |
| `--force` | complete cache 무시하고 재빌드 |
| `--from` / `--to` | 날짜 구간 |
| `--yesterday` | 어제 하루 |

**revision 참고 (자주 바뀜 — 코드 상수 확인)**

| 항목 | 위치 | 의미 |
| --- | --- | --- |
| `PACK_CONTRACT_REVISION` | `utils/aws_min_pack.js` | RN 등 non-TA 계약 (현재 8) |
| `TA_PACK_CONTRACT_REVISION` | 동상 | TA only (현재 9) |
| `RN_DAY_QC_LOGIC_REVISION` | 동상 | 강수 QC 로직 (현재 4) |
| `TA_QC_LOGIC_REVISION` | 동상 | TA QC 로직 |

Consumer cache는 `contractRevision` + 변수별 `logicRevision`으로 무효화합니다.

---

## Backfill

```bash
# Hub fetch + warm 원샷 (상단 FETCH_*/PACK_* 수정 또는 env)
bash kma_fetch/run_backfill.sh

FETCH_DRY_RUN=1 bash kma_fetch/run_backfill.sh   # 창만
SKIP_FETCH=1 bash kma_fetch/run_backfill.sh      # pack만
SKIP_PACK=1 bash kma_fetch/run_backfill.sh       # fetch만
```

또는:

```bash
node kma_fetch/backfill_aws_min.js --help
# 일회성 Hub만: ../work/fetch_aws_apihub.js  (work/README.md)
```

상세: `skills/aws-min-json-pipeline/references/historical-hub-fetch-pack.md`

---

## 관측소 마스터

```text
config/stn_inf_aws_YYYYMMDD.txt
  → node config/_build_stn_code_from_stn_inf.js
  → aws_stn_code_*.json / aws_stn_name_map_*.json
```

- `/api/aws/stations`·pack 메타의 기준
- `stn_inf` 스냅샷에 없는 지점(예: 신규 4자리 ID)은 Hub/JSON에 없으면 pack에도 없음
- 이름 패치: `patch_aws_min_stn_names.js`

---

## 핵심 유틸

| 모듈 | 역할 |
| --- | --- |
| `utils/aws_min_pack.js` | 변수별 Int16 pack, RN/TA QC, today warm, publish |
| `utils/aws_min_json.js` | JSON 경로·타임라인·range cache |
| `utils/aws_stn_catalog.js` | 지점 코드표 로드·enrich |
| `utils/aws_hub_fill.js` | DB 행에 Hub RN_12HR/TD merge |
| `services/aws_apihub_min.js` | `nph-aws2_min` 파싱 |

---

## 테스트

```bash
node kma_fetch/tests/test_aws_min_pack.js
node kma_fetch/tests/test_aws_apihub_min.js
# 기타 tests/ 참고
```

QC·계약 변경 시 pack 테스트부터 돌리는 것을 권장합니다.

---

## Python (KIM HGT500)

`python/kim_hgt_png_generator.py`, `kim_hgt_text_sequence_generator.py`, `kim_hgt_converter/`  
→ skill: [`../skills/kim-hgt500-png-pipeline`](../skills/kim-hgt500-png-pipeline/SKILL.md)  
→ API: [`../docs/kim_hgt500_frontend_api_spec.md`](../docs/kim_hgt500_frontend_api_spec.md)

---

## 관련 문서

- [`../README.md`](../README.md) — repo 입구
- [`../docs/README.md`](../docs/README.md) — QC·계약 인덱스
- [`../work/README.md`](../work/README.md) — 일회성 Hub / `#` 변환
