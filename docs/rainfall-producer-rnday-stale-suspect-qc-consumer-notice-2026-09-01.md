# RN_DAY stale suspect QC — Consumer 전달

작성일: 2026-09-01  
상태: **Producer 구현 완료 (`rnDayQcLogicRevision=3`) — warm·공동 검증 대기**

관련 문서:
- `docs/rainfall-producer-rnday-stale-suspect-qc-request-2026-09-01.md` (사례·증거·producer 요청 원문)
- `docs/aws-rn-qc-consumer-schema.md` (RN sparse QC sidecar 스키마)
- `docs/rainfall-consumer-today-pack-guide.md` (today partial pack)

---

## 1. 요약

2026-09-01 `RN_DAY` 시간재생에서 **STN 739 심원** 사례에 대해 Consumer 분석을 확인했습니다.

| 구분 | 판단 |
| --- | --- |
| **현상 재현** | 동의 — 09:41 binary는 결측, 08:12까지 유효한 94.0mm가 consumer carry로 현재처럼 보임 |
| **순위표 vs 지도 불일치** | 순위표(현재 시각 관측만)는 정상, 지도 carry는 consumer 정책 이슈 |
| **Producer 근본 원인** | 08:05 `suspect-retained` 이후 08:07~08:12 plateau가 pack에 **valid로 남음** — QC 보강 필요 |
| **Consumer 임시 방어** | 오래된 `RN_DAY` carry 제한 — **병행 권장** (화면 오인 방지) |

Producer는 본 문서 계약에 따라 **`staleSuspectPlateau` 2nd pass**를 `kma_fetch/utils/aws_min_pack.js`에 반영했습니다.

구현 요약:

- `qcRnDayStationSeries` 후처리: 저 baseline + ≥90mm plateau + reset/결측 aftermath → `staleSuspectPlateau` reject
- `isRnDaySpikeRejectReason`에 포함 → `RN_15M`/`RN_60M`/`RN_12HR` rolling mask 전파
- `RN_DAY_QC_LOGIC_REVISION`: **2 → 3** (`contractRevision` 8 유지)
- 테스트: STN 739 fixture (`kma_fetch/tests/test_aws_min_pack.js`)

---

## 2. 역할 분리 (확정 방향)

| 레이어 | 책임 |
| --- | --- |
| **Producer pack binary** | spike island를 reject → 누적/극값/TOP의 **원천**에서 제거 |
| **Producer qcDetailUrl** | reject/suspect-retained 추적 (표시값 소스 **아님**) |
| **Consumer 순위표** | 현재 시각 **실제 pack 관측**만 — 기존 유지 |
| **Consumer 지도 carry** | 짧은 결측 보정용; **오래된 carry 제한** — 임시 방어 유지 |
| **/exact, /range** | 원천 JSON 보존 — UI 통계 금지 (기존과 동일) |

Producer 수정 후에도 **과거 시각으로 재생**하면 당시 유효했던 값은 보일 수 있습니다.  
**현재 시각(09:41)에 94mm가 보이는 문제**는 consumer carry + producer spike 잔존이 겹친 것이며, 양쪽 모두 손볼 대상입니다.

---

## 3. Producer가 확인한 기술 원인 (요약)

확인 dataset: `aws-rn_day-1m-20260901-v67832e44` (to `202609010951` 시점 기준)

### 3.1 Pack binary

- STN 739 유효 `RN_DAY`: 96분 (sparse day)
- 마지막 유효: **08:12 = 94.0mm**
- 09:32~09:51: 결측 → 09:41 현재값 없음

### 3.2 QC sidecar (현행)

| state | count |
| --- | ---: |
| rejected | 268 |
| suspect-retained | **1** (08:05, 93.5mm) |

08:03 `isolatedPeakReset`(93.0mm)은 reject되었으나, **08:05 suspect-retained → 08:07~08:12 plateau는 pack에 valid로 publish**된 상태입니다.

### 3.3 QC detail에 08:07~08:12가 없는 이유

현행 sidecar는 **`suspect-retained` / `rejected` / `counterRegression`만** record로보냅니다.  
08:07~08:12가 QC 상 **valid**이면 sidecar에 **없는 것이 현재 스펙**입니다 (버그가 아니라 sparse-only 정책).

Producer 보강 후에는 해당 분이 **rejected**로 승격되면 sidecar record도 함께 생깁니다.

### 3.4 교차 변수

08:09~08:12 `RN_15M`/`RN_60M`도 94.0mm 동시 spike 후 0/결측 — 센서/원천 spike 가능성 높음.  
Producer 1차 범위는 **`RN_DAY` pack**이며, rolling 변수 mask 전파 여부는 §6에서 확인합니다.

---

## 4. Producer 구현 (반영됨)

### 4.1 신규 QC: suspect island 사후 승격 reject

**오프라인 2nd pass** (`qcRnDayStationSeries` 마지막 단계 — 당일 전체 시계열 재처리):

```text
t-1: 낮은 누적 (예: ≤ 4.5mm)
t:   suspect-retained 또는 급상승 plateau 시작
t+k: counterRegression / 0 reset / 연속 source missing
→ 해당 island(plateau) 전부 pack missing + qc detail rejected
```

reason: **`staleSuspectPlateau`** (고정)

### 4.2 기존 정책 유지

