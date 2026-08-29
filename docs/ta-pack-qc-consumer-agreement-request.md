# Consumer 합의 요청: TA pack QC 보강 (contractRevision 9)

작성일: 2026-08-29  
Producer 요구사항: `docs/producer-ta-temperature-qc-request.md`  
Consumer 임시 방어선: `weather-bars-instanced` commit `05e9841`  
대상 consumer: `weather-bars-instanced` (기온 카드·시간재생·일최고/극값·기준 이상 판)

---

## 1. 목적

2026-08-28 방산(STN 587) TA 이상값이 producer pack과 consumer carry-forward 조합으로 화면·극값에 노출됐다.  
Producer는 TA pack QC를 보강하고 **`contractRevision 9`** + **`qcDetailUrl` sidecar**를 추가할 예정이다.

**구현 전에 consumer와 아래 항목을 합의**해야 한다. 특히 “producer가 무엇을 보장하는지”와 “consumer 임시 방어선을 언제·어떻게 제거할지”를 분리해 두어야 한다.

---

## 2. Producer가 바꾸는 것 (합의 전제)

| 항목 | 현재 (rev 8) | 변경 예정 (rev 9) |
| --- | --- | --- |
| `contractRevision` | `8` | **`9`** |
| TA `qcDetailUrl` | 없음 | **있음** (content-addressed, RN sidecar와 동일 publish 패턴) |
| TA QC 규칙 | 1분 \|ΔTA\|>3℃, 고립 스파이크 | 위 + **sparse high** (station/day 유효 샘플 ≤30 & TA≥44℃ → reject) |
| manifest `qc.taTemporal` | 집계만 | `logicRevision`, sparse threshold/count, `sparseHighExcludedSampleCount` 등 |
| `/api/aws/min/exact` | 원천 유지 | **변경 없음** (품질 컬럼 추가는 별도 조사, 있으면 합의) |
| `/api/aws/min/pack` binary layout | Int16 LE, `-32768` missing | **변경 없음** |
| RN_* / WS / HM / TD pack | rev 8 QC | **변경 없음** (TA만) |

Producer warm 후 **같은 날짜 TA pack**은 `datasetId`, `data.url`, `data.sha256`, `qcDetailUrl`이 이전과 달라져야 한다.

---

## 3. Producer가 보장하지 않는 것 (consumer가 알아야 함)

1. **`/exact`는 QC 미적용 원천**  
   방산 587 `TA=447`(44.7℃) 등은 exact 응답에 그대로 남을 수 있다. **일최고·극값·카드는 pack binary 기준**으로만 계산해야 한다.

2. **Producer는 carry-forward 하지 않음**  
   pack에서 `-32768`인 분은 “그 분에 관측 없음”이다. **시간축 보간·마지막 유효값 유지는 consumer 정책** (`docs/aws-producer-1min-pack-requirements.md` §Consumer).

3. **sparse high는 complete day pack 중심**  
   오늘 partial pack(`complete:false`)에는 sparse 규칙 적용 범위를 producer와 별도로 합의해야 한다(§6.1). partial day에서 producer sparse가 약하거나 미적용일 수 있다.

4. **17:16 정상 기온(24.0℃)과 12:15 anchor(44.7℃)는 다른 문제**  
   Producer sparse는 **≥44℃ 샘플** 위주로 reject한다. anchor 제거 후 consumer가 **과거 고온 anchor를 carry-forward**하면 17시대에 여전히 44.7℃가 보일 수 있다(§6.2).

---

## 4. API 계약 — consumer가 확인·합의할 필드

### 4.1 manifest (TA, `GET /api/aws/min/pack?date=YYYYMMDD&variable=TA`)

**필수 확인:**

