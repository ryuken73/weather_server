# docs/

Producer↔Consumer **계약·QC·합의·검증** 문서와 OpenAPI입니다.  
HTTP 스키마의 권위는 [`openapi.yaml`](openapi.yaml) (`GET /docs`)입니다.

이 폴더는 이슈 대응 과정에서 쌓인 md가 많습니다. 아래는 **주제별 입구**입니다.

---

## 바로 쓸 것

| 문서 | 용도 |
| --- | --- |
| [`pipeline-image-flow-draft.md`](pipeline-image-flow-draft.md) | 구름/RDR/GFS 등 **이미지 파이프라인 미확정** 항목 (parse_netcdf 편입 전) |
| [`openapi.yaml`](openapi.yaml) | 전체 HTTP OpenAPI |
| [`aws-producer-1min-pack-requirements.md`](aws-producer-1min-pack-requirements.md) | 1분 pack 요구사항·binary 계약 |
| [`aws-rn-qc-consumer-schema.md`](aws-rn-qc-consumer-schema.md) | RN sparse QC sidecar (schema v2 / `removedSpans`) |
| [`aws-ta-qc-consumer-schema.md`](aws-ta-qc-consumer-schema.md) | TA QC sidecar |
| [`rainfall-consumer-today-pack-guide.md`](rainfall-consumer-today-pack-guide.md) | 오늘(KST) partial pack consumer 가이드 |
| [`kim_hgt500_frontend_api_spec.md`](kim_hgt500_frontend_api_spec.md) | HGT500 manifest·frame·PNG |

---

## AWS 강수 (RN_*)

### 계약·분리

| 문서 | 내용 |
| --- | --- |
| [`rainfall-producer-rn24-rnday-change-request.md`](rainfall-producer-rn24-rnday-change-request.md) | `RN_24HR` rolling vs `RN_DAY` day 분리 |
| [`rainfall-producer-contract-v8-verification-request.md`](rainfall-producer-contract-v8-verification-request.md) | contract v8 검증 요청 |
| [`rainfall-producer-contract-v8-runtime-fix-request.md`](rainfall-producer-contract-v8-runtime-fix-request.md) | v8 런타임 이슈 |

### Spike / QC

| 문서 | 내용 |
| --- | --- |
| [`rainfall-producer-spike-qc-final-review.md`](rainfall-producer-spike-qc-final-review.md) | spike QC 최종 리뷰 |
| [`rainfall-producer-spike-qc-safety-review.md`](rainfall-producer-spike-qc-safety-review.md) | 안전성·오탐 리뷰 |
| [`rainfall-producer-rn24-spike-qc-request.md`](rainfall-producer-rn24-spike-qc-request.md) | RN_24HR spike |
| [`rainfall-producer-stn574-repeated-spike-qc-request.md`](rainfall-producer-stn574-repeated-spike-qc-request.md) | STN 574 반복 spike |

### 2026-09-01 이후 (stale plateau → rev4)

| 문서 | 내용 |
| --- | --- |
| [`rainfall-producer-rnday-stale-suspect-qc-request-2026-09-01.md`](rainfall-producer-rnday-stale-suspect-qc-request-2026-09-01.md) | STN 739 사례·요청 |
| [`rainfall-producer-rnday-stale-suspect-qc-consumer-notice-2026-09-01.md`](rainfall-producer-rnday-stale-suspect-qc-consumer-notice-2026-09-01.md) | Producer notice (rev3) |
| [`rainfall-producer-rnday-stale-suspect-qc-consumer-response-2026-09-01.md`](rainfall-producer-rnday-stale-suspect-qc-consumer-response-2026-09-01.md) | Consumer 회신 |
| [`rainfall-producer-rnday-cumulative-qc-hardening-request-2026-09-01.md`](rainfall-producer-rnday-cumulative-qc-hardening-request-2026-09-01.md) | carry seed QC 강화 요청 |
| [`rainfall-producer-rnday-cumulative-qc-rev4-spec-draft.md`](rainfall-producer-rnday-cumulative-qc-rev4-spec-draft.md) | **rev4 합의·구현** (`suspect` binary 제외) |

코드: `kma_fetch/utils/aws_min_pack.js` — `RN_DAY_QC_LOGIC_REVISION`

### Today pack refresh

| 문서 | 내용 |
| --- | --- |
| [`rainfall-producer-today-pack-refresh-request.md`](rainfall-producer-today-pack-refresh-request.md) | 강수 today refresh (선행) |
| [`producer-today-all-variable-pack-refresh-request.md`](producer-today-all-variable-pack-refresh-request.md) | 전 변수 registry refresh |

---

## AWS 기온 (TA)

| 문서 | 내용 |
| --- | --- |
| [`producer-ta-temperature-qc-request.md`](producer-ta-temperature-qc-request.md) | TA QC 요청·스펙 |
| [`ta-pack-qc-agreement-final.md`](ta-pack-qc-agreement-final.md) | rev9 최종 합의 |
| [`ta-pack-qc-consumer-agreement-request.md`](ta-pack-qc-consumer-agreement-request.md) / [`-response.md`](ta-pack-qc-consumer-agreement-response.md) | Consumer 합의 왕복 |
| [`ta-pack-qc-producer-consumer-open-points.md`](ta-pack-qc-producer-consumer-open-points.md) | 잔여 논의 |

---

## 파이프라인·기획 (레거시/단계)

| 문서 | 내용 |
| --- | --- |
| [`phase_8_server_pipeline_prd.md`](phase_8_server_pipeline_prd.md) | phase 8 PRD |
| [`phase_8_server_pipeline_implementation_plan.md`](phase_8_server_pipeline_implementation_plan.md) | 구현 계획 |

---

## 문서 작성 관례 (초안)

- Consumer 요청 / Producer notice / 회신 / 합의안을 **날짜·주제**로 파일명에 넣음
- 구현이 끝나면 합의 md에 **상태·revision**을 갱신
- OpenAPI·skill은 API 변경과 **같은 작업**에서 맞춤 (`.cursor/rules`의 api-docs-sync)

새 이슈 문서를 추가하면 이 README 표에 한 줄만 더해 두면 찾기가 쉽습니다.
