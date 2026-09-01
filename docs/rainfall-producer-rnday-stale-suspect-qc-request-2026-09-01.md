# Producer 보완 요청 — RN_DAY suspect-retained + 장시간 결측 carry-forward 노출

## 목적

Consumer 운영 화면에서 2026-09-01 `RN_DAY` 시간재생 중 순위표에는 나오지 않는 관측소가 지도 기둥과 카드에는 큰 누적강수량으로 표시되는 사례가 확인됐다.

Consumer 확인 결과, 현재 시각의 실제 관측값은 결측이지만 과거에 `suspect-retained`로 pack에 남은 값이 `RN_DAY` 당일 누적 carry-forward 규칙에 의해 장시간 현재값처럼 보이는 상황이었다.

Consumer는 임시 방어로 오래된 `RN_DAY` carry-forward 표시를 제한할 예정이지만, 원천적으로는 Producer QC가 해당 spike island를 최종 reject하는 것이 필요하다.

## 대상 사례

```text
date: 20260901
variable: RN_DAY
baseUrl: https://weather-map.sbs.co.kr
manifest: GET /api/aws/min/pack?date=20260901&variable=RN_DAY
확인 datasetId: aws-rn_day-1m-20260901-v67832e44
확인 to: 202609010951
qcDetailUrl: /datasets/aws/rn_day/1m/20260901/qc-v44b30e92e519b3ac.json

STN_ID: 739
stationName: 심원
LAW_ADDR_SIDO: 전북특별자치도
LAW_ADDR_GUGUN: 고창군
LAT: 35.52254
LON: 126.54668
```

## Consumer에서 보인 현상

- 2026-09-01 09:41 화면에서 `심원` 카드가 `94.0mm`로 표시됨.
- 같은 시각 `현재 관측 00시부터 누적강수량 TOP 5` 순위표에는 `심원`이 없음.
- 원시 binary 확인 결과, 09:41의 `심원` 값은 결측이다.
- 즉 순위표는 현재 실제 관측값 기준이라 제외했고, 지도는 이전 유효 누적값을 carry-forward해 표시했다.

## Pack binary 확인 요약

`STN_ID=739`의 `RN_DAY` 유효값은 조사 시점 기준 96분뿐이었다.

마지막 유효 구간:

| 시각 | RN_DAY |
| --- | ---: |
| 202609010427 | 0.5mm |
| 202609010432 | 0.5mm |
| 202609010434 | 0.5mm |
| 202609010441 | 2.0mm |
| 202609010444 | 4.5mm |
| 202609010805 | 93.5mm |
| 202609010807 | 93.5mm |
| 202609010808 | 93.5mm |
| 202609010809 | 94.0mm |
| 202609010810 | 94.0mm |
| 202609010811 | 94.0mm |
| 202609010812 | 94.0mm |

09:32~09:51 구간은 모두 `-32768` 결측이었다. 따라서 09:41의 94.0mm는 현재 실제 관측이 아니라 08:12 마지막값의 consumer-side carry-forward 결과다.

## QC sidecar 확인

`STN_ID=739`의 QC record는 269건이었다.

상태 요약:

| state | count |
| --- | ---: |
| rejected | 268 |
| suspect-retained | 1 |

reason 요약:

| reason | count |
| --- | ---: |
| counterRegression | 262 |
| isolatedPeakReset | 5 |
| spikeRecoveryPending | 1 |
| suspectRetained | 1 |

08:00~08:14 주변 QC:

| 시각 | state | raw/value | reason | signals | pack 반영 |
| --- | --- | ---: | --- | --- | --- |
| 08:01 | rejected | 0 / 0.0mm | counterRegression | - | missing |
| 08:02 | rejected | 0 / 0.0mm | counterRegression | - | missing |
| 08:03 | rejected | 930 / 93.0mm | isolatedPeakReset | isolated_peak_reset | missing |
| 08:04 | rejected | 0 / 0.0mm | counterRegression | - | missing |
| 08:05 | suspect-retained | 935 / 93.5mm | suspectRetained | soft_rate, extreme_step_rate, large_step_increase | 93.5mm |
| 08:06 | rejected | 935 / 93.5mm | spikeRecoveryPending | soft_rate | missing |
| 08:13 | rejected | 0 / 0.0mm | counterRegression | - | missing |
| 08:14 | rejected | 0 / 0.0mm | counterRegression | - | missing |

