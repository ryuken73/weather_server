# AWS 강수 QC 보완 요청 — 관측소 574 대신 반복 spike

## 목적

오늘 `RN_DAY` 관측 화면에서 경기도 여주시 대신 관측소가 `0mm → 24.5mm → 0mm`로 반복 변화하는 문제가 확인됐다.

Consumer 렌더링 문제가 아니라 pack binary와 원본 계열 응답에 포함된 반복 spike이며, Producer QC가 이를 감지했지만 `suspect-retained`로 pack에 보존하고 있다.

반복되는 isolated peak를 최종 reject하고 오늘 pack을 소급 갱신하도록 QC를 보완한다.

## 대상

```text
date: 20260823
STN_ID: 574
stationName: 대신
LAW_ADDR_SIDO: 경기도
LAW_ADDR_GUGUN: 여주시
LAT: 37.3694
LON: 127.58711
```

## 확인된 이상 패턴

`RN_DAY` pack에서 다음 변화가 확인됐다.

| 시각 | 직전 값 | 해당 시각 | 다음 시각 |
| --- | ---: | ---: | ---: |
| 10:51 | 0mm | 24.5mm | 0mm |
| 10:56 | 0mm | 24.5mm | 0mm |
| 11:33 | 0mm | 24.5mm | 0mm |
| 14:49 | 0mm | 24.5mm | 다음 샘플로 복귀 여부 확인 필요 |

Pack에서 직접 확인한 변화:

```text
202608230000  RN_DAY=0.0
202608231051  RN_DAY=24.5
202608231052  RN_DAY=0.0
202608231056  RN_DAY=24.5
202608231057  RN_DAY=0.0
202608231133  RN_DAY=24.5
202608231134  RN_DAY=0.0
202608231449  RN_DAY=24.5
```

## 변수 간 교차 확인

10:51, 10:56, 11:33 spike 시점에 다음 필드가 모두 동일하게 `24.5mm`로 변했다.

- `RN_15M`
- `RN_60M`
- `RN_12HR`
- `RN_DAY`

`RN_24HR`은 기존 정상값 `28.0mm`에 spike가 더해져 `52.5mm`로 변한 뒤 다시 `28.0mm`로 복귀했다.

예시:

```text
202608231050
RN_15M=0.0
RN_60M=0.0
RN_12HR=0.0
RN_DAY=0.0
RN_24HR=28.0

202608231051
RN_15M=24.5
RN_60M=24.5
RN_12HR=24.5
RN_DAY=24.5
RN_24HR=52.5

202608231052
RN_15M=0.0
RN_60M=0.0
RN_12HR=0.0
RN_DAY=0.0
RN_24HR=28.0
```

15분·60분·12시간 누적강수가 같은 분에 동일한 값으로 상승하고 한 분 뒤 모두 0으로 복귀하는 것은 정상 강수로 볼 수 없다.

## 원본 계열 응답 확인

Legacy range 응답에서도 관측소 574의 10:56 값이 다음과 같이 반환됐다.

```json
{
  "TM": "202608231056",
  "STN_ID": 574,
  "RN_15M": 245,
  "RN_60M": 245,
  "RN_12HR": 245,
  "RN_24HR": 245
}
```

스케일 `0.1mm` 기준으로 모든 필드가 `24.5mm`다. 따라서 Consumer의 frame mapping이나 그래프 렌더링 오류가 아니다.

## 현재 QC 판정

RN_DAY와 RN_24HR의 sparse QC에서 세 spike가 다음과 같이 기록됐다.

```json
{
  "STN_ID": 574,
  "state": "suspect-retained",
  "rawValue": 245,
  "valueMm": 24.5,
  "signals": [
    "extreme_rate",
    "extreme_step_rate"
  ],
  "acceptedUpdated": false,
  "substitutionUsed": false,
  "reason": "suspectRetained",
  "packRawValue": 245,
  "packValueMm": 24.5
}
```

Producer는 이상 신호를 감지했지만 pack에는 원값을 그대로 기록했다.

## 추정되는 QC 공백

오늘 pack이 최신 원천까지 주기적으로 갱신되는 과정에서 다음 상황이 발생할 가능성이 있다.

1. spike가 처음 도착한 시점에는 다음 frame이 없어 `suspect-retained` 처리
2. 다음 분에 값이 0으로 복귀해 `isolated_peak_reset` 패턴이 완성됨
3. 이전 suspect sample을 소급 재평가하지 않아 pack에 24.5mm가 계속 남음
4. 같은 관측소에서 같은 24.5mm가 반복돼도 `mechanical_repeat`로 승격되지 않음

현재 contract revision 8의 최종 reject 신호인 다음 두 경로가 이 사례에서 작동해야 한다.

- `isolated_peak_reset`
- `mechanical_repeat`

## 필수 보완 요청

### 1. 최근 sample 소급 재평가

오늘 pack 갱신 시 신규 sample만 판정하지 말고 최소 최근 2~3분을 다시 QC한다.

```text
t-1 정상값
t   suspect spike
t+1 정상값 복귀
```

