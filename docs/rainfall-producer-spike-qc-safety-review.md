# Producer 재수정 요청: 강수 급상승 QC 오탐 방지

이 문서 전체를 producer 구현 AI Agent에 전달한다.

## 1. 요청 배경

RN_DAY 급상승 QC 및 RN_24HR 오염 방지 구현 결과를 검토한 결과, 현재 자동 reject 규칙이 실제 극한강수를 삭제할 가능성이 있다.

현재 구현된 주요 규칙:

| 규칙 | 현재 동작 |
|---|---|
| hard rate | `>= 20.0mm/min` 즉시 reject |
| soft rate/jump | `>= 5.0mm/min` 또는 `>= 10.0mm`이면 RN_15M/RN_60M 교차검증 |
| multi-field equal | `RN_DAY = RN_15M = RN_60M`, 값 `>= 5mm`이면 reject |
| 당일 첫 샘플 | 절대값을 1분 rate로 보지 않지만 multi-equal은 검사 |
| 복구 | accepted가 있으면 연속 2샘플, 없으면 첫 비-spike에서 복구 |
| rejected | RN_DAY pack은 missing, RN_24HR은 last accepted 또는 null 사용 |

이 중 `20mm/min 즉시 reject`와 `multi-field equal 즉시 reject`는 안전하지 않으므로 전체 warm 전에 수정한다.

---

## 2. 20mm/min은 물리적으로 불가능한 값이 아님

WMO 세계 1분 최대 강수량 기록은 `31.2mm/min`이다.

- 위치: Unionville, Maryland, USA
- 날짜: 1956-07-04
- 값: 31.2mm/1min
- 출처: WMO Records of Weather and Climate Extremes

참고:

- https://wmo.int/sites/default/files/2024-01/Table_Extreme_Records_30Jan2024.pdf

따라서 `20mm/min`은 매우 이례적인 값이지만 물리적으로 불가능한 값이나 일반적인 계기 측정 한계가 아니다.

WMO의 강우강도계 비교 자료는 전도형 강수량계가 고강도 강수에서 과소 측정될 수 있으며, 기기별 측정범위·불확도·동적 보정·품질정보를 함께 다뤄야 한다고 권고한다. 이 자료도 `20mm/min`을 일괄 invalid 처리할 근거를 제공하지 않는다.

- https://extranet.wmo.int/edistrib_exped/grp_prs/_en/2011_2022_Archives/2013/2013_08/2013-08-20-PR-6716-OBS-IMO-Intercomparison_en.pdf

기상청 AWS 자료가 1분 주기와 0.1 또는 0.2mm 단위를 사용한다는 사실도 `20mm/min`을 유효성 상한으로 만들지 않는다.

결론:

```text
rate >= 20mm/min
```

은 hard reject가 아니라 `extreme-suspect` 후보 조건으로 사용한다.

기상청 또는 실제 설치 우량계 제조사의 공식 측정 가능 범위가 별도로 확인된다면 그 명세를 보고하고 계기별 hard limit을 설계할 수 있다. 명세 확인 전에는 일반 hard limit으로 사용하지 않는다.

---

## 3. multi-field equality는 오류 근거가 아님

다음 조건은 정상 강수에서도 자연스럽게 성립할 수 있다.

```text
RN_DAY = RN_15M = RN_60M >= 5mm
```

예를 들어 자정 이후 비가 없다가 최근 10분 동안 8mm가 내렸다면 다음은 정상이다.

```text
RN_DAY = 8mm
RN_15M = 8mm
RN_60M = 8mm
```

당일 첫 강수이거나 당일 강수가 모두 최근 15분 안에 내렸다면 equality는 정상적인 수학 관계다.

따라서 다음 규칙을 제거한다.

```text
RN_DAY = RN_15M = RN_60M >= 5mm
→ 즉시 reject
```

당일 첫 샘플에도 multi-field equality 단독 reject를 적용하지 않는다.

multi-field equality는 다른 강한 이상 신호와 결합할 때만 낮은 가중치의 참고 특징으로 사용할 수 있다.

---

## 4. 요구하는 판정 상태

최소한 다음 네 상태를 구분한다.

```text
valid
suspect-retained
rejected
missing
```

### valid

- 정상 관측
- pack에 원래 값 기록
- accepted 상태 갱신

### suspect-retained

- 극단적이지만 오류라는 증거가 부족함
- pack에는 원래 값을 보존
- QC flag와 warning 기록
- 방송 consumer가 필요하면 상태를 확인할 수 있도록 metadata 또는 별도 QC 자료 제공

