# Producer 구현 요청: 오늘자 전 기상요소 partial pack 자동 갱신

## 목적

현재 producer는 오늘(KST) 강수 JSON이 들어올 때 강수 pack을 갱신하고 있다. 이 구조를 `TA`와 향후 도입할 바람·적설을 포함한 모든 운영 기상요소로 확장한다.

Consumer는 모든 요소에서 pack API만 사용한다. 오늘 pack이 없을 때 legacy `/api/aws/min/range` JSON fallback은 사용하지 않는다.

## 핵심 원칙

1. 1분 원천 JSON 수집이 성공한 뒤 변경된 변수와 파생 변수를 판별한다.
2. 해당 변수의 오늘자 partial pack을 producer 백그라운드 작업으로 갱신한다.
3. binary와 QC 자산을 먼저 완성한 뒤 manifest를 마지막에 원자적으로 교체한다.
4. `/api/aws/min/pack` 요청은 디스크에 publish된 manifest만 반환한다.
5. API cache miss나 일반 조회 요청으로 pack을 rebuild하지 않는다.
6. 이전 publish가 정상이라면 갱신 실패 중에도 직전 정상 manifest를 계속 제공한다.

## 변수별 갱신 관계

| 원천 변경 | 갱신할 pack |
| --- | --- |
| `TA` | `TA` |
| `RN_15M` | `RN_15M` |
| `RN_60M` | `RN_60M` |
| `RN_12HR` | `RN_12HR` |
| `RN_DAY` | `RN_DAY`, 파생 `RN_24HR` |
| 향후 `WS_INS`, `WD_INS` | 순간풍속·풍향 관련 pack |
| 향후 적설 원천 변수 | 해당 적설 pack |

변수별 조건을 scheduler에 하드코딩으로 계속 추가하기보다, 다음 정보를 가진 registry 기반으로 구성한다.

```js
{
  variable: 'TA',
  sourceFields: ['TA'],
  dependencies: [],
  refreshToday: true
}
```

파생 변수는 dependency graph로 선언한다. 예를 들어 `RN_24HR`은 `RN_DAY` 변경 뒤 갱신한다.

## 오늘자 pack 계약

- KST 기준 오늘 날짜
- `complete: false`
- `from: YYYYMMDD0000`
- `to: YYYYMMDDHHmm`
  - 실제 수집과 검증이 끝난 마지막 1분
  - 미래 시각을 미리 생성하지 않는다.
- `frameCount`는 `00:00`부터 `to`까지 포함한 실제 프레임 수
- `intervalMinutes: 1`
- 변수별 현재 `contractRevision` 유지
- `datasetId`와 content-addressed binary/QC URL은 갱신할 때 바뀔 수 있음
- `to` 이후는 아직 도착하지 않은 자료이며 source missing으로 기록하지 않음

Consumer가 검증할 기본 관계:

```text
frameCount == KST minute index(to) + 1
```

예: `to=18:08`이면 `frameCount=1089`.

## publish 순서와 원자성

다음 순서를 지킨다.

1. 임시 경로에 binary 생성
2. binary 길이와 SHA 검증
3. 임시 경로에 QC JSON 생성
4. QC JSON 길이와 SHA 검증
5. content-addressed binary/QC 파일 publish
6. 모든 참조 자산에 HTTP 200이 가능한 상태인지 확인
7. manifest를 임시 파일로 생성
8. rename을 사용해 manifest를 원자적으로 교체

금지:

- manifest를 먼저 교체한 뒤 binary/QC를 생성하는 방식
- 아직 존재하지 않는 `data.url` 또는 `qcDetailUrl`을 manifest에 공개
- 실패한 작업이 직전 정상 manifest를 삭제하거나 덮어쓰는 동작

## 중복 실행 및 OOM 방지

과거 `/api/aws/min/pack` cache miss에서 concurrent rebuild가 발생해 Node OOM이 발생했다. 다음 안전장치를 필수 적용한다.

### API와 build 분리

- 일반 pack API 요청은 rebuild 금지
- `cacheburst`는 HTTP cache bust 용도일 뿐 build key가 아님
- 대량 `force=1` 요청 금지
- rebuild 권한은 수집 완료 hook, warm scheduler, 명시적 operator 작업에만 둔다.

### single-flight

- 동일한 `date + variable`에 대해 build는 한 번만 실행
- 실행 중 같은 요청이 오면 기존 Promise/job을 공유하거나 다음 실행 하나만 예약
- 변수 dependency도 중복 실행되지 않도록 한다.

### debounce/coalescing

- JSON 수집 이벤트가 짧은 시간에 여러 번 발생하면 5~15초 정도 묶어서 한 번 갱신
- 마지막 정상 pack의 `to`와 새 원천의 마지막 시각이 같으면 rebuild 생략
- source checksum 또는 유효 마지막 시각이 바뀌지 않았다면 rebuild 생략 가능

### 자원 제한

