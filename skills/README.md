# skills/

Cursor/에이전트가 이 repo를 다룰 때 쓰는 **운영·계약 지식 입구**입니다.  
사람 온보딩에도 같은 경로를 쓰면 됩니다.

| Skill | 언제 보나 |
| --- | --- |
| [`weather-api-catalog`](weather-api-catalog/SKILL.md) | HTTP endpoint, timestamp, pack 변수 선택, OpenAPI |
| [`aws-min-json-pipeline`](aws-min-json-pipeline/SKILL.md) | AWS 수집, backfill, warm, today pack, RN/TA QC 운영 |
| [`kim-hgt500-png-pipeline`](kim-hgt500-png-pipeline/SKILL.md) | HGT500 변환·packed PNG·클라이언트 복호화 |

각 skill의 `references/`에 runbook·경로·포맷 상세가 있습니다.

**경계**

- HTTP 계약의 권위: `docs/openapi.yaml` + `weather-api-catalog`
- 수집/재기동/warm: `aws-min-json-pipeline` + [`../kma_fetch/README.md`](../kma_fetch/README.md)
- Producer↔Consumer 합의 원문: [`../docs/README.md`](../docs/README.md)
- 일회성 Hub 스크립트: [`../work/README.md`](../work/README.md)

Repo 전체 입구: [`../README.md`](../README.md)
