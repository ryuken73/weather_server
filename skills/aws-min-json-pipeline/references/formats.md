# 원본·API 포맷

## A. 서버/내부 `#` 텍스트 (로컬 원본)

파일명: `AWS_MIN_{yyyyMMddHHmm}` (확장자 없을 수 있음)  
줄 형식:

```text
STN_ID#TM#LAT#LON#HT#WD#WS#TA#HM#PA#PS#RN_YN#RN_1HR#RN_24HR#RN_15M#RN_60M#WD_INS#WS_INS#=
```

- 값 스케일은 MSSQL JSON과 **동일**(이미 내부 단위)
- `STN_NAME` 없음 → 코드표로 부착
- 강수 필드 순서: `RN_1HR` 다음이 **`RN_24HR` → `RN_15M` → `RN_60M`** (SQL SELECT 순서와 다를 수 있음에 주의)
- 변환기: `work/convert_aws_raw_to_json.js`

1분 자료가 있으면 짝수분만 고르면 2분 파이프라인과 맞다.

## B. API 허브 `nph-aws2_min`

```text
https://apihub-pub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min
  ?tm1={YYYYMMDDHHmm}&tm2={YYYYMMDDHHmm}&stn=0&disp=0&help=1&authKey=...
```

요청 인자 요약:

| 인자 | 의미 |
| --- | --- |
| `tm1` / `tm2` | KST. 전체지점(`stn=0`)이면 구간 **≤ 10분** |
| `stn` | `0` = 전체 |
| `disp` | `0` 고정폭, `1` CSV |
| `help` | `0` 짧은 헤더, `1` 필드 설명 포함, `2` 값만 |

데이터 컬럼(공백/`disp=0`):

```text
YYMMDDHHMI STN WD1 WS1 WDS WSS WD10 WS10 TA RE RN-15m RN-60m RN-12H RN-DAY HM PA PS TD
```

단위는 **물리값**(도, m/s, °C, %, hPa, mm).  
`-50` 이하·`-99.9` 류는 결측으로 본다.

원문 샘플(1분, `stn=0`, `disp=0`, `help=1`, CP949→UTF-8):  
`skills/aws-min-json-pipeline/assets/nph-aws2_min_202608131200.txt`  
(`#START7777` + 필드 설명 + 컬럼 헤더 + 지점 데이터 + `#7777END`. 운영 fetch는 `help=0`. `--save-raw` 시 `work/in/apihub/`에도 쌓이지만 gitignore.)

Pack binary로 넣을 때 (`encodeTaToI16` 후 temporal QC, schemaVersion 4):

| 원천 (JSON ×10) | pack Int16 |
| --- | --- |
| `null` / 비유한 | `-32768` |
| `-999` (DB sentinel) | `-32768` |
| ≤ `-500` (물리 ≤ -50℃, Hub) | `-32768` |
| > `600` (물리 > 60℃) | `-32768` |
| 그 외 (예: `-150` = -15.0℃) | 그대로, 단 pack QC에서 1분 급변·고립 스파이크면 `-32768` |

QC는 pack 전용이다. JSON 파일·`/exact`는 위 물리 결측만 반영하고 급변은 그대로 둔다.

JSON으로 넣을 때 (`work/fetch_aws_apihub.js`):

| API | JSON 필드 | 변환 |
| --- | --- | --- |
| STN | `STN_ID` | |
| YYMMDDHHMI | `TM` | |
| WD1 / WS1 | `WD` / `WS` | ×10 round |
| WDS / WSS | `WD_INS` / `WS_INS` | ×10 |
| TA / HM / PA / PS / TD | 동일 | ×10. TD는 `parts[17]` |
| RE | `RN_YN` | 0/1. 음수/≤-50 → null. pack 대상 아님 |
| RN-15m | `RN_15M` | ×10 |
| RN-60m | `RN_60M` (+ 호환 별칭 `RN_1HR`, 원본 변수가 아님) | ×10 |
| RN-12H (`parts[12]`) | `RN_12HR` | ×10 |
| RN-DAY | `RN_DAY` (+ legacy mirror `RN_24HR`) | ×10 |
| (없음) | `LAT`,`LON`,`HT`,`STN_NAME` | 코드표 |

강수 pack (`encodeRainToI16`, schemaVersion 4, TA QC 없음):

| pack 변수 | 의미 | accumulation | slug |
| --- | --- | --- | --- |
| `RN_15M` / `RN_60M` / `RN_12HR` | rolling window | `rolling` + windowMinutes | `rn_15m` 등 |
| `RN_24HR` | 직전 24시간 (RN-DAY 카운터 파생) | `rolling`, 1440 | `rn_24hr_rolling` |
| `RN_DAY` | KST 당일 00시~현재 | `day`, Asia/Seoul | `rn_day` |

`RN_24HR` 계산: `RN_DAY(D,t) + RN_DAY(D-1,23:59) - RN_DAY(D-1,t)`. 결측/음수/counter 감소는 `-32768`, 0으로 clamp하지 않음.
legacy `/datasets/aws/rn_24hr/` URL은 과거 day-total이므로 rolling으로 쓰지 말 것. 변경 요청: `docs/rainfall-producer-rn24-rnday-change-request.md`.

| 원천 (JSON ×10 mm) | pack Int16 |
| --- | --- |
| `0` | `0` (0.0 mm, 결측 아님) |
| 양수 (예: `15` = 1.5 mm) | 그대로 |
| `null` / 비유한 | `-32768` |
| ≤ `-500` (물리 ≤ -50 mm, Hub `-99.9` 등) | `-32768` |
| `< 0` (그 외 음수) | `-32768` |
| `> 32767` | `-32768` + manifest warning |

일반 사용자 도메인 `apihub.kma.go.kr`는 기업 키로 **403**이 날 수 있다 → 반드시 `apihub-pub`.

풍향 pack (`encodeWindDirToI16`): JSON ×10 deg, **0과 360.0(무풍, 3600)은 유효**. 범위 밖·Hub ≤ -50 → `-32768`.
풍속 pack: 강수와 같이 **0은 유효**, 음수/Hub sentinel → 결측.
습도: 0–100%(×10 0–1000). 이슬점: TA temporal QC 없음, >60℃ clip 없음.
