# AWS 강수 1분 pack Producer 구현 요청서

작성일: 2026-08-13 KST  
대상 저장소: `weather_api`  
요청 프로젝트: `weather-bars-instanced`

## 1. 목표

기존 AWS 1분 JSON과 pack 파이프라인을 확장해 아래 강수 누적 변수를 일자별 Int16 binary pack으로 제공한다.

| APIHUB 원본 | 저장 JSON 필드 | pack 변수 | 의미 | 단위 |
| --- | --- | --- | --- | --- |
| `RN-15m` | `RN_15M` | `RN_15M` | 최근 15분 누적강수량 | mm |
| `RN-60m` | `RN_60M` | `RN_60M` | 최근 60분 누적강수량 | mm |
| `RN-12H` | `RN_12HR` | `RN_12HR` | 최근 12시간 누적강수량 | mm |
| `RN-DAY` | `RN_24HR` | `RN_24HR` | 당일 누적강수량 | mm |

`RE`/`RN_YN`은 pack 대상에서 제외한다. 확인한 APIHUB 샘플에서는 736개 관측소 모두 `RE=-99.9`였으므로 강수 여부를 판단하는 필수 신호로 사용할 수 없다.

원본 확인 자료:

- consumer 저장소: `docs/nph-aws2_min_202608131200.txt`
- producer 저장소: `skills/aws-min-json-pipeline/assets/nph-aws2_min_202608131200.txt`

## 2. 반드시 먼저 수정할 수집 문제

현재 `kma_fetch/services/aws_apihub_min.js`의 `apiRowToDbShape()`는 다음과 같이 동작한다.

- `RN-15m` → `RN_15M`: 저장함
- `RN-60m` → `RN_60M`, `RN_1HR`: 저장함
- `RN-12H` → 저장하지 않음
- `RN-DAY` → `RN_24HR`: 저장함
- `RN_12HR`: 항상 `null`

따라서 APIHUB의 `parts[12]`를 읽어 `RN_12HR: scale10(rn12)`로 저장하도록 아래 두 변환기를 함께 수정한다.

- `kma_fetch/services/aws_apihub_min.js`
- `work/fetch_aws_apihub.js`

`RN_1HR`는 기존 consumer 호환을 위해 당장은 유지할 수 있지만, 원본 변수가 아니라 `RN-60m`의 별칭임을 코드와 문서에 명시한다. 신규 pack 이름에는 `RN_1HR`를 사용하지 않는다.

### 기존 1분 JSON에 대한 영향

서버에 이미 저장된 `AWS_MIN_*.json`에는 `RN_15M`, `RN_60M`, `RN_24HR`가 있으므로 이 세 변수는 즉시 pack 재생성이 가능하다.

반면 `RN_12HR`가 `null`인 기존 JSON에서는 12시간 누적값을 복원할 수 없다. `RN_12HR` 대상 기간은 변환기 수정 후 APIHUB에서 다시 받아 기존 JSON을 교체해야 한다. 15분 또는 60분 이동누적값을 합산해 12시간 값을 만들면 중복 합산되므로 금지한다.

## 3. Backfill 스크립트 변경

기존 `kma_fetch/backfill_aws_min.js`는 파일이 있으면 건너뛴다. 다음 중 하나를 구현한다.

권장 방식:

```text
--refresh-fields RN_12HR
```

- 기존 JSON이 있어도 해당 필드가 없거나 `null`이면 APIHUB를 다시 호출한다.
- 받은 전체 station row를 기존 JSON과 `STN_ID` 기준 병합하거나, APIHUB 결과로 안전하게 교체한다.
- 이미 유효한 `RN_12HR`가 있으면 건너뛴다.
- 실행을 재시도해도 결과가 동일한 idempotent 작업이어야 한다.
- DB fallback으로 `RN_12HR`를 채우지 말고 이 작업은 `AWS_FETCH_SOURCE=hub`로 실행한다.

구현이 복잡하면 최소한 다음 옵션을 제공한다.

```text
--force-refetch
```

- 지정 날짜 범위의 기존 1분 JSON을 APIHUB 응답으로 다시 저장한다.
- 임시 파일에 쓴 뒤 atomic rename하여 중간 파일 노출을 막는다.
- 원본 파일을 먼저 일괄 삭제하는 방식은 사용하지 않는다.

