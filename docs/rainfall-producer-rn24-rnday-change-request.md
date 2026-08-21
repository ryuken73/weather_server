# Producer 변경 요청: RN_24HR rolling 신설 및 RN_DAY 분리

작성일: 2026-08-21 KST  
대상 저장소: `weather_api`  
요청 프로젝트: `weather-bars-instanced`

## AI agent에게 요청할 작업

기존 강수 변수 이름은 유지한다. `_ROLLING`, `_WINDOW` 같은 suffix는 새로 도입하지 않는다. 대신 아래 명명 규칙과 manifest의 `accumulation` 계약을 일관되게 적용한다.

- 시간이 이름에 포함된 `RN_15M`, `RN_60M`, `RN_12HR`, `RN_24HR`는 모두 현재 시각 기준 rolling 누적이다.
- `RN_DAY`만 `Asia/Seoul` 당일 00시부터 현재까지 누적되는 일 누적이다.
- 현재 `RN_24HR`로 제공 중인 `RN-DAY` pack은 의미가 잘못 연결된 legacy 자료다. 이를 `RN_DAY`로 분리하고, `RN_24HR`에는 true rolling 24시간 값을 새로 생성한다.

기존 `TA`, `RN_15M`, `RN_60M`, `RN_12HR` 동작과 산출물을 변경하지 않는다.

## 1. 최종 변수 계약

| pack 변수 | 원천/계산 | 의미 | accumulation |
| --- | --- | --- | --- |
| `RN_15M` | APIHUB `RN-15m` | 현재 시각 직전 15분 | `{ "type": "rolling", "windowMinutes": 15 }` |
| `RN_60M` | APIHUB `RN-60m` | 현재 시각 직전 60분 | `{ "type": "rolling", "windowMinutes": 60 }` |
| `RN_12HR` | APIHUB `RN-12H` | 현재 시각 직전 12시간 | `{ "type": "rolling", "windowMinutes": 720 }` |
| `RN_24HR` | `RN-DAY` 시계열에서 파생 | 현재 시각 직전 24시간 | `{ "type": "rolling", "windowMinutes": 1440 }` |
| `RN_DAY` | APIHUB `RN-DAY` | KST 당일 00시부터 현재 | `{ "type": "day", "timezone": "Asia/Seoul", "resetTime": "00:00" }` |

UI 표기에서 `RN_24HR`은 “직전 24시간 누적강수량”, `RN_DAY`는 “오늘 00시부터 누적강수량”으로 구분할 예정이다.

## 2. 수집 JSON 필드 변경

APIHUB `RN-DAY`는 신규 수집분부터 `RN_DAY`에 저장한다.

```js
RN_DAY: scale10(rnDay)
```

마이그레이션 기간에는 기존 consumer/스크립트 호환을 위해 같은 원천값을 `RN_24HR` legacy 필드에도 기록해도 된다. 단, 이 legacy JSON 필드는 “일 누적 원천값”일 뿐이며 신규 `RN_24HR` pack에 그대로 넣으면 안 된다.

기존 JSON에는 일 누적값이 `RN_24HR` 필드로 저장되어 있으므로 builder는 다음 우선순위를 허용한다.

```text
RN_DAY 원천값 = row.RN_DAY ?? row.RN_24HR(legacy)
```

수정 대상은 최소 다음 두 변환기를 포함한다.

- `kma_fetch/services/aws_apihub_min.js`
- `work/fetch_aws_apihub.js`

## 3. True rolling 24시간 계산

APIHUB 응답에는 직접적인 rolling 24시간 필드가 없다. `RN_12HR` 두 값을 더하거나 `RN_60M`을 반복 합산하면 겹치는 window를 중복 계산하므로 금지한다.

관측소별 `RN-DAY` 누적 카운터를 이용한다. 날짜 `D`, 시각 `t`의 rolling 24시간은 다음과 같다.

