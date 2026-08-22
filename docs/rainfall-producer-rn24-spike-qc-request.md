# Producer 수정 요청: RN_DAY 급상승 QC와 RN_24HR 오염 방지

이 문서 전체를 producer 구현 AI Agent에 전달한다.

## 1. 목표

두 가지 연관 오류를 함께 수정한다.

1. `RN_DAY`의 비정상적인 양의 급상승이 정상값으로 승인되어 `RN_24HR`까지 오염되는 문제
2. 급상승으로 오염된 값이 `last accepted`가 된 뒤, 정상 복귀값을 counter regression으로 오판하여 오염 상태를 장시간 유지하는 문제

단순 상한이나 단일 분당 임계값으로 정상 집중호우를 제거해서는 안 된다. 시간 변화, 결측 상태, 다른 강수 누적 변수와의 일관성을 함께 사용한다.

---

## 2. 확인된 오류 A: 동래의 연속 급상승

대상:

- 날짜: `2026-08-21`
- STN_ID: `940`
- 관측소: 부산광역시 동래구 동래
- RN_DAY dataset: `aws-rn_day-1m-20260821-v7bbba744`
- RN_24HR dataset: `aws-rn_24hr_rolling-1m-20260821-v989d2432`

확인된 RN_DAY:

| 시각 | RN_DAY | 직전 대비 |
|---|---:|---:|
| 09:23 | 0.0mm | - |
| 09:24 | 101.5mm | +101.5mm |
| 09:25 | 221.5mm | +120.0mm |
| 09:26 | 341.5mm | +120.0mm |
| 09:27 | 461.5mm | +120.0mm |
| 09:28 이후 | 장시간 missing | - |

교차 확인:

- RN_15M: 09:23 `0.0`, 09:24 `101.5`, 이후 missing
- RN_60M: 09:23 `0.0`, 09:24 `101.5`, 09:25 `221.5`, 이후 missing
- 비정상값 `461.5mm`가 RN_24HR 기간 최고·평균·카드 그래프에 전파됨
- 현재 시각이 missing일 때 지도와 순위에서는 사라지지만 기간 통계에는 비정상 최고값이 남음

추가 의심 사례:

- 날짜: `2026-08-21`
- STN_ID: `277`
- 관측소: 경상북도 영덕군 영덕
- RN_DAY: 14:13 `0.4mm` → 14:14 `64.8mm`
- 증가량: `+64.4mm/min`
- 같은 시각 RN_15M은 missing
- 14:15 RN_60M은 `18.9mm`

영덕 사례도 원천 JSON과 교차변수를 확인하여 판정 결과를 보고한다.

---

## 3. 확인된 오류 B: 북강릉 last-accepted 증폭

대상:

- 원천 날짜: `2026-08-20`
- 파생 오류 날짜: `2026-08-21`
- STN_ID: `104`
- 관측소: 강원특별자치도 강릉시 북강릉

2026-08-20 원천 상태:

| 시각 | 상태 |
|---|---|
| 11:48~11:52 | missing |
| 11:53 | RN_DAY/RN_15M/RN_60M/RN_12HR 모두 31.0mm |
| 11:54 | missing |
| 11:55 이후 | 단기 누적값 0.0mm, RN_DAY는 31.0mm가 마지막 accepted로 남음 |

이후 발생한 현상:

1. 단발성 `31.0mm`가 정상 accepted 값이 됨
2. 뒤따르는 `0.0mm`를 counter regression으로 처리함
3. 오염된 `31.0mm`를 last accepted로 계속 사용함
4. 2026-08-21 RN_24HR이 장시간 `31.0mm` plateau를 보임
5. 전일 동일 시각인 11:53이 rolling window에서 빠질 때 `31.0 → 0.0mm`로 급락함

이는 upward spike QC와 counter-regression 처리 순서가 잘못 결합될 때 오류가 하루 이상 증폭될 수 있음을 보여준다.

---

## 4. 정상 비교 사례: 과잉 필터링 금지

장시간 일정한 RN_24HR 값은 그 자체로 오류가 아니다. 새 강수가 window에 들어오지 않고 24시간 전 강수도 빠져나가지 않으면 rolling 합계는 일정하다.

### 담양군 봉산, STN 688

- 2026-08-20 최종 RN_DAY: `54.0mm`
- 2026-08-21 당일 추가 강수: `0.5mm`
- RN_24HR: 02:27~16:52 `54.5mm` 유지
- 전날 17:21 이후 강수가 24시간 window 밖으로 빠지면서 당일 17:21부터 감소
- 이후 당일 강수 `0.5mm`만 유지
- 정상 rolling 사례로 보존해야 함

