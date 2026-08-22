const fastify = require('fastify')({ logger: false });
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const crypto = require('crypto');
const YAML = require('yaml');
const sharp = require('sharp');
const {addHours, format, parse} = require('date-fns');
const { Pool } = require('pg');
const server_util = require('./server_util');
const { deriveKimTextDirs } = require('./kma_fetch/utils/kim_text_paths');
const { listHgt500Datasets } = require('./kma_fetch/utils/hgt500_dataset_list');
const {
  AWS_INTERVAL_MINUTES,
  deriveAwsJsonDir,
  enumerateTimestamps,
  readAwsMinFile,
  readAwsMinFiles,
  isPastAwsRange,
  awsRangeCacheKey,
  getAwsRangePayload,
  setAwsRangePayload
} = require('./kma_fetch/utils/aws_min_json');
const {
  loadStationCatalog,
  enrichAwsRowsForHttp,
  getStationsPayload
} = require('./kma_fetch/utils/aws_stn_catalog');
const {
  deriveAwsPackDir,
  getOrBuildAwsVariablePack,
  parseTimestampKorStrict,
  parsePackVariables,
  packDayBounds,
  loadCachedManifest,
  kstTodayYmd,
  PACK_SCHEMA_VERSION,
  PACK_SLUG_TO_VARIABLE,
  SUPPORTED_PACK_VARIABLES,
  isPackImmutableCacheable,
  packManifestCacheHeaders
} = require('./kma_fetch/utils/aws_min_pack');

require('dotenv').config(); // .env 파일 로드

const openapiPath = path.join(__dirname, 'docs', 'openapi.yaml');
const openapiDocument = YAML.parse(fsSync.readFileSync(openapiPath, 'utf8'));

const {findNearestTimestamp, findNearestWindTimestamp} = server_util;

// 데이터 압축 플러그인 등록
// fastify.register(require('@fastify/compress'), { 
//   global: true ,
//   threshold: 1024, // 최소 1KB 이상 데이터에 대해 압축 (기본값은 1024)
//   encodings: ['gzip', 'deflate', 'br'], // 지원하는 압축 형식 명시  
// }).after(() => {
//   fastify.log.info('Compression plugin registered')
// });
fastify.register(require('@fastify/cors'), {
  origin: '*'
})

const mode = process.env.MODE || 'dev';
const rootDir = mode === 'prod' ? process.env.ROOT_DIR_PROD : process.env.ROOT_DIR_DEV 
const resolveLocalPath = (dir) => path.isAbsolute(dir) ? dir : path.resolve(__dirname, dir);
const { outputDir: kimTextOutputDir } = deriveKimTextDirs(process.env.BASE_DIR || './data/weather');
const kimTextOutDir = resolveLocalPath(kimTextOutputDir);
const kimTextDatasetDir = path.join(kimTextOutDir, 'datasets');
const kimTextLatestPath = path.join(kimTextOutDir, 'latest', 'hgt500.json');
const awsJsonDir = deriveAwsJsonDir(__dirname);
const awsPackDir = deriveAwsPackDir(__dirname);
const snapAwsTimestamp = findNearestTimestamp(AWS_INTERVAL_MINUTES);
const awsStnCatalog = loadStationCatalog();
console.log(`MODE: ${mode}`);
console.log(`DATA DIR: ${rootDir}`);
console.log(`KIM TEXT DATASET DIR: ${kimTextDatasetDir}`);
console.log(`AWS JSON DIR: ${awsJsonDir}`);
console.log(`AWS PACK DIR: ${awsPackDir}`);
console.log(`AWS STN CODE: ${awsStnCatalog.codeFile} (${awsStnCatalog.stationCount} stations)`);

// 데이터베이스 연결 설정
const dbConfig = {
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
};


// PostgreSQL 풀 생성
const pool = new Pool(dbConfig);

// (async () => {
//   console.time('query');
//   const result = await pool.query(
//     'SELECT observation_time_kor, data FROM ir105_json WHERE observation_area = $1 AND step = $2 AND observation_time_kor = ANY($3)',
//     ['ea', 10, Array.from({ length: 100 }, (_, i) => `2025-03-01T${String(Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 10).padStart(2, '0')}:00Z`)],
//   );
//   console.timeEnd('query');
//   console.log('Rows:', result.rows.length);
// })();


