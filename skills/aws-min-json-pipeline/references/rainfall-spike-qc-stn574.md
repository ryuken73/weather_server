# RN_DAY spike QC — STN 574 / Hub JSON 검증

## 문제 패턴 (대신 STN 574, 20260823)

기계적 오류로 **short-window 강수만 spike**하고 **일 누적 `RN_DAY`는 spike 직후 누적값(280=28.0mm)으로 유지**되는 경우가 있다.

| 시각 | RN_DAY (JSON) | RN_15M | 의미 |
| --- | --- | --- | --- |
| 1050 | 0 | 0 | dry |
| 1051 | 245 | 245 | spike 24.5mm |
| 1052 | **280** | **0** | window reset, day counter 유지 |

fixture(`RN_DAY` 이웃도 0)만 테스트하면 **운영 JSON과 불일치**한다. `/api/aws/min/exact`는 `RN_DAY` 필드가 없을 수 있어 exact API만으로는 stored JSON QC를 대표하지 못한다.

## reject 조건 (코드)

`kma_fetch/utils/aws_min_pack.js`:

1. **`isolated_peak_reset`** — RN_DAY 시계열 `0→spike→0` (또는 gap-separated 북강릉)
2. **`isCrossWindowPeakReset`** — RN_DAY가 누적 유지여도 **±1~2분 내 cross(`RN_15M/RN_60M/RN_12HR`)가 dry**이고 spike 분 cross가 peak와 일치
3. **`mechanical_repeat`** — 동일 isolated peak ≥2회 (`findRepeatedIsolatedSpikeRejects`)

오프라인 `rejectMask`는 sequential loop **전에** raw `scaledSeries`만 사용한다. `suspect-retained`·`acceptedUpdated:false`는 탐색에 영향 없음.

## rolling pack 전파

`RN_15M` / `RN_60M` / `RN_12HR`는 `buildQcRnDayScaledGrid`의 reject mask → `substituteSpikeRejectedRainScaled`로 **0 치환**.

`RN_24HR`는 derive 실패 시 **last confirmed RN_DAY hold** (≤30분).

## 로컬 검증

```bash
node kma_fetch/tests/test_aws_min_pack.js
```

테스트에 **prod JSON fixture** (`stn574ProdRoot`: spike 후 `RN_DAY=280`, window=0) 포함.

## 운영 warm (코드 배포 후)

```bash
node kma_fetch/warm_aws_min_packs.js \
  --from 20260823 --to 20260823 \
  --variables RN_15M,RN_60M,RN_12HR,RN_24HR,RN_DAY \
  --force
```

## 기대 pack (STN 574, 네 spike 시각)

| 변수 | 기대 |
| --- | --- |
| RN_15M / RN_60M / RN_12HR | 0.0 |
| RN_DAY | MISSING (`-32768`, reject) |
| RN_24HR | 28.0 (280 scaled) |

QC sidecar: `state=rejected`, `reason=isolatedPeakReset`, signals에 `isolated_peak_reset` + `mechanical_repeat`.

관련 문서: `docs/rainfall-producer-stn574-repeated-spike-qc-request.md`