- **극값 후 장결측만**으로 reject — **하지 않음** (`findExtremeThenLongMissingRejects` no-op 유지)  
  → 실제 극한 강수 보존
- 이번 규칙은 **저누적 baseline + 고 plateau + 직후 reset/결측 + (선택) cross-field 동시 spike** 조합

### 4.3 계약 bump (반영됨)

| 필드 | 이전 | 현재 |
| --- | --- | --- |
| `contractRevision` | **8** (RN_* 유지) | **8** (변경 없음) |
| `rnDayQcLogicRevision` | **2** | **3** (`staleSuspectPlateau` baseline) |

`logicRevision` bump → Consumer **IndexedDB / pack 캐시 무효화** 필요 (TA `logicRevision`과 동일 패턴).

### 4.4 배포·warm

| 순서 | 담당 | 작업 |
| --- | --- | --- |
| 1 | Consumer | 임시 carry 제한 **유지** (producer 배포 전에도 화면 보호) |
| 2 | Producer | QC 구현 + 테스트(STN 739 fixture) — **완료** |
| 3 | Producer | `20260901` RN_DAY/RN_15M/RN_60M/RN_24HR `--force` warm + **watcher(`main_AWS`) 재기동** |
| 4 | 공동 | §5 검증 |

**주의:** TA rev9 사례와 동일하게, **`server.js`만 재기동하고 `run_watcher_prod_AWS.sh`/`main_AWS`를 올리지 않으면** today RN_DAY pack이 구 QC로 덮어써질 수 있습니다. Producer 배포 시 **API + AWS watcher 모두** 재기동합니다.

---

## 5. 공동 검증 checklist (STN 739 / 2026-09-01)

### Producer (API)

- [ ] `rnDayQcLogicRevision >= 3`
- [ ] `GET /api/aws/min/pack?date=20260901&variable=RN_DAY` — STN 739 @ 08:05~08:12 → binary **missing** (`-32768`)
- [ ] qc detail: 08:05~08:12 `state=rejected`, reason에 stale/suspect 승격 사유
- [ ] `suspect-retained` count: 기존 1 → **0** (또는 island 전체 reject)
- [ ] 09:41 STN 739 binary: **missing** (기존과 동일)
- [ ] 정상 다습 station 회귀 없음 (스팟 1~2개)

### Consumer (UI)

- [ ] 2026-09-01 09:41 **현재 시각** — 심원 카드/지도에 94.0mm **없음** (carry 제한 + producer 반영)
- [ ] 순위표: 심원 없음 (기존과 동일)
- [ ] **08:12 이전 시각으로 재생** 시 — producer reject 전후 동작 문서화 (과거 plateau는 그 시각에선 보일 수 있음)
- [ ] `RN_24HR` / `RN_15M` / `RN_60M` 회귀 없음
- [ ] 캐시: `logicRevision` 변경 시 구 pack 미재사용

---

## 6. Consumer 확인 요청 (회신 부탁)

### 6.1 임시 carry 방어

계획하신 정책(마지막 관측 후 N분 초과 시 지도/IDW 제외)을 **producer 배포 전에도 적용**해 주실 수 있는지,  
적용 시 **N분 기본값**을 알려주시면 producer 검증 시 맞춰 보겠습니다.

### 6.2 캐시 키

`RN_DAY` pack 캐시에 아래가 모두 포함되는지 확인 부탁드립니다.

- `date`, `variable=RN_DAY`
- `contractRevision` (8)
- **`rnDayQcLogicRevision`** (≥ 3 이후)
- `datasetId`, `data.sha256`

`logicRevision`만 바뀌어도 구 pack을 쓰지 않아야 합니다.

### 6.3 qcDetailUrl fetch 실패 시

기존 RN 정책 유지인지 확인:

- binary 사용 + overlay/guard ON + warn
- PT hard stop 없음

### 6.4 Rolling 변수 범위

08:09~08:12 `RN_15M`/`RN_60M`에도 94.0mm spike가 있습니다.

- **A.** Producer가 `RN_DAY`만 reject해도 consumer UI에 충분한지
- **B.** rolling pack에도 동일 spike mask 전파가 필요한지

Consumer 입장에서 **B가 필요하면** 회신해 주세요 (구현 범위에 포함).

### 6.5 관측 소스 우선순위 (재확인)

Producer reject 후:

- **순위표·극값·기준판** = pack binary only (변경 없음)
- **지도 carry** = consumer 렌더링 정책 (producer가 carry 시간을 직접 제어하지 않음)

동의 여부만 짧게 회신해 주시면 됩니다.

---

## 7. Producer가 하지 않는 것 (명시)

- Consumer 지도 carry 시간/IDW 파라미터 직접 제어
- `/exact` 원천값 변경
- `contractRevision` 전역 9 상향 (TA-only rev9 정책 유지)
- 구 `rnDayQcLogicRevision: 2` pack을 consumer가 계속 극값/TOP에 쓰는 것 — **배포 후 rev3 warm pack만** 기대

---

## 8. 연락·다음 단계

1. Consumer: §6 회신 (특히 **6.4 rolling 범위**, **6.1 carry N분**)
2. Producer: 회신 반영 후 구현 + `rnDayQcLogicRevision: 3`
3. Producer: `20260901` warm + watcher 재기동
4. 공동: §5 checklist

Producer 구현 PR/배포 일정은 회신 수령 후 공유하겠습니다.