예상 운영 명령 예시:

```bash
AWS_FETCH_SOURCE=hub node kma_fetch/backfill_aws_min.js \
  --from 20260801 --to 20260813 \
  --refresh-fields RN_12HR \
  --skip-pack
```

실제 CLI 형식은 기존 스크립트 계약에 맞춰도 되지만 동일 기능은 제공해야 한다.

## 4. Pack builder 일반화

현재 `kma_fetch/utils/aws_min_pack.js`는 TA 전용이다. TA의 기존 동작을 깨지 않으면서 변수 정의 기반 builder로 일반화한다.

권장 변수 레지스트리 예시:

```js
const PACK_VARIABLES = {
  TA: {
    jsonField: 'TA',
    slug: 'ta',
    unit: 'degC',
    scale: 0.1,
    encode: encodeTaToI16,
    temporalQc: 'ta'
  },
  RN_15M: {
    jsonField: 'RN_15M',
    slug: 'rn_15m',
    unit: 'mm',
    scale: 0.1,
    accumulation: { type: 'rolling', windowMinutes: 15 },
    encode: encodeRainToI16
  },
  RN_60M: {
    jsonField: 'RN_60M',
    slug: 'rn_60m',
    unit: 'mm',
    scale: 0.1,
    accumulation: { type: 'rolling', windowMinutes: 60 },
    encode: encodeRainToI16
  },
  RN_12HR: {
    jsonField: 'RN_12HR',
    slug: 'rn_12hr',
    unit: 'mm',
    scale: 0.1,
    accumulation: { type: 'rolling', windowMinutes: 720 },
    encode: encodeRainToI16
  },
  RN_24HR: {
    jsonField: 'RN_24HR',
    slug: 'rn_24hr',
    unit: 'mm',
    scale: 0.1,
    accumulation: { type: 'day', timezone: 'Asia/Seoul' },
    encode: encodeRainToI16
  }
};
```

기존 공개 함수가 다른 코드에서 사용 중이면 wrapper를 유지한다.

- `buildAwsTaPack()` → 내부적으로 범용 `buildAwsVariablePack(..., 'TA')` 호출
- `publishAwsTaPack()` → 기존 동작 유지
- `warmAwsDayPack()` → 기본값 `TA`를 유지하되 `variables` 옵션 허용

### 강수 인코딩 규칙

저장 JSON은 이미 물리값의 10배 정수이므로 그대로 Int16에 기록한다.

```text
JSON 0      → binary 0      → 0.0 mm
JSON 15     → binary 15     → 1.5 mm
null        → -32768
비숫자      → -32768
JSON <= -500 → -32768
JSON < 0    → -32768
```

추가 규칙:

- 결측 sentinel은 모든 변수에서 `-32768`로 통일한다.
- 음수 강수량은 유효값으로 취급하지 않는다.
- 강수값에 TA 전용 급변/스파이크 temporal QC를 적용하지 않는다.
- carry-forward, back-fill, smoothing, clipping을 하지 않는다.
- 물리 상한을 둘 경우 임의로 정하지 말고 근거와 제외 건수를 manifest에 기록한다.
- Int16 범위를 넘는 값은 조용히 overflow시키지 말고 missing 처리 후 warning/count를 남긴다.

## 5. 산출물 경로와 manifest

변수별 독립 binary를 유지한다.

```text
out_data/aws/pack/ta/1m/{YYYYMMDD}/ta.i16le
out_data/aws/pack/rn_15m/1m/{YYYYMMDD}/rn_15m.i16le
out_data/aws/pack/rn_60m/1m/{YYYYMMDD}/rn_60m.i16le
out_data/aws/pack/rn_12hr/1m/{YYYYMMDD}/rn_12hr.i16le
out_data/aws/pack/rn_24hr/1m/{YYYYMMDD}/rn_24hr.i16le
```

각 디렉터리에 `manifest.json`을 둔다. binary layout은 기존 TA와 동일하다.

```text
dtype        = int16
endianness   = little
order        = FRAME_MAJOR_STATION_MINOR
scale        = 0.1
offset       = 0
missingValue = -32768
```

강수 manifest에는 다음을 명시한다.

