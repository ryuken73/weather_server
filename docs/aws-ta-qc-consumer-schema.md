# AWS TA sparse/temporal QC — consumer 계약

`contractRevision: 9` complete TA pack의 QC sidecar 연동 설명. 최종 합의: `docs/ta-pack-qc-agreement-final.md`.

## 가져오는 순서

1. `GET /api/aws/min/pack?date=YYYYMMDD&variable=TA&cacheburst=...`
2. manifest의 `data.url` → Int16 LE binary
3. manifest의 `qcDetailUrl` → TA QC JSON (**complete day 필수**)
4. **무결성**: `qcDetailSha256` === SHA-256(다운로드 본문 UTF-8 bytes). Brotli/gzip 등으로 압축 전송된 경우 **해제(decompress)한 원본 JSON bytes** 기준.

## URL (확정)

| 자산 | URL 패턴 |
| --- | --- |
| pack binary | `/datasets/aws/ta/1m/{day}/ta-v{sha8}.i16le` |
| qc detail | `/datasets/aws/ta/1m/{day}/qc-v{sha16}.json` |

> `/datasets/aws/qc/ta/...` 경로는 **사용하지 않음** (초안 spec 폐기). RN과 동일하게 variable slug 디렉터리 아래에 sidecar를 둔다.

## Cache 정책

| 자산 | Cache |
| --- | --- |
| pack binary (과거 complete) | immutable + ETag(sha256) |
| qc detail | immutable + ETag(qcDetailSha256). 파일명 sha16 = manifest qcDetailSha256 앞 16자 |
| manifest API | 오늘/미완료 `no-store`, 과거 complete는 ETag |

`qcDetail.datasetId === manifest.datasetId`이어야 한다.

## manifest QC 블록

```ts
type AwsTaTemporalQc = {
  enabled: boolean;
  logicRevision: number; // >= 2 (sparse high baseline)
  maxDeltaDegCPerMinute: number;
  spikeNeighborMaxDegC: number;
  spikeMinDegCDelta: number;
  sparseHighDegC: number; // default 44
  sparseMaxValidSamples: number; // default 30
  excludedSampleCount: number;
  temporalExcludedSampleCount: number;
  sparseHighExcludedSampleCount: number;
};

type AwsTaOfficialFlag = {
  available: boolean;
  excludedSampleCount: number;
  note?: string;
};
```

- **sparse high**: `complete:true` pack만 적용. partial/today는 temporal QC만.
- **consumer guard auto**: `contractRevision >= 9`, `qcDetailUrl` 존재, `logicRevision >= 2`, sparse env 필드 manifest 명시.

## qc.json top-level

```ts
type AwsTaQcDetail = {
  schemaVersion: 1;
  contractRevision: number; // 9+
  datasetId: string;
  date: string; // YYYYMMDD
  variable: 'TA';
  generatedAt: string;
  scale: 0.1;
  unit: 'degC';
  note?: string;
  qcStates: {
    rejectedSampleCount: number;
    temporalJumpRejectedSampleCount: number;
    isolatedSpikeRejectedSampleCount: number;
    sparseHighRejectedSampleCount: number;
    recordCount: number;
  };
  records: AwsTaQcRecord[];
};
```

## record

```ts
type AwsTaQcRecord = {
  TM: string; // YYYYMMDDHHmm
  STN_ID: number;
  variable: 'TA';
  rawValue: number; // Int16 scaled ×10
  valueC: number | null; // rawValue * 0.1
  state: 'rejected';
  reason: 'temporal-jump' | 'isolated-spike' | 'sparse-high';
  signals: string[];
  stationValidSampleCount?: number; // sparse-high only
};
```

## Lookup

```ts
const key = `${record.TM}:${record.STN_ID}`;
```

## Consumer 규칙 요약

| 규칙 | 내용 |
| --- | --- |
| 표시값 소스 | pack binary only (sidecar는 추적용) |
| carry seed | `rejected` / sparse-high rejected 분은 carry seed **금지** |
| sidecar fetch 실패 / SHA 불일치 | binary 사용 + guard ON, PT hard stop 없음 |
| plausibility | `[-50, 45]℃` 유지 (rev 9 이후에도 상한 43℃ 조정 없음) |

## env (producer)

```text
AWS_TA_QC=1
AWS_TA_QC_SPARSE_HIGH_DEGC=44
AWS_TA_QC_SPARSE_MAX_VALID_SAMPLES=30
```

`logicRevision` 또는 sparse env 변경 시 producer bump → consumer cache invalidate.

## Consumer 선행 구현 (2026-08-29 E2E blocked)

현재 consumer는 `AWS_PACK_CONTRACT_REVISION = 8` **전역** 검사로 rev9 TA를 거부한다.  
**전역을 9로 올리면 RN_*가 깨지므로**, manifest `variable` 기준으로 허용 revision을 분기한다.

| variable | producer `contractRevision` | consumer 허용 |
| --- | --- | --- |
| `TA` | **9** | `>= 9` |
| `RN_DAY`, `RN_24HR`, … | **8** | `8` (또는 `>= 8`) |

필수:

1. `awsVariablePack.js` / `awsApiAdapter.js` — **변수별** expected revision (전역 상수 9 금지)
2. IndexedDB 캐시 키 — `contractRevision`, `logicRevision`, `datasetId`, `data.sha256`
3. TA complete pack — `qcDetailUrl` fetch + `qcDetailSha256` 검증, 실패 시 guard ON (§3.3)
4. carry seed — sparse-high / temporal reject 분 seed 금지

consumer TA rev9 배포 **후** producer가 최근 14일 TA `--force` warm.