```json
{
  "schemaVersion": 4,
  "contractRevision": 9,
  "variable": "TA",
  "complete": true,
  "datasetId": "aws-ta-1m-YYYYMMDD-vXXXXXXXX",
  "data": { "url": "/datasets/aws/ta/1m/YYYYMMDD/ta-vXXXXXXXX.i16le", "sha256": "..." },
  "qc": {
    "taTemporal": {
      "enabled": true,
      "logicRevision": 2,
      "maxDeltaDegCPerMinute": 3,
      "spikeNeighborMaxDegC": 1.5,
      "spikeMinDegCDelta": 2.5,
      "sparseHighDegC": 44,
      "sparseMaxValidSamples": 30,
      "excludedSampleCount": 1520,
      "sparseHighExcludedSampleCount": 2
    }
  },
  "qcDetailUrl": "/datasets/aws/ta/1m/YYYYMMDD/qc-v{sha16}.json",
  "qcDetailSha256": "{full-sha256-hex}"
}
```

**합의 필요:**

| # | 질문 | Producer 제안 | Consumer 결정 |
| --- | --- | --- | --- |
| A | `contractRevision >= 9`일 때 TA pack **qcDetailUrl 필수**로 볼 것인가? | complete day TA는 **필수**. fetch 실패 시 §5 fallback | |
| B | `qc.taTemporal.logicRevision` bump만으로 **IndexedDB pack 폐기**할 것인가? | RN `rnDayQcLogicRevision`과 동일하게 **logicRevision + contractRevision** 모두 키에 포함 권장 | |
| C | `qcDetailUrl` 경로 | RN과 동일: **`/datasets/aws/ta/1m/{day}/qc-v{sha16}.json`** (별도 `/datasets/aws/qc/ta/...` 트리 아님) | |

### 4.2 qc detail sidecar (sparse, RN과 유사)

**Top-level (제안):**

```ts
type AwsTaQcDetail = {
  schemaVersion: 1;
  contractRevision: 9;
  datasetId: string; // === manifest.datasetId
  date: string; // YYYYMMDD
  variable: 'TA';
  generatedAt: string;
  scale: 0.1;
  unit: 'degC';
  qcStates: {
    rejectedSampleCount: number;
    sparseHighRejectedSampleCount: number;
    temporalJumpRejectedSampleCount: number;
    isolatedSpikeRejectedSampleCount: number;
    recordCount: number;
  };
  records: AwsTaQcRecord[];
};
```

**Record (reject만 sparse, 정상 sample 생략):**

```ts
type AwsTaQcState =
  | 'rejected'
  | 'sparse-high-rejected'
  | 'temporal-jump-rejected'
  | 'isolated-spike-rejected'
  | 'official-flag-rejected'; // 공식 플래그 도입 시

type AwsTaQcRecord = {
  TM: string;
  STN_ID: number;
  stationName?: string;
  variable: 'TA';
  state: AwsTaQcState;
  rawValue: number; // scaled ×10, reject 전 원값
  valueC: number;   // rawValue * 0.1
  reason: string;   // e.g. sparse-high
  signals: string[]; // e.g. station_valid_samples_lte_30, ta_gte_44c
  stationValidSampleCount?: number;
};
```

**합의 필요:**

| # | 질문 | Producer 제안 |
| --- | --- | --- |
| D | record가 **없는 (TM, STN_ID)** 는? | **valid** 또는 일반 missing(`-32768`) — RN sidecar와 동일 |
| E | qc detail을 **UI 배지/디버그**에만 쓰고, 표시값은 **binary `-32768`만** 신뢰할 것인가? | **권장: binary가 single source of truth**, sidecar는 설명·감사용 |
| F | `qcDetailSha256` 검증 | RN과 동일: **압축 해제 후 UTF-8 bytes** SHA-256. HTTP ETag `"${qcDetailSha256}"` |

참고: RN consumer schema — `docs/aws-rn-qc-consumer-schema.md`

---

## 5. Consumer 동작 — 합의 필요

### 5.1 pack 로드·캐시

