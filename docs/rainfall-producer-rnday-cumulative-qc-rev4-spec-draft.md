# RN_DAY 누적강수 QC rev4 — Producer↔Consumer 합의안

작성일: 2026-09-01  
상태: **Producer 구현 완료 (`rnDayQcLogicRevision=4`) — warm·공동 검증 대기**  
작성: Producer (`weather_api`)

관련 문서:

- `docs/rainfall-producer-rnday-cumulative-qc-hardening-request-2026-09-01.md` (Consumer 요청 원문)
- `docs/rainfall-producer-rnday-stale-suspect-qc-consumer-notice-2026-09-01.md` (rev3 `staleSuspectPlateau`)
- `docs/aws-rn-qc-consumer-schema.md` (RN sparse QC sidecar — rev4에서 schema v2 갱신 예정)
- `docs/rainfall-producer-spike-qc-final-review.md` (valid / suspect-retained / rejected 분리 원칙)

---

## 1. 요약

Consumer가 `RN_DAY`를 **당일 carry-forward seed**로 쓰면서, pack binary에 남는 값의 품질 요구가 올라갔다.

| revision | 핵심 변경 | 상태 |
| --- | --- | --- |
| **3** | `staleSuspectPlateau` — 저 baseline + 고 plateau island 사후 reject | **배포·warm 완료** (STN 739 검증 OK) |
| **4** (본 문서) | **`suspect-retained`를 binary에서 제외** + `removedSpans` sidecar | **구현 완료** |

rev4의 한 줄 정의:

> **`RN_DAY` pack binary에는 carry seed로 안전한 값만 남기고, `suspect-retained`는 sidecar로만 추적한다.**

`contractRevision`은 **8 유지**. cache 무효화는 `rnDayQcLogicRevision` bump로 처리한다.

### 1.1 Consumer 검토 결론 (2026-09-01)

| 항목 | 결과 |
| --- | --- |
| suspect-retained binary 제외 | **동의** |
| `removedSpans` sidecar | **강력 권장** → rev4 **필수 포함** |
| `spikeRecovery` publish 조건 | **명시 보강** (본 문서 §4.2.1) |
| 당일 carry 정책 | **당일 내 무제한 carry** (production 기본). 10분 제한은 진단/비상 옵션만 |

---

## 2. 배경 · rev3 이후 남은 갭

### 2.1 Consumer carry 정책 (확정)

Consumer production 기본값 (2026-09-01 기준):

- 같은 **KST 날짜** 안에서 마지막 **binary 유효** 누적값을 **무제한 carry-forward**
- 새 유효값이 이전 누적보다 작으면 표시값은 이전값으로 고정 (단조 증가 UI)
- `observationValidity` vs `carryForwardValidity` 분리 유지
- 순위표·극값은 pack binary 기준
- Consumer는 producer가 유효값으로 준 spike를 임의로 이상값 처리하지 않음

**진단/비상 옵션:** `RN_DAY_MAX_CARRY_FORWARD_MINUTES` (예: 10) — production 기본 **아님**.  
회귀·장애 분석 시에만 켜는 옵션으로 유지.

→ **잘못된 값이 binary에 한 번이라도 들어가면, 당일 끝까지 carry seed가 될 수 있다.**  
rev4에서 producer가 suspect를 binary에서 제거하는 것이 **핵심 방어선**이다. Consumer 10분 제한에 의존하지 않는다.

### 2.2 rev3로 해결된 것

- STN 739 심원: `suspect-retained` → plateau → `staleSuspectPlateau` 사후 reject
- 08:05~08:12 binary missing, 당일 max 4.5mm

### 2.3 rev3 이후에도 남는 것

현행 rev3에서 `suspect-retained` 판정 sample은:

| 저장소 | rev3 동작 |
| --- | --- |
| pack binary | **유효 Int16으로 publish** (`pack[i] = raw`) |
| qc sidecar | `state: suspect-retained` record 생성 |
| 내부 QC `rolling` | suspect 값 유지 (후속 counter-regression·파생용) |

즉 **739류 plateau는 rev3가 잡지만**, plateau로 승격되지 않는 **일반 suspect 1~N분**은 여전히 binary carry seed가 될 수 있다.

