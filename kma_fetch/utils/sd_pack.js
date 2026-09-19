/**
 * Snow SD_TOT / SD_24H → Int16 LE day pack
 */
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DateTime } = require('luxon');
const { deriveSdJsonDir, deriveSdPackDir } = require('./sd_paths');
const { listSdJsonTmsForDay, readSdJson } = require('./sd_json');
const { loadSdStationCatalog } = require('./sd_stn_catalog');

const MISSING_I16 = -32768;
const PACK_SCHEMA_VERSION = 1;
const PACK_CONTRACT_REVISION = 1;
const DEFAULT_INTERVAL_MINUTES = 60;
const ZONE = 'Asia/Seoul';

const PACK_VARIABLES = Object.freeze({
  SD_TOT: {
    jsonField: 'SD_TOT',
    slug: 'sd_tot',
    unit: 'cm',
    scale: 0.1,
    source: 'KMA_APIHUB_kma_snow1.php',
    sourceField: 'SD (sd=tot)',
    accumulation: { type: 'instantaneous' }
  },
  SD_24H: {
    jsonField: 'SD_24H',
    slug: 'sd_24h',
    unit: 'cm',
    scale: 0.1,
    source: 'KMA_APIHUB_kma_snow1.php',
    sourceField: 'SD (sd=24h)',
    accumulation: { type: 'rolling', windowMinutes: 1440 }
  }
});

const SUPPORTED_SD_PACK_VARIABLES = Object.freeze(Object.keys(PACK_VARIABLES));
const PACK_SLUG_TO_VARIABLE = Object.freeze(
  Object.fromEntries(Object.entries(PACK_VARIABLES).map(([k, v]) => [v.slug, k]))
);

function encodeSnowToI16(raw) {
  if (raw == null || raw === '') return MISSING_I16;
  const n = Number(raw);
  if (!Number.isFinite(n)) return MISSING_I16;
  if (n <= -500) return MISSING_I16; // Hub ≤ -50cm
  if (n < 0) return MISSING_I16;
  if (n > 32767) return MISSING_I16;
  return Math.round(n);
}

function parseSdPackVariables(raw) {
  if (raw == null || raw === '') return ['SD_TOT'];
  const parts = String(raw)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (!parts.length) return ['SD_TOT'];
  for (const p of parts) {
    if (!PACK_VARIABLES[p]) {
      const err = new Error(`Unsupported snow pack variable: ${p}`);
      err.code = 'BAD_VARIABLE';
      throw err;
    }
  }
  return parts;
}

function parseDayYmd(raw) {
  const s = String(raw || '').replace(/-/g, '');
  if (!/^\d{8}$/.test(s)) {
    const err = new Error(`Invalid date: ${raw}`);
    err.code = 'BAD_DATE';
    throw err;
  }
  return s;
}

function packBinaryUrl(spec, dayKey, sha256, intervalMinutes) {
  const sha8 = sha256.slice(0, 8);
  const intervalSlug = `${intervalMinutes}m`;
  return `/datasets/sd/${spec.slug}/${intervalSlug}/${dayKey}/${spec.slug}-v${sha8}.i16le`;
}

function packDirFor(variable, dayKey, packRoot, intervalMinutes) {
  const spec = PACK_VARIABLES[variable];
  return path.join(packRoot, spec.slug, `${intervalMinutes}m`, dayKey);
}

function manifestPathFor(variable, dayKey, packRoot, intervalMinutes) {
  return path.join(packDirFor(variable, dayKey, packRoot, intervalMinutes), 'manifest.json');
}

