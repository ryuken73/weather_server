# Producer 최종 검토 요청: spike QC와 RN_24HR 대체값 안전성

이 문서 전체를 producer 구현 AI Agent에 전달한다.

## 1. 현재 수정안 평가

다음 변경 방향은 승인한다.

- `>=20mm/min`을 즉시 reject가 아닌 extreme candidate로 변경
- multi-field equality 단독 reject 제거
- `valid / suspect-retained / rejected / missing` 상태 분리
- 단일 임계값이 아닌 복수 이상 신호로 reject
- 동래 STN 940: 반복적인 `+100~120mm` jump를 근거로 rejected
- 북강릉 STN 104: 결측 사이 isolated peak와 0 복귀를 근거로 rejected
- 영덕 STN 277: 자동 reject하지 않고 suspect-retained
- 정상 21mm/min과 정상 equality 8mm fixture 보존
- suspect-retained 값은 원값을 보존
- suspect 1샘플이 accepted baseline을 영구적으로 오염시키지 않도록 처리

전체 방향은 기존보다 안전하다. 다만 전체 pack warm 전에 아래 네 가지를 최종 검토하고 필요한 수정을 반영한다.

---

## 2. `extreme + 10분 missing` 단독 reject 금지

현재 reject 신호에 다음 조건이 포함된 것으로 보인다.

```text
extreme rate + 10분 이상 source missing
```

극한강수 직후 통신 또는 관측장비 장애가 발생할 수 있으므로 두 조건은 완전히 독립적이지 않다. 실제 극한강수를 자동 삭제할 가능성이 있다.

다음 원칙으로 수정 또는 확인한다.

```text
extreme + 10분 이상 missing만 존재
→ suspect-retained
```

최종 reject에는 다음 중 하나 이상의 추가 증거가 필요하다.

- 동일하거나 유사한 큰 jump가 기계적으로 반복됨
- isolated peak 직후 이전 정상 범위로 reset
- RN_15M/RN_60M/RN_12HR의 유효한 값 사이에 명백한 수학적 모순
- 원천 필드 파싱 또는 전송 오류를 입증하는 패턴
- 해당 기기의 공식 측정 가능 범위 초과

예상 판정:

- 동래 STN 940: 반복 jump가 있으므로 rejected 유지
- 북강릉 STN 104: isolated peak→reset이 있으므로 rejected 유지
- 영덕 STN 277: 보조 증거가 충분하지 않다면 suspect-retained 유지

완료 보고에서 `extreme + missing`만으로 reject되는 코드 경로가 남아 있는지 명시한다.

---

## 3. raw 값과 실제 단위 확인

영덕 STN 277의 보고값 `648`이 다음 의미인지 확인한다.

```text
raw Int16 = 648
scale = 0.1
실제 강수량 = 64.8mm
```

로그와 QC 상세에는 raw 값과 scale 적용값을 혼동하지 않도록 둘 다 명시한다.

권장 예:

```json
{
  "rawValue": 648,
  "scale": 0.1,
  "valueMm": 64.8
}
```

producer 내부 판정 임계값은 반드시 mm 단위 값에 적용되는지 테스트한다.

---

## 4. 관측소·시각별 QC 상태 제공

manifest의 전체 count와 warning만으로는 consumer가 `valid`와 `suspect-retained`를 구분할 수 없다.

최소한 별도 QC JSON 또는 동등한 자료로 다음을 제공한다.

- date
- variable
- TM
- STN_ID
- station name
- raw value
- scaled value in mm
- QC state: `valid | suspect-retained | rejected | missing`
- candidate signals
- accepted baseline 갱신 여부
- RN_24HR substitution 사용 여부
- 최종 판정 사유

전체 정상 sample을 모두 기록해 파일이 커진다면, 다음 상태만 sparse record로 제공할 수 있다.

```text
suspect-retained
rejected
substituted
```

예:

```json
{
  "qcDetailUrl": "/datasets/aws/qc/rn_day/1m/20260821/qc.json",
  "qcStates": {
    "suspectRetainedSampleCount": 1,
    "rejectedSampleCount": 5,
    "substitutedSampleCount": 0
  }
}
```

이번 consumer에서 즉시 QC overlay를 구현하지 않더라도, 방송 자료의 추적성과 향후 UI 표시를 위해 producer가 상태를 보존해야 한다.

---

## 5. RN_24HR last-confirmed substitution 정책

현재 정책:

```text
RN_DAY rejected
→ RN_DAY pack은 missing

RN_24HR 계산
→ last confirmed accepted 사용, 없으면 null
```