const convertGMTToKSTString = (dateString) => {
  // 입력 문자열을 Date 객체로 파싱
  // parse 함수는 형식 패턴을 사용해 문자열을 해석
  const gmtDate = parse(dateString, 'yyyyMMddHHmm', new Date());
  // KST는 UTC+9이므로 9시간 추가
  const kstDate = addHours(gmtDate, 9);
  // 변환된 시간을 yymmddHHmm 형식으로 포매팅
  const kstString = format(kstDate, 'yyyyMMddHHmm');
  return kstString;
}

const convertKSTToGMTString = (dateString) => {
  // 입력 문자열을 Date 객체로 파싱
  // parse 함수는 형식 패턴을 사용해 문자열을 해석
  const kstDate = parse(dateString, 'yyyyMMddHHmm', new Date());
  // KST는 UTC+9이므로 9시간 추가
  const gmtDate = addHours(kstDate, -9);
  // 변환된 시간을 yymmddHHmm 형식으로 포매팅
  const gmtString = format(gmtDate, 'yyyyMMddHHmm');
  return gmtString;
}

(async () => {
  await fastify.register(require('@fastify/swagger'), {
    mode: 'static',
    specification: {
      document: openapiDocument
    }
  });
  await fastify.register(require('@fastify/swagger-ui'), {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true
    },
    staticCSP: true
  });

  await fastify.register(require('@fastify/compress'), { global: true}).after(() => {
    fastify.log.info('Compression plugin registered')
  });
  fastify.register(require('@fastify/static'), {
    root: rootDir,
    prefix: '/weather/'
  })
  await fs.mkdir(kimTextDatasetDir, { recursive: true });
  await fs.mkdir(awsPackDir, { recursive: true });

  /**
   * Pack assets: content-addressed binary + QC JSON (past complete → immutable + ETag).
   * Registered before static so Cache-Control is not overwritten by @fastify/static defaults.
   */
  fastify.get('/datasets/aws/:slug/1m/:day/:file', async (request, reply) => {
    const slug = String(request.params.slug || '').toLowerCase();
    const day = String(request.params.day || '');
    const file = String(request.params.file || '');
    const variable = PACK_SLUG_TO_VARIABLE[slug];
    if (!variable) {
      return reply.code(400).send({
        error: `Unsupported pack slug: ${slug}. Supported: ${SUPPORTED_PACK_VARIABLES.join(', ')}`
      });
    }
    if (!/^\d{8}$/.test(day)) {
      return reply.code(400).send({ error: 'Invalid day. Expected YYYYMMDD' });
    }

    const isLegacyBinary = file === `${slug}.i16le`;
    const isHashedBinary = new RegExp(`^${slug}-v[a-f0-9]{8}\\.i16le$`, 'i').test(file);
    const isQcJson = /^qc(-v[a-f0-9]+)?\.json$/i.test(file);

    if (!isLegacyBinary && !isHashedBinary && !isQcJson) {
      return reply.code(404).send({ error: 'Pack asset not found', slug, day, file });
    }

    const assetPath = path.join(awsPackDir, slug, '1m', day, file);
    try {
      const cached = await loadCachedManifest(awsPackDir, day, variable);
      const today = kstTodayYmd();
      const immutable = cached && isPackImmutableCacheable(cached) && day !== today;

      if (isQcJson) {
        const body = await fs.readFile(assetPath, 'utf8');
        let etag = null;
        if (cached && cached.qcDetailSha256 && file === cached.qcDetailFile) {
          etag = `"${cached.qcDetailSha256}"`;
        } else {
          etag = `"${crypto.createHash('sha256').update(body).digest('hex')}"`;
        }
        if (immutable) {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          reply.header('Cache-Control', 'no-store');
        }
        reply.header('ETag', etag);
        if (immutable && request.headers['if-none-match'] === etag) {
          return reply.code(304).send();
        }
        reply.type('application/json');
        return reply.send(body);
      }

      const binary = await fs.readFile(assetPath);
      if (immutable) {
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        reply.header('Cache-Control', 'no-store');
      }
      reply.header('X-AWS-Pack-Schema-Version', String(
        (cached && cached.schemaVersion) || PACK_SCHEMA_VERSION
      ));
      let etag = null;
      if (cached && cached.data && cached.data.sha256) {
        etag = `"${cached.data.sha256}"`;
      }
      if (!etag) {
        etag = `"${crypto.createHash('sha256').update(binary).digest('hex')}"`;
      }
      reply.header('ETag', etag);
      if (immutable && request.headers['if-none-match'] === etag) {
        return reply.code(304).send();
      }
      reply.type('application/octet-stream');
      return reply.send(binary);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return reply.code(404).send({ error: 'Pack asset not found', slug, day, file });
      }
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Internal server error', details: err.message });
    }
  });

  // manifest.json 등만 static. binary(.i16le) / qc-v*.json 은 위 전용 route만 사용
  fastify.register(require('@fastify/static'), {
    root: awsPackDir,
    prefix: '/datasets/aws/',
    decorateReply: false,
    allowedPath: (pathName) => !/\.i16le$/i.test(pathName) && !/^\/[^/]+\/1m\/\d{8}\/qc-v[a-f0-9]+\.json$/i.test(pathName)
  });
  fastify.register(require('@fastify/static'), {
    root: kimTextDatasetDir,
    prefix: '/datasets/',
    decorateReply: false
  });

  fastify.get('/api/hgt500/latest', async (request, reply) => {
    try {
      const data = await fs.readFile(kimTextLatestPath, 'utf8');
      reply.header('Content-Type', 'application/json');
      return data;
    } catch (err) {
      if (err.code === 'ENOENT') {
        return reply.code(404).send({ error: 'No KIM HGT500 dataset is available' });
      }
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Internal server error', details: err.message });
    }
  });

  /**
   * List available KIM HGT500 datasets under /datasets (PRD 12.2).
   * Query: tmfc, from, to, intervalMinutes, downsampleFactor, sourceFormat, status
   */
  fastify.get('/api/hgt500/datasets', async (request, reply) => {
    try {
      const result = await listHgt500Datasets(kimTextDatasetDir, request.query || {});
      reply.header('Cache-Control', 'no-store');
      return result;
    } catch (err) {
      if (err.code === 'BAD_QUERY') {
        return reply.code(400).send({ error: err.message });
      }
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Internal server error', details: err.message });
    }
  });

  fastify.get('/api/hgt500/datasets/:datasetId/manifest', async (request, reply) => {
    const { datasetId } = request.params;
    if (!/^kim-glob-hgt500-\d{10}$/.test(datasetId)) {
      return reply.code(400).send({ error: 'Invalid datasetId' });
    }
    return reply.redirect(`/datasets/${datasetId}/manifest.json`);
  });

  /**
   * AWS station catalog (stn_inf 기반 코드표).
   * LAW_ADDR_* / 최신 STN_NAME / 좌표. 프레임 JSON에는 LAW를 넣지 않고 여기서 lookup.
   */
  fastify.get('/api/aws/stations', async (request, reply) => {
    try {
      const payload = getStationsPayload(awsStnCatalog);
      reply.header('Cache-Control', 'public, max-age=3600');
      return payload;
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Internal server error', details: err.message });
    }
  });

  /**
   * 1분 exact debug — 2분 snap 없이 해당 분 JSON을 읽는다.
   */
  fastify.get('/api/aws/min/exact', async (request, reply) => {
    const { timestamp_kor } = request.query;
    if (!timestamp_kor) {
      return reply.code(400).send({ error: 'timestamp_kor query parameter is required' });
    }
    try {
      const tm = parseTimestampKorStrict(timestamp_kor);
      const result = await readAwsMinFile(awsJsonDir, tm);
      if (result.missing) {
        return reply.code(404).send({
          error: 'No AWS JSON found for the given timestamp',
          timestamp_kor: tm
        });
      }
      const data = enrichAwsRowsForHttp(result.data, awsStnCatalog);
      reply.header('Cache-Control', 'no-store');
      return {
        timestamp_kor: tm,
        intervalMinutes: 1,
        count: data.length,
        data
      };
    } catch (err) {
      if (err.code === 'BAD_QUERY' || (err.message && err.message.startsWith('Invalid timestamp'))) {
        return reply.code(400).send({ error: err.message });
      }
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Internal server error', details: err.message });
    }
  });

  /**
   * 1분 변수별 packed day timeline manifest.
   * Primary: ?date=YYYYMMDD (KST 하루 0000–2359).
   * Legacy: ?from=&to= YYYYMMDDHHMM (호환).
   * Binary: GET manifest.data.url (static /datasets/aws/...)
   */
  fastify.get('/api/aws/min/pack', async (request, reply) => {
    const { date, from, to, variable } = request.query;
    let fromKor = from;
    let toKor = to;
    try {
      if (date) {
        const bounds = packDayBounds(date);
        fromKor = bounds.from;
        toKor = bounds.to;
      } else if (!fromKor || !toKor) {
        return reply.code(400).send({
          error: 'date query parameter is required (YYYYMMDD). Legacy from&to still accepted.'
        });
      }
    } catch (err) {
      if (err.code === 'BAD_QUERY') {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }

    let variables;
    try {
      variables = parsePackVariables(variable);
    } catch (err) {
      if (err.code === 'BAD_QUERY') {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
    try {
      const force = request.query.force === '1' || request.query.force === 'true';
      const items = [];
      for (const v of variables) {
        const result = await getOrBuildAwsVariablePack(awsJsonDir, awsPackDir, fromKor, toKor, v, {
          catalog: awsStnCatalog,
          force
        });
        items.push(result.manifest);
      }
      if (items.length === 1) {
        const manifest = items[0];
        const cacheHeaders = packManifestCacheHeaders(manifest);
        reply.header('Cache-Control', cacheHeaders['Cache-Control']);
        if (cacheHeaders.ETag) reply.header('ETag', cacheHeaders.ETag);
        reply.header('X-AWS-Pack-Schema-Version', String(manifest.schemaVersion || PACK_SCHEMA_VERSION));
        return manifest;
      }
      const allImmutable = items.every((m) => isPackImmutableCacheable(m));
      reply.header('Cache-Control', allImmutable ? 'public, max-age=31536000, immutable' : 'no-store');
      reply.header('X-AWS-Pack-Schema-Version', String(PACK_SCHEMA_VERSION));
      return {
        schemaVersion: PACK_SCHEMA_VERSION,
        from: fromKor,
        to: toKor,
        variables,
        items
      };
    } catch (err) {
      if (err.code === 'BAD_QUERY') {
        return reply.code(400).send({ error: err.message });
      }
      if (err.code === 'NOT_FOUND') {
        return reply.code(404).send({ error: err.message });
      }
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Internal server error', details: err.message });
    }
  });

  /**
   * AWS_MIN station JSON for a single KST timestamp.
   * Reads in_data/aws/{yyyy-MM-dd}/AWS_MIN_{YYYYMMDDHHMM}.json (main_AWS output).
   * Response rows are enriched: STN_NAME + LAW_ADDR_SIDO/GUGUN from station catalog.
   * Default: 2분 nearest snap (호환). intervalMinutes=1 이면 exact.
   */
  fastify.get('/api/aws/min', async (request, reply) => {
    const { timestamp_kor, intervalMinutes } = request.query;
    if (!timestamp_kor) {
      return reply.code(400).send({ error: 'timestamp_kor query parameter is required' });
    }
    try {
      const interval = Number(intervalMinutes);
      const useExact = interval === 1;
      const snapped = useExact
        ? parseTimestampKorStrict(timestamp_kor)
        : snapAwsTimestamp(timestamp_kor);
      const result = await readAwsMinFile(awsJsonDir, snapped);
      if (result.missing) {
        return reply.code(404).send({
          error: 'No AWS JSON found for the given timestamp',
          timestamp_kor: snapped
        });
      }
      const data = enrichAwsRowsForHttp(result.data, awsStnCatalog);
      reply.header('Cache-Control', 'no-store');
      return {
        timestamp_kor: result.timestamp_kor,
        requested_timestamp_kor: timestamp_kor,
        intervalMinutes: useExact ? 1 : AWS_INTERVAL_MINUTES,
        count: data.length,
        data
      };
    } catch (err) {
      if (err.code === 'BAD_QUERY' || (err.message && err.message.startsWith('Invalid timestamp'))) {
        return reply.code(400).send({ error: err.message });
      }
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Internal server error', details: err.message });
    }
  });

  /**
   * AWS_MIN station JSON for a KST time range (inclusive, 2-minute steps).
   * Query: from, to (YYYYMMDDHHMM). Missing frames are listed in missingTimestamps.
   * Each item.data is enriched like /api/aws/min.
   */
  fastify.get('/api/aws/min/range', async (request, reply) => {
    const { from, to } = request.query;
    if (!from || !to) {
      return reply.code(400).send({ error: 'from and to query parameters are required' });
    }
    try {
      const fromSnap = snapAwsTimestamp(from);
      const toSnap = snapAwsTimestamp(to);
      const timestamps = enumerateTimestamps(fromSnap, toSnap, AWS_INTERVAL_MINUTES);
      const skipEnrich =
        request.query.enrich === '0' || request.query.enrich === 'false';
      const past = isPastAwsRange(toSnap);
      const rangeKey = awsRangeCacheKey(fromSnap, toSnap, skipEnrich);

      if (past) {
        const cached = getAwsRangePayload(rangeKey);
        if (cached) {
          reply.header('Cache-Control', 'public, max-age=86400');
          reply.header('ETag', cached.etag);
          reply.header('X-AWS-Range-Cache', 'hit');
          if (request.headers['if-none-match'] === cached.etag) {
            return reply.code(304).send();
          }
          return reply.type('application/json').send(cached.body);
        }
      }

      const frames = await readAwsMinFiles(awsJsonDir, timestamps);
      const items = [];
      const missingTimestamps = [];

      for (const result of frames) {
        if (result.missing) {
          missingTimestamps.push(result.timestamp_kor);
          continue;
        }
        const data = skipEnrich
          ? result.data
          : enrichAwsRowsForHttp(result.data, awsStnCatalog);
        items.push({
          timestamp_kor: result.timestamp_kor,
          count: data.length,
          data
        });
      }

      const payload = {
        from: fromSnap,
        to: toSnap,
        requested_from: from,
        requested_to: to,
        intervalMinutes: AWS_INTERVAL_MINUTES,
        requestedCount: timestamps.length,
        itemCount: items.length,
        missingTimestamps,
        items
      };

      if (past) {
        const body = JSON.stringify(payload);
        const stored = setAwsRangePayload(rangeKey, body);
        reply.header('Cache-Control', 'public, max-age=86400');
        reply.header('ETag', stored.etag);
        reply.header('X-AWS-Range-Cache', 'miss');
        return reply.type('application/json').send(body);
      }

      reply.header('Cache-Control', 'no-store');
      reply.header('X-AWS-Range-Cache', 'skip-today');
      return payload;
    } catch (err) {
      if (err.code === 'BAD_QUERY' || (err.message && err.message.startsWith('Invalid timestamp'))) {
        return reply.code(400).send({ error: err.message });
      }
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Internal server error', details: err.message });
    }
  });

  // 엔드포인트 설정: /ir105/:area/:step?timestamp_kor=...
  fastify.get('/ir105/:area/:step', async (request, reply) => {
    const { area, step } = request.params; // URL 파라미터
    const { timestamp_kor } = request.query; // 쿼리 파라미터

    // 필수 파라미터 검증
    if (!timestamp_kor) {
      return reply.code(400).send({ error: 'timestamp_kor query parameter is required' });
    }

    try {
      // 데이터베이스 쿼리
      const query = `
        SELECT * 
        FROM ir105_json 
        WHERE observation_area = $1 
          AND step = $2 
          AND observation_time_kor = $3
      `;
      const values = [area, step, timestamp_kor];

      const result = await pool.query(query, values);

      // 결과가 없는 경우
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'No data found for the given parameters' });
      }

      // 결과 반환 (JSON 데이터 포함)
      return reply.send(result.rows[0]);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Internal server error', details: err.message });
    }
  });

  fastify.get('/ir105/:area/:step/batch', async (request, reply) => {
    const { area, step } = request.params;
    const { timestamps } = request.query; // 예: "2025-03-01T00:00:00Z,2025-03-01T00:10:00Z"
    const timestampArray = timestamps.split(',');

    try {
      const query = `
        SELECT observation_time_kor, data 
        FROM ir105_json 
        WHERE observation_area = $1 
          AND step = $2 
          AND observation_time_kor = ANY($3)
        ORDER BY observation_time_kor ASC
      `;
      const values = [area, step, timestampArray];
      console.time('query')
      const result = await pool.query(query, values);
      console.timeEnd('query')

      console.time('stringify');
      const jsonString = JSON.stringify(result.rows);
      console.timeEnd('stringify');

      reply.header('Content-Type', 'application/json');
      return jsonString;

      // return reply.send(result.rows);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });
  fastify.get('/ir105/:area/:step/fs', async (request, reply) => {
    const { area, step } = request.params; // URL 파라미터
    const { timestamp_utc } = request.query; // 쿼리 파라미터
    // 필수 파라미터 검증
    if (!timestamp_utc) {
      return reply.code(400).send({ error: 'timestamp_kor query parameter is required' });
    }
    const jsonFileDir = 'd:/002.Code/001.python/netcdf/jsonfiles'
    const fileName = `gk2a_ami_le1b_ir105_${area}020lc_${timestamp_utc}_step${step}.json.gz`;
    const gzipFname = path.join(jsonFileDir, fileName);
    console.log('read', gzipFname)

    try {
      const data = await fs.readFile(gzipFname);

      reply.header('Content-Type', 'application/json');
      reply.header('Content-Encoding', 'gzip');
      return data;
    } catch (err) {
      fastify.log.error(err);
      if (err.code === 'ENOENT') {
          return reply.code(404).send({ error: 'File not found' });
        }
      throw err;
    }
  });

  const dataDirs = {
    ir105: 'gk2a',
    rdr: 'rdr',
    aws: 'aws',
    gfs: 'gfs',
    gfs_equ: 'gfs',
    kim: 'kim'
  }
  const getNearTimestampFunc = {
    ir105: (timestamp) => timestamp,
    rdr: findNearestTimestamp(5),
    aws: findNearestTimestamp(2),
    gfs: findNearestWindTimestamp(),
    gfs_equ: findNearestWindTimestamp(),
    kim: (timestamp) => timestamp
  }
  const kimTypeMap = {
    psl: { sub: 'etc', suffix: 'psl' },
    hgt500: { sub: 'prs', suffix: 'hgt500' }
  }

  // type
  // ir105-mono: ir105 흑백
  // ir105-color: ir105 칼라
  // rdr-hsp: Radar 강수
  // rdr-hsp-equi: Radar 강수 (등압면)
  // aws-RN_15M: AWS 15분강수
  // aws-RN_60M: AWS 60분강수
  // gfs-wind_10m: GFS 10m 바람 (json)
  // gfs-wind_850mb: GFS 850mb 바람 (json)
  // gfs-wind_500mb: GFS 500mb 바람 (json)
  // gfs-0p25_tmp_10m: GFS 10m 온도 (이미지)
  // gfs-0p25_tmp_500mb: GFS 500mb 온도 (이미지)
  // gfs-0p25_tmp_850mb: GFS 850mb 온도 (이미지)
  // gfs-0p25_rh_10m: GFS 10m 습도 (이미지)
  // gfs-0p25_rh_500mb: GFS 500mb 습도 (이미지)
  // gfs-0p25_rh_850mb: GFS 850mb 습도 (이미지)
  // gfs_equ-0p25_tmp_10m: GFS 10m 온도 (등압면)
  // gfs_equ-0p25_tmp_500m: GFS 500m 온도 (등압면)
  // gfs_equ-0p25_tmp_850m: GFS 850m 온도 (등압면)
  // kim-psl: KIM PSL (해수면기압)
  // kim-hgt500: KIM 500hPa 지위고도

  fastify.get('/:type/:area/:step/image', async (request, reply) => {
    const { type, area, step } = request.params; // URL 파라미터
    const { timestamp_kor } = request.query; // 쿼리 파라미터
    // 필수 파라미터 검증
    if (!timestamp_kor) {
      return reply.code(400).send({ error: 'timestamp_kor query parameter is required' });
    }
    const [dataName, dataKind] = type.split('-')
    console.log(type, dataName, dataKind)
    const timestamp = getNearTimestampFunc[dataName](timestamp_kor);
    const dataDir = dataDirs[dataName];
    const timestamp_utc = convertKSTToGMTString(timestamp);
    const subdir = `${timestamp.slice(0,4)}-${timestamp.slice(4,6)}-${timestamp.slice(6,8)}`
    const proj = area === 'fd' ? 'ge' : 'lc';
    let fileName;
    if(type === 'rdr-hsp'){
      // /rdr-hsp/fd/1/image?timestamp_kor=202604050000
      fileName = `RDR_CMP_HSP_PUB_${timestamp}_step${step}.png`;
    } else if(type === 'rdr-hsp-equi'){
      // /rdr-hsp-equi/fd/1/image?timestamp_kor=202604050000
      fileName = `RDR_CMP_HSP_PUB_${timestamp}_step${step}_equi.png`;
    }  else if(dataName == 'aws'){
      // /aws-RN_15M/fd/1/image?timestamp_kor=202604050000
      // provide only step1 image
      fileName = `AWS_MIN_${timestamp}_${dataKind}_step1.png`;
    } else if(dataName === 'gfs'){
      if(dataKind === 'wind_10m' || dataKind === 'wind_850mb' || dataKind === 'wind_500mb'){
        // /gfs-wind_10m/fd/1/image?timestamp_kor=202604050000
        fileName = `gfs_${dataKind}_${timestamp_utc}_${timestamp}.json`;
      } else {
        // /gfs-0p25_tmp_10m/fd/1/image?timestamp_kor=202604050000
        fileName = `gfs_${dataKind}_${timestamp_utc}_${timestamp}_merc.png`;
      }
    } else if(dataName === 'gfs_equ'){
      // /gfs_equ-0p25_tmp_10m/fd/1/image?timestamp_kor=202604050000
      fileName = `gfs_${dataKind}_${timestamp_utc}_${timestamp}.png`;
    } else if(dataName === 'kim'){
      // get /kim-psl/easia/1/image?timestamp_kor=202604050000
      const kimType = kimTypeMap[dataKind];
      if(!kimType){
        return reply.code(400).send({ error: `Unsupported KIM data kind: ${dataKind}` });
      }
      fileName = `g576_v091_${area}_${kimType.sub}.2byte_${kimType.suffix}_${timestamp}.png`;
    } else {
      // /ir105-mono/fd/1/image?timestamp_kor=202604050000
      // /ir105-color/fd/1/image?timestamp_kor=202604050000
      fileName = `gk2a_ami_le1b_${dataName}_${area}020${proj}_${timestamp_utc}_${timestamp}_step${step}_${dataKind}.png`;
    }
    // const gzipFname = path.join(jsonFileDir, fileName);
    console.log('rootDir, dataDir, subdir, fileName', rootDir, dataDir, subdir, fileName)
    const fullName = path.join(rootDir, dataDir, subdir, fileName);
    console.log('fullName', fullName)
    try {
      const data = await fs.readFile(fullName);
      let imageResized = data;
      // if(dataName === 'aws' && parseInt(step) !== 1){
      //   const ratio = 0.5;
      //   console.log('resize aws image:', ratio)
      //   imageResized = await sharp(data)
      //     .resize({
      //       width: Math.floor(ratio * (await sharp(data).metadata()).width),
      //       height: Math.floor(ratio * (await sharp(data).metadata()).height),
      //       fit: 'inside', // 비율 유지
      //       withoutEnlargement: true // 확대 방지
      //     })
      //     .png() // PNG 포맷 유지
      //     .toBuffer();
      // } else {
      //   imageResized = data;
      // }
      console.log('return', fullName)
      const contentType = dataName === 'gfs' ? 'application/json':'image/png'
      reply.header('Content-Type', contentType);
      // reply.header('Content-Encoding', 'gzip');
      return imageResized;
    } catch (err) {
      fastify.log.error(err);
      console.log('not found', fullName)
      if (err.code === 'ENOENT') {
          return reply.code(404).send({ error: 'File not found' });
        }
      throw err;
    }
  });


  // 서버 시작
  const start = async () => {
    try {
      await fastify.listen({ port: 3010, host: '0.0.0.0' });
      fastify.log.info('Server running on http://localhost:3010');
    } catch (err) {
      console.log(err)
      fastify.log.error(err);
      process.exit(1);
    }
  };

  start();

})()