### 장수, STN 248

- 2026-08-20 최종 RN_DAY: `34.4mm`
- 2026-08-21 15:30 전까지 새 강수가 없어 `34.4mm` 유지
- 당일 강수로 최고 `38.4mm`
- 전날 19:24경 강수가 window 밖으로 빠지면서 당일 19:24부터 감소
- 이후 당일 강수 `4.0mm` 유지
- 정상 rolling 사례로 보존해야 함

기본 계산 관계:

```text
RN_24HR(D, t)
= RN_DAY(D, t)
+ RN_DAY(D-1, end)
- RN_DAY(D-1, t)
```

유효한 원천값에 대해서는 위 관계가 유지되어야 한다.

---

## 5. 구현 요구사항

### 5.1 upward spike QC를 counter regression 보정보다 먼저 수행

같은 관측소의 시간상 연속된 유효 RN_DAY 값에 대해 계산한다.

```text
elapsedMinutes = currentTM - previousAcceptedTM
increase = currentRnDay - previousAcceptedRnDay
ratePerMinute = increase / elapsedMinutes
```

판정 상태를 최소한 다음처럼 구분한다.

- 정상 증가
- source missing
- counter regression
- upward spike candidate
- upward spike rejected
- spike 이후 정상 복구

처리 순서는 다음 원칙을 지켜야 한다.

1. 원천값 유효성 검사
2. upward spike 후보 판정과 교차검증
3. 정상 accepted 상태 갱신 여부 결정
4. 그 이후 counter regression 처리
5. RN_24HR 파생 계산

spike candidate를 먼저 accepted로 저장한 뒤 후속 정상값을 regression으로 처리하면 안 된다.

### 5.2 단일 고정 상한만 사용하지 말 것

`RN_DAY > N` 또는 `increase > N` 하나만으로 제거하지 않는다.

가능하면 다음을 함께 확인한다.

- 실제 경과시간
- RN_15M
- RN_60M
- RN_12HR
- 동일 관측소 직전·직후 RN_DAY
- 원천 JSON의 같은 TM/STN 행
- 급상승 직후 연속 결측 또는 정상 범위 복귀 여부

교차변수 missing만으로 RN_DAY를 이상 처리해서는 안 된다. 시간 변화율 및 시계열 형태와 결합한다.

### 5.3 연속 오염 구간 처리

동래 사례처럼 다음 값이 연속될 수 있다.

```text
0 → 101.5 → 221.5 → 341.5 → 461.5 → missing
```

- 최초 급상승만 제거하고 후속 값을 정상값으로 승인하면 안 됨
- spike candidate는 `last accepted RN_DAY`를 갱신하지 않음
- 후속 값도 마지막 정상 accepted 값과 비교함
- spike 값은 0으로 clamp하지 않음
- 미래 정상값으로 back-fill하지 않음

### 5.4 오염 이후 복구 규칙

오염 구간 이후 값이 나타났다고 즉시 정상 상태로 복귀시키지 않는다. 다음과 같은 보수적인 복구 규칙을 설계한다.

- 날짜 경계에서 정상 reset 확인
- 충분한 수의 연속 정상 샘플 확인
- 단기 누적 변수와 증가량 일치 확인
- 직전의 비정상 peak를 기준으로 후속 정상값을 regression 처리하지 않음

정확한 복구 조건과 근거를 완료 보고에 포함한다.

### 5.5 RN_24HR 오염 전파 차단

- upward spike rejected 값은 RN_24HR 계산에 사용하지 않음
- rejected 값을 last accepted로 저장하지 않음
- rejected 값을 기준으로 후속 counter regression fill을 수행하지 않음
- 동래 `461.5mm`가 RN_24HR에 남지 않아야 함
- 북강릉의 `31mm` 장기 plateau와 `31 → 0mm` 급락이 사라져야 함
- 정상인 담양 봉산과 장수의 plateau 및 rolling 감소는 유지해야 함

---

## 6. QC 및 warning 계약

원천 결측, 감소, 상승 이상을 별도로 집계한다.

권장 필드:

```json
{
  "rnDayQc": {
    "sourceMissingSampleCount": 0,
    "counterRegressionSampleCount": 0,
    "counterRegressionFilledSampleCount": 0,
    "upwardSpikeCandidateSampleCount": 0,
    "upwardSpikeRejectedSampleCount": 0,
    "upwardSpikeStationCount": 0,
    "spikeRecoverySampleCount": 0
  },
  "rolling24h": {
    "sourceMissingSampleCount": 0,
    "counterRegressionFilledSampleCount": 0,
    "upwardSpikeRejectedSampleCount": 0,
    "upwardSpikeContaminationPreventedSampleCount": 0
  }
}
```

