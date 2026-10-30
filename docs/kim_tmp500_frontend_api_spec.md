# KIM TMP500 Frontend API Spec

500hPa air temperature. HTTP/manifest/packed PNG shape matches HGT500; differences below.  
Common flow/decode/list merge: [`kim_hgt500_frontend_api_spec.md`](kim_hgt500_frontend_api_spec.md).

## 차이 요약

| 항목 | HGT500 | TMP500 |
|------|--------|--------|
| API | `/api/hgt500/*` | `/api/tmp500/*` |
| datasetId | `kim-glob-hgt500-{tmfc}` | `kim-glob-tmp500-{tmfc}` |
| latest pointer | `latest/hgt500.json` | `latest/tmp500.json` |
| Hub `name` | `hgt` | **`T`** (case-sensitive) |
| Hub `level` | 500 | 500 |
| TXT header | `hgt`, unit `m` | `T`, unit `K` |
| packed store unit | m | **°C** (`K − 273.15`) |
| packing `encoding.valueMin/Max` | 4500–6500 m | **−70 … +5 °C** (provisional) |
| assetType | `kim-hgt500-packed-png` | `kim-tmp500-packed-png` |
| anomaly PNG | yes (±512 m) | **none** (`anomalyPng` null) |

## Endpoints

```text
GET /api/tmp500/latest
GET /api/tmp500/datasets?from=&to=&tmfc=...
GET /api/tmp500/datasets/{datasetId}/manifest  → 302 /datasets/{id}/manifest.json
GET /datasets/kim-glob-tmp500-{tmfc}/...
```

list / latest pointer shape matches HGT500.

## Producer

- Watcher: `kma_fetch/main_KIM_TXT.js` (`KIM_TEXT_PRODUCTS` default `hgt500,hgt850,tmp500`)
- PM2: `kma_fetch_hgt_txt`
- Converter: `python/kim_hgt_text_sequence_generator.py --product tmp500`
- Product profile: `kim_hgt_converter/contracts.py` → `PRODUCT_PROFILES["tmp500"]`