## 교차 변수 확인

08:09~08:12에는 `RN_15M`/`RN_60M`에도 94.0mm가 들어왔다.

| 시각 | RN_15M | RN_60M | RN_24HR | RN_DAY |
| --- | ---: | ---: | ---: | ---: |
| 08:01 | 0.0mm | 0.0mm | missing | missing |
| 08:02 | 0.0mm | 0.0mm | missing | missing |
| 08:03 | missing | missing | missing | missing |
| 08:04 | 0.0mm | 0.0mm | missing | missing |
| 08:05 | missing | missing | missing | 93.5mm |
| 08:06 | missing | missing | missing | missing |
| 08:07 | missing | missing | missing | 93.5mm |
| 08:08 | missing | missing | missing | 93.5mm |
| 08:09 | 94.0mm | 94.0mm | missing | 94.0mm |
| 08:10 | 94.0mm | 94.0mm | missing | 94.0mm |
| 08:11 | 94.0mm | 94.0mm | missing | 94.0mm |
| 08:12 | 94.0mm | 94.0mm | missing | 94.0mm |
| 08:13 | 0.0mm | 0.0mm | missing | missing |

`RN_15M`와 `RN_60M`가 같은 짧은 구간에 동일하게 94.0mm로 튀고 곧 0 또는 결측으로 돌아온 점을 보면 정상 강수 가능성보다 센서/원천 spike 가능성이 높다.

## 요청 사항

### 1. suspect-retained 소급 재평가

오늘 pack 갱신 시 신규 sample만 판정하지 말고 최근 몇 분의 `suspect-retained` sample을 재평가해 달라.

예:

```text
t-1: 낮은 누적 또는 결측
t:   suspect-retained 큰 상승
t+1~t+n: reset/counterRegression/결측 지속
```

이 패턴이 확인되면 기존 `suspect-retained`를 `rejected`로 승격하고 pack binary에서도 missing으로 publish해야 한다.

### 2. 짧은 high plateau 뒤 reset/결측 패턴 reject

이번 사례는 단일 1분 spike가 아니라 08:05~08:12 사이 일부 분에 93.5~94.0mm가 남아 있는 짧은 high plateau 형태다.

아래 조건 조합을 추가 검토해 달라.

- 직전 누적이 매우 낮음: 예) 4.5mm
- 몇 분 사이 90mm 이상 급상승
- 직후 counterRegression 또는 0mm reset
- 이후 장시간 source missing
- `RN_15M`/`RN_60M`/`RN_DAY`가 동일 또는 비정상적으로 유사한 큰 값을 공유

### 3. QC detail record와 pack binary 일치성 확인

08:07~08:12 값은 binary에 남아 있으나, 확인된 QC detail에는 일부 시각만 record로 보였다.

Producer에서 다음을 확인해 달라.

- 08:07~08:12 값이 QC record 생성 대상에서 빠진 이유
- 같은 spike island 안의 일부 sample만 `suspect-retained` 또는 normal로 남는지 여부
- 최종 binary publish 시 rejected/suspect/normal 상태가 의도대로 반영되는지 여부

## Consumer 임시 방어

Consumer는 `RN_DAY` 현재 재생 화면에서 오래된 carry-forward가 현재 관측처럼 보이지 않도록 제한한다.

예정 정책:

- `RN_DAY`의 station별 carry-forward는 짧은 결측 보정용으로만 유지
- 마지막 실제 관측 이후 일정 시간 이상 지나면 지도 기둥/IDW 보간 입력에서 제외
- 순위표는 기존처럼 현재 시각 실제 관측값 기준 유지

이 조치는 방송 화면의 오인 방지용이며, 기간 최대/기록 갱신 분석에서 원천 spike가 들어가는 문제는 Producer QC에서 해결되어야 한다.

