# AWS 1분 Packed Timeline Producer 요구사항

작성일: 2026-08-12 KST  
요청 프로젝트: `weather-bars-instanced`  
대상 Producer: `weather_api` (`https://weather-map.sbs.co.kr`)  
상태: 구현 협의용 설계안

## 1. 요청 요약

현재 시각화 앱은 AWS 자료를 2분 간격으로 재생한다. 그러나 기상청 AWS 원자료는 매분자료이며, 1분 자료 두 건 중 하나만 선택하는 방식은 홀수/짝수 분에 잠깐 나타난 일최고기온을 누락할 수 있다.

따라서 다음 구조로 전환을 요청한다.

- 원천 1분 자료를 빠짐없이 보존한다.
- 하루 timeline은 KST `00:00–23:59`, 총 1,440 frame으로 제공한다.
- 관측소 메타데이터를 frame마다 반복하는 JSON 대신 compact packed 자료를 제공한다.
- Consumer는 전체 1분 timeline에서 일최고·일최저·임계 돌파시각·지속시간을 직접 계산한다.
- 기존 2분 `/api/aws/min`, `/api/aws/min/range`는 호환성을 위해 유지한다.

권장 신규 endpoint 이름은 아래와 같지만, 실제 path는 producer 구현 협의에서 변경할 수 있다. **path보다 데이터 의미·binary layout·결측 계약이 우선이다.**

```text
GET /api/aws/min/pack?from=YYYYMMDDHHMM&to=YYYYMMDDHHMM&variable=TA
```

## 2. 배경과 현재 문제

### 2.1 현재 Producer 계약

현재 운영 계약은 다음과 같다.

- 단건: `GET /api/aws/min?timestamp_kor=YYYYMMDDHHMM`
- 구간: `GET /api/aws/min/range?from=&to=`
- KST, 2분 nearest snap
- range는 inclusive, 최대 360 frame
- 각 frame의 `data[]`에 관측소 메타데이터와 관측값을 반복하여 JSON으로 제공
- HTTP 응답 시 `/api/aws/stations` 코드표를 이용해 `STN_NAME`, `LAW_ADDR_SIDO`, `LAW_ADDR_GUGUN` enrich

### 2.2 정확성 문제

예를 들어 실제 원자료가 다음과 같을 수 있다.

```text
15:32  40.8℃
15:33  41.3℃  ← 실제 일최고
15:34  40.9℃
```

2분 timeline이 `15:32`, `15:34`만 사용하면 실제 최고 `41.3℃`와 발생시각 `15:33`이 사라진다. 이 문제는 다음 기능에 모두 영향을 준다.

- 오늘 현재까지 최고기온·최저기온
- 일최고 발생 관측소와 발생시각
- 임계값 최초/마지막 돌파 시각
- 임계 초과 지속시간
- 단시간 상승·하강 폭
- 날짜 비교와 관측소 순위
- 향후 AI 데이터 질의 결과

2분 양쪽 값으로 보간해도 중간 1분의 실제 peak는 복원할 수 없다. 두 값 중 큰 값만 2분 frame에 넣는 방식도 모든 frame을 상향 편향시키므로 일반 시계열로 사용할 수 없다.

## 3. 목표와 비목표

### 3.1 목표

1. 1분 원자료의 실제 관측값과 발생시각을 보존한다.
2. 하루 전체를 정규 timeline으로 재생할 수 있게 한다.
3. browser에서 날짜 2분할까지 안정적으로 적재할 수 있는 크기로 전달한다.
4. 관측소 순서·결측·단위·endian을 명시해 Consumer 해석의 모호성을 제거한다.
5. 과거 완결 일자는 immutable cache가 가능하게 한다.
6. 당일 자료는 현재 최근 1분까지 부분 pack으로 제공한다.

### 3.2 비목표

- Producer가 막대 높이, 색상 LUT 또는 IDW 보간 결과를 생성하지 않는다.
- Producer가 결측을 carry-forward하거나 미래값으로 back-fill하지 않는다.
- Producer가 anti-flicker median을 적용하지 않는다.
- Producer가 방송용 시도 대표 관측소를 선정하지 않는다.
- 이번 요구에서 TA 이외 강수·적설·풍속 변수의 정규화를 확정하지 않는다.

### 3.3 선행 필수조건: 수집·저장도 1분이어야 함

현재 `in_data/aws/.../AWS_MIN_*.json`이 짝수 분 등 2분 간격으로만 생성된다면 packed endpoint만 추가해서는 누락된 홀수 분 peak를 복원할 수 없다.

