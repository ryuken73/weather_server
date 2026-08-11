# 수집·누락·복구

## 실시간: `main_AWS.js`

- 스케줄: `1min` (`* * * * *`) — **모든 분** 보존 (pack/exact용)
- 후보: `mkFetchCandidate(1, 30)` 후 **최신 2개 drop**
- `AWS_FETCH_SOURCE`:
  - `auto` (기본): MSSQL 조회 → 비면 API Hub
  - `db`: MSSQL만
  - `hub`: API Hub만 (`API_KEY` 필요)
- `jsonData.length === 0` → `no data to save` 후 continue
- 저장: `file.saveFile` + `dataRoot: 'in_data'`, `subDirName: 'aws'`
- 저장 전 `patchAwsRowsForSave` (STN_NAME)

홀수분 존재 확인:

```bash
node kma_fetch/probe_aws_min_cadence.js
```

## 일단위 backfill: `backfill_aws_min.js`

```bash
NODE_ENV=production node kma_fetch/backfill_aws_min.js 20260810 --dry-run
AWS_FETCH_SOURCE=auto NODE_ENV=production node kma_fetch/backfill_aws_min.js 20260810
```

- 하루 **1440** 슬롯(1분) 스캔 → 없는 파일만 조회/저장
- 소스 정책은 `main_AWS`와 동일 (`AWS_FETCH_SOURCE`)

## 과거 API 허브: `work/fetch_aws_apihub.js`

```bash
node work/fetch_aws_apihub.js --from 20260712 --to 20260803 --dry-run
node work/fetch_aws_apihub.js --from 20260712 --to 20260803 --sleep 300
# 짝수분만 필요하면
node work/fetch_aws_apihub.js --from 20260712 --to 20260803 --even-only
```

- 도메인: `https://apihub-pub.kma.go.kr/.../nph-aws2_min`
- 기본: **모든 분** 저장 (`--all-minutes`가 기본, `--even-only`로 제한)
- 출력: `work/out/` → 운영 반영 시 `in_data/aws`로 복사

## 1분 TA pack

- Builder: `kma_fetch/utils/aws_min_pack.js`
- API: `GET /api/aws/min/pack?from=&to=&variable=TA`
- Binary 정적: `/datasets/aws/ta/1m/{dayKey}/ta.i16le` (`AWS_PACK_DIR` / `out_data/aws/pack`)
- Debug: `GET /api/aws/min/exact?timestamp_kor=`

## 누락 진단 체크리스트

1. 로그: `download AWS tm` / `no data to save` / `File saved` / `Skipping task`
2. `probe_aws_min_cadence.js`로 disk odd / DB odd 확인
3. DB에 있으면 backfill, 없으면 Hub (`AWS_FETCH_SOURCE=hub` 또는 auto)
4. pack은 원천 1분 파일이 있어야 홀수 peak를 살림