| 항목 | 제안 |
| --- | --- |
| 캐시 키 | `(date, variable=TA, contractRevision, taTemporal.logicRevision, datasetId)` 최소 |
| rev 8 TA pack | rev 9 배포 후 **극값/일최고 계산에서 사용 금지** (stale anchor 위험) |
| `cacheburst` | manifest API cache bust용. **rebuild 트리거 아님** (today pack guide와 동일) |
| IndexedDB | `contractRevision < 9` 또는 `logicRevision` 불일치 TA pack **삭제 또는 무시** |

### 5.2 표시·통계에서의 missing

- pack Int16 **`-32768`만 결측**으로 취급한다.
- producer가 reject한 분은 binary에 이미 `-32768`이다. consumer에서 **추가로 44℃ plausibility filter를 pack에 이중 적용**할지 여부를 정한다(§6.3).

### 5.3 carry-forward (현재 버그와 직결)

Producer 수정만으로는 다음이 자동 해결되지 **않을 수 있다.**

- 12:01/12:15 anchor가 pack에서 `-32768`이 되어도  
- consumer가 **“마지막 유효 TA”** 를 시간재생 카드에 유지하면  
- 17:16에 **44.7℃ ghost**가 남을 수 있다.

**합의 필요 (§6.2):** reject/missing 이후 **carry-forward 중단** 또는 **의심 anchor carry 금지** 규칙.

### 5.4 임시 방어선 제거 (`05e9841`)

Producer 배포 **후** 아래를 **모두** 만족하면 consumer 임시 방어( sparse day + TA≥44℃ anchor 제외 )를 **제거 또는 비활성**한다.

- [ ] 운영 TA pack `contractRevision >= 9`
- [ ] `qcDetailUrl` HTTP 200 + SHA 일치
- [ ] 방산 587 / 2026-08-28 재현 케이스 통과(§7)
- [ ] 20260828 TA `--force` warm 및 최근 고온 기간 pack 재생성 완료
- [ ] consumer IndexedDB / memory cache가 새 `datasetId` 사용 확인

**합의 필요:** 방어선을 **feature flag**로 남길지, **완전 삭제**할지.

---

## 6. 미결정 사항 (반드시 답 필요)

### 6.1 오늘 partial pack (`complete:false`)

Producer sparse high는 **complete day**에만 적용하는 방안을 검토 중이다.

| 선택 | consumer 영향 |
| --- | --- |
| **A.** complete day만 sparse | 오늘 TA는 기존 temporal QC만. consumer **오늘은 임시 방어 유지** 가능 |
| **B.** partial에도 동일 threshold | 오늘에도 producer sparse. consumer 방어선 제거 가능 |
| **C.** partial에는 sparse 미적용 | 오늘 극값/카드는 consumer 정책 또는 `/exact` 사용 금지 유지 |

**Consumer 선택:** A / B / C

### 6.2 carry-forward after QC missing

| 선택 | 설명 |
| --- | --- |
| **A.** missing 분은 표시 blank, carry-forward **안 함** |
| **B.** missing 직전 valid만 carry, 단 **≥44℃ anchor는 carry 금지** |
| **C.** 현행 유지 (producer만 수정) |

587 케이스 17시대 ghost 해결에는 **A 또는 B** 필요.

**Consumer 선택:** A / B / C

### 6.3 consumer 물리 plausibility `[-50, 45]℃`

Producer sparse는 **44℃ + sparse day** 조합이다. 44.7℃는 consumer plausibility **통과**한다.

| 선택 | 설명 |
| --- | --- |
| **A.** rev 9 이후 TA pack에 대해 plausibility **제거** (binary만 신뢰) |
| **B.** plausibility **유지** (producer와 이중 방어) |
| **C.** plausibility 상한만 **43℃** 등으로 조정 |

**Consumer 선택:** A / B / C

### 6.4 `/exact` 사용 범위

