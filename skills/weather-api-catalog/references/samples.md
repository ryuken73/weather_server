# 샘플 URL · Postman / Apidog

`{base}`:

- Local: `http://localhost:3010`
- Production: `https://weather-map.sbs.co.kr`

## HGT500

```text
GET {base}/api/hgt500/latest
GET {base}/api/hgt500/datasets?from=2026-07-28T00:00:00Z&to=2026-08-02T00:00:00Z
GET {base}/api/hgt500/datasets?tmfc=2026072800
GET {base}/api/hgt500/datasets/kim-glob-hgt500-2026070100/manifest
GET {base}/datasets/kim-glob-hgt500-2026070100/manifest.json
```

## AWS

```text
# 지점 코드표 (LAW_ADDR_* lookup)
GET {base}/api/aws/stations

# 2분 호환 JSON
GET {base}/api/aws/min?timestamp_kor=202604050000
GET {base}/api/aws/min/range?from=202604050000&to=202604050100

# 1분 exact / pack
GET {base}/api/aws/min/exact?timestamp_kor=202608121533
GET {base}/api/aws/min?timestamp_kor=202608121533&intervalMinutes=1
GET {base}/api/aws/min/pack?from=202608120000&to=202608122359&variable=TA
GET {base}/datasets/aws/ta/1m/20260812/ta.i16le
```

## IR105 JSON

```text
GET {base}/ir105/ea/10?timestamp_kor=2025-03-01T00:00:00Z
GET {base}/ir105/ea/10/batch?timestamps=2025-03-01T00:00:00Z,2025-03-01T00:10:00Z
GET {base}/ir105/ea/10/fs?timestamp_utc=202604050000
```

## Legacy image / wind

```text
GET {base}/gfs-wind_10m/fd/1/image?timestamp_kor=202604050000
GET {base}/gfs-wind_850mb/fd/1/image?timestamp_kor=202604050000
GET {base}/ir105-mono/fd/1/image?timestamp_kor=202604050000
GET {base}/rdr-hsp/fd/1/image?timestamp_kor=202604050000
GET {base}/kim-psl/easia/1/image?timestamp_kor=202604050000
```

## Docs

```text
GET {base}/docs          # Swagger UI
GET {base}/docs/json     # OpenAPI 3 JSON
```

## Postman

1. Import → Link (또는 File)
2. URL: `{base}/docs/json` 또는 repo의 `docs/openapi.yaml`
3. Environment에 `baseUrl` = `{base}` 설정

## Apidog

1. Import OpenAPI
2. `{base}/docs/json` 또는 `docs/openapi.yaml`
3. 서버 URL 변경 시 주기적으로 Re-import / Sync

별도 Postman collection 파일은 이중 관리하지 않는다. **Source of truth = `docs/openapi.yaml`**.
