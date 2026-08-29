# Producer TA 품질관리 보강 요청

작성일: 2026-08-29
대상 repo: `D:\002.Code\002.node\weather_api`
consumer 임시 방어선: `weather-bars-instanced` commit `05e9841`

## 배경

2026-08-28 AWS TA pack에서 `강원특별자치도 · 양구군 · 방산(STN_ID 587)`의 고온 이상값이 화면과 극값 산정에 노출됐다.

운영 확인 결과:

- `GET /api/aws/min/exact?timestamp_kor=202608281716`
  - 방산 `TA=240`, 즉 `24.0℃`
  - 응답 컬럼에는 공식 품질 플래그 또는 QC 상태 컬럼이 없음
- `GET /api/aws/min/pack?date=20260828&variable=TA`
  - manifest: `schemaVersion=4`, `contractRevision=8`
  - `qc.taTemporal.enabled=true`
  - `qc.taTemporal.excludedSampleCount=1518`
  - binary: `/datasets/aws/ta/1m/20260828/ta-v3e64a6c4.i16le`

문제는 pack의 일부 원시 TA anchor가 여전히 유효값으로 남는다는 점이다.

관측된 방산 고온 anchor:

| 시각(KST) | TA | 비고 |
| --- | ---: | --- |
| 2026-08-28 12:01 | 45.0℃ | 45℃ hard limit 안쪽/경계 |
| 2026-08-28 12:15 | 44.7℃ | 45℃ hard limit 안쪽 |
| 2026-08-28 12:40 | 47.4℃ | consumer plausibility에서 무효 |
| 2026-08-28 13:20 | 49.1℃ | consumer plausibility에서 무효 |
| 2026-08-28 13:21 | 49.3℃ | consumer plausibility에서 무효 |
| 2026-08-28 13:22 | 48.6℃ | consumer plausibility에서 무효 |
| 2026-08-28 13:23 | 47.7℃ | consumer plausibility에서 무효 |

이 중 `44.7℃`, `45.0℃`는 현재 consumer의 물리 범위 `[-50, 45]℃`를 통과한다. 이후 방산의 상당 구간이 producer pack에서 결측 처리되면서, consumer의 range 조합 로직이 마지막 유효값을 carry-forward 해 17시대에도 `44.7℃`가 보였다.

방재센터에서는 이 값을 최고기온으로 산정하지 않았으므로, producer 단계에서 공식 품질 플래그 또는 더 강한 TA QC 계약을 반영해야 한다.

## 현재 producer 계약의 한계

현재 `weather_api` 기준:

- `/api/aws/min/exact`와 디스크 JSON은 원천을 유지한다.
- TA temporal QC는 `/api/aws/min/pack` 전용이다.
- manifest에는 `qc.taTemporal` 집계 정보만 있고, TA per-sample QC detail은 없다.
- 강수 `RN_DAY`/`RN_24HR`에는 `qcDetailUrl` sidecar가 있으나, TA에는 대응 sidecar가 없다.
- `kma_fetch/utils/db.js`의 `queryAwsMin`은 `wx_AWS_MIN`에서 관측값 컬럼만 select하며, 품질 플래그 후보 컬럼은 select하지 않는다.
- `kma_fetch/services/aws_apihub_min.js`의 API Hub text parser도 `TA/HM/PA/PS/TD/RN/WS/WD` 계열 값만 DB shape으로 만든다.

현재 TA pack QC는 대략 다음 규칙이다.

- 인코딩 전 결측:
  - `null`
  - sentinel `-999`
  - Hub 물리 `<= -50℃`
  - `> 60℃`
- pack temporal QC:
  - 직전 유효 분 대비 `|ΔTA| > 3℃`
  - 양 이웃이 비슷하고 가운데만 크게 튀는 고립 스파이크

이 규칙은 `44.7℃`처럼 hard limit 안쪽이고, 이전 유효값도 이미 비정상 anchor인 경우를 놓칠 수 있다.

## 요청 목표

1. TA pack에서 방산 2026-08-28 케이스가 일최고/순위/기준 이상 산정에 들어오지 않게 한다.
2. 공식 품질 플래그가 DB 또는 API Hub 원천에 있으면 producer가 이를 보존·노출한다.
3. 공식 플래그가 없더라도 TA pack QC가 sparse outlier 케이스를 제거한다.
4. 왜 제거됐는지 운영자가 추적할 수 있도록 TA도 QC detail을 제공한다.
5. consumer가 임시 방어선을 제거하거나 완화할 수 있게 contract revision을 올리고 문서를 갱신한다.

