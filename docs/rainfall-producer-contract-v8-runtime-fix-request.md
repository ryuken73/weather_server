# Producer 재수정 요청: contractRevision 8 운영 검증 실패

이 문서 전체를 producer 구현 AI Agent에 전달한다.

## 1. 검증 결과 요약

2026-08-20·21 RN_DAY/RN_24HR contractRevision 8 운영 pack을 consumer에서 cache-burst로 직접 검증했다.

일부 수정은 성공했지만 전체 warm을 진행할 수 없는 네 가지 문제가 남아 있다.

| 항목 | 결과 |
|---|---|
| contractRevision 8 | 통과 |
| binary 실제 SHA | 통과 |
| 동래 STN 940의 461.5mm 제거 | 통과 |
| 담양 봉산 STN 688 정상 rolling 보존 | 통과 |
| 장수 STN 248 정상 rolling 보존 | 통과 |
| 영덕 STN 277 원값 보존 | 통과 |
| 북강릉 STN 104의 31mm plateau 제거 | 실패 |
| 영덕 suspect-retained 운영 QC 기록 | 실패 |
| qcDetailUrl 실제 서빙 | 실패, 모두 404 |
| immutable binary cache 무효화 | 실패, 이전과 동일 URL |

아래 네 항목을 수정한 뒤 8월 20·21일 pack만 다시 재생성한다. consumer 재검증 전에는 전체 warm을 진행하지 않는다.

---

## 2. 실패 1: 북강릉 전체 오염 episode 미검출

대상:

- 날짜: `2026-08-20`
- STN_ID: `104`
- 관측소: 북강릉

revision 8 RN_DAY binary에 실제로 남아 있는 값:

| 시각 | RN_DAY |
|---|---:|
| 12:50 | 0.0 |
| 12:51 | 0.0 |
| 12:52 | 0.0 |
| 12:53 | 0.0 |
| 12:54 | missing |
| 12:55 | 0.0 |
| 12:56 | 31.0 |
| 12:57 | missing |
| 12:58 | 0.0 |
| 12:59 | 31.0 |
| 13:00 | 31.0 |
| 13:01 이후 | missing |

RN_15M·RN_60M·RN_12HR도 같은 시각에 정확히 같은 `0/31/missing` 패턴을 보인다.

기존 11:53 isolated peak 일부는 제거됐지만 12:56·12:59·13:00의 31mm가 다시 accepted 상태로 들어갔다.

그 결과 2026-08-21 RN_24HR에는 여전히 다음 문제가 존재한다.

- 00:00부터 약 31.0mm
- 최고 31.6mm
- 장시간 31mm plateau
- 전일 오염값 이탈에 따른 비정상 변화

### 요구사항

개별 sample 단위 isolated peak 검사만 하지 말고, 결측과 정상 범위 복귀를 사이에 둔 연속 오염 episode를 검출한다.

대상 형태:

```text
정상 0
→ missing
→ 동일한 비정상 peak
→ missing 또는 정상 0
→ 동일한 비정상 peak 반복
→ missing
```

북강릉 사례에서는 `31.0mm`가 모든 누적 필드에 반복 복제되고, 정상 `0.0mm`와 번갈아 나타난다. equality 자체가 오류 근거인 것이 아니라 다음 결합 패턴이 근거다.

- 짧은 시간 내 동일 peak 반복
- peak 사이에 0 또는 missing
- 모든 누적 필드에 동일 값 복제
- episode 이후 장시간 missing

episode로 판정된 11:53 및 12:56~13:00 관련 오염 sample은 모두 rejected로 기록한다. 해당 값은 accepted baseline을 갱신하면 안 된다.

### 기대 결과

- 2026-08-20 RN_DAY에서 북강릉 오염 31mm 제거
- 2026-08-21 RN_24HR에서 31mm 장기 plateau 제거
- 북강릉 sparse QC에 episode ID, 시작·종료 시각, rejected sample 목록 기록
- 정상 multi-field equality fixture 8mm는 계속 valid
- 정상 강수 후 유지되는 누적 plateau는 오탐하지 않음

---

## 3. 실패 2: 영덕 suspect-retained가 운영 pack에 기록되지 않음