- 변수별/날짜별 동시 build 수 제한
- 전체 기간 warm과 오늘자 scheduler가 동시에 같은 target을 만들지 않도록 lock 적용
- 대형 배열과 입력 JSON 참조는 작업 완료 후 해제
- 요청 handler 메모리에 pack 전체를 장기 보관하지 않음

## Cache 정책

| 자산 | 권장 Cache-Control | 설명 |
| --- | --- | --- |
| 오늘 manifest | `no-store` | 사용 전 다시 조회 |
| 과거 complete manifest | ETag 및 장기 cache | 계약이 바뀔 때 revision/datasetId 변경 |
| binary | content-addressed immutable | URL hash 변경 시 새 파일 |
| QC JSON | content-addressed immutable | URL hash 변경 시 새 파일 |

오늘 manifest의 `datasetId`, `data.url`, `qcDetailUrl`을 장기간 고정하지 않는다.

## 관측소 roster 계약

현재 날짜에 따라 `stationCount`가 736, 750 등으로 달라지는 사례가 확인됐다. 날짜비교, 카드, 캐시 및 보간 일관성을 위해 roster 정책을 명시해야 한다.

### 권장 정책: 고정 master roster

- 동일 contract/roster revision의 모든 변수와 날짜가 같은 station 순서 사용
- 해당 날짜에 관측소 자료가 없으면 row를 제거하지 않고 missing으로 기록
- 신규 관측소 추가나 제거가 필요하면 `stationRosterRevision`을 올림
- roster revision 변경 시 영향받는 변수와 날짜 pack을 일관되게 재생성
- manifest에 다음 정보를 명시

```json
{
  "stationRosterRevision": 1,
  "stationCount": 750,
  "stations": []
}
```

날짜별 동적 roster를 유지해야 한다면 각 pack의 station ID를 기준으로 consumer가 좌우 날짜를 재매핑할 수 있도록 별도 계약이 필요하다. 현재 프로젝트에서는 고정 master roster가 더 단순하고 안전하다.

## 오류 응답

| 상황 | HTTP/code | 동작 |
| --- | --- | --- |
| 오늘 pack 최초 준비 전 | 404 `PACK_NOT_WARMED` | rebuild하지 않고 scheduler를 기다림 |
| 계약/revision 불일치 | 404 `PACK_STALE` | operator warm 필요 |
| 정상 partial pack | 200 | manifest 반환 |
| build 실패, 직전 정상 manifest 존재 | 200 | 직전 정상 manifest 유지, producer 로그/모니터링 경고 |

Consumer는 404에서 짧은 backoff 재시도와 “자료 준비 중” 안내만 수행한다. `/range` fallback이나 API-triggered rebuild를 기대하지 않는다.

## 우선 구현 순서

1. 현재 강수 today-refresh 로직을 공통 variable registry 기반으로 분리
2. `TA` 오늘자 partial pack 갱신 추가
3. single-flight, debounce, target lock 확인
4. atomic publish와 직전 manifest 보존 확인
5. station roster 정책 및 revision 확정
6. 향후 `WS_INS`/`WD_INS`, 적설 변수를 registry 등록만으로 확장 가능하게 구성

## 필수 검증

### TA 오늘 pack

```bash
TODAY=$(TZ=Asia/Seoul date +%Y%m%d)
BASE=https://weather-map.sbs.co.kr

curl -sS "$BASE/api/aws/min/pack?date=$TODAY&variable=TA" \
  | jq '{variable, complete, from, to, frameCount, stationCount, stationRosterRevision, datasetId, generatedAt, dataUrl:.data.url, qcDetailUrl}'
```

1~2분 후 다시 호출해 다음을 확인한다.

- `to`가 실제 새 원천 시각까지 전진
- `frameCount`가 함께 증가
- `complete=false` 유지
- 새 데이터가 없으면 불필요하게 datasetId를 변경하지 않음
- binary와 QC URL 모두 HTTP 200

### 강수 회귀

다음 변수도 동일 계약을 유지해야 한다.

```bash
for v in RN_15M RN_60M RN_12HR RN_24HR RN_DAY; do
  curl -sS "$BASE/api/aws/min/pack?date=$TODAY&variable=$v" \
    | jq -c '{variable, complete, from, to, frameCount, stationCount, stationRosterRevision, datasetId}'
done
```

### 동시성/OOM

- 동일 변수에 여러 요청을 보내도 API가 rebuild를 시작하지 않음
- 수집 이벤트가 겹쳐도 동일 target build는 하나만 실행
- full warm 중 today scheduler가 동일 target을 중복 생성하지 않음
- 테스트 전후 RSS/heap 증가가 안정 범위로 회복

## 완료 조건

- 오늘 TA pack이 강수와 동일하게 자동 갱신됨
- 오늘 pack의 `to/frameCount`가 실제 수집 완료 시각과 일치
- API 조회가 rebuild를 유발하지 않음
- build 중에도 깨진 manifest나 404 QC URL이 노출되지 않음
- 중복 build와 OOM 방지 장치가 동작함
- 모든 활성 변수에서 station roster와 revision 정책이 일관됨
- 신규 바람·적설 변수는 registry 등록 방식으로 today-refresh에 추가 가능