예: 영덕 STN 277류 극한 강수 후보 — 자동 reject하지 않고 suspect로 남기던 정책과 **binary publish 정책이 충돌**한다.

---

## 3. 역할 분리 (rev4 확정)

| 데이터 | rev4 용도 |
| --- | --- |
| `/api/aws/min/pack` `RN_DAY` binary | 카드·TOP·극값·기준판·**carry seed** — **신뢰 확정값만** |
| `qcDetailUrl` sidecar | `suspect-retained` / `rejected` / `removedSpans` 추적 — **표시값 소스 아님** |
| manifest `qc.rnDayRegression` | 일별 집계·warning·logicRevision |
| `/api/aws/min/exact` | 원천 JSON 대조 — UI 통계 금지 (기존과 동일) |

Consumer 지도 carry (production):

- binary에 값이 있는 분만 **새 carry seed** 후보
- binary missing이면 **이전 confirmed seed**를 당일 내 계속 carry (시간 제한 없음)
- rev4에서 suspect 분은 binary missing → **suspect가 seed가 되지 않음**

---

## 4. Producer 계약 (rev4)

### 4.1 revision

| 필드 | rev3 | rev4 |
| --- | --- | --- |
| `contractRevision` | 8 | **8** (변경 없음) |
| `rnDayQcLogicRevision` | 3 | **4** |
| `manifest.qc.rnDayQc.logicRevision` | (동일 값 mirror 권장) | **4** |
| qc sidecar `schemaVersion` | 1 | **2** (`removedSpans` 추가) |

Consumer cache key에 포함되는 경로 (기존과 동일):

```text
manifest.rnDayQcLogicRevision
manifest.qc.rnDayQcLogicRevision
manifest.qc.rnDayQc.logicRevision
manifest.qc.rainQc.logicRevision
```

### 4.2 binary publish 규칙 (`RN_DAY`)

| QC status / reason | pack binary | sidecar `state` | 비고 |
| --- | --- | --- | --- |
| `valid` | **publish** | (record 없음) | 정상 |
| `softCandidateAccepted` | **publish** | (record 없음) | soft 후보 수용 |
| `spikeRecovery` | **publish** | (record 없음) | §4.2.1 조건 충족 시만 |
| `suspect-retained` / `suspectRetained` | **missing** (`-32768`) | **`suspect-retained`** | **rev4 핵심 변경** |
| `rejected` (* spike reasons) | missing | `rejected` | rev3와 동일 |
| `staleSuspectPlateau` | missing | `rejected` | rev3와 동일 |
| `counterRegression` | missing | `rejected` (또는 기존 sparse 정책) | rev3와 동일 |
| `spikeRecoveryPending` | missing | `rejected` | rev3와 동일 |
| `missing` / `source_missing` | missing | (record 없음) | rev3와 동일 |

**내부 `rolling` grid**는 기존처럼 suspect 값을 들고 있을 수 있다.  
`RN_24HR` 파생·counter-regression hold는 **내부 rolling** 기준으로 유지한다.  
**대외 publish(`int16` binary)만** `packGrid` 기준으로 missing 처리한다.

#### 4.2.1 `spikeRecovery` binary publish 조건 (명시)

`spikeRecovery`는 reject 직후 관측이 다시 신뢰될 때만 binary에 publish한다.  
**2연속 회복**만으로 충분하지 않으며, 아래를 **모두** 만족해야 한다.

1. **회복 streak**  
   - offline spike reject 직후 `afterReject` 구간에서  
   - `RN_DAY_SPIKE_RECOVERY_STREAK` (= **2**) 연속 분이 `spikeRecoveryPending`이 아닌 회복 경로에 진입  
   - 1분째: `spikeRecoveryPending` → binary **missing**  
   - 2분째: `spikeRecovery` → binary **publish** (현행 구현과 동일)

2. **당일 누적 단조 증가**  
   - publish 시점 값 `v >= accepted` (이전 확정 누적)  
   - `v < accepted`이면 `counterRegression` → binary missing (회복 publish **불가**)

3. **offline reject mask 미포함**  
   - 해당 분이 `mechanicalRepeat` / `isolatedPeakReset` / `repeated_peak_episode` / `staleSuspectPlateau` 등 **사후 reject mask에 포함되지 않음**