대상:

- 날짜: `2026-08-21`
- STN_ID: `277`
- 관측소: 영덕

실제 revision 8 binary:

```text
14:14 RN_DAY = 64.8mm
당일 최고 RN_DAY = 66.6mm
RN_24HR 최고 = 66.9mm
```

원값 보존은 성공했다. 그러나 2026-08-21 RN_DAY manifest는 다음을 반환한다.

```json
{
  "qc": {
    "qcStates": {
      "suspectRetainedSampleCount": 0
    }
  }
}
```

producer 완료 보고에서는 영덕을 suspect-retained라고 했으므로 실제 운영 build 결과와 보고가 불일치한다.

### 요구사항

- 단위 테스트 fixture뿐 아니라 실제 pack builder 경로에서 영덕을 suspect-retained로 분류
- raw `648`, scale `0.1`, value `64.8mm` 유지
- RN_DAY binary 원값 보존
- `suspectRetainedSampleCount`에 포함
- qc.json에 `(TM, STN_ID=277)` sparse record 기록
- accepted baseline 갱신 여부 명시
- RN_24HR에서 해당 값이 사용된 시각과 QC 전파 정책 명시

첫 유효 sample 또는 결측 후 복귀 sample의 rate를 임의로 1분 rate로 해석해서는 안 된다. 영덕을 suspect로 두는 근거와 실제 운영 코드 경로를 완료 보고에 적는다.

실제 데이터가 최종적으로 suspect-retained 조건을 만족하지 않는다고 판단한다면, 단순히 count를 0으로 두지 말고 기존 완료 보고와 판정이 달라진 이유를 설명한다.

---

## 4. 실패 3: qcDetailUrl이 모두 404

manifest가 제공한 URL:

```text
/datasets/aws/rn_day/1m/20260820/qc-v1a163dab2ccd28dc.json
/datasets/aws/rn_day/1m/20260821/qc-v95e9217da5e2256a.json
/datasets/aws/rn_24hr_rolling/1m/20260821/qc-v118c8bbfba403d59.json
```

세 URL 모두 실제 운영 서버에서 HTTP 404를 반환한다.

응답 예:

```json
{
  "error": "Pack binary not found",
  "slug": "rn_day",
  "day": "20260821",
  "file": "qc-v95e9217da5e2256a.json"
}
```

manifest에는 `qcDetailSha256`이 있지만 실제 파일이 없으므로 검증할 수 없다.

### 요구사항

- pack 생성 디렉터리와 실제 API serving directory를 다시 확인
- qc.json을 binary와 함께 serving target에 배포
- API static/dataset route가 hash형 QC 파일명을 허용하도록 수정
- manifest를 반환하기 전에 qcDetailUrl 파일 존재 여부 검사
- 파일이 없으면 complete=true manifest를 제공하지 않거나 qc 계약 실패를 명확하게 처리
- 우선 세 QC URL을 HTTP 200으로 제공
- 실제 응답 SHA-256이 manifest `qcDetailSha256`과 일치

필수 QC metadata:

```json
{
  "schemaVersion": 1,
  "contractRevision": 8,
  "datasetId": "same-as-pack-manifest",
  "date": "YYYYMMDD",
  "variable": "RN_DAY or RN_24HR",
  "generatedAt": "ISO-8601",
  "records": []
}
```

---

## 5. 실패 4: immutable binary URL 재사용

revision 8 manifest의 binary URL:

```text
/datasets/aws/rn_day/1m/20260820/rn_day.i16le
/datasets/aws/rn_day/1m/20260821/rn_day.i16le
/datasets/aws/rn_24hr_rolling/1m/20260821/rn_24hr_rolling.i16le
```

이 URL은 이전 contract revision에서 사용된 경로와 동일하다.

실제 응답 헤더:

```text
Cache-Control: public, max-age=31536000, immutable
```

이미 이전 binary를 받은 브라우저는 같은 URL에 대해 1년 동안 재검증하지 않을 수 있다. manifest datasetId가 바뀌어도 HTTP cache key는 binary URL이므로 기존 `461.5mm` 자료가 계속 노출될 수 있다.

