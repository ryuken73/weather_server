/**
 * AWS_MIN → TA Int16 LE pack (1분 timeline)
 * @see docs/aws-producer-1min-pack-requirements.md
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const {
  awsMinJsonPath,
  folderDateFromTimestampKor,
  enumerateTimestamps
} = require('./aws_min_json');
const { loadStationCatalog } = require('./aws_stn_catalog');

const MISSING_I16 = -32768;
const PACK_INTERVAL_MINUTES = 1;
const PACK_MAX_FRAMES = 1440;
const VARIABLE_TA = 'TA';

function deriveAwsPackDir(projectRoot, env = process.env) {
  if (env.AWS_PACK_DIR) {
    return path.isAbsolute(env.AWS_PACK_DIR)
      ? env.AWS_PACK_DIR
      : path.resolve(projectRoot, env.AWS_PACK_DIR);
  }
  const base = env.BASE_DIR || './data/weather';
  const resolved = path.isAbsolute(base) ? base : path.resolve(projectRoot, base);
  const normalized = path.normalize(resolved);
  const baseName = path.basename(normalized);
  if (baseName === 'in_data') {
    return path.join(path.dirname(normalized), 'out_data', 'aws', 'pack');
  }
  if (baseName === 'out_data') {
    return path.join(normalized, 'aws', 'pack');
  }
  return path.join(normalized, 'out_data', 'aws', 'pack');
}

function parseTimestampKorStrict(timestampKor) {
  if (!/^\d{12}$/.test(timestampKor)) {
    const err = new Error(`Invalid timestamp format. Expected YYYYMMDDHHMM, got: ${timestampKor}`);
    err.code = 'BAD_QUERY';
    throw err;
  }
  return timestampKor;
}

function encodeTaToI16(raw) {
  if (raw == null || raw === '') return MISSING_I16;
  const n = Number(raw);
  if (!Number.isFinite(n)) return MISSING_I16;
  // in_data JSON / MSSQL: TA 는 ×10 정수 (277 → 27.7℃)
  const scaled = Math.round(n);
  if (scaled > 32767 || scaled < -32767) return MISSING_I16;
  return scaled;
}

async function readFrameRows(awsJsonDir, tm) {
  const filePath = awsMinJsonPath(awsJsonDir, tm);
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return { missing: true, rows: [] };
    return { missing: false, rows: data };
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: true, rows: [] };
    throw err;
  }
}

function stationMetaFromCatalog(stnId, catalog) {
  const meta = catalog.byId.get(String(stnId));
  if (meta) {
    return {
      STN_ID: meta.STN_ID,
      STN_NAME: meta.STN_NAME,
      LAT: meta.LAT,
      LON: meta.LON,
      HT: meta.HT,
      LAW_ADDR_SIDO: meta.LAW_ADDR_SIDO != null ? meta.LAW_ADDR_SIDO : null,
      LAW_ADDR_GUGUN: meta.LAW_ADDR_GUGUN != null ? meta.LAW_ADDR_GUGUN : null
    };
  }
  return {
    STN_ID: Number(stnId),
    STN_NAME: null,
    LAT: null,
    LON: null,
    HT: null,
    LAW_ADDR_SIDO: null,
    LAW_ADDR_GUGUN: null
  };
}

function dayKeyFromRange(from, to) {
  const fromDay = from.slice(0, 8);
  const toDay = to.slice(0, 8);
  if (fromDay === toDay) return fromDay;
  return `${fromDay}_${toDay}`;
}

function isFullPastDay(from, to) {
  return from.endsWith('0000') && to.endsWith('2359') && from.slice(0, 8) === to.slice(0, 8);
}

function kstTodayYmd() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  // en-CA → YYYY-MM-DD
  return fmt.format(new Date()).replace(/-/g, '');
}

/**
 * @returns {Promise<{ manifest: object, binary: Buffer, packDirRel: string }>}
 */