## 구현 요구사항

### 1. 원천 품질 플래그 확인

먼저 `wx_AWS_MIN` 또는 관련 테이블에 TA 품질 컬럼이 있는지 확인한다.

확인 대상 예시:

- `TA_QC`
- `TA_QA`
- `TA_FLAG`
- `QC_FLAG`
- `QC`
- `ERR`
- `STATUS`
- `GRADE`
- 관측 요소별 품질/검사/보정 상태 컬럼

있다면:

- `kma_fetch/utils/db.js`의 `queryAwsMin`에 해당 컬럼을 추가한다.
- `/api/aws/min`, `/api/aws/min/exact`, `/api/aws/min/range` 응답에 품질 컬럼을 보존한다.
- TA pack 생성 시 공식 불량 플래그는 `-32768`로 인코딩한다.
- manifest `qc.taOfficialFlag` 또는 유사 필드에 사용한 컬럼명과 제외 개수를 기록한다.

없다면:

- 문서에 “현재 API Hub/DB shape에는 TA 공식 품질 플래그 없음”을 명시한다.
- 아래 producer-side heuristic QC를 적용한다.

### 2. TA sparse high outlier QC 추가

방산 케이스처럼 하루 중 유효 TA 샘플이 극히 적고, 남은 유효 anchor가 `44℃ 이상`인 경우를 제거한다.

권장 기본값:

```text
AWS_TA_QC_SPARSE_HIGH_DEGC=44
AWS_TA_QC_SPARSE_MAX_VALID_SAMPLES=30
```

판정:

- 대상: `variable=TA`
- station/day 단위로 producer temporal QC 이후 유효 TA 샘플 수를 계산한다.
- 하루 유효 TA 샘플 수가 `30개 이하`이고,
- 그 station/day에 `44.0℃ 이상` TA가 있으면,
- 해당 station/day의 `44.0℃ 이상` 샘플을 `-32768`로 제외한다.

주의:

- 정상적으로 하루 대부분을 관측한 station의 44℃ 이상 값은 이 규칙만으로 제거하지 않는다.
- 공식 품질 플래그가 있으면 heuristic보다 우선한다.
- threshold와 sample count는 env로 조정 가능하게 둔다.

### 3. 첫 유효값/긴 결측 후 재출현 QC 보강

현재 temporal QC는 “직전 유효값”이 이미 비정상 anchor일 때 연쇄적으로 오염될 수 있다. 다음 보강을 검토한다.

- 긴 결측 후 첫 유효 TA가 주변 관측소 또는 station-day 중앙값과 크게 다르면 suspect 처리
- `TD`, `PS` 등 주요 동반 컬럼이 동시에 `null`인 고온 TA는 suspect 가중
- 이슬점 `TD`가 비현실적으로 높거나 TA/HM/TD 조합이 물리적으로 어색한 경우 suspect 가중
- 같은 station에서 `44℃ 이상` 고온이 매우 드문 sparse episode로만 나타나면 reject

권장 상태값:

- `valid`
- `suspect-retained`
- `rejected`
- `official-flag-rejected`
- `sparse-high-rejected`
- `temporal-jump-rejected`
- `isolated-spike-rejected`

### 4. TA QC detail sidecar 추가

강수 QC처럼 TA도 sparse QC detail을 제공한다.

> **경로 우선순위**: 초안 예시의 `/datasets/aws/qc/ta/...`는 무효. 최종 합의(`docs/ta-pack-qc-agreement-final.md`)대로 **`/datasets/aws/ta/1m/{day}/qc-v{sha16}.json`** (RN 패턴, `packQcDetailUrl`)을 사용한다.

manifest 예시:

```json
{
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
  "qcDetailUrl": "/datasets/aws/ta/1m/20260828/qc-v{sha16}.json",
  "qcDetailSha256": "{sha256}"
}
```

QC detail record 예시:

```json
{
  "TM": "202608281215",
  "STN_ID": 587,
  "variable": "TA",
  "rawValue": 447,
  "valueC": 44.7,
  "state": "rejected",
  "reason": "sparse-high",
  "signals": [
    "station_valid_samples_lte_30",
    "ta_gte_44c"
  ],
  "stationValidSampleCount": 7
}
```

요구사항:

- `qcDetailUrl`은 content-addressed immutable 파일로 발행한다.
- `qcDetailSha256`은 다운로드 원문 JSON bytes 기준 SHA-256과 일치해야 한다.
- manifest는 binary와 qc detail이 모두 publish된 뒤 마지막에 원자적으로 교체한다.
- TA에 sidecar를 추가하더라도 기존 binary layout은 유지한다.

### 5. contract/schema 갱신

권장:

- `contractRevision`을 `9`로 올린다.
- `schemaVersion`은 binary layout이 그대로면 유지 가능하나, consumer가 TA QC detail을 필수로 보게 할 경우 schema 또는 contract 중 하나는 반드시 올린다.
- `docs/openapi.yaml`
- `skills/weather-api-catalog/SKILL.md`
- `skills/weather-api-catalog/references/endpoints.md`
- 필요 시 consumer 문서

문서에 명시할 것:

- `/exact`는 원천 보존
- `/pack`은 QC 적용 산출물
- TA pack은 `qc.taTemporal`과 선택적/필수 `qcDetailUrl`을 제공
- TA sparse high QC 기준값
- 공식 품질 플래그 사용 여부

### 6. 운영 재생성

producer 수정 후 다음 날짜는 강제 재생성한다.

우선 대상:

- `20260828` `TA`

권장 추가 대상:

- 2026년 여름 고온 사례 기간
- 최근 14일 TA pack

재생성 후 manifest의 `datasetId`, `data.url`, `data.sha256`이 바뀌어야 한다.

## 검증 기준

### API/pack 검증

`GET /api/aws/min/exact?timestamp_kor=202608281215`

- 원천 보존 정책이면 방산 `TA=447`이 그대로 남아 있어도 된다.
- 단, 공식 품질 컬럼이 있으면 응답에 함께 노출되어야 한다.

`GET /api/aws/min/pack?date=20260828&variable=TA`

- `contractRevision >= 9`
- `qc.taTemporal.sparseHighExcludedSampleCount >= 2`
- `qcDetailUrl` 존재
- `qcDetailUrl` 다운로드 성공
- QC detail에 최소 다음 record 존재:
  - `STN_ID=587`, `TM=202608281201`, `rawValue=450`
  - `STN_ID=587`, `TM=202608281215`, `rawValue=447`

binary 직접 검증:

- STN_ID 587, 2026-08-28 12:01 → `-32768`
- STN_ID 587, 2026-08-28 12:15 → `-32768`
- STN_ID 587, 2026-08-28 17:16 → `-32768` 또는 실제 원천 24.0℃를 producer가 재수용할 경우 `240`
- 2026-08-28 일최고 TOP10에 방산 44.7℃/45.0℃/49℃대가 없어야 한다.

### consumer 표시 검증

producer 수정 배포 후 `weather-bars-instanced`에서:

- 2026-08-28 시간재생 17시대 방산 카드에 `44.7℃`가 나오지 않아야 한다.
- 2026-08-28 일 최고기온 극값 조회 TOP10에 방산 49.3℃가 나오지 않아야 한다.
- 고온 기준 이상 판의 시도 비컨/카드/순위가 방산 이상값을 선택하지 않아야 한다.
- 기존 강수 `RN_*` QC와 단위/range는 변하지 않아야 한다.

## consumer 임시 방어선 제거 조건

현재 consumer에는 다음 임시 방어선이 있다.

- station/day 유효 TA 샘플 수가 매우 적고
- `44℃ 이상` anchor가 남아 있으면
- 해당 고온 anchor를 관측/표시/극값 계산에서 제외

producer가 다음 조건을 만족하면 consumer 방어선을 제거하거나 비활성화할 수 있다.

- `contractRevision >= 9`
- TA `qcDetailUrl` 제공
- 방산 2026-08-28 재현 케이스 통과
- 최근 고온 기간 pack 재생성 완료
- 운영 consumer에서 오래된 IndexedDB pack을 무시할 수 있도록 `datasetId`/contract 기준 캐시 갱신 확인

## 비고

이번 문제는 단순히 `45℃ hard limit`를 낮추는 것만으로는 충분하지 않다. 값 자체가 44.7℃처럼 임계 안쪽에 있을 수 있고, 긴 결측·동반 컬럼 이상·station/day sparse 패턴과 함께 봐야 한다. 가장 좋은 해법은 방재센터가 사용하는 공식 품질 판정 컬럼을 producer API 계약에 포함하는 것이다. 공식 플래그를 받을 수 없다면, TA pack 전용 QC detail과 sparse high heuristic을 producer에서 명시적으로 관리해야 한다.