### 요구사항

binary도 content-addressed 또는 revisioned URL을 사용한다.

권장:

```text
/datasets/aws/rn_day/1m/20260821/rn_day-v{shaPrefix}.i16le
/datasets/aws/rn_24hr_rolling/1m/20260821/rn_24hr_rolling-v{shaPrefix}.i16le
```

예:

```text
/datasets/aws/rn_day/1m/20260821/rn_day-v33560fdf.i16le
/datasets/aws/rn_24hr_rolling/1m/20260821/rn_24hr_rolling-v2347fe0a.i16le
```

요구 계약:

- 내용이 바뀌면 URL도 바뀜
- hash URL에는 `immutable` 허용
- manifest `data.url`은 새 hash URL을 가리킴
- 이전 고정 URL은 신규 manifest에서 사용하지 않음
- force rebuild와 warm 모두 새 URL을 생성
- serving route가 hash형 binary 파일명을 허용
- manifest 응답은 stale cache를 피할 수 있는 기존 정책 유지

고정 URL을 계속 사용해야 한다면 `immutable`을 제거하고 반드시 revalidation을 강제해야 하지만, content-addressed URL을 우선한다.

---

## 6. 재생성 후 필수 검증

다음 세 pack만 다시 강제 재생성한다.

```text
2026-08-20 RN_DAY
2026-08-21 RN_DAY
2026-08-21 RN_24HR
```

각 API를 cache-burst query로 호출하고 다음을 제출한다.

- HTTP status
- contractRevision
- datasetId
- generatedAt
- 새 hash형 data.url
- data.sha256
- qcDetailUrl
- qcDetailSha256
- qc.qcStates
- warnings

각 data.url과 qcDetailUrl을 직접 호출해 다음을 확인한다.

- HTTP 200
- 응답 SHA와 manifest SHA 일치
- hash/revision이 URL에 포함됨
- immutable cache 정책이 content-addressed URL과 일치

---

## 7. 관측소 검증 기대값

### 동래 STN 940

- 461.5mm 제거 상태 유지
- RN_24HR TOP 목록에 비정상값 없음
- rejected/substituted sparse QC 확인

### 북강릉 STN 104

- 11:53 및 12:56~13:00 오염 episode 처리
- 전일 RN_DAY의 비정상 31mm accepted 제거
- 다음 날 RN_24HR의 31mm 장기 plateau 제거
- sparse QC에 episode 기록

### 영덕 STN 277

- 64.8mm 원값 보존
- suspect-retained count 증가
- sparse QC record 존재
- raw/scale/value 단위 확인

### 담양 봉산 STN 688

- RN_24HR 최고 54.5mm
- 02:27~16:52 plateau 유지
- 17:21 이후 정상 감소

### 장수 STN 248

- RN_24HR 34.4→38.4→4.0mm 형태 유지

---

## 8. 전체 warm 금지 조건

다음 중 하나라도 남으면 전체 warm을 진행하지 않는다.

- 북강릉 RN_24HR에 31mm 오염 plateau가 남음
- 영덕 suspect-retained가 manifest/QC에 없음
- qcDetailUrl이 404 또는 SHA 불일치
- binary data.url이 이전 immutable 고정 URL을 재사용
- 동래 461.5mm가 다시 나타남
- 담양 봉산·장수 정상 시계열이 변경됨

consumer가 우선 세 pack의 API·binary·QC를 다시 검증해 통과를 알린 뒤 전체 기간을 warm한다.

---

## 9. 완료 보고 형식

다음을 한 번에 제출한다.

1. 네 실패 항목의 실제 원인
2. 북강릉 episode 검출 방식
3. 영덕 실제 운영 builder의 suspect 판정 결과
4. 세 새 manifest 요약
5. 세 hash형 binary URL과 SHA
6. 세 qcDetailUrl과 SHA 및 HTTP 상태
7. STN 940/104/277 sparse QC record
8. STN 688/248 정상 시계열 요약
9. substitution 구간과 지속시간
10. 전체 TOP 10 및 최대값
11. 단위·회귀 테스트 결과
12. 전체 warm 실행 전 대기 상태 확인