```text
RN_24HR(D, t)
  = RN_DAY(D, t)
  + RN_DAY(D-1, 23:59)
  - RN_DAY(D-1, t)
```

이는 전일 같은 시각 이후부터 전일 23:59까지의 강수와, 당일 00:00부터 현재까지 강수를 합친 값이다. timestamp 포함 경계는 원본 `RN-DAY`가 해당 timestamp까지 포함하는 방식과 일치하도록 fixture에서 확정한다. 한 프레임이 이중 포함되지 않게 한다.

### 필수 입력

날짜 `D` pack을 생성할 때 다음 1분 JSON이 필요하다.

- `D` 당일 전체 또는 현재까지 자료
- `D-1` 전일 전체 자료

따라서 기간 backfill에서 첫 날짜의 RN_24HR을 만들려면 그 전날 JSON도 준비해야 한다. 예를 들어 2026-07-01부터 생성하려면 최소 2026-06-30 원천이 필요하다.

### 결측 및 QC 규칙

아래 중 하나라도 만족하면 해당 `(TM, STN_ID)`의 RN_24HR은 `-32768` missing으로 기록한다.

- 당일 같은 시각 `RN_DAY(D,t)` 결측
- 전일 23:59 `RN_DAY(D-1,23:59)` 결측
- 전일 같은 시각 `RN_DAY(D-1,t)` 결측
- 계산 결과가 음수
- 전일 최종 누적이 전일 같은 시각 누적보다 작음
- station이 전일/당일 station set 중 한쪽에 없음

추가 원칙:

- 결측을 0으로 대체하지 않는다.
- carry-forward, back-fill, smoothing을 하지 않는다.
- 음수 차이를 임의로 0으로 clamp하지 않는다.
- 원본 계기 보정이나 counter 감소가 발견되면 missing 처리하고 QC count/warning을 남긴다.
- Int16 범위를 초과하면 overflow시키지 말고 missing 처리 후 count를 남긴다.
- 오늘의 partial pack도 전일 완성 자료가 없으면 RN_24HR을 만들지 않고 원인을 명시한다.

성능상 필요하다면 관측소별 전일 `23:59` 값과 1,440개 전일 minute 값을 메모리에 index하여 O(frame × station)으로 계산한다.

## 4. 변수 레지스트리

권장 정의 예시:

```js
RN_24HR: {
  jsonField: null,
  slug: 'rn_24hr_rolling',
  unit: 'mm',
  scale: 0.1,
  accumulation: { type: 'rolling', windowMinutes: 1440 },
  derive: deriveRolling24hFromDayCounters,
  encode: encodeRainToI16
},
RN_DAY: {
  jsonField: ['RN_DAY', 'RN_24HR'], // 두 번째는 legacy JSON fallback
  slug: 'rn_day',
  unit: 'mm',
  scale: 0.1,
  accumulation: { type: 'day', timezone: 'Asia/Seoul', resetTime: '00:00' },
  encode: encodeRainToI16
}
```

저장 slug는 구현에 맞게 조정할 수 있지만, legacy 일 누적 RN_24HR binary와 true rolling RN_24HR binary가 동일한 immutable URL을 사용하면 안 된다.

## 5. Pack 경로와 immutable cache

기존 `rn_24hr/1m/.../rn_24hr.i16le`에는 일 누적 자료가 배포된 적이 있다. 같은 URL의 파일만 교체하면 CDN/browser immutable cache가 과거 의미의 binary를 계속 반환할 수 있다.

따라서 true rolling RN_24HR은 반드시 새로운 asset URL을 사용한다. 예:

```text
/datasets/aws/rn_24hr_rolling/1m/{YYYYMMDD}/rn_24hr.i16le
/datasets/aws/rn_day/1m/{YYYYMMDD}/rn_day.i16le
```

API 변수명은 각각 `RN_24HR`, `RN_DAY`로 유지한다. 저장 slug만 cache 충돌 방지를 위해 다르게 둘 수 있다.

