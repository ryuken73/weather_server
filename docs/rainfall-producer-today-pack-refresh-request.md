# 오늘자 AWS 강수 pack 자동 갱신 요청

## 목적

오늘 KST 날짜의 강수 pack이 없거나 오래되어 Consumer에서 실시간 강수 자료를 사용할 수 없는 문제를 해결한다.

Consumer의 legacy JSON fallback은 복원하지 않는다. Producer가 오늘 pack을 지속적으로 갱신하고, API는 생성된 pack manifest만 정적으로 반환하는 구조를 유지한다.

## 대상 변수

- `RN_15M`
- `RN_60M`
- `RN_12HR`
- `RN_24HR`
- `RN_DAY`

## 현재 확인된 문제

2026-08-23 기준:

- `RN_15M`, `RN_60M`, `RN_12HR`
  - `/api/aws/min/pack` 응답: `404 PACK_NOT_WARMED`
- `RN_24HR`, `RN_DAY`
  - manifest는 존재하지만 갱신이 오래되어 대부분의 현재 시각 구간이 결측
  - Consumer에서 `00:00~11:43` 요청 시 704프레임 중 602프레임 결측

현재 `/api/aws/min/range`의 2분 JSON에는 일부 강수 필드가 있지만 다음 이유로 Consumer fallback으로 사용하지 않는다.

- `RN_DAY`가 없음
- 1분 pack과 시간 해상도가 다름
- QC와 rolling 계산 계약이 다를 수 있음
- 날짜 비교·기간 분석·순위 결과가 pack과 달라질 수 있음
- 다수 Consumer가 대용량 JSON을 반복 요청할 수 있음

## 필수 구현

### 1. 오늘 pack 자동 갱신

KST 오늘 날짜의 원천 1분 JSON이 추가될 때마다, 또는 1~2분 주기로 오늘 pack을 갱신한다.

권장 흐름:

```text
신규 1분 JSON 도착 또는 scheduler 실행
→ 해당 날짜·변수의 기존 실행 여부 확인
→ 원천 JSON 목록 확인
→ 원천을 가능한 한 번만 읽고 정규화
→ 대상 변수 pack 생성
→ 임시 파일에 binary와 manifest 작성
→ binary atomic publish
→ manifest를 마지막에 atomic publish
```

### 2. 요청 경로에서는 rebuild 금지

`GET /api/aws/min/pack`은 계속 manifest-only로 유지한다.

- warm된 pack 존재: `200`
- pack 없음: `404 PACK_NOT_WARMED`
- 계약이 오래됨: `404 PACK_STALE`
- API 요청을 계기로 pack을 생성하거나 갱신하지 않음
- `force=1`은 운영자용 수동 경로에서만 허용

### 3. 중복 실행 방지

날짜와 변수 단위로 single-flight 또는 lock을 적용한다.

최소 lock key:

```text
YYYYMMDD + variable
```

가능하면 오늘 다섯 변수를 하나의 작업으로 갱신해 원천 JSON을 반복 파싱하지 않도록 한다.

동시에 같은 날짜 pack을 여러 작업이 생성하지 않아야 한다.

### 4. 메모리 제한

과거 OOM이 재발하지 않도록 다음을 지킨다.

- 요청별 rebuild 금지
- 무제한 `Promise.all` 금지
- 날짜·변수 생성 동시성 제한
- 원천 JSON 전체를 변수마다 다시 메모리에 올리지 않음
- 이전 작업 종료 전에 동일 날짜 작업 시작 금지
- 작업 전후 `rss`, `heapUsed`, 실행 시간 기록
- 실패 시 메모리와 lock이 반드시 해제되도록 `finally` 처리

### 5. 오늘 pack 계약

오늘 pack은 다음 계약을 사용한다.

```json
{
  "complete": false,
  "from": "YYYYMMDD0000",
  "to": "현재 실제로 이용 가능한 최근 1분",
  "intervalMinutes": 1
}
```

주의:

- 미래 시각은 유효 프레임으로 취급하지 않음
- 아직 도착하지 않은 미래 구간을 일반 source missing과 혼동하지 않음
- 현재 시각 이전의 실제 결측만 QC 및 missing 통계에 포함
- 갱신마다 새로운 `datasetId`와 content-addressed binary 파일명 사용
- manifest는 `no-store` 또는 항상 revalidate
- binary는 content-addressed immutable cache 가능

Consumer는 오늘 manifest를 항상 재검증한다.

### 6. 원자적 공개

불완전한 binary와 manifest 조합이 노출되지 않아야 한다.

권장 순서:

```text
binary.tmp 작성
→ 길이·SHA·decode 검증
→ binary 최종 경로 rename
→ manifest.tmp 작성
→ manifest 최종 경로 rename
```

