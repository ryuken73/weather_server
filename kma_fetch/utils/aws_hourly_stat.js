/**
 * AWS 시간통계(RN) 원천 JSON + day pack
 *
 * 원천: {awsJsonDir}/stat/hourly/rn/{yyyy-MM-dd}/AWS_STAT_RN_{tm}.json
 * pack: {awsStatPackDir}/rn/{YYYYMMDD}/manifest.json + data-v{sha8}.json
 */
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { DateTime } = require('luxon');
const {
  PRODUCTION_AWS_JSON_DIR,
  PRODUCTION_AWS_PACK_DIR,
  isProductionNodeEnv,
  resolveEnvPath
} = require('./aws_paths');
const {
  RN_FIELDS,
  sanitizeRnAmountNegatives,
  fetchAwsHourlyRnRows
} = require('../services/aws_apihub_hourly');

const ZONE = 'Asia/Seoul';
const HOURLY_STAT_SCHEMA_VERSION = 1;
const HOURLY_STAT_CONTRACT_REVISION = 3;
const HOURLY_STAT_KIND = 'aws-hourly-stat';
const SUPPORTED_HOURLY_STAT_VARIABLES = Object.freeze(['RN']);
const DEFAULT_HOURLY_LOOKBACK_HOURS = 6;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 닫힌 정시 lookback (최신 = 현재 시각의 시 정각 포함).
 * 예: 10:12 → …, 0500, …, 1000 (lookbackHours개). 진행 중 다음 시(1100)는 제외.
 *
 * @param {import('luxon').DateTime|Date|string|number} [now]
 * @param {number} [lookbackHours]
 * @returns {string[]} YYYYMMDDHHMM chronological
 */
function enumerateClosedHourlyTmsLookback(now, lookbackHours = DEFAULT_HOURLY_LOOKBACK_HOURS) {
  const n = Math.max(1, Math.floor(Number(lookbackHours) || DEFAULT_HOURLY_LOOKBACK_HOURS));
  let dt;
  if (now == null) {
    dt = DateTime.now().setZone(ZONE);
  } else if (DateTime.isDateTime(now)) {
    dt = now.setZone(ZONE);
  } else if (now instanceof Date) {
    dt = DateTime.fromJSDate(now, { zone: ZONE });
  } else {
    dt = DateTime.fromJSDate(new Date(now), { zone: ZONE });
  }
  if (!dt.isValid) {
    dt = DateTime.now().setZone(ZONE);
  }
  const end = dt.set({ minute: 0, second: 0, millisecond: 0 });
  const tms = [];
  for (let i = n - 1; i >= 0; i--) {
    tms.push(end.minus({ hours: i }).toFormat('yyyyMMddHHmm'));
  }
  return tms;
}

/**
 * Hub awsh RN → 디스크 JSON. 파일 있으면 skip (force 아니면).
 * CLI / main_AWS 공용.
 *
 * @returns {Promise<{ ok:number, fail:number, skipped:number, empty:number, writtenTms:string[], writtenDays:string[] }>}
 */