- upstream AWS 매분자료를 매 1분 수집한다.
- 파일 또는 원천 저장소 key에 모든 `YYYYMMDDHHMM`을 보존한다.
- 수집 단계에서 2분 nearest snap, 홀수 분 제거, 두 값 중 하나 선택을 하지 않는다.
- 수집 실패와 정상 관측소 결측을 구분할 수 있게 한다.
- 기존 2분 산출물이 필요하면 1분 원천에서 별도 파생하되 1분 원천을 삭제하지 않는다.

Producer 구현의 첫 gate는 특정 홀수 분 원본 파일/레코드와 TA 값이 실제 저장소에 존재하는지 확인하는 것이다.

## 4. 전체 설계

```text
기상청 AWS 매분자료
        │
        ▼
weather_api 수집·보관
  - 1분 시각 유지
  - raw TA 유지
  - 결측 유지
        │
        ▼
1분 pack builder / cache
  ├─ manifest JSON
  │   ├─ 시간·단위·schema
  │   ├─ 관측소 snapshot/order
  │   └─ binary URL·길이·checksum
  └─ TA Int16 binary
      └─ [frame][station], KST 1분
        │
        ▼
weather-bars Consumer
  - IndexedDB cache
  - raw 1분 timeline
  - 현재 frame만 Mesh/IDW 갱신
  - 일최고·임계 통계는 Worker scan
```

핵심은 **1분 frame 수가 늘어도 매 frame의 관측소 객체를 JSON으로 반복하지 않는 것**이다. TA 하나만 제공할 경우 750지점×1,440분×2bytes는 약 2.16MB다.

## 5. Endpoint 제안

### 5.1 신규 1분 pack manifest

```http
GET /api/aws/min/pack?from=202608120000&to=202608122359&variable=TA
```

Query:

| 이름 | 필수 | 계약 |
|---|---:|---|
| `from` | O | `YYYYMMDDHHMM`, KST, inclusive |
| `to` | O | `YYYYMMDDHHMM`, KST, inclusive |
| `variable` | O | 1차는 `TA`만 허용 |
| `format` | X | 기본 `i16le`; debug용 `json`은 선택사항 |

규칙:

- 1분 exact 범위이며 2분 snap을 적용하지 않는다.
- `from > to`는 400이다.
- 1회 최대 1,440 frame을 권장한다.
- 여러 날짜는 Consumer가 KST 일자별로 나눠 요청한다.
- 과거 하루는 `00:00–23:59`, 정확히 1,440 frame이다.
- today는 `00:00–현재 이용 가능한 최근 1분`이다.
- 요청한 정규 시각은 파일이 없어도 frame index를 유지한다.

### 5.2 기존 endpoint 호환

기존 endpoint의 2분 snap 의미를 즉시 바꾸지 않는다.

```text
GET /api/aws/min
GET /api/aws/min/range
```

기존 Consumer가 있으므로 신규 1분 pack 검증과 전환이 끝날 때까지 병행한다. 기존 endpoint를 추후 변경·폐기한다면 별도 deprecation 기간과 OpenAPI 공지가 필요하다.

### 5.3 선택적인 exact-minute debug endpoint

pack parity 확인을 위해 다음 중 하나를 제공하면 좋다.

```http
GET /api/aws/min/exact?timestamp_kor=202608121533
```

또는 기존 단건 endpoint에 명시적 mode를 추가할 수 있다.

```http
GET /api/aws/min?timestamp_kor=202608121533&intervalMinutes=1
```

이 endpoint는 packed 값과 원본 매분자료의 표본 대조에 사용한다. 기존 2분 default 동작은 유지한다.

## 6. Manifest 응답 스키마

권장 예시:

```json
{
  "schemaVersion": 1,
  "datasetId": "aws-ta-1m-20260812-v3",
  "source": "KMA_AWS_MIN",
  "variable": "TA",
  "unit": "degC",
  "timezone": "Asia/Seoul",
  "intervalMinutes": 1,
  "from": "202608120000",
  "to": "202608122359",
  "frameCount": 1440,
  "stationCount": 736,
  "complete": true,
  "generatedAt": "2026-08-13T00:03:10+09:00",
  "stationOrder": "STN_ID_ASC",
  "stations": [
    {
      "STN_ID": 42,
      "STN_NAME": "군산오식도",
      "LAT": 35.93681,
      "LON": 126.59737,
      "HT": 25.5,
      "LAW_ADDR_SIDO": "전북특별자치도",
      "LAW_ADDR_GUGUN": "군산시"
    }
  ],
  "data": {
    "url": "/datasets/aws/ta/1m/20260812/ta.i16le",
    "dtype": "int16",
    "endianness": "little",
    "order": "FRAME_MAJOR_STATION_MINOR",
    "scale": 0.1,
    "offset": 0,
    "missingValue": -32768,
    "byteLength": 2119680,
    "sha256": "..."
  },
  "missingTimestamps": ["202608120617"],
  "warnings": []
}
```

