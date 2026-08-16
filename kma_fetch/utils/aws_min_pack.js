/**
 * AWS_MIN → variable Int16 LE pack (1분 timeline)
 * @see docs/aws-producer-1min-pack-requirements.md
 * @see skills/aws-min-json-pipeline/references/rainfall-producer-implementation-handoff.md
 */
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const {
  awsMinJsonPath,
  enumerateTimestamps
} = require('./aws_min_json');
const { loadStationCatalog } = require('./aws_stn_catalog');
const {
  PRODUCTION_AWS_PACK_DIR,
  isProductionNodeEnv,
  resolveEnvPath,
  deriveAwsPackDirFromBase
} = require('./aws_paths');

const MISSING_I16 = -32768;
const PACK_INTERVAL_MINUTES = 1;
const PACK_MAX_FRAMES = 1440;
const VARIABLE_TA = 'TA';
/** TA QC + rain missing rules. Binary layout unchanged → keep v3. */
const PACK_SCHEMA_VERSION = 3;

/**
 * Hub nph-aws2_min: 물리기온 ≤ -50℃ 결측.
 * JSON/MSSQL TA는 ×10 정수. DB 관례 sentinel `-999`(= -99.9℃)도 결측.
 * 정상 음수(예: -15.0 → -150)는 유지.
 */
const TA_PHYSICAL_MISSING_MAX_C = -50;
const TA_PHYSICAL_VALID_MAX_C = 60;
const TA_SCALED_SENTINELS = Object.freeze(new Set([-999]));
const HUB_PHYSICAL_MISSING_MAX = -50;
const WD_MAX_DEG = 360;
const HM_MAX_PCT = 100;