rejected spike가 accepted를 갱신하지 않는 것은 맞다. 그러나 last-confirmed 값을 장시간 사용하면 해당 구간에 새 강수가 없었다고 가정한 추정값을 실제 관측처럼 제공할 수 있다.

다음 사항을 명확히 정의한다.

### 5.1 내부 counter와 출력값 구분

- last-confirmed 값은 내부 누적 counter 복구용 상태
- 해당 값이 원시 관측값은 아님
- substitution으로 생성된 RN_24HR sample을 일반 valid sample과 구분

### 5.2 substitution 최대 허용시간

무제한 last-confirmed 사용을 금지한다.

producer가 데이터 특성을 검토해 최대 허용시간을 제안하고 근거를 보고한다. 허용시간을 초과하면 RN_24HR을 missing으로 출력한다.

권장 검토안:

```text
짧은 isolated rejected 구간
→ 제한적으로 last-confirmed 사용 + substituted QC

장시간 rejected/source-missing 구간
→ RN_24HR missing
```

원천 source missing은 기존 계약처럼 임의 carry-forward하지 않는다.

### 5.3 QC 집계

최소한 다음을 분리한다.

```json
{
  "rolling24h": {
    "sourceMissingSampleCount": 0,
    "qcRejectedSourceSampleCount": 0,
    "lastConfirmedSubstitutionSampleCount": 0,
    "substitutionExpiredSampleCount": 0,
    "substitutionMaxMinutes": 0
  }
}
```

---

## 6. 필수 회귀 테스트

### A. 실제 극한강수 뒤 통신 장애

```text
RN_DAY 0 → 21mm
단기 누적 변수와 일관됨
이후 15분 source missing
```

기대:

- `extreme + missing`만으로 rejected 처리하지 않음
- 최소 suspect-retained
- 원래 21mm 보존

### B. 동래 STN 940

```text
0 → 101.5 → 221.5 → 341.5 → 461.5 → missing
```

기대:

- 반복적인 기계적 jump를 근거로 rejected
- spike 값이 accepted를 갱신하지 않음
- RN_24HR에 461.5mm 오염 없음

### C. 북강릉 STN 104

```text
missing → 31mm isolated peak → missing/0 복귀
```

기대:

- equality가 아닌 isolated peak→reset 패턴으로 rejected
- 다음 날 RN_24HR의 31mm plateau 및 급락 제거

### D. 영덕 STN 277

```text
RN_DAY raw=648, scaled=64.8mm
```

기대:

- raw/scale 단위 확인
- 자동 hard reject하지 않음
- suspect-retained 및 상세 QC 기록

### E. substitution 만료

- 짧은 rejected 구간에서는 substituted 상태로 계산 가능
- 최대 허용시간 초과 후 RN_24HR missing
- source missing을 substitution으로 채우지 않음

### F. 정상 비교 사례

- 담양 봉산 STN 688 정상 plateau와 rolling 감소 유지
- 장수 STN 248 정상 plateau, 당일 유입 및 전일 이탈 유지
- 정상 21mm/min 및 equality 8mm fixture 유지

---

## 7. 우선 재생성 범위

최종 수정 후 전체 warm 전에 다음만 먼저 강제 재생성한다.

```text
2026-08-20 RN_DAY
2026-08-21 RN_DAY
2026-08-21 RN_24HR
```

새 contractRevision, datasetId, data URL, SHA-256가 이전 결과와 달라야 한다.

검증 대상:

- STN 940 동래
- STN 104 북강릉
- STN 277 영덕
- STN 688 담양 봉산
- STN 248 장수
- RN_DAY/RN_24HR 전체 최대값 및 TOP 20
- suspect/rejected/substituted QC 상세

위 검증을 통과하고 consumer 측 확인을 받은 뒤 전체 기간을 warm한다.

---

## 8. 완료 보고 요청

다음을 보고한다.

1. `extreme + 10분 missing` 단독 reject 제거 여부
2. 최종 reject에 필요한 독립 신호 조합
3. 영덕 raw 648과 64.8mm 단위 확인
4. suspect/rejected/substituted sparse QC 제공 방식
5. RN_24HR last-confirmed substitution 최대 허용시간과 근거
6. substitution 만료 후 처리
7. source missing과 QC rejected의 처리 차이
8. STN 940/104/277 수정 결과
9. STN 688/248 정상 보존 결과
10. contractRevision 및 cache 무효화 결과
11. 우선 재생성 pack의 API URL과 datasetId
12. 전체 단위·회귀 테스트 결과