4. **cross-window 모순 없음**  
   - publish 분에서 `classifyRnDayIncrease(v, accepted, elapsed, cross)` 기준  
   - `extremeCandidate` 단독 + `crossContradiction` 조합으로 **다시 suspect로 빠지지 않음**  
   - 즉 회복 분이 “reject는 풀렸지만 여전히 suspect”로 분류되면 binary publish **하지 않음** (rev4 suspect = missing)

5. **후속 2nd pass 무해**  
   - `findStaleSuspectPlateauRejects` 등 rev3 사후 pass에 의해 **소급 reject되지 않음**

요약: `spikeRecovery`는 “reject 후 2분 연속으로 돌아왔다”가 아니라, **단조 증가·cross 일관·mask 클린**까지 확인된 값만 carry seed가 된다.

### 4.3 suspect-retained 정의 (변경 없음, publish만 변경)

suspect 판정 조건 자체는 rev3와 동일:

- extreme rate / large step / soft+cross contradiction 등 **단독 reject 금지** 후보
- multi-signal reject 패턴에 해당하지 않는 큰 상승
- `findExtremeThenLongMissingRejects` no-op 유지 (극한 강수 + 장결측 자동 reject **하지 않음**)

변경점은 **판정 결과의 binary 반영**뿐이다.

### 4.4 단조 증가 · 자정 reset (변경 없음)

- `v < accepted` → `counterRegression` → binary missing
- KST `0000` Hub 잔존값 → `0` normalize (기존 `midnightRnDay`)
- rev4에서 추가 변경 없음

### 4.5 rolling 변수 mask 전파 (변경 없음)

`ROLLING_RAIN_SPIKE_QC_VARIABLES`: `RN_15M`, `RN_60M`, `RN_12HR`

`isRnDaySpikeRejectReason`에 포함된 reason은 rolling pack에 substitute/mask 전파 (rev3와 동일).

**rev4 주의:** `suspectRetained`는 spike reject reason에 **포함하지 않는다**.  
rolling 변수는 suspect 분을 RN_DAY spike mask로 대체하지 않는다 (rev3와 동일).

### 4.6 기존 정책 유지 (명시)

| 정책 | rev4 |
| --- | --- |
| `staleSuspectPlateau` 2nd pass | **유지** |
| mechanical repeat / isolated peak / episode reject | **유지** |
| suspect → plateau 사후 reject | **유지** (rev3) |
| suspect 단독 자동 reject | **하지 않음** (sidecar만) |
| 극한 강수 + 장결측 자동 reject | **하지 않음** |

---

## 5. QC 메타데이터 확장 (rev4)

### 5.1 manifest 집계 (기존 + 보강)

`manifest.qc.rnDayRegression.byReason`에 이미 있는 producer reason 유지:

```json
{
  "counterRegression": 0,
  "sourceMissing": 0,
  "upwardSpikeRejected": 0,
  "suspectRetained": 0,
  "spikeRecoveryPending": 0,
  "spikeRecovery": 0,
  "staleSuspectPlateau": 0
}
```

rev4 추가 필드:

```json
{
  "suspectExcludedFromBinarySampleCount": 0,
  "suspectExcludedFromBinaryStationCount": 0
}
```

`manifest.warnings` 예시:

```text
RN_DAY suspect-retained excluded from binary for N samples across M stations (logicRevision 4)
```

### 5.2 Consumer 친화 reason 카테고리 매핑

운영·대시보드용 **카테고리** (sidecar span·manifest 공통):

| category | producer reason / 출처 | binary |
| --- | --- | --- |
| `midnight-normalize` | `manifest.qc.midnightRnDay` | publish `0` |
| `counter-regression` | `counterRegression` | missing |
| `upward-spike` | `upwardSpikeRejected`, `mechanicalRepeat`, `isolatedPeakReset`, `spikeRecoveryPending` | missing |
| `sparse-spike-island` | `staleSuspectPlateau` | missing |
| `cross-window-inconsistent` | signals에 `cross_contradiction_*` 포함된 reject/suspect | reason별 |
| `suspect-excluded-from-binary` | `suspectRetained` (rev4) | **missing** |

### 5.3 sidecar `removedSpans` (rev4 **필수**)