function toScaledOrNull(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function encodeTaToI16(raw) {
  const scaled = toScaledOrNull(raw);
  if (scaled == null) return MISSING_I16;
  if (TA_SCALED_SENTINELS.has(scaled)) return MISSING_I16;
  if (scaled <= TA_PHYSICAL_MISSING_MAX_C * 10) return MISSING_I16;
  if (scaled > TA_PHYSICAL_VALID_MAX_C * 10) return MISSING_I16;
  if (scaled > 32767 || scaled < -32767) return MISSING_I16;
  return scaled;
}

/**
 * Rain / wind-speed JSON is already ×10. 0 is valid. Hub ≤ -50 and any negative → missing.
 * Values above Int16 max → missing (no silent wrap).
 */
function encodeNonNegativeToI16(raw) {
  const scaled = toScaledOrNull(raw);
  if (scaled == null) return MISSING_I16;
  if (scaled <= HUB_PHYSICAL_MISSING_MAX * 10) return MISSING_I16;
  if (scaled < 0) return MISSING_I16;
  if (scaled > 32767) return MISSING_I16;
  return scaled;
}

const encodeRainToI16 = encodeNonNegativeToI16;
const encodeWindSpeedToI16 = encodeNonNegativeToI16;

/** Wind direction ×10 deg. 0–360 inclusive; calm = 360.0 → 3600. No wrap. */
function encodeWindDirToI16(raw) {
  const scaled = toScaledOrNull(raw);
  if (scaled == null) return MISSING_I16;
  if (scaled <= HUB_PHYSICAL_MISSING_MAX * 10) return MISSING_I16;
  if (scaled < 0 || scaled > WD_MAX_DEG * 10) return MISSING_I16;
  return scaled;
}

/** Relative humidity ×10 %. 0 is valid. >100% → missing. */
function encodeHumidityToI16(raw) {
  const scaled = toScaledOrNull(raw);
  if (scaled == null) return MISSING_I16;
  if (TA_SCALED_SENTINELS.has(scaled)) return MISSING_I16;
  if (scaled <= HUB_PHYSICAL_MISSING_MAX * 10) return MISSING_I16;
  if (scaled < 0 || scaled > HM_MAX_PCT * 10) return MISSING_I16;
  return scaled;
}

/** Dewpoint ×10 ℃. Hub ≤ -50 / -999 → missing. No TA temporal QC, no >60 clip. */
function encodeDewpointToI16(raw) {
  const scaled = toScaledOrNull(raw);
  if (scaled == null) return MISSING_I16;
  if (TA_SCALED_SENTINELS.has(scaled)) return MISSING_I16;
  if (scaled <= HUB_PHYSICAL_MISSING_MAX * 10) return MISSING_I16;
  if (scaled > 32767 || scaled < -32767) return MISSING_I16;
  return scaled;
}

const PACK_VARIABLES = Object.freeze({
  TA: {
    jsonField: 'TA',
    slug: 'ta',
    unit: 'degC',
    scale: 0.1,
    source: 'KMA_AWS_MIN',
    sourceField: 'TA',
    family: 'ta',
    encode: encodeTaToI16,
    temporalQc: 'ta'
  },
  RN_15M: {
    jsonField: 'RN_15M',
    slug: 'rn_15m',
    unit: 'mm',
    scale: 0.1,
    source: 'KMA_APIHUB_nph-aws2_min',
    sourceField: 'RN-15m',
    family: 'rain',
    accumulation: { type: 'rolling', windowMinutes: 15 },
    encode: encodeRainToI16
  },
  RN_60M: {
    jsonField: 'RN_60M',
    slug: 'rn_60m',
    unit: 'mm',
    scale: 0.1,
    source: 'KMA_APIHUB_nph-aws2_min',
    sourceField: 'RN-60m',
    family: 'rain',
    accumulation: { type: 'rolling', windowMinutes: 60 },
    encode: encodeRainToI16
  },
  RN_12HR: {
    jsonField: 'RN_12HR',
    slug: 'rn_12hr',
    unit: 'mm',
    scale: 0.1,
    source: 'KMA_APIHUB_nph-aws2_min',
    sourceField: 'RN-12H',
    family: 'rain',
    accumulation: { type: 'rolling', windowMinutes: 720 },
    encode: encodeRainToI16
  },
  RN_24HR: {
    jsonField: 'RN_24HR',
    slug: 'rn_24hr',
    unit: 'mm',
    scale: 0.1,
    source: 'KMA_APIHUB_nph-aws2_min',
    sourceField: 'RN-DAY',
    family: 'rain',
    accumulation: { type: 'day', timezone: 'Asia/Seoul' },
    encode: encodeRainToI16
  },
  WS_INS: {
    jsonField: 'WS_INS',
    slug: 'ws_ins',
    unit: 'm/s',
    scale: 0.1,
    source: 'KMA_APIHUB_nph-aws2_min',
    sourceField: 'WSS',
    family: 'wind_speed',
    encode: encodeWindSpeedToI16
  },
  WS: {
    jsonField: 'WS',
    slug: 'ws',
    unit: 'm/s',
    scale: 0.1,
    source: 'KMA_APIHUB_nph-aws2_min',
    sourceField: 'WS1',
    family: 'wind_speed',
    encode: encodeWindSpeedToI16
  },
  WD_INS: {
    jsonField: 'WD_INS',
    slug: 'wd_ins',
    unit: 'deg',
    scale: 0.1,
    source: 'KMA_APIHUB_nph-aws2_min',
    sourceField: 'WDS',
    family: 'wind_dir',
    encode: encodeWindDirToI16
  },
  WD: {
    jsonField: 'WD',
    slug: 'wd',
    unit: 'deg',
    scale: 0.1,
    source: 'KMA_APIHUB_nph-aws2_min',
    sourceField: 'WD1',
    family: 'wind_dir',
    encode: encodeWindDirToI16
  },
  HM: {
    jsonField: 'HM',
    slug: 'hm',
    unit: 'pct',
    scale: 0.1,
    source: 'KMA_APIHUB_nph-aws2_min',
    sourceField: 'HM',
    family: 'humidity',
    encode: encodeHumidityToI16
  },
  TD: {
    jsonField: 'TD',
    slug: 'td',
    unit: 'degC',
    scale: 0.1,
    source: 'KMA_APIHUB_nph-aws2_min',
    sourceField: 'TD',
    family: 'dewpoint',
    encode: encodeDewpointToI16
  }
});

const REQUIRED_PACK_VARIABLES = Object.freeze([
  'TA',
  'RN_15M',
  'RN_60M',
  'RN_12HR',
  'RN_24HR',
  'WS_INS'
]);
const SUPPORTED_PACK_VARIABLES = Object.freeze(Object.keys(PACK_VARIABLES));
const EXCLUDED_PACK_ALIASES = Object.freeze({ RN_1HR: 'RN_60M' });
const EXCLUDED_PACK_FIELDS = Object.freeze(['RN_6HR', 'RN_48HR', 'RN_YN']);
const PACK_SLUG_TO_VARIABLE = Object.freeze(
  Object.fromEntries(SUPPORTED_PACK_VARIABLES.map((name) => [PACK_VARIABLES[name].slug, name]))
);

function getPackVariableSpec(variable) {
  const name = String(variable || '').toUpperCase();
  const spec = PACK_VARIABLES[name];
  if (!spec) {
    const err = new Error(`Unsupported pack variable: ${variable}. Supported: ${SUPPORTED_PACK_VARIABLES.join(', ')}`);
    err.code = 'BAD_QUERY';
    throw err;
  }
  return { name, spec };
}

function deriveAwsPackDir(projectRoot, env = process.env) {
  const override = resolveEnvPath(projectRoot, env.AWS_PACK_DIR);
  if (override) return override;
  if (isProductionNodeEnv(env)) return PRODUCTION_AWS_PACK_DIR;
  return deriveAwsPackDirFromBase(projectRoot, env.BASE_DIR || './data/weather');
}

function parseTimestampKorStrict(timestampKor) {
  if (!/^\d{12}$/.test(timestampKor)) {
    const err = new Error(`Invalid timestamp format. Expected YYYYMMDDHHMM, got: ${timestampKor}`);
    err.code = 'BAD_QUERY';
    throw err;
  }
  return timestampKor;
}

function readTaQcConfig(env = process.env) {
  const enabled = env.AWS_TA_QC !== '0' && env.AWS_TA_QC !== 'false';
  return {
    enabled,
    maxDeltaScaled: Math.round(Number(env.AWS_TA_QC_MAX_DELTA_DEGC || 3) * 10),
    spikeNeighborMaxScaled: Math.round(Number(env.AWS_TA_QC_SPIKE_NEIGHBOR_MAX_DEGC || 1.5) * 10),
    spikeMinScaled: Math.round(Number(env.AWS_TA_QC_SPIKE_MIN_DEGC || 2.5) * 10)
  };
}

/**
 * Pack 전용 temporal QC. /exact·디스크 JSON 원천은 그대로.
 * 1) 직전 유효 분 대비 |ΔTA| > maxDelta → missing
 * 2) 양 이웃은 비슷한데 가운데만 크게 튐 → missing (고립 스파이크)
 */
function applyTaTemporalQc(int16, stationCount, frameCount, config) {
  if (!config.enabled) return 0;
  let excluded = 0;

  for (let si = 0; si < stationCount; si++) {
    for (let fi = 1; fi < frameCount; fi++) {
      const idx = fi * stationCount + si;
      const curr = int16[idx];
      if (curr === MISSING_I16) continue;

      let prevVal = null;
      for (let pj = fi - 1; pj >= 0; pj--) {
        const pv = int16[pj * stationCount + si];
        if (pv !== MISSING_I16) {
          prevVal = pv;
          break;
        }
      }
      if (prevVal == null) continue;
      if (Math.abs(curr - prevVal) > config.maxDeltaScaled) {
        int16[idx] = MISSING_I16;
        excluded += 1;
      }
    }

    for (let fi = 1; fi < frameCount - 1; fi++) {
      const idx = fi * stationCount + si;
      if (int16[idx] === MISSING_I16) continue;
      const prev = int16[(fi - 1) * stationCount + si];
      const next = int16[(fi + 1) * stationCount + si];
      const curr = int16[idx];
      if (prev === MISSING_I16 || next === MISSING_I16) continue;
      if (
        Math.abs(prev - next) <= config.spikeNeighborMaxScaled &&
        Math.abs(curr - prev) > config.spikeMinScaled &&
        Math.abs(curr - next) > config.spikeMinScaled
      ) {
        int16[idx] = MISSING_I16;
        excluded += 1;
      }
    }
  }

  return excluded;
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
  return fmt.format(new Date()).replace(/-/g, '');
}

function kstYmdDaysAgo(days) {
  const ms = Date.now() - Number(days) * 24 * 60 * 60 * 1000;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return fmt.format(new Date(ms)).replace(/-/g, '');
}

function packDayBounds(yyyymmdd) {
  const day = String(yyyymmdd || '').replace(/-/g, '');
  if (!/^\d{8}$/.test(day)) {
    const err = new Error(`Invalid pack date. Expected YYYYMMDD or YYYY-MM-DD, got: ${yyyymmdd}`);
    err.code = 'BAD_QUERY';
    throw err;
  }
  return { yyyymmdd: day, from: `${day}0000`, to: `${day}2359` };
}

function packRelDir(spec, dayKey) {
  return path.join(spec.slug, '1m', dayKey);
}

function packBinaryUrl(spec, dayKey) {
  return `/datasets/aws/${spec.slug}/1m/${dayKey}/${spec.slug}.i16le`;
}

/**
 * `variable` query. 기본 TA. comma 복수(TA,RN_60M). FULL 불가.
 * @returns {string[]}
 */
function parsePackVariables(raw) {
  const fail = (message) => {
    const err = new Error(message);
    err.code = 'BAD_QUERY';
    throw err;
  };
  if (raw == null || String(raw).trim() === '') {
    return [VARIABLE_TA];
  }
  const parts = String(raw)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (parts.length === 0) return [VARIABLE_TA];
  const seen = new Set();
  const out = [];
  for (const v of parts) {
    if (v === 'FULL') {
      fail(
        `variable=FULL is not supported. Request variables separately (e.g. variable=TA or variable=${SUPPORTED_PACK_VARIABLES.join(',')}).`
      );
    }
    if (EXCLUDED_PACK_ALIASES[v]) {
      fail(`${v} is an alias of ${EXCLUDED_PACK_ALIASES[v]} and is not a pack variable. Use variable=${EXCLUDED_PACK_ALIASES[v]}.`);
    }
    if (EXCLUDED_PACK_FIELDS.includes(v)) {
      fail(`${v} is not packed. Supported: ${SUPPORTED_PACK_VARIABLES.join(', ')}`);
    }
    if (!PACK_VARIABLES[v]) {
      fail(`Unsupported pack variable: ${v}. Supported: ${SUPPORTED_PACK_VARIABLES.join(', ')}`);
    }
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function countSamples(int16) {
  let valid = 0;
  let missing = 0;
  for (let i = 0; i < int16.length; i++) {
    if (int16[i] === MISSING_I16) missing += 1;
    else valid += 1;
  }
  return { validSampleCount: valid, missingSampleCount: missing };
}

const COVERAGE_OK_MIN_RATIO = 0.8;

function assessPackCoverage(validSampleCount, missingSampleCount) {
  const total = validSampleCount + missingSampleCount;
  const validRatio = total === 0 ? 0 : validSampleCount / total;
  let status = 'ok';
  if (validSampleCount === 0) status = 'empty';
  else if (validRatio < COVERAGE_OK_MIN_RATIO) status = 'degraded';
  return {
    validSampleCount,
    missingSampleCount,
    validRatio: Number(validRatio.toFixed(4)),
    status
  };
}

async function readDayFrames(awsJsonDir, timestamps, catalog) {
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

  let stationIds = [...idSet].sort((a, b) => a - b);
  if (stationIds.length === 0) {
    stationIds = catalog.stations.map((s) => s.STN_ID).sort((a, b) => a - b);
  }

  return { frames, missingTimestamps, stationIds };
}

/**
 * @returns {Promise<{ manifest: object, binary: Buffer, dayKey: string, datasetId: string, revision: string, variable: string }>}
 */
async function buildAwsVariablePack(awsJsonDir, fromKor, toKor, variable, options = {}) {
  const { name, spec } = getPackVariableSpec(variable);
  const from = parseTimestampKorStrict(fromKor);
  const to = parseTimestampKorStrict(toKor);
  if (from > to) {
    const err = new Error('`from` must be less than or equal to `to`');
    err.code = 'BAD_QUERY';
    throw err;
  }

  const timestamps = enumerateTimestamps(from, to, PACK_INTERVAL_MINUTES, PACK_MAX_FRAMES);
  const catalog = options.catalog || loadStationCatalog();
  const { frames, missingTimestamps, stationIds } = await readDayFrames(awsJsonDir, timestamps, catalog);

  const stations = stationIds.map((id) => stationMetaFromCatalog(id, catalog));
  const stationCount = stations.length;
  const frameCount = timestamps.length;
  const int16 = new Int16Array(frameCount * stationCount);
  int16.fill(MISSING_I16);

  let overflowCount = 0;
  let negativeRainCount = 0;
  const jsonField = spec.jsonField;

  let jsonPresentCount = 0;
  for (let fi = 0; fi < frameCount; fi++) {
    const byId = frames[fi];
    if (!byId) continue;
    for (let si = 0; si < stationCount; si++) {
      const row = byId.get(stationIds[si]);
      if (!row) continue;
      const raw = row[jsonField];
      if (raw != null && raw !== '') jsonPresentCount += 1;
      if (spec.family === 'rain' && raw != null && raw !== '') {
        const n = Number(raw);
        if (Number.isFinite(n)) {
          const scaled = Math.round(n);
          if (scaled > 32767) overflowCount += 1;
          else if (scaled < 0 && scaled > HUB_PHYSICAL_MISSING_MAX * 10) negativeRainCount += 1;
        }
      }
      int16[fi * stationCount + si] = spec.encode(raw);
    }
  }

  let taQcConfig = null;
  let taQcExcluded = 0;
  if (spec.temporalQc === 'ta') {
    taQcConfig = readTaQcConfig(options.env);
    taQcExcluded = applyTaTemporalQc(int16, stationCount, frameCount, taQcConfig);
  }

  const { validSampleCount, missingSampleCount } = countSamples(int16);
  const coverage = assessPackCoverage(validSampleCount, missingSampleCount);
  coverage.jsonPresentCount = jsonPresentCount;
  const dataComplete = coverage.status === 'ok';
  const binary = Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
  const sha256 = crypto.createHash('sha256').update(binary).digest('hex');
  const dayKey = dayKeyFromRange(from, to);
  const todayYmd = kstTodayYmd();
  const isToday = from.slice(0, 8) === todayYmd || to.slice(0, 8) === todayYmd;
  const complete = !isToday && isFullPastDay(from, to) && missingTimestamps.length === 0;
  const revision = sha256.slice(0, 8);
  const datasetId = `aws-${spec.slug}-1m-${dayKey}-v${revision}`;

  const warnings = [];
  if (taQcExcluded > 0) {
    warnings.push(`TA temporal QC excluded ${taQcExcluded} samples (see qc.taTemporal)`);
  }
  if (overflowCount > 0) {
    warnings.push(`Int16 overflow excluded ${overflowCount} samples (value > 3276.7 ${spec.unit})`);
  }
  if (negativeRainCount > 0) {
    warnings.push(`Negative ${name} excluded ${negativeRainCount} samples`);
  }
  if (coverage.status === 'empty') {
    warnings.push(`${name} has no valid samples (all missing)`);
  } else if (coverage.status === 'degraded') {
    warnings.push(
      `${name} coverage ${(coverage.validRatio * 100).toFixed(1)}% is abnormally low (status=degraded)`
    );
  }
  if (jsonPresentCount === 0) {
    warnings.push(
      `JSON field ${jsonField} is missing for the whole day (likely DB-only source without Hub fill)`
    );
  }

  const manifest = {
    schemaVersion: PACK_SCHEMA_VERSION,
    datasetId,
    source: spec.source,
    variable: name,
    sourceField: spec.sourceField,
    unit: spec.unit,
    timezone: 'Asia/Seoul',
    intervalMinutes: PACK_INTERVAL_MINUTES,
    from,
    to,
    frameCount,
    stationCount,
    complete,
    dataComplete,
    generatedAt: new Date().toISOString(),
    stationOrder: 'STN_ID_ASC',
    stations,
    data: {
      url: packBinaryUrl(spec, dayKey),
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
    validRatio: coverage.validRatio,
    coverage,
    qc: {},
    warnings
  };

  if (spec.accumulation) {
    manifest.accumulation = { ...spec.accumulation };
  }
  if (spec.temporalQc === 'ta' && taQcConfig) {
    manifest.qc.taTemporal = {
      enabled: taQcConfig.enabled,
      maxDeltaDegCPerMinute: taQcConfig.maxDeltaScaled / 10,
      spikeNeighborMaxDegC: taQcConfig.spikeNeighborMaxScaled / 10,
      spikeMinDegCDelta: taQcConfig.spikeMinScaled / 10,
      excludedSampleCount: taQcExcluded
    };
  }
  if (overflowCount > 0 || negativeRainCount > 0) {
    manifest.qc.encode = {
      overflowExcluded: overflowCount,
      negativeExcluded: negativeRainCount
    };
  }

  return { manifest, binary, dayKey, datasetId, revision, variable: name };
}

async function buildAwsTaPack(awsJsonDir, fromKor, toKor, options = {}) {
  return buildAwsVariablePack(awsJsonDir, fromKor, toKor, VARIABLE_TA, options);
}

async function publishAwsVariablePack(packRoot, built) {
  const { manifest, binary, dayKey, variable } = built;
  const { spec } = getPackVariableSpec(variable || manifest.variable);
  const outDir = path.join(packRoot, packRelDir(spec, dayKey));
  await fsp.mkdir(outDir, { recursive: true });

  const binTmp = path.join(outDir, `${spec.slug}.i16le.${process.pid}.tmp`);
  const binFinal = path.join(outDir, `${spec.slug}.i16le`);
  const manTmp = path.join(outDir, `manifest.json.${process.pid}.tmp`);
  const manFinal = path.join(outDir, 'manifest.json');

  await fsp.writeFile(binTmp, binary);
  await fsp.rename(binTmp, binFinal);
  await fsp.writeFile(manTmp, JSON.stringify(manifest, null, 2), 'utf8');
  await fsp.rename(manTmp, manFinal);

  return { manifest, binaryPath: binFinal, manifestPath: manFinal };
}

async function publishAwsTaPack(packRoot, built) {
  return publishAwsVariablePack(packRoot, { ...built, variable: VARIABLE_TA });
}

async function loadCachedManifest(packRoot, dayKey, variable = VARIABLE_TA) {
  const { spec } = getPackVariableSpec(variable);
  const manPath = path.join(packRoot, packRelDir(spec, dayKey), 'manifest.json');
  try {
    const raw = await fsp.readFile(manPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function isReusableCachedManifest(cached, name, from, to) {
  return Boolean(
    cached &&
      cached.complete === true &&
      cached.schemaVersion === PACK_SCHEMA_VERSION &&
      cached.variable === name &&
      cached.from === from &&
      cached.to === to &&
      cached.sourceField != null &&
      typeof cached.validSampleCount === 'number' &&
      cached.coverage &&
      cached.coverage.status
  );
}

async function getOrBuildAwsVariablePack(awsJsonDir, packRoot, fromKor, toKor, variable, options = {}) {
  const { name } = getPackVariableSpec(variable);
  const from = parseTimestampKorStrict(fromKor);
  const to = parseTimestampKorStrict(toKor);
  const dayKey = dayKeyFromRange(from, to);
  const force = options.force === true;
  const todayYmd = kstTodayYmd();
  const isToday = from.slice(0, 8) === todayYmd || to.slice(0, 8) === todayYmd;

  if (!force && !isToday && isFullPastDay(from, to)) {
    const cached = await loadCachedManifest(packRoot, dayKey, name);
    if (isReusableCachedManifest(cached, name, from, to)) {
      return { manifest: cached, fromCache: true, variable: name };
    }
  }

  const built = await buildAwsVariablePack(awsJsonDir, from, to, name, options);
  await publishAwsVariablePack(packRoot, built);
  return { manifest: built.manifest, fromCache: false, variable: name };
}

async function getOrBuildAwsTaPack(awsJsonDir, packRoot, fromKor, toKor, options = {}) {
  return getOrBuildAwsVariablePack(awsJsonDir, packRoot, fromKor, toKor, VARIABLE_TA, options);
}

/**
 * 완료된 KST 하루(0000–2359) pack을 디스크에 만든다.
 * options.variables 기본 = 지원 변수 전부. 복수면 items[]로 개별 성공/실패.
 * TA만 쓰려면 variables: ['TA']. TA-only 호출은 { manifest, fromCache } 를 유지한다.
 */
async function warmAwsDayPack(awsJsonDir, packRoot, yyyymmdd, options = {}) {
  const { from, to } = packDayBounds(yyyymmdd);
  const variables = options.variables
    ? parsePackVariables(Array.isArray(options.variables) ? options.variables.join(',') : options.variables)
    : [...SUPPORTED_PACK_VARIABLES];

  const items = [];
  for (const variable of variables) {
    try {
      const result = await getOrBuildAwsVariablePack(awsJsonDir, packRoot, from, to, variable, options);
      items.push({
        variable,
        ok: true,
        fromCache: result.fromCache,
        complete: Boolean(result.manifest && result.manifest.complete),
        manifest: result.manifest
      });
    } catch (err) {
      items.push({
        variable,
        ok: false,
        fromCache: false,
        complete: false,
        error: err,
        message: err && err.message ? err.message : String(err)
      });
    }
  }

  const primary =
    items.find((i) => i.ok && i.variable === VARIABLE_TA) || items.find((i) => i.ok) || items[0];
  return {
    manifest: primary && primary.manifest,
    fromCache: Boolean(primary && primary.fromCache),
    items
  };
}

function isPackImmutableCacheable(manifest) {
  return (
    manifest &&
    manifest.complete === true &&
    manifest.schemaVersion === PACK_SCHEMA_VERSION
  );
}

function packManifestCacheHeaders(manifest) {
  if (isPackImmutableCacheable(manifest)) {
    return {
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: `"${manifest.datasetId}"`
    };
  }
  return {
    'Cache-Control': 'no-store',
    ETag: manifest && manifest.datasetId ? `"${manifest.datasetId}"` : undefined
  };
}

module.exports = {
  MISSING_I16,
  PACK_INTERVAL_MINUTES,
  PACK_MAX_FRAMES,
  PACK_SCHEMA_VERSION,
  VARIABLE_TA,
  PACK_VARIABLES,
  REQUIRED_PACK_VARIABLES,
  SUPPORTED_PACK_VARIABLES,
  PACK_SLUG_TO_VARIABLE,
  TA_PHYSICAL_MISSING_MAX_C,
  TA_PHYSICAL_VALID_MAX_C,
  deriveAwsPackDir,
  encodeTaToI16,
  encodeRainToI16,
  encodeWindSpeedToI16,
  encodeWindDirToI16,
  encodeHumidityToI16,
  encodeDewpointToI16,
  assessPackCoverage,
  isReusableCachedManifest,
  readTaQcConfig,
  applyTaTemporalQc,
  getPackVariableSpec,
  buildAwsVariablePack,
  buildAwsTaPack,
  publishAwsVariablePack,
  publishAwsTaPack,
  getOrBuildAwsVariablePack,
  getOrBuildAwsTaPack,
  warmAwsDayPack,
  parsePackVariables,
  parseTimestampKorStrict,
  packDayBounds,
  kstTodayYmd,
  kstYmdDaysAgo,
  loadCachedManifest,
  isPackImmutableCacheable,
  packManifestCacheHeaders
};