- `source: "KMA_APIHUB_nph-aws2_min"`
- `variable`: `RN_15M | RN_60M | RN_12HR | RN_24HR`
- `sourceField`: `RN-15m | RN-60m | RN-12H | RN-DAY`
- `unit: "mm"`
- `intervalMinutes: 1`
- `accumulation.type`: `rolling | day`
- rolling이면 `accumulation.windowMinutes`
- day이면 `accumulation.timezone: "Asia/Seoul"`
- 기존 필수 필드인 `schemaVersion`, `datasetId`, `from`, `to`, `frameCount`, `stationCount`, `stations`, `complete`, `generatedAt`, `missingTimestamps`, `data.*`
- 변수별 `validSampleCount`, `missingSampleCount` 또는 이에 준하는 QC 통계

TA manifest와 binary의 하위 호환을 유지할 수 있다면 schemaVersion은 현재 값을 유지한다. 공통 schema의 필수 의미가 바뀌면 version을 올리고 기존 완성 pack이 자동 재생성되게 한다.

## 6. Pack 재생성 CLI

`warm_aws_ta_pack.js`를 범용 이름으로 교체하거나 신규 스크립트를 추가한다.

권장 이름:

```text
kma_fetch/warm_aws_min_packs.js
```

필수 사용 예:

```bash
# 하루, 모든 지원 변수
node kma_fetch/warm_aws_min_packs.js 20260812 \
  --variables TA,RN_15M,RN_60M,RN_12HR,RN_24HR

# 기간, 강수만 강제 재생성
node kma_fetch/warm_aws_min_packs.js \
  --from 20260801 --to 20260812 \
  --variables RN_15M,RN_60M,RN_12HR,RN_24HR \
  --force

# 기존 서버 1분 JSON 위치를 명시
node kma_fetch/warm_aws_min_packs.js \
  --from 20260801 --to 20260812 \
  --json-dir /data/node_project/weather_data/in_data/aws \
  --variables RN_15M,RN_60M,RN_24HR
```

요구사항:

- `--variables` 생략 시 기존 호환을 위해 `TA`만 생성해도 된다.
- 변수 하나의 실패가 성공한 다른 변수의 산출물을 훼손하지 않아야 한다.
- 날짜·변수별 `built/cache/complete/incomplete/error` 요약을 출력한다.
- `--force`가 없으면 같은 schemaVersion의 완성 pack은 재사용한다.
- backfill 종료 후 선택한 변수 pack을 자동 warm할 수 있게 한다.
- 기존 `warm_aws_ta_pack.js`는 wrapper로 남겨 기존 운영 명령을 보호한다.

## 7. HTTP API 변경

기존 endpoint를 확장한다.

```http
GET /api/aws/min/pack?date=20260812&variable=RN_60M
```

지원 변수:

```text
TA, RN_15M, RN_60M, RN_12HR, RN_24HR
```

규칙:

- `variable` 생략 시 기존과 동일하게 `TA`.
- 우선 단일 변수 요청을 확실하게 지원한다.
- 복수 변수 요청을 지원한다면 하나의 binary에 섞지 말고 변수별 manifest 또는 asset URL을 반환한다.
- `FULL`은 계속 지원하지 않는다.
- 미지원 변수는 400과 지원 목록을 반환한다.
- 과거 `complete:true` pack은 immutable cache와 ETag를 유지한다.
- 오늘의 부분 pack은 `no-store` 또는 revision 기반으로 갱신한다.

예상 정적 URL:

```text
/datasets/aws/rn_15m/1m/20260812/rn_15m.i16le
/datasets/aws/rn_60m/1m/20260812/rn_60m.i16le
/datasets/aws/rn_12hr/1m/20260812/rn_12hr.i16le
/datasets/aws/rn_24hr/1m/20260812/rn_24hr.i16le
```

## 8. 테스트 및 검증

### 단위 테스트

- APIHUB `parts[12]`가 `RN_12HR`의 ×10 정수로 저장되는지 확인한다.
- `-99.9`, `-99.7`, `-99.2`, `null`, 비숫자가 모두 `-32768`인지 확인한다.
- `0.0 mm`는 missing이 아니라 binary `0`인지 확인한다.
- 각 변수의 `byteLength === frameCount * stationCount * 2`인지 확인한다.
- frame/station 순서가 TA pack과 같은지 확인한다.
- 강수 pack에 TA temporal QC가 적용되지 않는지 확인한다.
- `RN_60M`과 호환 필드 `RN_1HR`가 같은 원본에서 생성되는지 확인한다.