필수 필드:

- `schemaVersion`
- `datasetId`
- `variable`, `unit`, `timezone`
- `intervalMinutes = 1`
- `from`, `to`, `frameCount`
- `stationCount`, `stationOrder`, `stations[]`
- `data.url`, `dtype`, `endianness`, `order`, `scale`, `missingValue`, `byteLength`, `sha256`
- `complete`, `generatedAt`, `missingTimestamps`

## 7. Binary 자료 계약

### 7.1 TA encoding

```text
dtype        = signed Int16
endianness   = little-endian
scale        = 0.1℃
missing      = -32768
layout       = frame-major, station-minor
offset       = frameIndex * stationCount + stationIndex
TA(℃)        = int16Value * 0.1
```

예:

```text
277  → 27.7℃
413  → 41.3℃
-32768 → missing
```

정상 byte 길이:

```text
byteLength = frameCount × stationCount × 2
```

`missingValue`는 통계·일최고 계산에서 제외한다. Producer는 결측 칸에 이전값이나 이후값을 넣지 않는다.

### 7.2 관측소 순서

- 기본 정렬은 numeric `STN_ID` 오름차순이다.
- binary station index는 manifest의 `stations[]` 순서와 정확히 같아야 한다.
- 범위 중 등장/소멸하는 관측소를 포함한 union을 먼저 만든 후 순서를 고정한다.
- 관측소가 아직 운영되지 않았거나 이미 종료된 frame은 missing sentinel을 기록한다.
- station metadata snapshot은 pack 생성 시점의 `/api/aws/stations` enrich 계약을 따른다.

### 7.3 시간 순서

- frame 0은 manifest `from`이다.
- frame `i`의 KST 시각은 `from + i분`이다.
- `to`는 inclusive이며 `frameCount`와 일치해야 한다.
- 전체 frame 파일이 없는 시각도 한 행의 missing sentinel로 유지한다.
- `missingTimestamps[]`에는 전체 frame 원천이 없는 시각을 기록한다.
- station 일부만 결측인 경우 binary sentinel로 표현하며 전체 frame missing 목록에는 넣지 않는다.

## 8. 결측·품질관리 계약

1. Raw pack에는 carry-forward/back-fill을 적용하지 않는다.
2. `TA == null`, 빈 문자열, producer가 정의한 결측 코드는 `-32768`로 기록한다.
3. 원천에서 품질 flag를 제공한다면 후속 schema에서 별도 `qc.u8`를 추가한다. TA 값을 임의 수정해 품질 상태를 숨기지 않는다.
4. 현재값 시각화의 carry-forward 여부는 Consumer 정책이다.
5. 일최고·일최저·임계 통계는 raw valid minute만 사용한다.
6. 당일 실시간 값은 사후 품질관리로 변경될 수 있으므로 Consumer는 `오늘 현재까지 AWS 최고 · 실시간 관측 기준`으로 표현한다.
7. 값의 급변을 producer가 임의 clipping하지 않는다. 물리 범위나 QC 제외 규칙이 필요하면 문서화하고 원자료와 구분한다.

## 9. 캐시·갱신·원자성

### 9.1 과거 완결 일자

- `complete: true`
- content hash가 포함된 immutable `datasetId` 또는 data URL 사용
- 권장 header: `Cache-Control: public, max-age=31536000, immutable`
- 동일 dataset의 manifest와 binary checksum은 변하지 않아야 한다.

사후 품질 정정으로 자료가 바뀌면 같은 URL을 덮어쓰지 말고 revision을 올린 새 `datasetId`를 발행한다.

### 9.2 Today 부분 일자

- `complete: false`
- `to`는 실제 이용 가능한 최근 1분
- `Cache-Control: no-store` 또는 짧은 max-age + ETag
- 갱신할 때 `datasetId`/ETag/revision이 변경되어야 한다.
- binary를 먼저 완성하고 manifest를 마지막에 공개하는 atomic publish를 사용한다.

