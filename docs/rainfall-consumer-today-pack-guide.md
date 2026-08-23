# Consumer guide: 오늘(KST) AWS 강수 pack

Producer가 오늘 강수 pack을 1분마다 갱신한다. Consumer는 **pack API만** 사용하고, legacy `/api/aws/min/range` JSON fallback은 쓰지 않는다.

## 대상 변수

| variable | 의미 | binary slug |
| --- | --- | --- |
| `RN_15M` | rolling 15분 | `rn_15m` |
| `RN_60M` | rolling 60분 | `rn_60m` |
| `RN_12HR` | rolling 720분 | `rn_12hr` |
| `RN_24HR` | rolling 1440분 (`derived:RN-DAY`) | `rn_24hr_rolling` |
| `RN_DAY` | KST 00:00~현재 당일 누적 | `rn_day` |

`RN_24HR`과 `RN_DAY`를 같은 값·같은 URL로 취급하지 말 것. legacy `/datasets/aws/rn_24hr/` 재사용 금지.

## Fetch 순서

```text
1. GET /api/aws/min/pack?date={오늘KST YYYYMMDD}&variable=RN_DAY
2. GET manifest.data.url          → Int16 LE binary
3. GET manifest.qcDetailUrl       → qc-v{sha}.json (RN_DAY / RN_24HR)
4. (선택) bytes SHA256 ↔ qcDetailSha256 / data.sha256
```

동일 패턴으로 `RN_15M`, `RN_60M`, `RN_12HR`, `RN_24HR`도 호출.

## 오늘 pack 계약

```json
{
  "complete": false,
  "from": "YYYYMMDD0000",
  "to": "YYYYMMDDHHmm",
  "intervalMinutes": 1,
  "contractRevision": 8
}
```

| 필드 | 의미 |
| --- | --- |
| `complete` | 항상 `false` (미완 일) |
| `from` | 그날 00:00 |
| `to` | **실제로 이용 가능한 최근 1분** (미래 프레임 없음) |
| `intervalMinutes` | `1` |
| `datasetId` / binary URL hash | 갱신마다 바뀔 수 있음 → 캐시에 고정하지 말 것 |

- `to` 이후 시각은 프레임에 없음. “아직 안 온 분”을 source missing과 혼동하지 말 것.
- `to` 이전의 실제 결측만 missing/QC 통계에 포함.

## Cache

| 자산 | Cache-Control | Consumer 동작 |
| --- | --- | --- |
| 오늘 manifest | `no-store` (또는 항상 revalidate) | **매 사용 전 재요청** |
| 과거 complete manifest | `immutable` + ETag | 장기 캐시 OK |
| binary (`*-v{sha8}.i16le`) | content-addressed immutable | URL이 바뀌면 새 파일 |
| `qc-v{sha}.json` | immutable | URL이 바뀌면 새 파일 |

`cacheburst`는 CDN/브라우저용이며 **서버 pack lookup 키에 사용되지 않음**. 필수는 아님.

## HTTP 응답

| HTTP | code | 동작 |
| --- | --- | --- |
| 200 | — | manifest 사용 → binary/QC fetch |
| 404 | `PACK_NOT_WARMED` | warm 전/미생성. 잠시 후 retry. rebuild 기대 금지 |
| 404 | `PACK_STALE` | contract/complete 불일치. producer warm 필요 |
| 400 | — | date/variable 수정 |
| 500 | — | backoff retry |

**금지**

- `force=1`로 대량 호출 (operator 전용 rebuild)
- 오늘 pack miss를 `/range` JSON으로 대체
- 오늘 manifest를 immutable처럼 장시간 캐시
- `RN_24HR`에 legacy day-total URL 사용

## 갱신 확인 (smoke)

```bash
TODAY=$(TZ=Asia/Seoul date +%Y%m%d)
BASE=https://weather-map.sbs.co.kr

# 1) 현재 revision
curl -sS "$BASE/api/aws/min/pack?date=$TODAY&variable=RN_DAY" \
  | jq '{complete, from, to, datasetId, qcDetailUrl}'

# 2) 1~2분 대기 후 재요청 — to 또는 datasetId 전진 여부
curl -sS "$BASE/api/aws/min/pack?date=$TODAY&variable=RN_DAY" \
  | jq '{to, datasetId}'

# 3) binary
URL=$(curl -sS "$BASE/api/aws/min/pack?date=$TODAY&variable=RN_DAY" | jq -r '.data.url')
curl -sS -o /dev/null -w "%{http_code} %{size_download}\n" "$BASE$URL"
```

기대:

- 다섯 변수 모두 200
- `complete:false`, `intervalMinutes:1`
- `to`가 최신 원천 분에 근접
- 갱신 후 `to` 및/또는 `datasetId` 전진
- binary HTTP 200, `byteLength` 일치

## 동시성

- manifest API 동시성 8~20 이하 권장
- binary/QC는 CDN immutable이라 병렬 OK
- 동일 manifest를 여러 탭이 요청해도 producer rebuild가 트리거되지 않음

## QC (RN_DAY / RN_24HR)

- `qcDetailUrl` → sparse records only (정상 sample 생략)
- `qcDetailSha256` === SHA-256(다운로드 UTF-8 bytes)
- `qc.qcStates`에 suspect/rejected/substituted 카운트
- 스키마: `docs/aws-rn-qc-consumer-schema.md`

## 과거 일자

- `complete:true` 기대 (warm 완료 시)
- immutable cache OK
- 없으면 `PACK_NOT_WARMED` — producer `warm_aws_min_packs.js --force` 필요
