# 수집·누락·복구

## 실시간: `main_AWS.js`

- 스케줄: `2min` (`*/2 * * * *`)
- 후보: `mkFetchCandidate(2, candiateCount)` 후 **최신 2개 drop** → 실제 시도는 나머지
- `candiateCount`가 작으면(과거 5) 관측 후 대략 +4~+8분만 재시도 → DB 지연 시 누락
- 권장: `candiateCount: 15` (약 +4~+28분 lookback)
- `jsonData.length === 0` → `no data to save` 후 continue. 창을 벗어나면 자동 복구 없음
- 저장은 `file.saveFile` + `dataRoot: 'in_data'`, `subDirName: 'aws'`

스케줄러는 이전 job이 끝나지 않으면 `Skipping task`로 tick을 건너뛴다. 로그에 skip이 많으면 lookback과 별개로 기회를 잃는다.

## 일단위 DB backfill: `backfill_aws_min.js`

MSSQL에 데이터가 남아 있을 때 하루 gap을 메운다.

```bash
NODE_ENV=production node kma_fetch/backfill_aws_min.js 20260810 --dry-run
NODE_ENV=production node kma_fetch/backfill_aws_min.js 20260810
```

- 하루 720 슬롯(2분) 스캔 → 없는 파일만 조회/저장
- 경로 규칙은 `main_AWS`와 동일

## 과거 API 허브: `work/fetch_aws_apihub.js`

서버 원본/MSSQL에 없는 구간(예: 보관 시작일 이전)용.

```bash
# API_KEY 필요 (kma_fetch/.env.production 등)
node work/fetch_aws_apihub.js --from 20260712 --to 20260803 --dry-run
node work/fetch_aws_apihub.js --from 20260712 --to 20260803 --sleep 300
```

- 도메인: `https://apihub-pub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min`
- `stn=0` → 창 길이 최대 10분
- 기본 짝수분만 `work/out/{yyyy-MM-dd}/`에 저장
- 운영 `in_data/aws`로 옮길 때는 경로·권한을 확인하고 복사

쿼타 참고: 하루 ≈ 144 호출, 30일 ≈ 4,300 호출. sleep/재시도 권장.

## 로컬 `#` 원본: `work/convert_aws_raw_to_json.js`

서버에 `#` 구분 분 파일이 남아 있을 때.

```bash
node work/convert_aws_raw_to_json.js --dry-run
node work/convert_aws_raw_to_json.js
```

입력 `work/in/`, 출력 `work/out/`. 출력 폴더는 **파일명 TM** 기준.

## 누락 진단 체크리스트

1. 전체 로그에서 해당 TM의 `download AWS tm` / `no data to save` / `File saved` / `Skipping task`
2. 시도 횟수 ≈ lookback 창 크기인지
3. MSSQL에 그 TM row가 지금 있는지 → 있으면 `backfill_aws_min`
4. MSSQL/서버 원본 모두 없으면 → API 허브 fetch
