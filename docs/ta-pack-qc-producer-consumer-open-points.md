# TA pack QC — Producer↔Consumer 잔여 합의 사항

작성일: 2026-08-29  
상태: **종료 — 최종 합의는 `ta-pack-qc-agreement-final.md` 참조**  
기준 문서:
- Producer 요청: `docs/producer-ta-temperature-qc-request.md`
- Consumer 합의 요청: `docs/ta-pack-qc-consumer-agreement-request.md`
- Consumer 회신: `docs/ta-pack-qc-consumer-agreement-response.md`

---

## 1. 이미 합의된 것 (요약)

양쪽 문서 기준 **blocking 없음**으로 정리 가능한 항목이다.

| 항목 | 합의 |
| --- | --- |
| 표시·극값·TOP10·기준판 | **pack binary only** (`-32768` = 결측) |
| `/exact` | 원천 대조·디버그 전용 |
| `qcDetailUrl` | complete day TA(`contractRevision>=9`) **필수**; consumer는 manifest URL 그대로 follow |
| sidecar 역할 | 감사·설명용; **표시값 소스 아님** |
| sparse high 적용 범위 | **complete day pack만** (partial/today는 temporal QC만) |
| sparse reject 단위 | station/day 전체 blank가 아니라 **≥44℃ sample만** `-32768` |
| consumer plausibility | rev 9 이후에도 **유지(B)**; 상한 43℃ 조정은 **양쪽 반대** |
| 임시 방어선 | **feature flag 유지**; rev 9 검증 후 auto/off 가능 |
| 587 핵심 | 12:01/12:15 anchor reject + **carry-forward로 17시 ghost 금지** |
| 공식 QC 플래그 | 조사 결과 manifest `qc.taOfficialFlag` 등으로 **명시** (consumer §8.1) |

Consumer 회신은 Producer 요청 방향과 **전반적으로 정합**하다.  
**2026-08-29 consumer 잔여 회신으로 §2 전 항목 합의 완료.**

---

## 2. 잔여 항목 — consumer 최종 회신 (합의 완료)

| # | 항목 | Consumer 회신 |
| --- | --- | --- |
| 2.1 | 렌더링 carry | **조건부 동의**: 카드·TOP10·극값·기준판·tooltip·label = observationValidity only. bar/색상 = 렌더링 carry 허용. **rejected/sparse-high는 carry seed 금지**. 587 17시 **지도 bar/색상** ghost도 없어야 함 |
| 2.2 | auto 587 판정 | **A+B 동의**: manifest에 revision/threshold 명시, `qcVerified` boolean 없음, 587은 E2E/checklist |
| 2.3 | SHA 불일치 | **guard ON 동의** (fetch 실패와 동일, PT hard stop 없음) |
| 2.4 | rev8 3단계 | **동의** |
| 2.5 | 배포 순서 | **Consumer 선배포 동의** |
| 2.6 | logicRevision 2 | **동의** |
| 2.7 | 이중 방어 | **동의** |
| 2.8 | V3 범위 | 카드·tooltip·TOP·기준판 + **지도 bar/색상** 587 17시 ghost 없음 |

---

## 2 (archive). 추가 합의가 필요했던 항목 (원문 보존)

### 2.1 carry-forward “렌더링 전용” 범위 (중요)

Consumer 회신 §5·§6.2:

- 카드·TOP10·극값·기준판: **carry-forward 금지 (A)**
- 지도 **렌더링 연속성**용 내부 carry는 허용, 단 `observationValidity`와 분리

**열린 질문:** “렌더링 전용 carry”에 다음이 포함되는가?

| UI 요소 | pack `-32768`인 분 | 제안 |
| --- | --- | --- |
| 시간재생 **카드 숫자** | ghost 금지 | ✅ 합의됨 |
| **일최고/TOP10/극값** | ghost 금지 | ✅ 합의됨 |
| 지도 **색상/높이(bar)** | ? | **합의 필요** |
| 지도 **hover/tooltip 기온** | ? | **합의 필요** |
| 지도 **station label** | ? | **합의 필요** |
| **기준 이상/이하 판** 시도 shading | ? | **합의 필요** |

Producer 제안:

- **관측 판정에 쓰이는 모든 UI**는 `observationValidity === true`인 분만 사용한다.
- 렌더ering carry는 **색 보간용 intermediate 값**만 허용하고, 그 값을 **텍스트·숫자·순위·임계판 입력으로 노출하지 않는다.**

Consumer 확인 요청:

```text
[ ] 지도 bar/색상도 observationValidity 없는 분에는 carry 값을 쓰지 않는다 (missing 색/0 높이)
[ ] bar/색상만 carry 허용, 숫자·TOP·카드·tooltip은 observationValidity only
[ ] 기타 (설명):
```