필수 사항:

- RN_24HR `datasetId`와 binary URL을 새로 발급한다.
- binary SHA-256을 새로 계산한다.
- 필요하면 `contractRevision` 또는 schemaVersion을 올린다.
- consumer는 schemaVersion 3 이상을 허용하므로 schemaVersion 4 사용도 가능하다.
- `force=1`은 manifest와 pack을 재생성해야 하지만, cache 무효화 수단으로만 의존하지 않는다.
- 과거 complete pack의 새 URL에는 immutable cache를 적용할 수 있다.
- 오늘 partial pack은 기존 정책대로 `no-store` 또는 revision URL을 사용한다.

## 6. Manifest 요구사항

### RN_24HR

```json
{
  "variable": "RN_24HR",
  "sourceField": "derived:RN-DAY",
  "unit": "mm",
  "intervalMinutes": 1,
  "accumulation": {
    "type": "rolling",
    "windowMinutes": 1440
  },
  "dependency": {
    "sourceVariable": "RN_DAY",
    "requiresPreviousDay": true
  }
}
```

### RN_DAY

```json
{
  "variable": "RN_DAY",
  "sourceField": "RN-DAY",
  "unit": "mm",
  "intervalMinutes": 1,
  "accumulation": {
    "type": "day",
    "timezone": "Asia/Seoul",
    "resetTime": "00:00"
  }
}
```

두 manifest 모두 기존 필수 필드와 다음 QC 통계를 유지한다.

- `schemaVersion`, `datasetId`, `from`, `to`
- `frameCount`, `stationCount`, `stations`
- `complete`, `dataComplete`, `generatedAt`
- `missingTimestamps`, `validSampleCount`, `missingSampleCount`, `validRatio`
- `data.url`, `dtype`, `endianness`, `order`, `scale`, `offset`, `missingValue`, `byteLength`, `sha256`
- rolling 계산 결측 원인별 count

## 7. CLI 및 backfill 변경

지원 변수 목록에 `RN_DAY`를 추가한다.

```text
TA,RN_15M,RN_60M,RN_12HR,RN_24HR,RN_DAY
```

사용 예:

```bash
# 전일 dependency를 포함해 RN_24HR과 RN_DAY 생성
node kma_fetch/warm_aws_min_packs.js \
  --from 20260701 --to 20260817 \
  --variables RN_24HR,RN_DAY \
  --force
```

요구사항:

- RN_24HR 생성 전에 범위 첫날의 전일 JSON 존재 여부를 검사한다.
- 전일 자료가 없으면 해당 날짜만 명확한 `dependency-missing`으로 실패 처리한다.
- RN_DAY는 기존 JSON의 legacy `RN_24HR` 필드를 이용해 pack 생성 가능하다.
- 날짜·변수별 `built/cache/complete/incomplete/dependency-missing/error` 요약을 출력한다.
- 한 날짜/변수 실패가 다른 성공 산출물을 훼손하지 않게 한다.
- 임시 파일 생성 후 atomic rename한다.
- 기존 legacy RN_24HR pack을 새 rolling 결과로 잘못 재사용하지 않도록 cache 판별에 contract revision을 포함한다.

## 8. HTTP API 변경

동일 endpoint에서 다음을 지원한다.

```http
GET /api/aws/min/pack?date=20260817&variable=RN_24HR
GET /api/aws/min/pack?date=20260817&variable=RN_DAY
```

지원 변수 오류 응답 목록에도 `RN_DAY`를 추가한다.

RN_24HR 응답은 반드시 다음을 만족해야 한다.

```text
manifest.variable == RN_24HR
manifest.accumulation.type == rolling
manifest.accumulation.windowMinutes == 1440
manifest.data.url != legacy day-accumulation RN_24HR URL
```

RN_DAY 응답은 반드시 다음을 만족해야 한다.

