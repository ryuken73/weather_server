# Timestamp 규칙

## 공통 형식

| 이름 | 형식 | Timezone | 사용처 |
| --- | --- | --- | --- |
| `timestamp_kor` | `YYYYMMDDHHMM` | KST | `/{type}/.../image`, `/api/aws/min`, 일부 IR105 |
| `from` / `to` | `YYYYMMDDHHMM` | KST | `/api/aws/min/range` |
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

## AWS_MIN JSON

- 관측 주기 2분. API는 image route와 같이 `findNearestTimestamp(2)`로 snap한다.
- range는 snap된 `from`~`to`를 inclusive로 2분 step 열거한다.
- 파일명·폴더는 snap된 KST 시각 기준: `aws/YYYY-MM-DD/AWS_MIN_{YYYYMMDDHHMM}.json`

## HGT500

- `datasetId` = `kim-glob-hgt500-{tmfc}` (`tmfc` = UTC `YYYYMMDDHH`)
- list의 `from`/`to`는 dataset `validTimeStart..validTimeEnd`와 inclusive overlap
- frame `validTime`은 manifest/metadata의 ISO UTC
- 기본 output interval: 10분 (dataset마다 `outputFrameIntervalMinutes` 확인)

## Consumer 주의

시각화 쪽에서 GFS/구름을 쓸 때 hour/10분 후보를 만드는 로직은 consumer skill에 있을 수 있다.  
**실제 파일이 있는 시각·스냅 규칙**은 이 서버 구현(위 표)이 권위다.