Consumer 검토: UI 계산에는 쓰지 않더라도 운영에서 **“왜 빠졌는지”** 확인에 필수.  
특히 suspect → binary missing은 화면에 값이 안 보이므로 **sidecar 추적성이 중요**.

**qc.json schemaVersion: 1 → 2** (rev4 pack은 `removedSpans` **필수** 포함).

```ts
type AwsRnQcRemovedSpan = {
  STN_ID: number;
  stationName?: string;
  from: string; // YYYYMMDDHHmm inclusive
  to: string;   // YYYYMMDDHHmm inclusive
  reason: string;           // producer reason code e.g. suspectRetained, staleSuspectPlateau
  reasonCategory: string;   // §5.2 category
  maxRawValue: number | null;
  maxValueMm: number | null;
  sampleCount: number;
};

type AwsRnQcDetailV2 = AwsRnQcDetail & {
  schemaVersion: 2;
  rnDayQcLogicRevision: number; // >= 4
  removedSpans: AwsRnQcRemovedSpan[]; // rev4: 필수 (없으면 빈 배열)
};
```

생성 규칙:

- binary **missing**이 된 sample 중 sidecar에 기록할 대상을 `(STN_ID, reason)`별 **연속 TM** span으로 병합
- `maxRawValue` / `maxValueMm` = span 내 raw 최대
- `suspect-excluded-from-binary` span은 rev4에서 **반드시 생성**
- `staleSuspectPlateau` / spike reject span도 동일 규칙

**Consumer 사용:** UI 통계·carry seed에는 사용하지 않음. 운영 QC·감사·회귀 검증용.

### 5.4 sidecar record 보강 (rev4)

`suspect-retained` record (rev4):

```json
{
  "state": "suspect-retained",
  "reason": "suspectRetained",
  "binaryPublished": false,
  "packRawValue": null,
  "packValueMm": null,
  "rawValue": 648,
  "valueMm": 64.8
}
```

rev3 이전: `binaryPublished` 없음 또는 `true`로 간주.  
rev4: suspect는 `binaryPublished: false`.

---

## 6. Consumer 영향 분석

### 6.1 지도 carry-forward (production 기본)

| 시나리오 | rev3 | rev4 |
| --- | --- | --- |
| suspect 1분 후 결측 지속 | suspect 값이 seed → **당일 끝까지 carry 가능** | binary missing → **이전 confirmed seed만 carry** |
| STN 739 plateau | rev3 reject로 해결 | 동일 |
| 정상 강수 단계적 증가 (`valid`) | carry 정상 | 동일 |
| 장시간 source missing | 마지막 valid binary seed **무제한 carry** | 동일 (단, seed는 **confirmed binary만**) |

**Producer 책임 (rev4):** suspect·spike island가 binary carry seed가 되지 않도록 보장.  
Consumer **10분 carry 제한**에 의존하지 않음 — 해당 옵션은 진단/비상용.

### 6.2 순위표 · 극값 · 기준판

- 해당 분에 binary missing이면 **그 분 관측으로는 순위 제외** (기존과 동일)
- suspect peak 분이 binary에 없으면 **그 순간 TOP에 안 뜰 수 있음** (합의됨)
- 영덕 STN 277류 극한 suspect는 sidecar·`removedSpans`로 운영 추적

### 6.3 시간재생

- 과거 시각 scrub: 해당 분 binary 기준 (suspect 분은 rev4에서 missing)
- “당시 화면에 suspect가 보였는가”와 pack 재생 결과는 **의도적으로 다를 수 있음** (binary-only 정책)

### 6.4 캐시

`rnDayQcLogicRevision: 3 → 4` bump 시 Consumer IndexedDB / pack cache **재다운로드 필요** (기존 TA·RN rev3 패턴과 동일).

---

## 7. 합의 사항 · 잔여 확인

### 7.1 suspect binary 제외 — **합의 (A)**

`suspect-retained` → pack binary missing, sidecar only.

영덕 STN 277류: TOP/극값 binary 기준 peak 분 제외 가능 — **수용**.  
운영 경고 UI는 sidecar `suspect-retained` + `removedSpans` 활용 (Consumer 자율).

### 7.2 `removedSpans` — **필수 포함**

