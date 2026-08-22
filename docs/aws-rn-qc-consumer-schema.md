# AWS RN_DAY / RN_24HR sparse QC — consumer 계약

`contractRevision: 8` pack의 sparse QC 연동 설명이다. 전체 검증 요청: `docs/rainfall-producer-contract-v8-verification-request.md`.

## 가져오는 순서

1. `GET /api/aws/min/pack?date=YYYYMMDD&variable=RN_DAY|RN_24HR&cacheburst=...`
2. manifest의 `data.url` → Int16 LE binary
3. manifest의 `qcDetailUrl` → sparse QC JSON (있으면)
4. `manifest.qcDetailSha256`로 본문 무결성 확인 (권장)

## Cache 정책

| 자산 | URL | Cache |
| --- | --- | --- |
| pack binary (과거 complete) | `.../{slug}.i16le` | immutable + ETag(sha256) |
| qc detail | `.../qc-v{sha16}.json` | 파일명에 content hash → URL 변경 시 자동 bust. alias `qc.json`은 편의용(덮어쓰기됨) → **소비자는 qcDetailUrl만 사용** |
| manifest API | `/api/aws/min/pack` | 오늘/미완료 `no-store`, 과거 complete는 ETag |

`qcDetailUrl`이 가리키는 hashed 파일과 binary는 같은 warm에서 생성되며, `qcDetail.datasetId === manifest.datasetId`이어야 한다.

## qc.json top-level

```ts
type AwsRnQcDetail = {
  schemaVersion: 1;
  contractRevision: number; // 8+
  datasetId: string; // === pack manifest.datasetId
  date: string; // YYYYMMDD
  variable: 'RN_DAY' | 'RN_24HR';
  generatedAt: string; // ISO-8601
  scale: 0.1;
  unit: 'mm';
  sha256: string; // of canonical body (producer stamps)
  qcStates: {
    suspectRetainedSampleCount: number;
    rejectedSampleCount: number;
    substitutedSampleCount: number;
    substitutionExpiredSampleCount: number;
    recordCount: number;
  };
  records: AwsRnQcRecord[];
};
```

## record

```ts
type AwsRnQcState =
  | 'suspect-retained'
  | 'rejected'
  | 'substituted'
  | 'substitution-expired';

type AwsRnQcRecord = {
  TM: string; // YYYYMMDDHHmm
  STN_ID: number;
  stationName?: string;
  state: AwsRnQcState;
  rawValue: number | null; // Int16 scaled ×10
  scale: 0.1;
  valueMm: number | null; // rawValue * 0.1
  signals: string[]; // e.g. mechanical_repeat, isolated_peak_reset, extreme_rate
  acceptedUpdated: boolean;
  substitutionUsed: boolean;
  reason?: string;
  // optional traces
  substitutionMinutes?: number;
  substitutionMaxMinutes?: number; // 30
  rn24hrValueMm?: number;
  packRawValue?: number | null;
  packValueMm?: number | null;
  date?: string;
  variable?: 'RN_DAY' | 'RN_24HR';
};
```

## Lookup

```ts
function findQc(records: AwsRnQcRecord[], tm: string, stnId: number) {
  return records.find((r) => r.TM === tm && r.STN_ID === stnId) ?? null;
}
```

동일 `(TM, STN_ID)`에 record가 없으면 **valid**(또는 일반 source missing)로 간주한다. sparse이므로 정상/일반 missing은 생략된다.

## state 의미

| state | RN_DAY pack | RN_24HR | UI 제안 |
| --- | --- | --- | --- |
| (없음) | 관측값 | 관측 파생 | 정상 |
| `suspect-retained` | **원값 보존** | 원값으로 계산 가능 | 검토 필요 |
| `rejected` | missing | last-confirmed ≤30분 또는 missing | 결측/보정 |
| `substituted` | (RN_24HR only) | last-confirmed 보정값 | QC 보정 |
| `substitution-expired` | (RN_24HR only) | missing (30분 초과) | 결측 |

여러 signal이 있어도 **최종 state는 하나**다. reject 패턴(mechanical_repeat / isolated_peak_reset)이 있으면 `rejected`, 아니면 extreme/soft 후보는 `suspect-retained`.

## Fallback (qcDetailUrl 없음 / fetch 실패)

1. binary + manifest만으로 표시
2. 모든 sample을 valid로 취급하지 말고, missing sentinel(`-32768`)만 결측 처리
3. suspect/substituted 배지는 숨김
4. 가능하면 `contractRevision < 8`이면 QC overlay 비활성

## 예시 JSON

```json
{
  "schemaVersion": 1,
  "contractRevision": 8,
  "datasetId": "aws-rn_day-1m-20260821-vXXXXXXXX",
  "date": "20260821",
  "variable": "RN_DAY",
  "generatedAt": "2026-08-22T05:00:00.000Z",
  "scale": 0.1,
  "unit": "mm",
  "sha256": "...",
  "qcStates": {
    "suspectRetainedSampleCount": 1,
    "rejectedSampleCount": 4,
    "substitutedSampleCount": 0,
    "substitutionExpiredSampleCount": 0,
    "recordCount": 5
  },
  "records": [
    {
      "TM": "202608211414",
      "STN_ID": 277,
      "stationName": "영덕",
      "state": "suspect-retained",
      "rawValue": 648,
      "scale": 0.1,
      "valueMm": 64.8,
      "signals": ["extreme_rate", "cross_contradiction_rn60"],
      "acceptedUpdated": false,
      "substitutionUsed": false,
      "reason": "suspectRetained"
    }
  ]
}
```