function loadCachedManifest(variable, dayKey, packRoot, intervalMinutes) {
  const p = manifestPathFor(variable, dayKey, packRoot, intervalMinutes);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function stationSnapshot(catalog) {
  return (catalog.stations || []).map((s) => ({
    STN_ID: s.STN_ID,
    STN_NAME: s.STN_NAME,
    LAT: s.LAT,
    LON: s.LON,
    HT: s.HT,
    LAW_ADDR_SIDO: s.LAW_ADDR_SIDO != null ? s.LAW_ADDR_SIDO : null,
    LAW_ADDR_GUGUN: s.LAW_ADDR_GUGUN != null ? s.LAW_ADDR_GUGUN : null
  }));
}

function expectedTmsForDay(dayKey, intervalMinutes) {
  const start = DateTime.fromFormat(`${dayKey}0000`, 'yyyyMMddHHmm', { zone: ZONE });
  const tms = [];
  for (let i = 0; i < (24 * 60) / intervalMinutes; i++) {
    tms.push(start.plus({ minutes: i * intervalMinutes }).toFormat('yyyyMMddHHmm'));
  }
  return tms;
}

async function buildSdVariablePack(jsonRoot, packRoot, dayKey, variable, options = {}) {
  const intervalMinutes = options.intervalMinutes || DEFAULT_INTERVAL_MINUTES;
  const force = options.force === true;
  const catalog = options.catalog || loadSdStationCatalog();
  const spec = PACK_VARIABLES[variable];
  if (!spec) {
    const err = new Error(`Unsupported variable ${variable}`);
    err.code = 'BAD_VARIABLE';
    throw err;
  }

  const cached = !force ? loadCachedManifest(variable, dayKey, packRoot, intervalMinutes) : null;
  if (
    cached &&
    cached.schemaVersion === PACK_SCHEMA_VERSION &&
    cached.contractRevision === PACK_CONTRACT_REVISION &&
    cached.intervalMinutes === intervalMinutes
  ) {
    return { manifest: cached, built: false, fromCache: true, ok: true, variable };
  }

  const expected = expectedTmsForDay(dayKey, intervalMinutes);
  const present = new Set(listSdJsonTmsForDay(jsonRoot, dayKey));
  const frameTms = expected.filter((tm) => present.has(tm));
  if (frameTms.length === 0) {
    const err = new Error(`No SD JSON for ${dayKey}`);
    err.code = 'NO_SD_DATA';
    throw err;
  }

  const stations = stationSnapshot(catalog);
  const stationCount = stations.length;
  if (stationCount === 0) {
    const err = new Error('sd station catalog empty');
    err.code = 'NO_SD_STN';
    throw err;
  }
  const stnIndex = new Map(stations.map((s, i) => [String(s.STN_ID), i]));
  const frameCount = frameTms.length;
  const int16 = new Int16Array(frameCount * stationCount);
  int16.fill(MISSING_I16);

  let validSampleCount = 0;
  let missingSampleCount = 0;

  for (let fi = 0; fi < frameTms.length; fi++) {
    const tm = frameTms[fi];
    let rows = [];
    try {
      rows = await readSdJson(jsonRoot, tm);
    } catch (_) {
      rows = [];
    }
    const byId = new Map();
    for (const r of rows || []) {
      if (r && r.STN_ID != null) byId.set(String(r.STN_ID), r);
    }
    for (const [id, si] of stnIndex.entries()) {
      const row = byId.get(id);
      const raw = row ? row[spec.jsonField] : null;
      const encoded = encodeSnowToI16(raw);
      int16[fi * stationCount + si] = encoded;
      if (encoded === MISSING_I16) missingSampleCount += 1;
      else validSampleCount += 1;
    }
  }

  const binary = Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
  const sha256 = crypto.createHash('sha256').update(binary).digest('hex');
  const outDir = packDirFor(variable, dayKey, packRoot, intervalMinutes);
  await fsp.mkdir(outDir, { recursive: true });
  const binName = `${spec.slug}-v${sha256.slice(0, 8)}.i16le`;
  const binPath = path.join(outDir, binName);
  const partialBin = `${binPath}.partial`;
  await fsp.writeFile(partialBin, binary);
  await fsp.rename(partialBin, binPath);

  const complete = frameTms.length === expected.length;
  const from = frameTms[0];
  const to = frameTms[frameTms.length - 1];
  const validRatio = validSampleCount + missingSampleCount > 0
    ? validSampleCount / (validSampleCount + missingSampleCount)
    : 0;
  const coverage = {
    status: validSampleCount === 0 ? 'empty' : validRatio >= 0.8 ? 'ok' : 'degraded',
    validRatio
  };

  const missingTimestamps = expected.filter((tm) => !present.has(tm));
  const manifest = {
    schemaVersion: PACK_SCHEMA_VERSION,
    contractRevision: PACK_CONTRACT_REVISION,
    datasetId: `sd-${spec.slug}-${dayKey}`,
    source: spec.source,
    variable,
    sourceField: spec.sourceField,
    unit: spec.unit,
    timezone: ZONE,
    intervalMinutes,
    from,
    to,
    frameCount,
    stationCount,
    complete,
    dataComplete: coverage.status !== 'empty',
    generatedAt: new Date().toISOString(),
    stationOrder: 'STN_ID_ASC',
    stations,
    accumulation: spec.accumulation,
    data: {
      url: packBinaryUrl(spec, dayKey, sha256, intervalMinutes),
      dtype: 'int16',
      endianness: 'little',
      order: 'FRAME_MAJOR_STATION_MINOR',
      scale: spec.scale,
      offset: 0,
      missingValue: MISSING_I16,
      byteLength: binary.length,
      sha256
    },
    missingTimestamps,
    validSampleCount,
    missingSampleCount,
    validRatio,
    coverage,
    warnings: []
  };

  if (coverage.status === 'empty') {
    manifest.warnings.push(`${variable} has no valid samples`);
  }

  const manPath = manifestPathFor(variable, dayKey, packRoot, intervalMinutes);
  const partialMan = `${manPath}.partial`;
  await fsp.writeFile(partialMan, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await fsp.rename(partialMan, manPath);

  return { manifest, built: true, fromCache: false, ok: true, variable };
}

async function getOrBuildSdVariablePack(jsonRoot, packRoot, dayKey, variable, options = {}) {
  try {
    return await buildSdVariablePack(jsonRoot, packRoot, dayKey, variable, options);
  } catch (err) {
    return {
      ok: false,
      variable,
      message: err.message,
      code: err.code,
      manifest: null,
      built: false,
      fromCache: false
    };
  }
}

async function warmSdDayPack(jsonRoot, packRoot, dayKey, options = {}) {
  const variables = options.variables || [...SUPPORTED_SD_PACK_VARIABLES];
  const items = [];
  for (const variable of variables) {
    items.push(await getOrBuildSdVariablePack(jsonRoot, packRoot, dayKey, variable, options));
  }
  return { day: dayKey, items };
}

function isSdPackImmutableCacheable(manifest) {
  return Boolean(manifest && manifest.complete === true && manifest.coverage);
}

function sdPackManifestCacheHeaders(manifest) {
  if (isSdPackImmutableCacheable(manifest)) {
    return { 'Cache-Control': 'public, max-age=31536000, immutable' };
  }
  return { 'Cache-Control': 'no-store' };
}

module.exports = {
  MISSING_I16,
  PACK_SCHEMA_VERSION,
  PACK_CONTRACT_REVISION,
  DEFAULT_INTERVAL_MINUTES,
  PACK_VARIABLES,
  SUPPORTED_SD_PACK_VARIABLES,
  PACK_SLUG_TO_VARIABLE,
  encodeSnowToI16,
  parseSdPackVariables,
  parseDayYmd,
  loadCachedManifest,
  buildSdVariablePack,
  getOrBuildSdVariablePack,
  warmSdDayPack,
  isSdPackImmutableCacheable,
  sdPackManifestCacheHeaders,
  deriveSdJsonDir,
  deriveSdPackDir
};