### rejected

- 복수의 독립적인 이상 증거로 오류 확신도가 높음
- pack에는 missing sentinel
- accepted 상태 미갱신
- 상세 QC 기록

### missing

- 원천 자료가 없음
- suspect/rejected와 별도로 집계

---

## 5. 수정된 판정 원칙

### 5.1 후보 탐지

다음 임계값은 후보 탐지용으로 유지할 수 있다.

```text
soft candidate:
  rate >= 5mm/min OR jump >= 10mm

extreme candidate:
  rate >= 20mm/min
```

하지만 임계값 초과만으로 reject하지 않는다.

### 5.2 최종 reject

최종 reject에는 적어도 두 가지 이상의 독립적인 이상 신호를 요구한다.

검토 가능한 신호 예시:

1. 비정상적으로 큰 분당 증가
2. 동일하거나 유사한 큰 증가량이 기계적으로 반복됨
3. 급상승 직후 장시간 source missing
4. 급상승 직후 누적값이 즉시 이전 정상 범위로 reset됨
5. RN_15M/RN_60M/RN_12HR의 시간적 관계가 모순됨
6. 같은 TM의 원천 필드들이 파싱 또는 전송 오류를 시사하는 패턴을 보임
7. 인접 관측소 또는 레이더 자료와 현저히 불일치함
8. 해당 관측기기의 공식 측정 가능 범위를 초과함

단, 다음은 독립적인 이상 증거로 단독 사용하지 않는다.

- 교차변수 missing
- RN_DAY/RN_15M/RN_60M equality
- 하루 중 첫 유효 샘플의 큰 절대값
- 세계 기록보다 크다는 사실만으로 구성한 물리적 불가능 판정

### 5.3 고신뢰 오류 예시

동래 STN 940:

```text
0.0 → 101.5 → 221.5 → 341.5 → 461.5 → 장시간 missing
```

이 사례에는 다음 복수 신호가 있다.

- 극단적인 분당 증가
- 약 `+120mm`가 기계적으로 반복
- 직후 장시간 결측
- 장기 누적 통계까지 비정상적으로 오염

따라서 고신뢰 reject가 가능하다.

### 5.4 북강릉 사례

북강릉 STN 104:

```text
장시간 missing
→ 한 시각 RN_DAY/RN_15M/RN_60M/RN_12HR = 31mm
→ 다시 missing
→ 단기 누적 0mm
→ 오염된 31mm가 last accepted로 유지
```

북강릉은 equality 하나 때문에 reject하는 것이 아니다. 결측 사이의 단발성 동시 peak, 즉시 정상 범위 복귀, 이후 오염된 last-accepted 유지라는 전체 시계열 패턴으로 판정한다.

### 5.5 영덕 사례

영덕 STN 277:

```text
RN_DAY 0.4 → 64.8mm
RN_15M missing
후속 RN_60M 18.9mm
```

이 사례는 자동 reject하지 말고 원천 JSON, 후속 시계열, 인접 관측소 또는 가능한 보조자료까지 확인해 `suspect-retained`와 `rejected` 중 어느 쪽인지 근거를 보고한다.

---

## 6. accepted와 복구 규칙 재검토

### 6.1 suspect-retained

원래 값을 pack에 보존하되, accepted baseline을 갱신할지는 별도 정책으로 정한다.

권장:

- 극단 후보 1샘플만으로 baseline을 영구 변경하지 않음
- 후속 정상 시계열로 확인되면 정상 accepted로 승격
- 오류 패턴이 확인되면 rejected로 확정

offline pack 생성은 미래 샘플을 확인할 수 있으므로 단방향 실시간 판정보다 전체 시계열 기반 판정이 가능하다.

### 6.2 rejected 이후 복구

연속 2샘플 규칙은 보조 조건으로 사용할 수 있지만 단독으로 충분하지 않다.

복구 시 확인:

- rejected peak가 아닌 마지막 정상 baseline과 비교
- 정상 누적 관계 회복
- 단기 누적 변수와 시계열적으로 일치
- 날짜 경계의 정상 reset
- source missing과 QC reject를 구분

### 6.3 RN_24HR의 last accepted 사용

rejected 시각에 RN_24HR이 무조건 last accepted를 사용하는 정책도 재검토한다.

주의점:

- stale 값을 정상 관측처럼 표시할 수 있음
- 오염값이 accepted에 들어갔다면 RN_24HR 전체를 오염시킴
- 원천 결측과 QC 보정값의 의미가 달라짐