`t+1`이 도착해 isolated peak가 확정되면 `t`의 기존 `suspect-retained` 판정을 `rejected`로 갱신해야 한다.

### 2. isolated peak reset 판정

동일 관측소에서 다음 조건이 충족되면 가운데 sample을 reject한다.

```text
previous ≈ baseline
current  = 큰 상승
next     ≈ previous
```

대신 관측소 사례:

```text
0.0 → 24.5 → 0.0
```

### 3. mechanical repeat 판정

동일 관측소에서 같은 비정상 값 `24.5mm`가 서로 떨어진 시각에 반복되고 매번 즉시 원복된다.

다음 시각을 하나의 반복 패턴으로 판단해야 한다.

```text
10:51
10:56
11:33
14:49
```

동일 값·동일 다중 필드·동일 즉시 reset 패턴이 반복되므로 `mechanical_repeat` 신호를 적용한다.

### 4. 다중 필드 동일값의 사용 범위

다중 필드 equality 단독으로 reject하지 않는 기존 안전 원칙은 유지한다.

다만 다음 독립 신호와 결합될 때는 반복 기계 오류를 뒷받침하는 보조 신호로 사용한다.

- isolated peak 후 즉시 reset
- 동일 관측소·동일 값 반복
- RN_15M/RN_60M/RN_12HR/RN_DAY 동시 동일값
- 주변 분의 모든 누적값이 0 또는 안정된 baseline

### 5. 보정값

reject 이후 pack에는 last confirmed accepted 값을 사용한다.

| 변수 | spike 원값 | 기대 pack 값 |
| --- | ---: | ---: |
| RN_15M | 24.5mm | 0.0mm |
| RN_60M | 24.5mm | 0.0mm |
| RN_12HR | 24.5mm | 0.0mm |
| RN_DAY | 24.5mm | 0.0mm |
| RN_24HR | 52.5mm | 28.0mm |

RN_DAY를 Consumer에서 단순 단조 증가 clamp하면 24.5mm 이상치가 하루 종일 유지되는 더 큰 오류가 생긴다. 반드시 Producer QC 단계에서 처리해야 한다.

### 6. QC 상세 기록

수정 후 해당 sample은 다음과 같이 기록돼야 한다.

```json
{
  "state": "rejected",
  "signals": [
    "isolated_peak_reset",
    "mechanical_repeat"
  ],
  "acceptedUpdated": false,
  "substitutionUsed": true,
  "reason": "isolatedPeakReset",
  "packValueMm": 0.0
}
```

RN_24HR의 `packValueMm`은 해당 시각의 last confirmed rolling 값인 `28.0`이어야 한다.

## 재생성 대상

QC 로직 수정 후 KST 오늘 날짜의 다음 pack을 모두 다시 갱신한다.

- `RN_15M`
- `RN_60M`
- `RN_12HR`
- `RN_24HR`
- `RN_DAY`

오늘 pack scheduler가 이후 신규 spike에도 같은 수정 로직을 적용해야 한다.

## 회귀 테스트

### 필수 fixture 1: 단일 isolated peak

```text
0.0 → 24.5 → 0.0
```

기대:

- 가운데 sample rejected
- pack에는 0.0
- accepted state 미갱신

### 필수 fixture 2: 정상 강수 지속

```text
0.0 → 21.0 → 21.5 → 22.0
```

기대:

- 자동 reject하지 않음
- extreme rate 단독으로 정상 후속 일관 값을 제거하지 않음

### 필수 fixture 3: equality 단독

```text
RN_15M=8.0
RN_60M=8.0
RN_12HR=8.0
RN_DAY=8.0
```

후속 값이 정상적으로 증가하거나 유지되는 경우 기대:

- equality만으로 reject하지 않음

### 필수 fixture 4: 반복 기계 spike

```text
10:51 0.0 → 24.5 → 0.0
10:56 0.0 → 24.5 → 0.0
11:33 0.0 → 24.5 → 0.0
```

기대:

- 각 peak rejected
- `mechanical_repeat` 기록
- pack에는 정상 baseline 유지

### 필수 fixture 5: 오늘 incremental warm 소급 판정

1. `t`까지만 원천이 있을 때 spike를 `suspect-retained`로 임시 공개할 수 있음
2. `t+1`에서 baseline 복귀가 확인됨
3. 다음 warm revision에서 `t`를 rejected로 소급 변경
4. 새로운 datasetId와 binary hash가 공개됨

## 완료 검증 요청

수정 후 다음 정보를 전달한다.

- QC 로직 변경 위치
- 소급 재평가 window 크기
- `isolated_peak_reset` 판정 조건
- `mechanical_repeat` 판정 조건
- 정상 21mm/min 후속 일관 사례 보존 테스트 결과
- equality 단독 보존 테스트 결과
- 관측소 574의 네 spike QC 레코드
- 수정 전후 datasetId
- 수정 후 다섯 변수의 아래 시각 값

```text
202608231051
202608231056
202608231133
202608231449
```

최종 기대:

```text
RN_15M=0.0
RN_60M=0.0
RN_12HR=0.0
RN_DAY=0.0
RN_24HR=28.0
```