### 9.3 무결성

- Consumer는 `byteLength`를 먼저 검증한다.
- 배포/회귀 검사에서는 `sha256`도 검증한다.
- manifest가 아직 존재하지 않는 binary, 절반만 기록된 binary를 가리켜서는 안 된다.

## 10. HTTP 요구사항

- Manifest: `Content-Type: application/json; charset=utf-8`
- Binary: `Content-Type: application/octet-stream`
- 정확한 `Content-Length` 제공
- CORS는 현재와 같이 consumer origin에서 GET 허용
- `AbortController` 취소가 즉시 연결 종료로 이어질 수 있어야 함
- gzip/br은 manifest에 적용; binary 압축은 실제 압축률과 CPU 비용 측정 후 결정
- 가능하면 binary `Range` 요청 지원
- 오류 응답은 JSON `{ error, details? }` 형식 유지

권장 상태 코드:

| 상태 | 의미 |
|---:|---|
| 200 | manifest 또는 binary 정상 |
| 400 | 시간 형식·범위·variable 오류 |
| 404 | 요청 범위에 원자료가 전혀 없음 |
| 409/503 | pack 생성 중이며 아직 원자적으로 공개되지 않음 |
| 500 | 내부 오류 |

## 11. Producer 생성 파이프라인

```text
1. 요청 KST 범위의 1분 원자료 목록 생성
2. 모든 frame의 STN_ID union 수집
3. STN_ID numeric 오름차순 고정
4. /api/aws/stations 코드표와 metadata join
5. Int16Array(frameCount × stationCount)를 missing sentinel로 초기화
6. 각 valid TA를 원래 0.1℃ 정수 단위로 기록
7. byteLength·sha256 계산
8. 임시 경로에 binary/manifest 작성
9. binary publish
10. manifest를 마지막에 atomic rename/publish
```

과거 day pack은 최초 요청 때 생성 후 cache하거나 정기 batch로 미리 만들 수 있다. today는 매 요청마다 전체 JSON을 재조립하기보다 최근 revision을 증분 갱신하거나 짧은 TTL cache를 두는 것을 권장한다.

## 12. Consumer 사용 설계

Producer가 위 pack을 제공하면 `weather-bars-instanced`는 다음처럼 전환한다.

1. 날짜별 manifest 요청
2. stations와 binary byteLength 검증
3. `Int16Array`로 raw TA 매핑
4. IndexedDB에 datasetId/sha256 기준 저장
5. 한 frame의 raw TA만 visual 20–40℃ norm으로 변환
6. 고정 K=4 index/weight로 현재 frame IDW 계산
7. rAF 시점에 필요한 최신 frame만 최대 1회 Mesh 갱신
8. 일최고·일최저·임계시간은 Worker에서 raw 1분 pack scan

프레젠테이션 10초 재생 중 1,440 frame을 모두 순차 렌더링하지 않는다. display clock에 해당하는 최신 frame만 선택하므로 GPU draw call과 shadow pass 수는 기존 2분 pack과 동일하다.

Consumer timeline 계약:

- 과거 하루: `00:00–23:59`, 1,440 frame
- today: `00:00–현재 최근 1분`
- 두 날짜 비교: 좌우 동일 minute index
- 한쪽이 today면 다른 날짜도 동일 `HH:mm`까지만 요청
- Loop OFF는 실제 마지막 1분 frame에 정지
- hover·카드·통계는 raw TA 표시
- 막대 높이·색만 anti-flicker 적용 가능

기존 2분 5-frame median은 약 10분 폭이므로, 1분 전환 시 같은 시간 폭을 유지하도록 Consumer가 9~10 frame 수준을 별도 검증한다. Producer raw 값에는 smoothing을 적용하지 않는다.

## 13. 용량·성능 예산

750개 관측소, 하루 1,440 frame 기준:

```text
TA Int16 = 750 × 1,440 × 2 = 2,160,000 bytes
```

관측소 metadata와 manifest를 포함해도 browser에서 충분히 관리 가능한 크기다. 날짜 2분할은 raw TA 약 4.32MB다. 실제 다운로드 크기·decode 시간은 구현 후 기록한다.

Producer 필수 성능 원칙:

- frame마다 station metadata를 반복하지 않는다.
- cached 과거 pack 요청에서 원천 JSON 1,440개를 매번 다시 parse하지 않는다.
- Content-Length를 제공해 Consumer가 실제 progress를 표시할 수 있게 한다.
- pack 생성 시간과 cached 응답 시간을 구분해 관측한다.
- today 갱신이 과거 immutable pack cache를 무효화하지 않는다.