async function buildAwsTaPack(awsJsonDir, fromKor, toKor, options = {}) {
  const from = parseTimestampKorStrict(fromKor);
  const to = parseTimestampKorStrict(toKor);
  if (from > to) {
    const err = new Error('`from` must be less than or equal to `to`');
    err.code = 'BAD_QUERY';
    throw err;
  }

  const timestamps = enumerateTimestamps(from, to, PACK_INTERVAL_MINUTES);
  if (timestamps.length > PACK_MAX_FRAMES) {
    const err = new Error(`Range too large. Max ${PACK_MAX_FRAMES} frames at 1-minute interval`);
    err.code = 'BAD_QUERY';
    throw err;
  }

  const catalog = options.catalog || loadStationCatalog();
  const frames = [];
  const missingTimestamps = [];
  const idSet = new Set();

  for (const tm of timestamps) {
    const { missing, rows } = await readFrameRows(awsJsonDir, tm);
    if (missing) {
      missingTimestamps.push(tm);
      frames.push(null);
      continue;
    }
    const byId = new Map();
    for (const row of rows) {
      if (row == null || row.STN_ID == null) continue;
      const id = Number(row.STN_ID);
      idSet.add(id);
      byId.set(id, row);
    }
    frames.push(byId);
  }

  if (idSet.size === 0 && missingTimestamps.length === timestamps.length) {
    const err = new Error('No AWS JSON found for the requested range');
    err.code = 'NOT_FOUND';
    throw err;
  }

  // union이 비면 코드표 전체로 fallback (전부 missing sentinel)
  let stationIds = [...idSet].sort((a, b) => a - b);
  if (stationIds.length === 0) {
    stationIds = catalog.stations.map((s) => s.STN_ID).sort((a, b) => a - b);
  }

  const stations = stationIds.map((id) => stationMetaFromCatalog(id, catalog));
  const stationCount = stations.length;
  const frameCount = timestamps.length;
  const sampleCount = frameCount * stationCount;
  const int16 = new Int16Array(sampleCount);
  int16.fill(MISSING_I16);

  for (let fi = 0; fi < frameCount; fi++) {
    const byId = frames[fi];
    if (!byId) continue;
    for (let si = 0; si < stationCount; si++) {
      const row = byId.get(stationIds[si]);
      if (!row) continue;
      int16[fi * stationCount + si] = encodeTaToI16(row.TA);
    }
  }

  const binary = Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
  const sha256 = crypto.createHash('sha256').update(binary).digest('hex');
  const dayKey = dayKeyFromRange(from, to);
  const todayYmd = kstTodayYmd();
  const isToday = from.slice(0, 8) === todayYmd || to.slice(0, 8) === todayYmd;
  const complete =
    !isToday &&
    isFullPastDay(from, to) &&
    missingTimestamps.length === 0;

  const revision = sha256.slice(0, 8);
  const datasetId = `aws-ta-1m-${dayKey}-v${revision}`;
  const relUrl = `/datasets/aws/ta/1m/${dayKey}/ta.i16le`;

  const manifest = {
    schemaVersion: 1,
    datasetId,
    source: 'KMA_AWS_MIN',
    variable: VARIABLE_TA,
    unit: 'degC',
    timezone: 'Asia/Seoul',
    intervalMinutes: PACK_INTERVAL_MINUTES,
    from,
    to,
    frameCount,
    stationCount,
    complete,
    generatedAt: new Date().toISOString(),
    stationOrder: 'STN_ID_ASC',
    stations,
    data: {
      url: relUrl,
      dtype: 'int16',
      endianness: 'little',
      order: 'FRAME_MAJOR_STATION_MINOR',
      scale: 0.1,
      offset: 0,
      missingValue: MISSING_I16,
      byteLength: binary.length,
      sha256
    },
    missingTimestamps,
    warnings: []
  };

  return { manifest, binary, dayKey, datasetId, revision };
}

async function publishAwsTaPack(packRoot, built) {
  const { manifest, binary, dayKey } = built;
  const outDir = path.join(packRoot, 'ta', '1m', dayKey);
  await fsp.mkdir(outDir, { recursive: true });

  const binTmp = path.join(outDir, `ta.i16le.${process.pid}.tmp`);
  const binFinal = path.join(outDir, 'ta.i16le');
  const manTmp = path.join(outDir, `manifest.json.${process.pid}.tmp`);
  const manFinal = path.join(outDir, 'manifest.json');

  await fsp.writeFile(binTmp, binary);
  await fsp.rename(binTmp, binFinal);
  await fsp.writeFile(manTmp, JSON.stringify(manifest, null, 2), 'utf8');
  await fsp.rename(manTmp, manFinal);

  return { manifest, binaryPath: binFinal, manifestPath: manFinal };
}

async function loadCachedManifest(packRoot, dayKey) {
  const manPath = path.join(packRoot, 'ta', '1m', dayKey, 'manifest.json');
  try {
    const raw = await fsp.readFile(manPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * 과거 complete pack은 cache hit, today/불완전은 재빌드
 */
async function getOrBuildAwsTaPack(awsJsonDir, packRoot, fromKor, toKor, options = {}) {
  const from = parseTimestampKorStrict(fromKor);
  const to = parseTimestampKorStrict(toKor);
  const dayKey = dayKeyFromRange(from, to);
  const force = options.force === true;
  const todayYmd = kstTodayYmd();
  const isToday = from.slice(0, 8) === todayYmd || to.slice(0, 8) === todayYmd;

  if (!force && !isToday && isFullPastDay(from, to)) {
    const cached = await loadCachedManifest(packRoot, dayKey);
    if (cached && cached.complete && cached.from === from && cached.to === to) {
      return { manifest: cached, fromCache: true };
    }
  }

  const built = await buildAwsTaPack(awsJsonDir, from, to, options);
  await publishAwsTaPack(packRoot, built);
  return { manifest: built.manifest, fromCache: false };
}

module.exports = {
  MISSING_I16,
  PACK_INTERVAL_MINUTES,
  PACK_MAX_FRAMES,
  deriveAwsPackDir,
  encodeTaToI16,
  buildAwsTaPack,
  publishAwsTaPack,
  getOrBuildAwsTaPack,
  parseTimestampKorStrict
};
