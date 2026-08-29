# TA pack QC — Producer↔Consumer 최종 합의

작성일: 2026-08-29  
상태: **합의 완료 — producer 구현 착수 가능**

관련 문서:
- `docs/producer-ta-temperature-qc-request.md` (producer 구현 spec)
- `docs/ta-pack-qc-consumer-agreement-request.md`
- `docs/ta-pack-qc-consumer-agreement-response.md`
- `docs/ta-pack-qc-producer-consumer-open-points.md` (잔여 항목 → 본 문서로 종료)

---

## 1. 역할 분리 (확정)

| 데이터 | 용도 |
| --- | --- |
| `/api/aws/min/pack` binary | 카드·TOP10·극값·기준판·tooltip·station label의 **유일한 관측 소스** |
| `qcDetailUrl` sidecar | reject 사유 추적·운영 감사 (표시값 소스 **아님**) |
| `/api/aws/min/exact` | 원천 대조·디버그 **전용** (UI 통계 금지) |

---

## 2. Producer 계약 (rev 9)

| 항목 | 값 |
| --- | --- |
| `contractRevision` | **9** |
| `qc.taTemporal.logicRevision` | **2** (sparse high 출시 baseline) |
| sparse high | **complete day only** (`complete:true`) |
| sparse 조건 | temporal QC 후 station/day 유효 TA ≤30 **且** TA≥44℃ sample → `-32768` |
| env | `AWS_TA_QC_SPARSE_HIGH_DEGC=44`, `AWS_TA_QC_SPARSE_MAX_VALID_SAMPLES=30` |
| partial/today | sparse high **미적용** (temporal QC만) |
| `qcDetailUrl` | complete TA **필수** — `/datasets/aws/ta/1m/{day}/qc-v{sha16}.json` |
| `qc.taOfficialFlag` | DB/Hub 조사 결과 manifest에 명시 |
| warm | binary → qc-v → manifest atomic publish (RN 패턴) |

`logicRevision` 또는 sparse env 변경 시 bump → consumer cache invalidate.

---

## 3. Consumer 동작 (확정)

### 3.1 observationValidity vs 렌더링 carry

| UI | 규칙 |
| --- | --- |
| 카드 숫자, TOP10, 극값, 기준 이상/이하 판, **tooltip**, **station label** | **observationValidity only** (pack에 값 있는 분만) |
| 지도 **bar/색상** | PT 연속성을 위해 **렌더링 전용 carry 허용** |
| carry seed | producer QC **rejected / sparse-high rejected** 분은 carry seed **금지** |

587 재현: **17시대 지도 bar/색상**에도 44.7℃ 고온 ghost **없음** (카드뿐 아니라 지도 포함).

### 3.2 임시 방어선 (`AWS_TA_CONSUMER_SPARSE_HIGH_GUARD`)

| 모드 | 동작 |
| --- | --- |
| `on` | sparse high guard 강제 |
| `off` | guard 비활성 (plausibility는 유지) |
| `auto` | 아래 모두 충족 시 off에 준함 |

`auto` 조건:

- `contractRevision >= 9`
- `qcDetailUrl` 존재
- `qc.taTemporal.logicRevision >= 2`
- manifest에 `sparseHighDegC`, `sparseMaxValidSamples` 명시
- **587 통과**: consumer E2E / 운영 checklist (manifest `qcVerified` boolean **없음**)

### 3.3 sidecar fetch / SHA

| 상황 | 동작 |
| --- | --- |
| fetch 실패 | binary 사용 + guard ON + warn; **PT hard stop 없음** |
| SHA ≠ `qcDetailSha256` | **동일** (sidecar 불신, guard ON) |
| SHA OK | binary = truth; sidecar = 디버그 |

### 3.4 plausibility

rev 9 이후에도 **물리 plausibility `[-50, 45]℃` 유지**. 상한 43℃ 조정 **없음**.

### 3.5 rev 8 pack 3단계

1. rev 9 warm **전**: rev 8 + guard — 허용  
2. rev 9 warm **후**: 극값/TOP/기준판은 **rev 9 pack만**  
3. rev 9 있으나 qcDetail stale/없음: guard ON, rev 8 **재사용 금지**

### 3.6 캐시 키 (최소)

`date`, `variable`, `contractRevision`, `logicRevision`, `datasetId`, (권장) `data.sha256`

---

## 4. 배포 순서 (확정)

| 순서 | 담당 | 작업 |
| --- | --- | --- |
| 1 | **Consumer** | carry seed 규칙, observationValidity 분리, guard auto/on |
| 2 | **Producer** | rev 9 TA QC + sidecar 구현·배포 |
| 3 | **Producer** | `20260828` TA + 최근 14일 TA `--force` warm |
| 4 | **공동** | §5 검증 |
| 5 | **Consumer** | guard `auto`/off 운영 |

---

## 5. 공동 검증 checklist (587 / 2026-08-28)

### Producer (API)

- [ ] `contractRevision >= 9`, `logicRevision >= 2`
- [ ] `qcDetailUrl` 200, `qcDetailSha256` 일치
- [ ] `sparseHighExcludedSampleCount >= 2`
- [ ] qc detail: STN 587 @ 12:01 `450`, 12:15 `447` rejected
- [ ] binary: STN 587 @ 12:01, 12:15 → `-32768`
- [ ] exact @ 12:15 TA=447 **유지 OK** (원천 보존)

### Consumer (UI)

- [ ] 17시대 방산 **카드** 44.7℃ 없음
- [ ] 17시대 **tooltip / station label** 44.7℃ 없음
- [ ] 17시대 **지도 bar/색상** 44.7℃ ghost 없음
- [ ] TOP10 / 극값 / 기준판에 587 44.7·45.0·49℃대 없음
- [ ] RN_* pack 회귀 없음

---

## 6. 이중 방어 기대치 (확정)

| 케이스 | producer sparse | consumer plausibility | 표시 |
| --- | --- | --- | --- |
| 587 sparse day, 44.7/45.0℃ | reject | 통과(≤45) | **producer가 제거** |
| sparse day, 47~49℃ | reject | reject(>45) | 양쪽 제거 |
| complete day, valid>30, 44.5℃ | **유지** | 유지 | **의도적 표시 OK** |

---

## 7. producer 구현 착수 조건

- [x] Consumer §6 미결정 항목 회신
- [x] Open points §2.1–2.8 회신
- [x] Producer `producer-ta-temperature-qc-request.md` §검증·sidecar 경로를 본 합의와 sync (구현 시)
- [ ] Consumer E2E 587 시나리오 (선배포)

**Blocking 이슈: 없음**

---

## 8. 참고

- RN QC sidecar: `docs/aws-rn-qc-consumer-schema.md` (TA sidecar는 동일 publish·SHA 정책)
- TA consumer schema (구현 후 추가 예정): producer 구현과 함께 `docs/aws-ta-qc-consumer-schema.md` 작성 권장