587 검증 §7.2는 “17시대 **카드** 44.7℃ 없음”만 명시되어 있다. **지도 위 방산이 17시에 여전히 고온색**이면 PT 운영자 입장에서 “고온이 남았다”고 볼 수 있으므로, 검증 checklist에 **지도 시각화** 항목 추가 여부도 함께 정한다.

---

### 2.2 feature flag `auto` — “587 검증 통과” 판정 주체

Consumer 회신 §7:

`AWS_TA_CONSUMER_SPARSE_HIGH_GUARD=auto` 조건 예:

- `contractRevision >= 9`
- `qcDetailUrl` 존재
- `qc.taTemporal.logicRevision >= 2`
- **20260828 방산 검증 통과 pack**

**열린 질문:** 마지막 조건은 **consumer 내부 하드코딩/릴리스 노트**인가, **manifest 신호**인가?

| 방식 | 장단점 |
| --- | --- |
| **A. Consumer-only** (날짜·STN smoke test 내장) | producer 계약 변경 불필요; consumer 배포마다 테스트 목록 관리 |
| **B. Manifest hint** (예: `qc.taTemporal.verificationProfile: "rev9-sparse-v1"`) | auto off 조건을 API로 전달; producer warm 후 일관 |
| **C. Ops 수동** (`auto` 없이 on/off만) | 단순; 운영 실수 위험 |

Producer 제안: **A + B 병행**

- producer manifest에 `logicRevision`과 `sparseHighDegC`/`sparseMaxValidSamples`를 명시 (이미 예정)
- “587 통과” 자체는 **consumer E2E 또는 ops checklist**로 두고 manifest에 별도 boolean **`qcVerified` 같은 필드는 넣지 않는다** (운영 거짓 true 방지)

Consumer 확인:

```text
587 검증 통과 판정: A / B / C
```

---

### 2.3 `qcDetailSha256` 불일치 vs fetch 실패

Consumer §3.3: SHA 불일치 시 **hard stop 없이** guard 유지.

합의 요청 §6.5 **C**는 “fetch 실패”만 다룸.

**Producer 제안 (통합 fallback):**

| 상황 | consumer 동작 |
| --- | --- |
| `qcDetailUrl` 404/timeout | binary 사용 + guard ON + warn |
| HTTP 200 but SHA ≠ `qcDetailSha256` | **동일** (sidecar 불신) |
| HTTP 200, SHA OK, records sparse | binary only; sidecar는 디버그 |

Consumer 동의 여부:

```text
[ ] SHA 불일치 = fetch 실패와 동일 fallback (guard ON, PT 계속)
[ ] SHA 불일치 = 해당 일 pack 전체 폐기 (비권장)
```

---

### 2.4 rev 8 TA pack 사용 기간

| 문서 |表述 |
| --- | --- |
| 합의 요청 §5.1 | rev 9 배포 후 rev 8 **극값 계산 금지** |
| Consumer §4.2 | rev 9 + 검증 통과 **전까지** rev 8 + guard 유지 |

**Producer 수용 제안:**

- rev 9 producer warm **이전**: rev 8 + consumer guard → **허용**
- rev 9 warm **이후**: `contractRevision>=9` pack이 있으면 **극값/TOP/기준판은 rev 9만**
- rev 9 warm 됐지만 `datasetId` stale / qcDetail 없음: guard ON, rev 8 **재사용 금지**

Consumer 확인:

```text
[ ] 위 3단계 정책 동의
[ ] 수정 필요 (설명):
```

---

### 2.5 배포 순서

| | Producer 요청 §8 | Consumer §9 |
| --- | --- | --- |
| 순서 | Producer 구현 → warm → consumer | **Consumer 선배포** → producer → warm |

**Producer 수용 조건 (consumer 선배포 OK):**

1. consumer 선배포에 **carry-forward 분리 + guard auto/on** 포함
2. producer rev 9 warm 전에도 rev 8 환경에서 ghost **완화**되는지 consumer 측에서 확인
3. rev 9 warm 직후 consumer가 **`datasetId` 변경**으로 새 binary를 받는지 E2E 확인

합의 문구:

```text
배포 순서: Consumer 선배포 (guard on) → Producer rev9 → warm → 공동 검증 → guard auto/off
```

양측 서명:

- Producer: [ ]
- Consumer: [ ]

---

### 2.6 `logicRevision` 초기값과 bump 정책

Consumer auto off 조건: `logicRevision >= 2`.

**Producer 확약 (구현 시):**

