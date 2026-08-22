# Producer 검증 요청: contractRevision 8 우선 pack과 sparse QC

이 문서 전체를 producer 구현 AI Agent에 전달한다.

## 1. 현재 구현 판정

다음 변경은 승인한다.

- `>=20mm/min`은 즉시 reject가 아닌 extreme candidate
- extreme 뒤 10분 missing만으로 reject하지 않음
- multi-field equality는 reject 신호로 사용하지 않음
- 상태를 `valid / suspect-retained / rejected / missing`으로 구분
- 최종 reject 신호를 `mechanical_repeat`, `isolated_peak_reset`으로 제한
- 동래 STN 940은 mechanical repeat로 rejected
- 북강릉 STN 104는 isolated peak→reset으로 rejected
- 영덕 STN 277은 raw 648, scale 0.1, 64.8mm로 suspect-retained
- 정상 21mm/min 및 equality 8mm fixture 보존
- source missing은 fill하지 않음
- QC rejected만 last-confirmed substitution 허용
- substitution 상한 30분, 만료 후 RN_24HR missing
- contractRevision 8로 cache 무효화

producer 로직은 조건부 승인한다. 전체 warm 전에 우선 pack과 sparse QC 계약을 아래와 같이 검증해야 한다.

---

## 2. 우선 재생성 범위

전체 기간을 warm하지 말고 다음 pack만 먼저 강제 재생성한다.

```text
2026-08-20 RN_DAY
2026-08-21 RN_DAY
2026-08-21 RN_24HR
```

RN_24HR은 전일 dependency를 사용하므로 8월 20일 RN_DAY 재생성이 먼저 완료되어야 한다.

각 응답에 cache-burst query를 사용해 이전 immutable 응답이 섞이지 않도록 한다.

예:

```text
GET /api/aws/min/pack?date=20260820&variable=RN_DAY&cacheburst=contract-v8-a
GET /api/aws/min/pack?date=20260821&variable=RN_DAY&cacheburst=contract-v8-a
GET /api/aws/min/pack?date=20260821&variable=RN_24HR&cacheburst=contract-v8-a
```

---

## 3. pack manifest 제출 항목

세 API 각각에 대해 다음 값을 보고한다.

- HTTP status
- schemaVersion
- contractRevision
- datasetId
- variable
- accumulation
- generatedAt
- complete/dataComplete
- stationCount/frameCount
- data.url
- data.sha256
- qcDetailUrl
- qc.qcStates
- warnings

기대:

```text
contractRevision == 8
```

이전 revision의 datasetId, binary URL 또는 SHA를 재사용하면 안 된다.

---

## 4. sparse QC 파일 계약

`qcDetailUrl`이 가리키는 `qc.json`은 대응 binary와 정확히 결합되어야 한다.

최소 필드:

```json
{
  "schemaVersion": 1,
  "contractRevision": 8,
  "datasetId": "same-as-pack-manifest",
  "date": "20260821",
  "variable": "RN_DAY",
  "generatedAt": "ISO-8601",
  "records": []
}
```

각 sparse record 최소 필드:

```json
{
  "TM": "202608211414",
  "STN_ID": 277,
  "stationName": "영덕",
  "state": "suspect-retained",
  "rawValue": 648,
  "scale": 0.1,
  "valueMm": 64.8,
  "signals": [],
  "acceptedUpdated": false,
  "substitutionUsed": false,
  "reason": "..."
}
```

파일 크기를 줄이기 위해 정상 valid와 일반 source missing은 생략해도 된다. 다음 상태는 반드시 기록한다.

- suspect-retained
- rejected
- substituted
- substitution-expired

### cache 안전성

`qc.json`에도 다음 중 하나를 적용한다.

1. hash/revision이 포함된 immutable URL
2. manifest에 QC 파일 SHA-256 제공
3. 가능하면 두 방법 모두 사용

권장 manifest 형태:

```json
{
  "qcDetailUrl": "/datasets/aws/qc/rn_day/1m/20260821/qc-v{hash}.json",
  "qcDetailSha256": "..."
}
```

binary는 revision 8인데 QC만 이전 cache가 남는 상황을 방지해야 한다.

---

## 5. substitution 검증

RN_24HR의 last-confirmed substitution은 실제 관측값이 아닌 QC 보정값이다.

다음을 보고한다.

- substitution이 적용된 STN_ID/TM
- 각 연속 substitution 구간의 시작·종료 시각
- 구간별 지속시간
- 사용된 last-confirmed TM과 값
- 30분 상한 적용 여부
- 만료 후 첫 missing TM
- `lastConfirmedSubstitutionSampleCount`
- `substitutionExpiredSampleCount`
- `substitutionMaxMinutes`

기대 정책:

```text
source missing
→ substitution 금지

QC rejected
→ last-confirmed를 최대 30분 사용 가능

30분 초과
→ RN_24HR missing
```