async function ensureHourlyRnHours(statJsonRoot, tms, options = {}) {
  const force = Boolean(options.force);
  const sleepMs = options.sleepMs != null ? Number(options.sleepMs) : 300;
  const authKey = options.authKey || process.env.API_KEY || process.env.KMA_API_KEY;
  const fetchFn = options.fetchFn || fetchAwsHourlyRnRows;
  const onHour = typeof options.onHour === 'function' ? options.onHour : null;
  const list = Array.isArray(tms) ? tms : [];

  if (!authKey && !options.fetchFn) {
    const err = new Error('API_KEY (or KMA_API_KEY) required for awsh.php');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const summary = {
    ok: 0,
    fail: 0,
    skipped: 0,
    empty: 0,
    writtenTms: [],
    writtenDays: []
  };
  const daySet = new Set();

  for (let i = 0; i < list.length; i++) {
    const tm = String(list[i]);
    const outPath = hourlyRnJsonPath(statJsonRoot, tm);
    if (!force && fs.existsSync(outPath)) {
      summary.skipped += 1;
      if (onHour) onHour({ tm, status: 'skip' });
      continue;
    }
    try {
      const { rows, qc } = await fetchFn(tm, { authKey });
      if (!rows || !rows.length) {
        summary.empty += 1;
        if (onHour) onHour({ tm, status: 'empty' });
      } else {
        await writeHourlyRnJson(statJsonRoot, tm, rows, { qc });
        summary.ok += 1;
        summary.writtenTms.push(tm);
        const day = tm.slice(0, 8);
        daySet.add(day);
        if (onHour) {
          const neg =
            qc && qc.negativeAmountNulls ? qc.negativeAmountNulls.nullCount : 0;
          onHour({ tm, status: 'ok', stationCount: rows.length, negNulls: neg });
        }
      }
    } catch (err) {
      summary.fail += 1;
      if (onHour) onHour({ tm, status: 'fail', message: err.message || String(err) });
    }
    if (sleepMs > 0 && i < list.length - 1) await sleep(sleepMs);
  }

  summary.writtenDays = [...daySet];
  return summary;
}

function deriveAwsHourlyStatJsonDir(projectRoot, env = process.env) {
  const override = resolveEnvPath(projectRoot, env.AWS_HOURLY_STAT_JSON_DIR);
  if (override) return override;
  // sibling of minute JSON: .../in_data/aws/stat/hourly
  const awsJsonRoot = (() => {
    const o = resolveEnvPath(projectRoot, env.AWS_JSON_DIR);
    if (o) return o;
    if (isProductionNodeEnv(env)) return PRODUCTION_AWS_JSON_DIR;
    const base = resolveEnvPath(projectRoot, env.BASE_DIR || './data/weather');
    return path.join(base, 'in_data', 'aws');
  })();
  return path.join(awsJsonRoot, 'stat', 'hourly');
}

function deriveAwsHourlyStatPackDir(projectRoot, env = process.env) {
  const override = resolveEnvPath(projectRoot, env.AWS_HOURLY_STAT_PACK_DIR);
  if (override) return override;
  const packRoot = (() => {
    const o = resolveEnvPath(projectRoot, env.AWS_PACK_DIR);
    if (o) return o;
    if (isProductionNodeEnv(env)) return PRODUCTION_AWS_PACK_DIR;
    const base = resolveEnvPath(projectRoot, env.BASE_DIR || './data/weather');
    return path.join(base, 'out_data', 'aws', 'pack');
  })();
  // .../out_data/aws/pack → .../out_data/aws/stat/hourly
  return path.join(path.dirname(packRoot), 'stat', 'hourly');
}

function folderDateFromTm(tm) {
  return `${tm.slice(0, 4)}-${tm.slice(4, 6)}-${tm.slice(6, 8)}`;
}

function hourlyRnJsonPath(statJsonRoot, tm) {
  return path.join(
    statJsonRoot,
    'rn',
    folderDateFromTm(tm),
    `AWS_STAT_RN_${tm}.json`
  );
}

function parseDayYmd(input) {
  const compact = String(input).replace(/-/g, '');
  if (!/^\d{8}$/.test(compact)) {
    const err = new Error(`Invalid date. Expected YYYYMMDD, got: ${input}`);
    err.code = 'BAD_QUERY';
    throw err;
  }
  const dt = DateTime.fromFormat(compact, 'yyyyMMdd', { zone: ZONE });
  if (!dt.isValid) {
    const err = new Error(`Invalid calendar date: ${input}`);
    err.code = 'BAD_QUERY';
    throw err;
  }
  return compact;
}

/** 달력일 D의 정시 TM: D0000 … D2300 (24개) */
function enumerateHourlyTmsForDay(dayYmd) {
  const day = parseDayYmd(dayYmd);
  const tms = [];
  for (let h = 0; h < 24; h++) {
    tms.push(`${day}${String(h).padStart(2, '0')}00`);
  }
  return tms;
}

async function writeHourlyRnJson(statJsonRoot, tm, rows, options = {}) {
  const outPath = hourlyRnJsonPath(statJsonRoot, tm);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  const payload = {
    schemaVersion: HOURLY_STAT_SCHEMA_VERSION,
    contractRevision: HOURLY_STAT_CONTRACT_REVISION,
    kind: HOURLY_STAT_KIND,
    variable: 'RN',
    tm,
    source: 'KMA_APIHUB_awsh.php',
    generatedAt: options.generatedAt || new Date().toISOString(),
    stationCount: rows.length,
    fields: ['TM', 'STN_ID', ...RN_FIELDS],
    data: rows
  };
  if (options.qc) {
    payload.qc = options.qc;
  }
  const tmp = `${outPath}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(payload), 'utf8');
  await fsp.rename(tmp, outPath);
  return outPath;
}

async function readHourlyRnJson(statJsonRoot, tm) {
  const p = hourlyRnJsonPath(statJsonRoot, tm);
  try {
    const raw = await fsp.readFile(p, 'utf8');
    return { path: p, missing: false, doc: JSON.parse(raw) };
  } catch (err) {
    if (err.code === 'ENOENT') return { path: p, missing: true, doc: null };
    throw err;
  }
}

function shortSha(hex) {
  return String(hex).slice(0, 8);
}

function packDataFileName(sha256) {
  return `data-v${shortSha(sha256)}.json`;
}

/**
 * @returns {Promise<{ manifest: object, dayKey: string }>}
 */
async function buildAwsHourlyRnPack(statJsonRoot, dayYmd, options = {}) {
  const dayKey = parseDayYmd(dayYmd);
  const tms = enumerateHourlyTmsForDay(dayKey);
  const hours = [];
  let presentHours = 0;
  let stationUnion = new Set();
  const dayNeg = {
    nullCount: 0,
    stationIds: new Set(),
    byField: Object.fromEntries(
      ['RN_DAY', 'RN_HR1', 'RN_60M_MAX', 'RN_15M_MAX'].map((f) => [f, 0])
    ),
    samples: [],
    hoursWithNulls: 0
  };

  for (const tm of tms) {
    const { missing, doc } = await readHourlyRnJson(statJsonRoot, tm);
    if (missing || !doc || !Array.isArray(doc.data)) {
      hours.push({ tm, present: false, stationCount: 0, stations: [] });
      continue;
    }
    presentHours += 1;
    const stations = doc.data.map((r) => {
      stationUnion.add(String(r.STN_ID));
      const out = { STN_ID: r.STN_ID };
      for (const f of RN_FIELDS) out[f] = r[f] == null ? null : r[f];
      return out;
    });

    // disk에 남은 음수(구 fetch)도 pack 직전에 STN/field만 null
    const sanitized = sanitizeRnAmountNegatives(stations, {
      context: `buildAwsHourlyRnPack ${tm}`
    });
    const diskQc =
      doc.qc && doc.qc.negativeAmountNulls ? doc.qc.negativeAmountNulls : null;
    const hourNullCount = Math.max(
      sanitized.nullCount,
      diskQc && diskQc.nullCount ? diskQc.nullCount : 0
    );
    const hourByField = { ...sanitized.byField };
    if (diskQc && diskQc.byField && sanitized.nullCount === 0) {
      for (const [f, n] of Object.entries(diskQc.byField)) {
        if (hourByField[f] != null) hourByField[f] = n;
      }
    }
    const hourSamples =
      sanitized.nullCount > 0
        ? sanitized.samples
        : diskQc && diskQc.samples
          ? diskQc.samples
          : [];
    const hourStationCount =
      sanitized.nullCount > 0
        ? sanitized.stationCount
        : diskQc && diskQc.stationCount
          ? diskQc.stationCount
          : 0;

    if (hourNullCount > 0) {
      dayNeg.hoursWithNulls += 1;
      dayNeg.nullCount += hourNullCount;
      for (const s of hourSamples) {
        dayNeg.stationIds.add(String(s.STN_ID));
        if (dayNeg.samples.length < 20) {
          dayNeg.samples.push({ ...s, TM: s.TM || tm });
        }
      }
      for (const [f, n] of Object.entries(hourByField)) {
        if (dayNeg.byField[f] != null) dayNeg.byField[f] += n;
      }
    }

    hours.push({
      tm,
      present: true,
      stationCount: stations.length,
      stations,
      ...(hourNullCount > 0
        ? {
            qc: {
              negativeAmountNulls: {
                nullCount: hourNullCount,
                stationCount: hourStationCount,
                byField: hourByField,
                samples: hourSamples
              }
            }
          }
        : {})
    });
  }

  if (presentHours === 0) {
    const err = new Error(`No AWS hourly RN JSON found for ${dayKey}`);
    err.code = 'NOT_FOUND';
    throw err;
  }

  const dataBody = {
    schemaVersion: HOURLY_STAT_SCHEMA_VERSION,
    contractRevision: HOURLY_STAT_CONTRACT_REVISION,
    kind: HOURLY_STAT_KIND,
    variable: 'RN',
    date: dayKey,
    hourCount: 24,
    presentHourCount: presentHours,
    fields: ['STN_ID', ...RN_FIELDS],
    rangeSemantics: {
      startExclusive: true,
      endInclusive: true,
      note: 'Consumer filters hours with (start,end]; see docs/aws-hourly-stat-rn-consumer-mapping.md'
    },
    uiMapping: {
      max1hRain: { field: 'RN_HR1', eventTime: 'TM' },
      max60mRain: { field: 'RN_60M_MAX', eventTime: 'TM + RN_60M_MAX_MI minutes' }
    },
    hours
  };

  const dataJson = JSON.stringify(dataBody);
  const sha256 = crypto.createHash('sha256').update(dataJson).digest('hex');
  const dataFile = packDataFileName(sha256);
  const complete = presentHours === 24;
  const today = DateTime.now().setZone(ZONE).toFormat('yyyyMMdd');

  const manifest = {
    schemaVersion: HOURLY_STAT_SCHEMA_VERSION,
    contractRevision: HOURLY_STAT_CONTRACT_REVISION,
    kind: HOURLY_STAT_KIND,
    variable: 'RN',
    date: dayKey,
    generatedAt: new Date().toISOString(),
    complete,
    hourCount: 24,
    presentHourCount: presentHours,
    stationCount: stationUnion.size,
    source: 'KMA_APIHUB_awsh.php',
    mappingDoc: 'docs/aws-hourly-stat-rn-consumer-mapping.md',
    data: {
      encoding: 'json',
      file: dataFile,
      sha256,
      url: `/datasets/aws/stat/hourly/rn/${dayKey}/${dataFile}`,
      byteLength: Buffer.byteLength(dataJson)
    },
    fields: ['STN_ID', ...RN_FIELDS],
    cache: {
      immutable: complete && dayKey !== today
    },
    qc: {
      negativeAmountNulls: {
        nullCount: dayNeg.nullCount,
        stationCount: dayNeg.stationIds.size,
        hoursWithNulls: dayNeg.hoursWithNulls,
        byField: dayNeg.byField,
        samples: dayNeg.samples
      }
    }
  };

  return { manifest, dataJson, dataBody, dayKey, dataFile };
}

async function publishAwsHourlyRnPack(statPackRoot, built) {
  const { manifest, dataJson, dayKey, dataFile } = built;
  const outDir = path.join(statPackRoot, 'rn', dayKey);
  await fsp.mkdir(outDir, { recursive: true });

  const dataFinal = path.join(outDir, dataFile);
  const dataTmp = `${dataFinal}.${process.pid}.tmp`;
  await fsp.writeFile(dataTmp, dataJson, 'utf8');
  await fsp.rename(dataTmp, dataFinal);

  const manFinal = path.join(outDir, 'manifest.json');
  const manTmp = `${manFinal}.${process.pid}.tmp`;
  await fsp.writeFile(manTmp, JSON.stringify(manifest, null, 2), 'utf8');
  await fsp.rename(manTmp, manFinal);

  // legacy alias without hash for convenience
  const alias = path.join(outDir, 'data.json');
  try {
    await fsp.unlink(alias);
  } catch (_) {
    /* ignore */
  }
  try {
    await fsp.link(dataFinal, alias);
  } catch (_) {
    await fsp.copyFile(dataFinal, alias);
  }

  return { manifest, outDir };
}

async function loadHourlyRnManifest(statPackRoot, dayYmd) {
  const dayKey = parseDayYmd(dayYmd);
  const manPath = path.join(statPackRoot, 'rn', dayKey, 'manifest.json');
  try {
    const raw = await fsp.readFile(manPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function getOrBuildAwsHourlyRnPack(statJsonRoot, statPackRoot, dayYmd, options = {}) {
  const dayKey = parseDayYmd(dayYmd);
  const force = Boolean(options.force);
  const manifestOnly = options.manifestOnly !== false;

  if (!force) {
    const cached = await loadHourlyRnManifest(statPackRoot, dayKey);
    if (cached && cached.data && cached.data.url) {
      const dataPath = path.join(statPackRoot, 'rn', dayKey, cached.data.file || 'data.json');
      if (fs.existsSync(dataPath)) {
        return { manifest: cached, built: false };
      }
    }
    if (manifestOnly) {
      const err = new Error(
        `AWS hourly RN pack not warmed for ${dayKey}. Run warm_aws_hourly_stat.js`
      );
      err.code = 'PACK_NOT_WARMED';
      err.dayKey = dayKey;
      err.variable = 'RN';
      throw err;
    }
  }

  const built = await buildAwsHourlyRnPack(statJsonRoot, dayKey, options);
  await publishAwsHourlyRnPack(statPackRoot, built);
  return { manifest: built.manifest, built: true };
}

function parseHourlyStatVariable(variable) {
  const v = String(variable == null || variable === '' ? 'RN' : variable).trim().toUpperCase();
  if (!SUPPORTED_HOURLY_STAT_VARIABLES.includes(v)) {
    const err = new Error(
      `Unsupported hourly stat variable: ${variable}. Supported: ${SUPPORTED_HOURLY_STAT_VARIABLES.join(', ')}`
    );
    err.code = 'BAD_QUERY';
    throw err;
  }
  return v;
}

module.exports = {
  HOURLY_STAT_SCHEMA_VERSION,
  HOURLY_STAT_CONTRACT_REVISION,
  HOURLY_STAT_KIND,
  SUPPORTED_HOURLY_STAT_VARIABLES,
  DEFAULT_HOURLY_LOOKBACK_HOURS,
  RN_FIELDS,
  deriveAwsHourlyStatJsonDir,
  deriveAwsHourlyStatPackDir,
  hourlyRnJsonPath,
  folderDateFromTm,
  parseDayYmd,
  enumerateHourlyTmsForDay,
  enumerateClosedHourlyTmsLookback,
  ensureHourlyRnHours,
  writeHourlyRnJson,
  readHourlyRnJson,
  buildAwsHourlyRnPack,
  publishAwsHourlyRnPack,
  loadHourlyRnManifest,
  getOrBuildAwsHourlyRnPack,
  parseHourlyStatVariable
};
