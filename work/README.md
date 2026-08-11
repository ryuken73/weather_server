# AWS 과거 자료 (일회성 work)

## 폴더

- `in/{yyyy-MM-dd}/` — 로컬 원본 `#` 텍스트 복사용
- `in/apihub/{yyyy-MM-dd}/` — API 허브 원문 (`--save-raw` 시)
- `out/{yyyy-MM-dd}/` — `AWS_MIN_{yyyyMMddHHmm}.json` 출력

## 1) API 허브에서 받기 (권장, 8/4 이전)

기업용 도메인 `apihub-pub.kma.go.kr` 사용 (일반 `apihub.kma.go.kr`는 403).

전체 지점(`stn=0`)은 **최대 10분** 구간만 허용 → 스크립트가 10분 창으로 순회합니다.

```bash
# 인증키
set API_KEY=발급키
# 또는 kma_fetch/.env.production 에 API_KEY=

# 창 목록만 확인
node work/fetch_aws_apihub.js --from 20260712 --to 20260803 --dry-run

# 실행 (기본: 모든 분 저장, 호출 간 300ms)
node work/fetch_aws_apihub.js --from 20260712 --to 20260803 --sleep 300

# 짝수분만
node work/fetch_aws_apihub.js --from 20260712 --to 20260803 --even-only --sleep 300

# 원문도 보관
node work/fetch_aws_apihub.js --from 20260712 --to 20260803 --save-raw
```
- 출력: `work/out/2026-07-12/AWS_MIN_202607120000.json` …
- `STN_NAME` / `LAT` / `LON` / `HT`: `kma_fetch/config/aws_stn_*_20260811.json`
- 값 스케일: API 물리단위 → 기존 MSSQL fetch JSON과 맞게 ×10 (TA, WD, WS, HM, PA, PS, 강수)

예상 호출 수: 하루 ≈ 144회, 30일 ≈ 4,300회.

## 2) 로컬 `#` 원본 변환

서버에 남아 있는 `#` 구분 파일이 있을 때:

```bash
node work/convert_aws_raw_to_json.js --dry-run
node work/convert_aws_raw_to_json.js
```