상세 QC에는 가능한 범위에서 다음 정보를 남긴다.

- STN_ID 및 관측소명
- TM
- 이전 정상 accepted TM과 값
- 현재 원천값
- 증가량과 실제 경과시간
- 분당 환산 증가량
- RN_15M/RN_60M/RN_12HR 교차검증값
- 판정 사유와 rejected 여부
- 복구 시각과 복구 사유

manifest가 커지면 count와 일부 sample만 manifest에 포함하고 전체 상세는 별도 QC JSON 또는 build log로 남긴다.

---

## 7. contract 및 cache

이번 변경은 binary 의미를 변경하므로 다음을 수행한다.

1. `contractRevision` 증가
2. RN_DAY 및 RN_24HR datasetId 갱신
3. binary SHA 갱신
4. immutable cache가 이전 binary를 재사용하지 않도록 revision-aware URL 또는 신규 asset URL 사용
5. force rebuild 및 warm cache key에 contract revision 포함

---

## 8. 필수 회귀 테스트

### A. 동래 STN 940 fixture

```text
09:23  RN_DAY=0.0
09:24  RN_DAY=101.5
09:25  RN_DAY=221.5
09:26  RN_DAY=341.5
09:27  RN_DAY=461.5
09:28  missing
```

기대 결과:

- 09:24~09:27 오염 구간 검출
- spike가 last accepted를 갱신하지 않음
- RN_DAY pack에서 invalid/missing으로 표현
- RN_24HR에 461.5mm가 나타나지 않음
- QC count와 warning 기록

### B. 북강릉 STN 104 fixture

```text
11:48~11:52  missing
11:53        RN_DAY=31.0
11:54        missing
11:55 이후   정상 단기 누적=0.0
```

기대 결과:

- 31.0mm 단발 spike가 last accepted를 오염시키지 않음
- 후속 0.0mm를 오염 peak 기준 regression으로 처리하지 않음
- 2026-08-21 RN_24HR의 장기 31mm plateau 제거
- 11:53의 31→0mm 급락 제거

### C. 영덕 STN 277 실제 사례

- 14:13 `0.4mm` → 14:14 `64.8mm`
- RN_15M missing, 14:15 RN_60M `18.9mm`
- 원천 JSON까지 대조하고 최종 판정 결과 보고

### D. 정상 담양 봉산 STN 688

- 장시간 54.5mm plateau 유지
- 전일 강수가 window 밖으로 빠지는 시각부터 정상 감소 유지

### E. 정상 장수 STN 248

- 34.4mm plateau, 당일 강수 유입, 전일 강수 이탈에 따른 변화 유지

### F. 기타 계약

- 실제 집중호우를 오탐하지 않음
- 결측 간격이 있으면 실제 경과시간 반영
- 기존 counter regression 계약 유지
- source missing을 upward spike로 집계하지 않음
- KST 00:00 RN_DAY reset 유지
- RN_24HR은 자정에 reset되지 않음

---

## 9. 재생성 및 검증 범위

우선 다음 pack을 강제 재생성한다.

```text
2026-08-20 RN_DAY
2026-08-21 RN_DAY
2026-08-21 RN_24HR
```

RN_24HR은 전일 dependency를 사용하므로 8월 20일과 21일을 함께 처리한다. 검증 통과 후 전체 운영 범위를 재생성한다.

cache-burst query로 다음 API를 확인한다.

```text
GET /api/aws/min/pack?date=20260820&variable=RN_DAY
GET /api/aws/min/pack?date=20260821&variable=RN_DAY
GET /api/aws/min/pack?date=20260821&variable=RN_24HR
```

확인 항목:

- contractRevision
- datasetId
- generatedAt
- data.url
- SHA-256
- QC count 및 warnings
- STN 940, 104, 277 수정 전후 시계열
- STN 688, 248 정상 시계열 유지
- 8월 21일 RN_DAY/RN_24HR 전체 최대값과 TOP 20

---

## 10. 완료 보고 형식

다음 내용을 보고한다.

1. 실제 원인
2. upward spike 판정 규칙과 처리 순서
3. 임계값을 사용했다면 값과 근거
4. 교차변수 검증 방식
5. 오염 이후 복구 규칙
6. RN_24HR 전파 차단 방식
7. 추가·변경된 QC 필드
8. contractRevision과 cache 무효화 방식
9. 재생성한 날짜와 변수
10. STN 940·104·277 수정 전후 시계열
11. STN 688·248 정상 사례 유지 결과
12. 전체 테스트 결과
13. 전체 과거 pack 재생성이 필요한지 여부