substituted RN_24HR sample은 일반 valid와 구분되어 sparse QC에 기록되어야 한다.

실제 오류 사례에서 30분 전체가 사용되지 않았다면, 각 사례에 실제로 몇 분 사용됐는지 보고한다.

---

## 6. 관측소별 필수 검증

### 6.1 동래 STN 940

기존 오류:

```text
0.0 → 101.5 → 221.5 → 341.5 → 461.5 → missing
```

확인:

- `mechanical_repeat` 신호
- 09:24~09:27 최종 state
- accepted baseline 미갱신
- RN_DAY pack의 해당 sample은 missing
- RN_24HR에 461.5mm가 남지 않음
- substitution 적용 구간과 실제 지속시간

### 6.2 북강릉 STN 104

기존 오류:

```text
missing → 31.0mm isolated peak → missing/0 복귀
```

확인:

- equality가 아니라 `isolated_peak_reset`으로 rejected
- 오염된 31mm가 accepted baseline이 되지 않음
- 2026-08-21 RN_24HR의 장시간 31mm plateau 제거
- 11:53의 31→0mm 급락 제거
- source missing 구간이 임의로 채워지지 않음

### 6.3 영덕 STN 277

확인:

- rawValue `648`
- scale `0.1`
- valueMm `64.8`
- state `suspect-retained`
- 원래 값이 RN_DAY pack에 보존됨
- qc.json에 record 존재
- hard reject 또는 missing 변환 없음
- RN_24HR에서 사용되었다면 해당 결과와 QC 상태 보고

### 6.4 담양 봉산 STN 688

정상 rolling 비교군:

- 54.5mm plateau 유지
- 전일 강수가 window 밖으로 빠지는 시각부터 정상 감소
- spike QC로 오탐하지 않음

### 6.5 장수 STN 248

정상 rolling 비교군:

- 34.4mm plateau 유지
- 당일 강수 유입에 따른 증가 유지
- 전일 강수 이탈에 따른 감소 유지
- spike QC로 오탐하지 않음

---

## 7. 전체 통계 검증

재생성한 각 pack에 대해 다음을 보고한다.

- 전체 유효 sample 수
- source missing 수
- suspect-retained 수
- rejected 수
- substituted 수
- substitution-expired 수
- 전체 최댓값과 관측소·시각
- TOP 20 관측소·시각·값
- 음수/overflow 수
- counter regression 수

2026-08-21 RN_24HR TOP 20에 동래의 461.5mm가 없어야 한다.

영덕 64.8mm는 suspect-retained 정책에 따라 보존될 수 있지만 QC 상태가 명확하게 추적되어야 한다.

---

## 8. consumer 연동을 위한 계약 설명

consumer는 향후 다음 상태를 화면에서 구분할 예정이다.

```text
suspect-retained → 검토 필요
substituted      → QC 보정값
rejected/missing → 결측
```

따라서 producer는 다음을 명확히 알려달라.

- qcDetailUrl fetch cache 정책
- qc.json schema와 versioning
- `(TM, STN_ID)`로 record를 찾는 방법
- RN_DAY와 RN_24HR 각각의 state 의미
- 동일 sample에 여러 signal이 있을 때 최종 state 결정 방법
- qc.json이 없거나 fetch 실패했을 때 consumer가 적용할 fallback

producer가 consumer용 TypeScript 또는 JSON schema 예시를 제공할 수 있다면 함께 제출한다.

---

## 9. 전체 warm 승인 조건

다음 조건을 모두 만족한 뒤 전체 기간 warm을 진행한다.

1. 우선 세 pack이 contractRevision 8로 재생성됨
2. datasetId/binary SHA가 이전 revision과 다름
3. qcDetailUrl과 QC SHA/cache 정책 확인
4. 동래 461.5mm 오염 제거
5. 북강릉 31mm plateau/급락 제거
6. 영덕 64.8mm suspect-retained 추적 가능
7. 담양 봉산·장수 정상 rolling 보존
8. source missing fill 금지 확인
9. substitution 30분 상한과 만료 확인
10. 단위·회귀 테스트 통과
11. consumer 측 API/binary/QC 검증 통과

consumer 확인 전에는 전체 warm을 시작하지 않는다.

---

## 10. 완료 보고 형식

다음을 한 번에 제출한다.

1. 세 API manifest 요약
2. 세 data.url과 SHA-256
3. qcDetailUrl과 QC SHA/cache 정책
4. STN 940/104/277 sparse QC record
5. STN 688/248 정상 시계열 요약
6. substitution 구간 및 지속시간 목록
7. pack별 QC count
8. 2026-08-21 RN_24HR TOP 20
9. contractRevision 8 테스트 결과
10. consumer 연동 schema 설명
11. 전체 warm 실행 명령과 예상 범위