rev4 구현 시 schema v2 + `removedSpans` **반드시 생성**.

### 7.3 reason 카테고리 표

§5.2 명칭·한글 라벨 수정 요청 있으면 구현 전 알림.

### 7.4 Consumer carry 정책 — **확정**

| 항목 | 값 |
| --- | --- |
| production 기본 | **당일(KST) 내 무제한 carry-forward** |
| `RN_DAY_MAX_CARRY_FORWARD_MINUTES` | 진단/비상 옵션만 (production 기본 **아님**) |
| rev4 producer 역할 | suspect/spike가 **binary carry seed가 되지 않도록** QC |

### 7.5 warm 범위 (합의 제안)

| 단계 | 범위 |
| --- | --- |
| 1차 (사고일) | `20260901` — `RN_DAY,RN_15M,RN_60M,RN_12HR,RN_24HR` `--force` |
| 2차 (회귀) | **최근 14일** 동일 변수 `--force` (consumer rev4 수용 배포 **후**) |

### 7.6 rolling 변수

rev4는 `suspectRetained`를 spike mask에 넣지 않음.  
`RN_15M`/`RN_60M` 원천 spike는 **RN_DAY reject reason mask**로만 대체.  
추가 rolling QC는 별도 요청으로 분리 (**합의**).

---

## 8. 회귀·검증 계획 (Producer)

### 8.1 자동 테스트 (구현 시)

| fixture | 기대 |
| --- | --- |
| STN 739 심원 plateau | rev3와 동일 — binary missing |
| STN 277 영덕 suspect | sidecar `suspect-retained`, **binary missing**, `removedSpans` 존재 |
| `spikeRecovery` | §4.2.1 충족 시만 publish; cross 모순 시 missing |
| extreme + long missing | suspect sidecar 가능, **자동 reject 없음** |
| 정상 다습 plateau (STN 688, 248) | binary 유지, 회귀 없음 |
| counter-regression 연속 | binary missing, rolling hold 유지 |

### 8.2 공동 운영 checklist (rev4 warm 후)

- [ ] `rnDayQcLogicRevision >= 4`
- [ ] sidecar `schemaVersion >= 2`, `removedSpans` 비어 있지 않음 (reject/suspect 있는 날)
- [ ] STN 739 @ 2026-09-01 — rev3와 동일 (08:05~08:12 missing)
- [ ] suspect 관측소 1곳 — binary missing + sidecar `suspect-retained` + `binaryPublished:false` + span 기록
- [ ] 정상 강수 TOP station 회귀 없음
- [ ] Consumer cache rev4 pack 재사용 없음
- [ ] STN 739 당일 max binary 유효값 **4.5mm** 유지, 94mm carry seed **없음** (당일 무제한 carry 전제)

### 8.3 배포

TA rev9 / RN rev3 사례와 동일:

1. 코드 배포
2. **`server.js` + `run_watcher_prod_AWS.sh` / `main_AWS` 재기동**
3. warm (`--force`)
4. manifest `rnDayQcLogicRevision` 확인

---

## 9. 구현 범위

| 항목 | 포함 |
| --- | --- |
| `suspect-retained` → packGrid null | ✅ rev4 core |
| `RN_DAY_QC_LOGIC_REVISION = 4` | ✅ |
| `spikeRecovery` publish guard (§4.2.1) | ✅ |
| manifest 집계·warning | ✅ |
| sidecar `binaryPublished` 필드 | ✅ |
| sidecar `removedSpans` (schema v2, **필수**) | ✅ |
| `aws-rn-qc-consumer-schema.md` 갱신 | ✅ 구현 시 |
| consumer 코드 변경 | ❌ Producer 범위 밖 |

---

## 10. 변경 이력

| 날짜 | 내용 |
| --- | --- |
| 2026-09-01 | 초안 작성 — Consumer 검토 요청 |
| 2026-09-01 | Consumer 검토 반영 — carry 무제한 확정, `removedSpans` 필수, `spikeRecovery` 조건 명시, 합의안으로 승격 |
| 2026-09-01 | Producer 구현 완료 (`kma_fetch/utils/aws_min_pack.js`, `RN_DAY_QC_LOGIC_REVISION=4`) |