### 원문 parity fixture

첨부한 `nph-aws2_min_202608131200.txt`를 fixture로 사용한다. 확인된 기대값:

| STN | RN_15M | RN_60M | RN_12HR | RN_24HR |
| ---: | ---: | ---: | ---: | ---: |
| 530 | 0.5 | 6.0 | 9.5 | 9.5 |
| 679 | 0.0 | 0.0 | 24.5 | 24.5 |
| 793 | 1.0 | 1.0 | 1.0 | 1.0 |

binary 기대값은 각각 물리값의 10배 정수다. 예: STN 530의 `RN_60M`은 `60`.

전체 샘플 기대 통계:

- station row: 736
- 강수 유효 row: 712
- 강수 결측 row: 24
- `RE` 유효 row: 0
- `RN_15M` 최대: 1.0 mm, STN 793
- `RN_60M` 최대: 6.0 mm, STN 530
- `RN_12HR` 최대: 24.5 mm, STN 679
- `RN_24HR` 최대: 24.5 mm, STN 679

### 기간 검증

단일 12:00 샘플에서는 `RN_12HR`와 `RN_24HR`가 모두 같았다. 두 변수가 별개로 동작하는지는 자정 전후와 18:00 자료를 포함한 기간 테스트로 확인한다.

- 유효한 같은 시각에서 일반적으로 `RN_15M <= RN_60M <= RN_12HR`인지 통계 확인
- `RN_24HR`의 KST 일 경계 초기화 확인
- 자정 이후 `RN_12HR`와 `RN_24HR`가 서로 달라지는 사례 확인
- 원본 JSON 임의 20개 `(TM, STN_ID)`와 binary decode 결과 parity 확인
- pack 생성기가 rolling 누적 필드를 프레임 간 재합산하지 않는지 확인

## 9. 문서 동기화

구현과 같은 변경에서 아래 문서를 갱신한다.

- `docs/openapi.yaml`
- `skills/weather-api-catalog/SKILL.md`
- `skills/weather-api-catalog/references/endpoints.md`
- `skills/aws-min-json-pipeline/SKILL.md`
- `skills/aws-min-json-pipeline/references/formats.md`
- `skills/aws-min-json-pipeline/references/paths-and-schema.md`
- 필요 시 `docs/aws-producer-1min-pack-requirements.md`

특히 기존 문서의 “현재 TA만 구현”, `RN_12HR: null`, `RN-60m → RN_1HR` 설명을 새 계약과 일치시킨다.

## 10. 완료 조건

- [ ] 신규 APIHUB 수집 JSON에 `RN_12HR`가 보존된다.
- [ ] 기존 서버 JSON에서 `RN_15M`, `RN_60M`, `RN_24HR` 과거 pack을 재생성할 수 있다.
- [ ] 필요한 과거 기간을 APIHUB로 재수집해 `RN_12HR`를 복구할 수 있다.
- [ ] 4개 강수 변수의 독립 Int16 LE pack과 manifest가 생성된다.
- [ ] `/api/aws/min/pack`에서 각 강수 변수를 조회할 수 있다.
- [ ] TA endpoint, TA binary, 기존 운영 명령의 하위 호환이 유지된다.
- [ ] 결측과 0 mm가 명확히 구분된다.
- [ ] fixture 및 실제 기간 parity 테스트가 통과한다.
- [ ] 과거 pack immutable cache와 오늘 부분 pack 갱신 정책이 유지된다.
- [ ] OpenAPI와 producer skill 문서가 구현과 동시에 갱신된다.

## Producer 에이전트용 한 줄 지시

> 기존 AWS 1분 JSON/TA pack 파이프라인을 변수 정의 기반으로 일반화해 APIHUB 원본 `RN-15m`, `RN-60m`, `RN-12H`, `RN-DAY`를 각각 `RN_15M`, `RN_60M`, `RN_12HR`, `RN_24HR` Int16 LE 일자 pack으로 제공하라. 먼저 누락 중인 `RN-12H(parts[12])` 저장을 수정하고 기존 JSON을 안전하게 강제 재수집할 backfill 옵션을 추가하며, 기존 TA 계약과 운영 명령은 유지하고 fixture parity·결측·cache·OpenAPI/skill 문서까지 검증하라.