```text
manifest.variable == RN_DAY
manifest.accumulation.type == day
manifest.accumulation.timezone == Asia/Seoul
```

## 9. 필수 테스트

### 단위 테스트

- 전일 같은 시각 이후 강수 + 당일 현재까지 강수가 정확히 합산되는지 확인한다.
- 무강수 24시간은 0.0mm이며 missing이 아닌지 확인한다.
- 자정 전후에도 RN_24HR이 reset되지 않는지 확인한다.
- RN_DAY는 KST 자정에 reset되는지 확인한다.
- 전일 dependency 또는 세 구성값 중 하나가 결측이면 RN_24HR이 missing인지 확인한다.
- counter 감소를 0으로 clamp하지 않고 missing/QC 처리하는지 확인한다.
- frame/station order와 byteLength가 기존 pack 계약과 같은지 확인한다.
- 기존 RN_15M, RN_60M, RN_12HR pack 결과가 변경되지 않는지 회귀 테스트한다.

### 실제 자료 검증

2026-08-16~17 거제 집중호우 자료를 우선 검증한다.

- 2026-08-17 자정 직후 RN_DAY가 작아지거나 0에 가까워지는지 확인한다.
- 같은 시각 RN_24HR은 자정에 급격히 0으로 reset되지 않는지 확인한다.
- 유효한 동일 시각에서 일반적으로 `RN_12HR <= RN_24HR`인지 통계 확인하고 예외를 보고한다.
- 원본 JSON 임의 20개 `(TM, STN_ID)`에 대해 위 계산식과 binary decode 결과 parity를 확인한다.
- RN_24HR과 RN_DAY가 서로 다른 값을 갖는 자정 이후 사례를 테스트 fixture로 고정한다.

## 10. 배포 후 HTTP 검증

아래처럼 cache-busting 값을 매번 다르게 호출한다.

```bash
curl -sS "https://weather-map.sbs.co.kr/api/aws/min/pack?date=20260817&variable=RN_24HR&cacheburst=rn24-v2-a"
curl -sS "https://weather-map.sbs.co.kr/api/aws/min/pack?date=20260817&variable=RN_DAY&cacheburst=rnday-v1-a"
```

추가 검증:

1. manifest의 `variable`, `sourceField`, `accumulation` 확인
2. 두 응답의 `data.url`이 서로 다르고 legacy RN_24HR URL과도 다른지 확인
3. binary `byteLength == frameCount * stationCount * 2`
4. binary SHA-256이 manifest와 일치
5. `force=1&cacheburst=<새 값>` 호출 후에도 의미 계약이 동일
6. 일반 호출과 cache-busting 호출이 동일 datasetId/SHA를 반환
7. complete 과거 pack의 Cache-Control/ETag, 오늘 partial pack의 갱신 정책 확인

## 11. 문서 동기화

같은 변경에서 다음 문서와 skill을 갱신한다.

- `docs/openapi.yaml`
- `skills/weather-api-catalog/SKILL.md`
- `skills/weather-api-catalog/references/endpoints.md`
- `skills/aws-min-json-pipeline/SKILL.md`
- `skills/aws-min-json-pipeline/references/formats.md`
- `skills/aws-min-json-pipeline/references/paths-and-schema.md`
- 기존 RN_24HR을 RN-DAY로 설명한 문서와 테스트 fixture

## 12. 완료 보고 형식

구현 완료 시 다음을 함께 보고한다.

- 변경한 파일 목록
- RN_24HR 계산식과 timestamp 경계 정의
- legacy RN_24HR cache 충돌을 피한 방법
- RN_DAY migration/backfill 방법
- 날짜·변수별 pack 생성 결과
- 단위/통합 테스트 결과
- 실제 2026-08-16~17 parity 및 자정 경계 결과
- 배포 URL, datasetId, SHA-256, Cache-Control/ETag 확인 결과
- 남은 결측 또는 원천 자료 제약
