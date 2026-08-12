# Timestamp 규칙

## 공통 형식

| 이름 | 형식 | Timezone | 사용처 |
| --- | --- | --- | --- |
| `timestamp_kor` | `YYYYMMDDHHMM` | KST | `/{type}/.../image`, `/api/aws/min`, 일부 IR105 |
| `from` / `to` | `YYYYMMDDHHMM` | KST | `/api/aws/min/range`, pack 레거시 |
| `date` | `YYYYMMDD` 또는 `YYYY-MM-DD` | KST | `/api/aws/min/pack` (권장) |
| `timestamp_utc` | `YYYYMMDDHHMM` | UTC | `/ir105/.../fs` |
| `tmfc` | `YYYYMMDDHH` | UTC | HGT500 dataset id / list filter |
| ISO-8601 | e.g. `2026-07-28T00:00:00Z` | UTC | HGT500 `from`/`to`, manifest `validTime` |

서버는 image 라우트에서 KST↔UTC 변환 시 `date-fns`로 ±9h 한다 (`convertKSTToGMTString` / `convertGMTToKSTString`).

## Image route nearest snap (`server_util.js`)

요청 query의 `timestamp_kor`를 product family별로 보정한 뒤 파일을 찾는다.

1. **ir105 / kim**: 보정 없음
2. **rdr**: 분을 5분 단위로 반올림(nearest)
3. **aws**: 분을 2분 단위로 반올림(nearest)
4. **gfs / gfs_equ** (`findNearestWindTimestamp`):
   - 분·초를 버린 뒤, 현재 또는 직전 hour(`HH00`)로 스냅
   - consumer skill의 “KST hour 내림”과 동일 계열

잘못된 12자리 형식이면 rdr/aws snap 함수가 throw할 수 있다. 클라이언트는 항상 `^\d{12}$`를 보내야 한다.

## IR105 DB

- `/ir105/{area}/{step}`의 `timestamp_kor`는 DB 컬럼 `observation_time_kor`와 **문자열 일치**
- batch의 `timestamps`는 동일 형식 값의 comma-separated 목록
- `/fs`만 `timestamp_utc`를 파일명에 사용

## AWS_MIN JSON / pack

디스크에는 **1분** 파일이 쌓일 수 있다. HTTP 계약은 endpoint마다 다르다.

| Endpoint | 간격 | snap |
| --- | --- | --- |
| `GET /api/aws/min` (기본) | 2분 | `findNearestTimestamp(2)` — **호환** |
| `GET /api/aws/min?intervalMinutes=1` | 1분 | snap 없음 (exact) |
| `GET /api/aws/min/exact` | 1분 | snap 없음 |
| `GET /api/aws/min/range` | 2분 | from/to 각각 2분 snap 후 2분 step, max 360 |
| `GET /api/aws/min/pack` | 1분 | `date=YYYYMMDD` → `0000–2359`. 레거시 `from`/`to` 허용. max 1440 |

- 파일명·폴더: `aws/YYYY-MM-DD/AWS_MIN_{YYYYMMDDHHMM}.json` (요청/스냅된 KST 시각)
- image route의 `aws-*` PNG도 **2분** nearest snap (`server_util`)
- 일최고·임계·홀수 분 peak는 **pack / exact**를 쓴다. 2분 min/range만으로는 복원 불가
- pack `variable=FULL` 없음. 기본 `TA`, 이후 comma 복수
- pack binary URL timezone도 KST timeline (`intervalMinutes: 1` in manifest)

## HGT500

- `datasetId` = `kim-glob-hgt500-{tmfc}` (`tmfc` = UTC `YYYYMMDDHH`)
- list의 `from`/`to`는 dataset `validTimeStart..validTimeEnd`와 inclusive overlap
- frame `validTime`은 manifest/metadata의 ISO UTC
- 기본 output interval: 10분 (dataset마다 `outputFrameIntervalMinutes` 확인)

## Consumer 주의

시각화 쪽에서 GFS/구름을 쓸 때 hour/10분 후보를 만드는 로직은 consumer skill에 있을 수 있다.  
**실제 파일이 있는 시각·스냅 규칙**은 이 서버 구현(위 표)이 권위다.