## 14. Acceptance test

### 14.1 계약 검증

- [ ] OpenAPI에 신규 endpoint, schema, binary layout, example 추가
- [ ] producer `weather-api-catalog` skill과 endpoint reference 동시 갱신
- [ ] `intervalMinutes === 1`
- [ ] 과거 하루 `frameCount === 1440`, `00:00–23:59`
- [ ] `byteLength === frameCount × stationCount × 2`
- [ ] stations는 STN_ID numeric 오름차순
- [ ] `STN_NAME`, `LAW_ADDR_SIDO`, `LAW_ADDR_GUGUN` 포함
- [ ] missing frame과 station missing이 sentinel로 유지
- [ ] 과거 pack immutable cache, today pack revision/ETag 확인

### 14.2 원자료 parity

- [ ] 무작위 20개 `(timestamp, STN_ID)`를 exact-minute 원자료와 대조
- [ ] 홀수 분 peak가 binary에 존재하는지 확인
- [ ] 관측소별 일최고·발생시각을 1분 원자료 전수 scan 결과와 비교
- [ ] 일최저·최초 임계 돌파·임계 초과 분수도 동일 방식으로 비교
- [ ] 결측을 제외한 통계와 carry-forward 미적용 확인

필수 회귀 fixture 예:

```text
15:32 40.8℃
15:33 41.3℃  ← pack과 일최고에 반드시 존재
15:34 40.9℃
```

### 14.3 Consumer 통합 gate

- [ ] 단일 날짜 1,440 frame load/play/scrub
- [ ] 2개 날짜 1,440/1,440 동기 재생
- [ ] 최고기온 레이블 클릭 시 정확한 1분 frame 이동
- [ ] Loop OFF `23:59` 종료
- [ ] 10초 Play FPS가 기존 2분 기준 대비 5% 이상 하락하지 않음
- [ ] pack 교체·취소·재시도 후 geometry/texture/resource 누수 없음
- [ ] hover·카드·임계 라벨이 같은 raw 1분 값을 사용

## 15. 마이그레이션 순서

### Producer

1. 1분 원자료 보관 여부와 파일 가용성 확인
2. 신규 pack endpoint와 binary builder 구현
3. exact-minute parity 경로 마련
4. OpenAPI·catalog skill·운영 문서 갱신
5. 과거 하루와 today pack 배포
6. fixture·checksum·cache·부하 테스트

### Consumer

1. 신규 schema decoder와 cache version 추가
2. 1분 timeline 단일 날짜 전환
3. 최고기온·카드·임계 통계를 raw 1분 scan으로 교체
4. 2분할 1,440/1,440 전환
5. anti-flicker 시간 폭 재조정
6. 성능·시각·장시간 안정성 gate 수행
7. 안정화 후 기존 2분 adapter의 유지/폐기 결정

## 16. 완료 정의

Producer 작업은 endpoint가 200을 반환하는 것만으로 완료되지 않는다. 다음을 모두 만족해야 한다.

- 실제 홀수 분 최고기온이 pack에 보존된다.
- 하루 1,440개 정규 frame과 station-level 결측이 구분된다.
- binary layout이 OpenAPI/문서와 일치한다.
- 과거 pack은 immutable하고 today pack은 revision 가능하다.
- exact 원자료 표본과 일최고 scan parity가 자동 검증된다.
- Consumer의 단일/2분할 재생 성능 gate를 통과한다.
- 기존 2분 API 사용자는 마이그레이션 전까지 영향을 받지 않는다.

## 17. Producer 진실 원천과 동기화 대상

구현 시 아래 producer 문서를 같은 변경에서 갱신해야 한다.

- `D:\002.Code\002.node\weather_api\docs\openapi.yaml`
- `D:\002.Code\002.node\weather_api\skills\weather-api-catalog\SKILL.md`
- `D:\002.Code\002.node\weather_api\skills\weather-api-catalog\references\endpoints.md`
- 필요 시 `aws-min-json-pipeline` 수집·파일주기 계약
- 운영 `https://weather-map.sbs.co.kr/docs/json`

현재 2분 계약 검증 기록은 `docs/aws-producer-api-verification.md`에 있다. 신규 1분 pack 운영 배포 후 별도의 verification 문서와 재현 가능한 probe를 추가한다.