manifest는 항상 완전히 공개된 binary만 가리켜야 한다.

### 7. 실패 처리

오늘 갱신이 실패하면:

- 직전 정상 pack 유지
- 기존 manifest와 binary를 삭제하거나 덮어쓰지 않음
- API는 직전 정상 revision을 계속 반환
- 실패 원인, 날짜, 변수, 원천 마지막 시각 기록
- 다음 scheduler 실행에서 재시도

### 8. 변수별 의미 유지

- `RN_15M`: rolling 15분
- `RN_60M`: rolling 60분
- `RN_12HR`: rolling 720분
- `RN_24HR`: rolling 1440분
- `RN_DAY`: KST 00:00부터 누적

`RN_24HR`과 `RN_DAY`를 같은 값이나 같은 의미로 처리하지 않는다.

기존 contract revision 8의 QC 정책을 그대로 적용한다.

### 9. 전일 의존성

`RN_24HR`은 오늘 00:00 직후에도 전일 자료가 필요하다.

- 전일 RN_DAY/원천 자료가 준비된 후 계산
- 전일 의존성이 없으면 잘못된 0 또는 당일 누적으로 대체하지 않음
- 의존성 부족을 manifest/QC에 명확히 기록
- dependency missing 상태가 해결되면 다음 warm에서 자동 복구

## 권장 실행 방식

다음 중 현재 Producer 구조에 맞는 방식을 선택한다.

### 방식 A: 원천 JSON 수신 후 trigger

신규 1분 JSON 저장이 성공한 뒤 오늘 pack warm job을 enqueue한다.

장점:

- 원천 도착과 pack 갱신 간 지연이 짧음

필수 조건:

- debounce
- single-flight
- 원천 파일 저장 완료 후 실행

### 방식 B: 1~2분 scheduler

KST 오늘 날짜를 대상으로 주기적으로 warm한다.

장점:

- 구현과 장애 복구가 단순함
- 이전 실행 실패도 다음 주기에 자동 복구

권장 초기 구현은 방식 B이며, 안정화 후 A를 추가해도 된다.

## 상태 관측

로그 또는 상태 JSON에 다음 정보를 남긴다.

```json
{
  "date": "YYYYMMDD",
  "variables": ["RN_15M", "RN_60M", "RN_12HR", "RN_24HR", "RN_DAY"],
  "sourceAvailableThrough": "YYYYMMDDHHmm",
  "publishedThrough": "YYYYMMDDHHmm",
  "startedAt": "...",
  "finishedAt": "...",
  "durationMs": 0,
  "rssBefore": 0,
  "rssAfter": 0,
  "heapUsedBefore": 0,
  "heapUsedAfter": 0,
  "lockWaitMs": 0,
  "result": "updated|unchanged|failed"
}
```

신규 원천이 없으면 binary를 다시 생성하지 않고 `unchanged`로 종료할 수 있어야 한다.

## 검증 요청

구현 후 오늘 날짜에 대해 다음 결과를 전달한다.

### API 확인

각 변수:

```text
GET /api/aws/min/pack?date=오늘KST&variable=RN_15M
GET /api/aws/min/pack?date=오늘KST&variable=RN_60M
GET /api/aws/min/pack?date=오늘KST&variable=RN_12HR
GET /api/aws/min/pack?date=오늘KST&variable=RN_24HR
GET /api/aws/min/pack?date=오늘KST&variable=RN_DAY
```

확인 항목:

- 모두 `200`
- `complete:false`
- `intervalMinutes:1`
- `to` 또는 이에 준하는 available-through 값이 최신 원천 시각과 일치
- binary URL이 실제로 `200`
- `byteLength` 일치
- 갱신 후 `datasetId` 또는 binary content hash 변경
- manifest cache가 이전 revision을 고정하지 않음

### 갱신 확인

1. 신규 JSON 도착 전 manifest 확인
2. 신규 JSON 도착
3. scheduler/warm 완료
4. manifest 재요청
5. 최근 이용 시각과 binary revision이 전진했는지 확인

### 동시성 확인

동시에 여러 pack API 요청을 보내도:

- rebuild가 발생하지 않음
- warm job이 중복 실행되지 않음
- Node 메모리가 지속적으로 증가하지 않음
- API는 기존 정상 manifest를 안정적으로 반환

## 완료 보고에 포함할 내용

- 선택한 trigger 방식
- scheduler 주기
- lock/single-flight 구현 위치
- 오늘 pack 저장 경로
- manifest 및 binary cache header
- 신규 원천이 없을 때 동작
- 원자적 publish 방식
- OOM 방지 동시성 설정
- 오늘 다섯 변수 API 응답 요약
- warm 전후 메모리 측정값