| 이벤트 | `contractRevision` | `qc.taTemporal.logicRevision` |
| --- | --- | --- |
| rev 8 (현재) | 8 | 없음 또는 1 |
| rev 9 + sparse high 최초 | **9** | **2** |
| sparse threshold/env만 변경 | 9 유지 | **+1 bump** |
| sidecar schema breaking | 9 또는 10 | bump |

Consumer 확인:

```text
[ ] logicRevision=2를 rev9 sparse 출시 baseline으로 동의
[ ] env threshold 변경 시 logicRevision bump 동의 (cache invalidate)
```

---

### 2.7 이중 방어(plausibility + producer sparse) 기대치

Consumer **B**: plausibility `[-50, 45]` 유지.

Producer sparse: **sparse day & valid≤30** 일 때 **≥44℃** reject.

**영향:**

- 44.7℃ / 45.0℃ (587): producer sparse + consumer plausibility(45 통과) → **producer가 주 defense**
- 47~49℃: producer sparse + consumer plausibility(>45 reject) → **양쪽에서 제거**

**합의:** rev 9 이후 consumer guard **auto off**여도 plausibility는 **항상 on** (consumer B). producer sparse는 complete day **추가** QC.

추가 확인 — **complete day + valid>30 + TA=44.5℃** 실관측:

- producer: **유지**
- consumer plausibility: **유지**
- consumer guard auto off: **표시 OK**

→ 실제 폭염 complete day station은 **의도적으로 표시** (양쪽 OK).

---

### 2.8 검증 checklist 보강 (공동)

Consumer §8.4: UI “값 없음”까지 검증.

Producer가 §7에 **추가 제안**하는 항목:

| # | 검증 |
| --- | --- |
| V1 | pack binary 587 @ 12:01, 12:15 → `-32768` |
| V2 | qc detail record 587 @ 12:01, 12:15 `state=sparse-high-rejected` (또는 동등) |
| V3 | 17:16 카드 **및 tooltip** 44.7℃ 없음 |
| V4 | TOP10 / 극값 API·UI에 587 44.7/45.0/49℃대 없음 |
| V5 | exact @ 12:15 TA=447 **유지 가능** (pack과 불일치 OK) |
| V6 | RN_DAY pack 회귀 없음 |

Consumer §2.1 지도 carry 정책 확정 후 V3 범위 조정.

---

## 3. Producer 구현에 반영할 consumer 요청 (확인만)

아래는 **이견 없이 반영 예정**이나, consumer가 문구/필드명만 확인하면 된다.

### 3.1 `qc.taOfficialFlag` manifest 블록

```json
{
  "qc": {
    "taOfficialFlag": {
      "available": false,
      "source": "none",
      "checkedColumns": ["TA_QC", "TA_QA", "TA_FLAG", "QC_FLAG", "QC", "ERR", "STATUS", "GRADE"],
      "checkedHubFields": [],
      "note": "DB wx_AWS_MIN / API Hub nph-aws2_min — 조사일 2026-08-29"
    }
  }
}
```

공식 플래그 발견 시 `available: true`, `sourceColumn`, `excludedSampleCount` 추가.

### 3.2 complete day TA — `qcDetailUrl` 필수

`complete === true && variable === TA && contractRevision >= 9` → publish 실패 if sidecar missing (RN_DAY와 동일 atomic publish).

### 3.3 partial / today TA

`complete === false` → sparse high **미적용** (consumer §6.1 **A**).

---

## 4. 회신 템플릿 (Consumer / Producer)

```text
=== TA QC 잔여 합의 회신 ===

2.1 렌더링 carry 범위: ( bar만 / tooltip 포함 전부 observationValidity / 기타 )
2.2 auto flag 587 판정: A / B / C
2.3 SHA 불일치 fallback: guard ON 동의 / 기타
2.4 rev8 사용 3단계: 동의 / 수정
2.5 배포 순서: Consumer 선배포 동의 / Producer 선warm 동의
2.6 logicRevision baseline 2: 동의 / 수정
2.7 이중 방어 기대치: 동의 / 코멘트
2.8 검증 V3 범위 (tooltip/지도): ...

기타 blocking:
```

---

## 5. 다음 단계 (합의 후)

1. ~~Consumer §2 회신~~ ✅
2. Producer rev 9 구현 (`producer-ta-temperature-qc-request.md` + 본 합의)
3. Consumer carry seed 규칙 선배포 (이미 진행 중이면 병행)
4. Producer `20260828` TA warm
5. `ta-pack-qc-agreement-final.md` §5 공동 검증 → guard auto/off

---

## 6. 참고

- RN sidecar 패턴: `docs/aws-rn-qc-consumer-schema.md`
- Pack carry-forward 원칙: `docs/aws-producer-1min-pack-requirements.md` (consumer 정책)