최소 요구사항:

- rejected spike는 절대 last accepted를 갱신하지 않음
- 원천 missing과 QC rejected를 별도 집계
- RN_24HR이 last accepted를 사용한 sample 수와 원인을 manifest에 기록
- 가능하면 원시 관측값과 보정 사용 여부를 consumer가 구분할 수 있도록 함
- 확신할 수 없는 경우 값을 만들어 유지하기보다 missing을 우선 고려

---

## 7. 필수 테스트

### A. 정상 극한강수 보존

다음 fixture를 추가한다.

```text
직전 RN_DAY = 0mm
현재 RN_DAY = 21mm
RN_15M = 21mm
RN_60M = 21mm
후속 RN_DAY = 22mm, 23mm, 24mm
후속 단기 누적도 일관됨
```

기대:

- `20mm/min` 초과만으로 reject하지 않음
- 최소 `suspect-retained`
- 후속 일관성 확인 후 valid로 승격 가능

### B. 정상 multi-field equality

```text
자정 이후 무강수
최근 10분 강수 = 8mm
RN_DAY = RN_15M = RN_60M = 8mm
```

기대:

- 정상값 유지
- equality만으로 suspect 또는 rejected 처리하지 않음

### C. 동래 STN 940

- 반복되는 `+120mm`와 후속 장시간 missing을 포함
- 고신뢰 reject
- RN_24HR에 461.5mm가 남지 않음

### D. 북강릉 STN 104

- equality 자체가 아니라 전체 시계열 패턴으로 reject
- 오염된 31mm가 last accepted가 되지 않음
- 다음 날 RN_24HR의 31mm plateau와 급락 제거

### E. 영덕 STN 277

- 자동 hard reject 여부를 재평가
- 최종 상태와 근거를 테스트 및 완료 보고에 포함

### F. 정상 rolling 사례

- 담양 봉산 STN 688의 54.5mm plateau와 정상 감소 유지
- 장수 STN 248의 34.4mm plateau, 당일 유입 및 전일 이탈 형태 유지

---

## 8. QC 필드

다음과 같이 후보·보존·거부를 분리한다.

```json
{
  "rnDayQc": {
    "extremeCandidateSampleCount": 0,
    "suspectRetainedSampleCount": 0,
    "upwardSpikeRejectedSampleCount": 0,
    "upwardSpikeRejectedStationCount": 0,
    "sourceMissingSampleCount": 0,
    "counterRegressionSampleCount": 0,
    "recoverySampleCount": 0
  },
  "rolling24h": {
    "qcRejectedSourceSampleCount": 0,
    "lastAcceptedSubstitutionSampleCount": 0,
    "sourceMissingSampleCount": 0
  }
}
```

상세 QC에는 다음을 남긴다.

- STN_ID, 관측소명, TM
- 원천값과 이전 정상 accepted 값
- elapsedMinutes, jump, rate
- 교차변수 값
- 적용된 독립 이상 신호 목록
- 최종 상태: valid/suspect-retained/rejected/missing
- accepted 갱신 여부
- RN_24HR 대체값 사용 여부

---

## 9. 수행 순서

1. `>=20mm/min 즉시 reject` 제거
2. `multi-field equality 즉시 reject` 제거
3. 후보와 최종 판정 상태 분리
4. 복수 독립 신호 기반 reject 구현
5. accepted 및 복구 순서 수정
6. 위 fixture 단위 테스트 추가
7. 2026-08-20 RN_DAY 재생성
8. 2026-08-21 RN_DAY/RN_24HR 재생성
9. STN 940/104/277과 정상 비교 STN 688/248 검증
10. 검증 결과 보고 후 전체 warm 수행

전체 warm은 위 안전성 수정과 테스트를 통과한 뒤 진행한다.

---

## 10. 완료 보고 요청

다음을 보고한다.

1. 변경된 후보 및 reject 규칙
2. `20mm/min`의 새 의미
3. multi-field equality 단독 reject 제거 여부
4. suspect-retained 저장 방식
5. 복수 독립 신호 조합 방식
6. accepted와 복구 상태 머신
7. RN_24HR last-accepted 사용 정책
8. STN 940/104/277 판정 결과와 근거
9. 정상 극한강수 및 equality fixture 결과
10. STN 688/248 정상 rolling 보존 결과
11. QC manifest 예시
12. contractRevision 및 cache 무효화 방식
13. 재생성 범위와 전체 테스트 결과