| 선택 | 설명 |
| --- | --- |
| **A.** 일최고·극값·기준 이상 판은 **pack only** (exact는 디버그/대조만) |
| **B.** exact도 병행 (이중 소스 — **비권장**) |

**Consumer 선택:** A / B

### 6.5 qc detail fetch 실패 시

| 선택 | 설명 |
| --- | --- |
| **A.** binary만 사용, 배지 없음 (RN fallback과 동일) |
| **B.** `contractRevision >= 9`인데 qc fetch 실패면 **해당 일 pack 사용 중단** |
| **C.** 임시 방어선(plausibility)으로 fallback |

**Consumer 선택:** A / B / C

---

## 7. 공동 검증 시나리오 (587 / 2026-08-28)

Producer warm + consumer 배포 후 **양쪽 PASS** 조건.

### 7.1 Producer (API)

```bash
curl -sS "https://weather-map.sbs.co.kr/api/aws/min/pack?date=20260828&variable=TA&cacheburst=ta-rev9"
```

- `contractRevision >= 9`
- `qcDetailUrl` 존재, GET 200, `qcDetailSha256` 일치
- `qc.taTemporal.sparseHighExcludedSampleCount >= 2`
- qc detail에 `STN_ID=587`, `TM=202608281201` `rawValue=450`, `202608281215` `rawValue=447` record

Binary: STN 587 @ 12:01, 12:15 → `-32768`

### 7.2 Consumer (UI)

- 2026-08-28 시간재생 **17시대** 방산 카드: **44.7℃ 표시 없음**
- 2026-08-28 **일 최고기온 TOP10**: 방산 49.3℃ / 44.7℃ / 45.0℃ **없음**
- 기준 이상 판 시도 비컨/순위: 방산 이상 anchor **미선택**
- RN_* pack·단위·range **회귀 없음**

### 7.3 exact (원천 보존 확인, UI 비사용)

```bash
curl -sS "https://weather-map.sbs.co.kr/api/aws/min/exact?timestamp_kor=202608281215"
```

- STN 587 `TA=447` **남아 있어도 OK** (pack과 불일치 가능 — consumer는 pack만 사용해야 함)

---

## 8. 배포 순서 (합의)

| 순서 | 담당 | 작업 |
| --- | --- | --- |
| 1 | Producer | TA QC 구현, `contractRevision 9`, sidecar publish |
| 2 | Producer | `20260828` TA + 최근 14일 TA `--force` warm |
| 3 | Consumer | 캐시 키·carry-forward·pack-only 극값 반영, 방어선 flag |
| 4 | 공동 | §7 검증 |
| 5 | Consumer | `05e9841` 임시 방어 **off** (§5.4 조건 충족 시) |

**합의 필요:** consumer를 producer warm **전**에 배포할지(방어선 유지), **후**에 배포할지.

---

## 9. 회신 형식 (consumer 팀)

아래를 채워 회신해 주시면 producer 구현에 반영한다.

```text
1. §6.1 partial pack: A / B / C
2. §6.2 carry-forward: A / B / C
3. §6.3 plausibility: A / B / C
4. §6.4 exact 범위: A / B
5. §6.5 qc fetch 실패: A / B / C
6. §4 qcDetailUrl complete day 필수: 동의 / 조건부 / 반대
7. §5.4 임시 방어선: 완전 삭제 / feature flag 유지
8. §8 배포 순서: consumer 선배포 / producer warm 후 배포
9. 기타 blocking 이슈:
```

---

## 10. 참고 문서

- Producer 구현 요청: `docs/producer-ta-temperature-qc-request.md`
- RN QC consumer schema (sidecar 패턴): `docs/aws-rn-qc-consumer-schema.md`
- Pack 원칙 (carry-forward는 consumer): `docs/aws-producer-1min-pack-requirements.md`
- API catalog: `skills/weather-api-catalog/references/endpoints.md`
