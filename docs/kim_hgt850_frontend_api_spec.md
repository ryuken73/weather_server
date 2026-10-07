# KIM HGT850 Frontend API Spec

HGT500과 **동일한 HTTP/manifest/packed PNG 계약**이다. 차이만 아래에 적는다.  
공통 플로우·복호화·list merge는 [`kim_hgt500_frontend_api_spec.md`](kim_hgt500_frontend_api_spec.md)를 따른다.

## 차이 요약

| 항목 | HGT500 | HGT850 |
|------|--------|--------|
| API | `/api/hgt500/*` | `/api/hgt850/*` |
| datasetId | `kim-glob-hgt500-{tmfc}` | `kim-glob-hgt850-{tmfc}` |
| latest pointer | `latest/hgt500.json` | `latest/hgt850.json` |
| Hub `level` | 500 | 850 |
| packing `encoding.valueMin/Max` | 4500–6500 m | **800–1800 m** |
| assetType | `kim-hgt500-packed-png` | `kim-hgt850-packed-png` |
| anomaly encoding | ±512 m | 동일 ±512 m |

## Endpoints

```text
GET /api/hgt850/latest
GET /api/hgt850/datasets?from=&to=&tmfc=...
GET /api/hgt850/datasets/{datasetId}/manifest  → 302 /datasets/{id}/manifest.json
GET /datasets/kim-glob-hgt850-{tmfc}/...
```

list item / latest pointer shape는 HGT500과 같다 (`datasetId`, `tmfc`, `manifestUrl`, valid window, …).

## Producer

- Watcher: `kma_fetch/main_KIM_TXT.js` (`KIM_TEXT_LEVELS` 기본 `500,850`)
- PM2: `kma_fetch_hgt_txt` (500+850 동일 프로세스)
- Converter: `python/kim_hgt_text_sequence_generator.py --level 850`
