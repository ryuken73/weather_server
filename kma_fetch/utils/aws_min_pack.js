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
/**
 * v4: RN_24HR = true rolling 24h (derived from RN-DAY counters, slug rn_24hr_rolling);
 * RN_DAY = KST day accumulation. Legacy day-total under rn_24hr/ must not be reused.
 */
const PACK_SCHEMA_VERSION = 4;
/** Bump when pack meaning/URL contract changes for cache reuse checks. */
const PACK_CONTRACT_REVISION = 6;

/**
 * RN_DAY upward-spike thresholds (scaled ×10 mm).
 * Hard rate alone is absurd for AWS; soft rate needs cross-variable corroboration.
 * Do not use a single absolute RN_DAY ceiling.
 */
const RN_DAY_SPIKE_HARD_RATE_PER_MIN = 200; // 20.0 mm/min
const RN_DAY_SPIKE_SOFT_RATE_PER_MIN = 50; // 5.0 mm/min
const RN_DAY_SPIKE_SOFT_JUMP = 100; // 10.0 mm absolute jump (soft path)
const RN_DAY_SPIKE_MULTI_EQUAL_MIN = 50; // 5.0 mm multi-field equality floor
const RN_DAY_SPIKE_CROSS_SLACK = 20; // 2.0 mm slack vs RN_15M/RN_60M
const RN_DAY_SPIKE_RECOVERY_STREAK = 2;

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
    jsonField: null,
    slug: 'rn_24hr_rolling',
    unit: 'mm',
    scale: 0.1,
    source: 'KMA_APIHUB_nph-aws2_min',
    sourceField: 'derived:RN-DAY',
    family: 'rain',
    accumulation: { type: 'rolling', windowMinutes: 1440 },
    dependency: { sourceVariable: 'RN_DAY', requiresPreviousDay: true },
    derive: 'rolling24hFromDayCounters',
    encode: encodeRainToI16
  },
  RN_DAY: {
    // Prefer RN_DAY; fall back to legacy JSON field that stored day-total as RN_24HR.
    jsonField: ['RN_DAY', 'RN_24HR'],
    slug: 'rn_day',
    unit: 'mm',
    scale: 0.1,
    source: 'KMA_APIHUB_nph-aws2_min',
    sourceField: 'RN-DAY',
    family: 'rain',
    accumulation: { type: 'day', timezone: 'Asia/Seoul', resetTime: '00:00' },
    // Hub RN-DAY often still holds previous-day total at 00:00; reset appears at 00:01.
    normalizeMidnightRnDay: true,
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
  'RN_DAY',
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
 * Read scaled rain day-counter from a JSON row.
 * Prefer RN_DAY; legacy files stored the same value as RN_24HR.
 */
function readRnDayRaw(row) {
  if (row == null) return null;
  if (row.RN_DAY != null && row.RN_DAY !== '') return row.RN_DAY;
  if (row.RN_24HR != null && row.RN_24HR !== '') return row.RN_24HR;
  return null;
}

function readJsonFieldRaw(row, jsonField) {
  if (row == null || jsonField == null) return null;
  if (Array.isArray(jsonField)) {
    for (const key of jsonField) {
      if (key === 'RN_DAY' || key === 'RN_24HR') {
        // Use shared day-counter reader so order in the array still prefers RN_DAY.
        const v = key === 'RN_DAY' ? (row.RN_DAY != null && row.RN_DAY !== '' ? row.RN_DAY : null)
          : (row.RN_24HR != null && row.RN_24HR !== '' ? row.RN_24HR : null);
        if (v != null) return v;
        continue;
      }
      if (row[key] != null && row[key] !== '') return row[key];
    }
    return null;
  }
  const raw = row[jsonField];
  return raw != null && raw !== '' ? raw : null;
}

function jsonFieldLabel(jsonField) {
  if (jsonField == null) return '(derived)';
  if (Array.isArray(jsonField)) return jsonField.join('|');
  return String(jsonField);
}

function prevYmd(yyyymmdd) {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

/**
 * Scaled day-counter validity for rolling arithmetic (null = missing input).
 * Does not treat 0 as missing.
 */
function scaledRnDayOrNull(raw) {
  const scaled = toScaledOrNull(raw);
  if (scaled == null) return null;
  if (scaled <= HUB_PHYSICAL_MISSING_MAX * 10) return null;
  if (scaled < 0) return null;
  return scaled;
}

/**
 * Hub RN-DAY resets at 00:01, so the 00:00 frame often still carries the previous
 * day's total. For day-accumulation semantics, force a valid 00:00 sample to 0.
 * Missing stays missing.
 */
function normalizeRnDayScaledAtHhmm(scaled, hhmm) {
  if (scaled == null) return null;
  if (String(hhmm) === '0000') return 0;
  return scaled;
}

function scaledRnDayFromRow(row, hhmm) {
  return normalizeRnDayScaledAtHhmm(scaledRnDayOrNull(readRnDayRaw(row)), hhmm);
}

/** Short-window rain fields for RN_DAY spike cross-check (scaled ×10, null=missing). */
function readRainCrossScaled(row) {
  if (row == null) return { rn15: null, rn60: null, rn12: null };
  const rn15 = scaledRnDayOrNull(row.RN_15M);
  const rn60Raw =
    row.RN_60M != null && row.RN_60M !== ''
      ? row.RN_60M
      : row.RN_1HR != null && row.RN_1HR !== ''
        ? row.RN_1HR
        : null;
  const rn60 = scaledRnDayOrNull(rn60Raw);
  const rn12 = scaledRnDayOrNull(row.RN_12HR);
  return { rn15, rn60, rn12 };
}

/**
 * Multi-field Hub glitch: RN_DAY equals short/medium accumulations (impossible for day total).
 */
function isMultiFieldEqualSpike(scaled, cross) {
  if (scaled == null || scaled < RN_DAY_SPIKE_MULTI_EQUAL_MIN) return false;
  if (cross == null) return false;
  const { rn15, rn60, rn12 } = cross;
  if (rn15 == null || rn60 == null) return false;
  if (rn15 !== scaled || rn60 !== scaled) return false;
  if (rn12 != null && rn12 !== scaled) return false;
  return true;
}

/**
 * Decide whether an increase is an upward spike (candidate → rejected when evidence holds).
 * Cross-var missing alone never rejects; rate / equality / inconsistency must combine.
 */
function evaluateRnDayUpwardSpike(scaled, accepted, elapsedMinutes, cross) {
  const elapsed = Math.max(1, elapsedMinutes | 0);
  const baseline = accepted == null ? 0 : accepted;
  const increase = scaled - baseline;
  if (increase <= 0) {
    return { spike: false, candidate: false, ratePerMinute: 0, increase, elapsedMinutes: elapsed };
  }
  const ratePerMinute = increase / elapsed;
  const candidate =
    ratePerMinute >= RN_DAY_SPIKE_SOFT_RATE_PER_MIN || increase >= RN_DAY_SPIKE_SOFT_JUMP;

  if (ratePerMinute >= RN_DAY_SPIKE_HARD_RATE_PER_MIN) {
    return {
      spike: true,
      candidate: true,
      rejected: true,
      reason: 'hard_rate',
      ratePerMinute,
      increase,
      elapsedMinutes: elapsed
    };
  }

  if (isMultiFieldEqualSpike(scaled, cross)) {
    return {
      spike: true,
      candidate: true,
      rejected: true,
      reason: 'multi_field_equal',
      ratePerMinute,
      increase,
      elapsedMinutes: elapsed
    };
  }

  if (!candidate) {
    return { spike: false, candidate: false, ratePerMinute, increase, elapsedMinutes: elapsed };
  }

  // Soft candidate: corroborate with short-window accumulations when present.
  const slack = RN_DAY_SPIKE_CROSS_SLACK;
  if (cross) {
    if (elapsed <= 15 && cross.rn15 != null && increase > cross.rn15 + slack) {
      return {
        spike: true,
        candidate: true,
        rejected: true,
        reason: 'exceeds_rn15',
        ratePerMinute,
        increase,
        elapsedMinutes: elapsed
      };
    }
    if (elapsed <= 60 && cross.rn60 != null && increase > cross.rn60 + slack) {
      return {
        spike: true,
        candidate: true,
        rejected: true,
        reason: 'exceeds_rn60',
        ratePerMinute,
        increase,
        elapsedMinutes: elapsed
      };
    }
    // Soft rate with both short windows present and roughly matching → allow (real heavy rain).
    if (
      cross.rn15 != null &&
      cross.rn60 != null &&
      increase <= cross.rn15 + slack &&
      increase <= cross.rn60 + slack
    ) {
      return {
        spike: false,
        candidate: true,
        rejected: false,
        reason: 'soft_corroborated',
        ratePerMinute,
        increase,
        elapsedMinutes: elapsed
      };
    }
  }

  // Soft candidate without corroborating short-window support → reject (Yeongdeok-style).
  // Missing cross alone is not enough: require soft rate/jump already true above.
  if (cross == null || (cross.rn15 == null && cross.rn60 == null)) {
    if (ratePerMinute >= RN_DAY_SPIKE_SOFT_RATE_PER_MIN && increase >= RN_DAY_SPIKE_SOFT_JUMP) {
      return {
        spike: true,
        candidate: true,
        rejected: true,
        reason: 'soft_uncorroborated',
        ratePerMinute,
        increase,
        elapsedMinutes: elapsed
      };
    }
    // Soft rate but modest jump and no cross → do not reject solely on missing cross.
    return {
      spike: false,
      candidate: true,
      rejected: false,
      reason: 'soft_missing_cross_allowed',
      ratePerMinute,
      increase,
      elapsedMinutes: elapsed
    };
  }

  // Cross present but inconsistent / incomplete → reject soft candidate.
  return {
    spike: true,
    candidate: true,
    rejected: true,
    reason: 'soft_inconsistent_cross',
    ratePerMinute,
    increase,
    elapsedMinutes: elapsed
  };
}

/**
 * Per-station RN_DAY QC: upward spike → then counter regression.
 * Pack: spike/regression → missing. Rolling: hold last accepted (never spike; never source-missing fill).
 */
function createRnDayRunningMaxTracker() {
  let acceptedRnDay = null;
  let acceptedFrameIndex = null;
  let hadRegression = false;
  let spikeContamination = false;
  let recoveryStreak = 0;
  return {
    /**
     * @param {number|null} scaled midnight-normalized scaled RN_DAY
     * @param {{ frameIndex?: number, cross?: {rn15:number|null,rn60:number|null,rn12:number|null}, hhmm?: string }} [meta]
     */
    push(scaled, meta = {}) {
      const frameIndex = meta.frameIndex == null ? 0 : meta.frameIndex;
      const cross = meta.cross || null;
      const hhmm = meta.hhmm != null ? String(meta.hhmm) : null;

      if (scaled == null) {
        recoveryStreak = 0;
        return { packValue: null, forRolling: null, reason: 'source_missing', spikeEval: null };
      }

      // Normal KST midnight reset (already normalized to 0 for valid 00:00).
      if (hhmm === '0000' && scaled === 0) {
        acceptedRnDay = 0;
        acceptedFrameIndex = frameIndex;
        spikeContamination = false;
        recoveryStreak = 0;
        return { packValue: 0, forRolling: 0, reason: null, spikeEval: null };
      }

      if (acceptedRnDay != null && scaled < acceptedRnDay) {
        hadRegression = true;
        recoveryStreak = 0;
        return {
          packValue: null,
          forRolling: acceptedRnDay,
          reason: 'counterRegression',
          spikeEval: null
        };
      }

      // First valid sample of the KST day: do not treat absolute day-total as a 1-min rate.
      // Only reject isolated multi-field equality glitches (북강릉-style).
      if (acceptedRnDay == null) {
        if (isMultiFieldEqualSpike(scaled, cross)) {
          spikeContamination = true;
          recoveryStreak = 0;
          return {
            packValue: null,
            forRolling: null,
            reason: 'upwardSpikeRejected',
            spikeEval: {
              spike: true,
              candidate: true,
              rejected: true,
              reason: 'multi_field_equal',
              ratePerMinute: scaled,
              increase: scaled,
              elapsedMinutes: 1
            }
          };
        }
        acceptedRnDay = scaled;
        acceptedFrameIndex = frameIndex;
        recoveryStreak = 0;
        return { packValue: scaled, forRolling: scaled, reason: null, spikeEval: null };
      }

      const elapsed = Math.max(1, frameIndex - acceptedFrameIndex);
      const spikeEval = evaluateRnDayUpwardSpike(scaled, acceptedRnDay, elapsed, cross);

      if (spikeEval.rejected) {
        spikeContamination = true;
        recoveryStreak = 0;
        return {
          packValue: null,
          forRolling: acceptedRnDay,
          reason: 'upwardSpikeRejected',
          spikeEval
        };
      }

      if (spikeContamination) {
        // No accepted lock yet: first non-spike sample becomes accepted immediately
        // (e.g. isolated multi-equal spike then return to 0).
        if (acceptedRnDay == null) {
          spikeContamination = false;
          recoveryStreak = 0;
          acceptedRnDay = scaled;
          acceptedFrameIndex = frameIndex;
          return {
            packValue: scaled,
            forRolling: scaled,
            reason: 'spikeRecovery',
            spikeEval
          };
        }
        recoveryStreak += 1;
        if (recoveryStreak < RN_DAY_SPIKE_RECOVERY_STREAK) {
          return {
            packValue: null,
            forRolling: acceptedRnDay,
            reason: 'spikeRecoveryPending',
            spikeEval
          };
        }
        spikeContamination = false;
        recoveryStreak = 0;
        acceptedRnDay = scaled;
        acceptedFrameIndex = frameIndex;
        return {
          packValue: scaled,
          forRolling: scaled,
          reason: 'spikeRecovery',
          spikeEval
        };
      }

      acceptedRnDay = scaled;
      acceptedFrameIndex = frameIndex;
      recoveryStreak = 0;
      return {
        packValue: scaled,
        forRolling: scaled,
        reason: spikeEval.candidate ? 'upwardSpikeCandidateAccepted' : null,
        spikeEval
      };
    },
    get acceptedRnDay() {
      return acceptedRnDay;
    },
    get hadRegression() {
      return hadRegression;
    },
    get spikeContamination() {
      return spikeContamination;
    }
  };
}

function emptyRnDayRegressionStats() {
  return {
    regressionSampleCount: 0,
    regressionStationCount: 0,
    counterRegressionFilledSampleCount: 0,
    sourceMissingSampleCount: 0,
    upwardSpikeCandidateSampleCount: 0,
    upwardSpikeRejectedSampleCount: 0,
    upwardSpikeStationCount: 0,
    spikeRecoverySampleCount: 0,
    byReason: {
      counterRegression: 0,
      sourceMissing: 0,
      upwardSpikeRejected: 0,
      spikeRecoveryPending: 0,
      spikeRecovery: 0
    }
  };
}

/**
 * Apply RN_DAY QC (spike then regression) to midnight-normalized grids.
 * @param {Array<number|null>} scaledGrid
 * @param {Array<object|null>|null} crossGrid parallel {rn15,rn60,rn12} or null entries
 * @param {string[]} timestamps
 */
function applyRnDayCounterRegression(scaledGrid, frameCount, stationCount, options = {}) {
  const crossGrid = options.crossGrid || null;
  const timestamps = options.timestamps || null;
  const packGrid = new Array(frameCount * stationCount);
  const rollingGrid = new Array(frameCount * stationCount);
  const reasonGrid = new Array(frameCount * stationCount);
  const stats = emptyRnDayRegressionStats();
  const stationHadRegression = new Uint8Array(stationCount);
  const stationHadSpike = new Uint8Array(stationCount);

  for (let si = 0; si < stationCount; si++) {
    const tracker = createRnDayRunningMaxTracker();
    for (let fi = 0; fi < frameCount; fi++) {
      const idx = fi * stationCount + si;
      const hhmm = timestamps ? timestamps[fi].slice(8, 12) : null;
      const cross = crossGrid ? crossGrid[idx] : null;
      const result = tracker.push(scaledGrid[idx], { frameIndex: fi, cross, hhmm });
      packGrid[idx] = result.packValue;
      rollingGrid[idx] = result.forRolling;
      reasonGrid[idx] = result.reason;

      if (result.spikeEval && result.spikeEval.candidate) {
        stats.upwardSpikeCandidateSampleCount += 1;
      }

      if (result.reason === 'counterRegression') {
        stats.regressionSampleCount += 1;
        stats.counterRegressionFilledSampleCount += 1;
        stats.byReason.counterRegression += 1;
        stationHadRegression[si] = 1;
      } else if (result.reason === 'source_missing') {
        stats.sourceMissingSampleCount += 1;
        stats.byReason.sourceMissing += 1;
      } else if (result.reason === 'upwardSpikeRejected') {
        stats.upwardSpikeRejectedSampleCount += 1;
        stats.byReason.upwardSpikeRejected += 1;
        stationHadSpike[si] = 1;
      } else if (result.reason === 'spikeRecoveryPending') {
        stats.byReason.spikeRecoveryPending += 1;
        stationHadSpike[si] = 1;
      } else if (result.reason === 'spikeRecovery') {
        stats.spikeRecoverySampleCount += 1;
        stats.byReason.spikeRecovery += 1;
      }
    }
    if (stationHadRegression[si]) stats.regressionStationCount += 1;
    if (stationHadSpike[si]) stats.upwardSpikeStationCount += 1;
  }

  return { packGrid, rollingGrid, reasonGrid, stats };
}

/**
 * Build midnight-normalized + dual QC grids (spike/regression pack missing; rolling holds accepted).
 */
function buildQcRnDayScaledGrid(frames, timestamps, stationIds) {
  const frameCount = timestamps.length;
  const stationCount = stationIds.length;
  const scaledGrid = new Array(frameCount * stationCount);
  const crossGrid = new Array(frameCount * stationCount);
  let midnightNormalizedCount = 0;
  let jsonPresentCount = 0;

  for (let fi = 0; fi < frameCount; fi++) {
    const byId = frames[fi];
    const hhmm = timestamps[fi].slice(8, 12);
    for (let si = 0; si < stationCount; si++) {
      const idx = fi * stationCount + si;
      if (!byId) {
        scaledGrid[idx] = null;
        crossGrid[idx] = null;
        continue;
      }
      const row = byId.get(stationIds[si]);
      if (!row) {
        scaledGrid[idx] = null;
        crossGrid[idx] = null;
        continue;
      }
      const raw = scaledRnDayOrNull(readRnDayRaw(row));
      if (raw != null) jsonPresentCount += 1;
      if (raw != null && hhmm === '0000' && raw !== 0) midnightNormalizedCount += 1;
      scaledGrid[idx] = normalizeRnDayScaledAtHhmm(raw, hhmm);
      crossGrid[idx] = readRainCrossScaled(row);
    }
  }

  const { packGrid, rollingGrid, reasonGrid, stats: regression } = applyRnDayCounterRegression(
    scaledGrid,
    frameCount,
    stationCount,
    { crossGrid, timestamps }
  );
  return {
    packGrid,
    rollingGrid,
    reasonGrid,
    scaledGrid: packGrid,
    midnightNormalizedCount,
    jsonPresentCount,
    regression
  };
}

/**
 * RN_24HR(D,t) = RN_DAY(D,t) + RN_DAY(D-1,23:59) - RN_DAY(D-1,t)
 * Uses rnDayForRolling (regression holds last accepted; source missing stays missing).
 */
function deriveRolling24hScaled(todayScaled, prevEndScaled, prevSameScaled) {
  if (todayScaled == null) return { value: null, reason: 'missing_today' };
  if (prevEndScaled == null) return { value: null, reason: 'missing_prev_end' };
  if (prevSameScaled == null) return { value: null, reason: 'missing_prev_same' };
  if (prevEndScaled < prevSameScaled) return { value: null, reason: 'counter_decrease' };
  const rolling = todayScaled + prevEndScaled - prevSameScaled;
  if (rolling < 0) return { value: null, reason: 'negative' };
  if (rolling > 32767) return { value: null, reason: 'overflow' };
  return { value: rolling, reason: null };
}

/**
 * Index previous KST day RN_DAY (midnight-normalized + dual QC including upward spike).
 * byTm / endById expose forRolling values for RN_24HR derive.
 */
async function loadPrevDayRnDayIndex(awsJsonDir, dayYmd) {
  const prevDay = prevYmd(dayYmd);
  const from = `${prevDay}0000`;
  const to = `${prevDay}2359`;
  const timestamps = enumerateTimestamps(from, to, PACK_INTERVAL_MINUTES, PACK_MAX_FRAMES);
  const frames = new Array(timestamps.length);
  let presentCount = 0;
  const stationSet = new Set();

  for (let fi = 0; fi < timestamps.length; fi++) {
    const tm = timestamps[fi];
    const { missing, rows } = await readFrameRows(awsJsonDir, tm);
    if (missing) {
      frames[fi] = null;
      continue;
    }
    presentCount += 1;
    const byId = new Map();
    for (const row of rows) {
      if (row == null || row.STN_ID == null) continue;
      const id = Number(row.STN_ID);
      stationSet.add(id);
      byId.set(id, row);
    }
    frames[fi] = byId;
  }

  if (presentCount === 0) {
    const err = new Error(
      `RN_24HR dependency missing: no AWS JSON for previous day ${prevDay} (required for rolling 24h)`
    );
    err.code = 'DEPENDENCY_MISSING';
    err.prevDay = prevDay;
    throw err;
  }

  const stationIds = [...stationSet].sort((a, b) => a - b);
  const dayQc = buildQcRnDayScaledGrid(frames, timestamps, stationIds);
  const { packGrid, rollingGrid, regression } = dayQc;
  const frameCount = timestamps.length;
  const stationCount = stationIds.length;

  const byTm = new Map();
  const filledByTm = new Map();
  const spikeHoldByTm = new Map();
  for (let fi = 0; fi < frameCount; fi++) {
    const hhmm = timestamps[fi].slice(8, 12);
    if (frames[fi] == null) {
      byTm.set(hhmm, null);
      filledByTm.set(hhmm, null);
      spikeHoldByTm.set(hhmm, null);
      continue;
    }
    const byIdRoll = new Map();
    const byIdFilled = new Map();
    const byIdSpikeHold = new Map();
    for (let si = 0; si < stationCount; si++) {
      const idx = fi * stationCount + si;
      const stnId = stationIds[si];
      byIdRoll.set(stnId, rollingGrid[idx]);
      const held = packGrid[idx] == null && rollingGrid[idx] != null;
      byIdFilled.set(stnId, held);
      // Approximate spike-hold: held but not from a lower pack value than raw...
      // Detailed reason isn't stored per cell; treat held as regression/spike fill for rolling.
      byIdSpikeHold.set(stnId, held);
    }
    byTm.set(hhmm, byIdRoll);
    filledByTm.set(hhmm, byIdFilled);
    spikeHoldByTm.set(hhmm, byIdSpikeHold);
  }

  return {
    prevDay,
    byTm,
    filledByTm,
    spikeHoldByTm,
    endById: byTm.get('2359'),
    endFilledById: filledByTm.get('2359'),
    stationSet,
    presentCount,
    expectedCount: timestamps.length,
    regression
  };
}

function emptyRollingQcCounts() {
  return {
    missingToday: 0,
    missingPrevEnd: 0,
    missingPrevSame: 0,
    counterDecrease: 0,
    negative: 0,
    overflow: 0,
    stationMismatch: 0,
    midnightNormalized: 0,
    counterRegressionFilledSampleCount: 0,
    sourceMissingSampleCount: 0,
    upwardSpikeRejectedSampleCount: 0,
    upwardSpikeContaminationPreventedSampleCount: 0
  };
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
  let midnightNormalizedCount = 0;
  const jsonField = spec.jsonField;
  const fieldLabel = jsonFieldLabel(jsonField);
  let jsonPresentCount = 0;
  let prevDayIndex = null;
  const rollingQc = emptyRollingQcCounts();
  let rnDayRegression = emptyRnDayRegressionStats();
  let prevDayRegression = emptyRnDayRegressionStats();

  if (spec.derive === 'rolling24hFromDayCounters') {
    const dayYmd = from.slice(0, 8);
    if (to.slice(0, 8) !== dayYmd) {
      const err = new Error('RN_24HR rolling derive requires a single KST day range');
      err.code = 'BAD_QUERY';
      throw err;
    }
    prevDayIndex = await loadPrevDayRnDayIndex(awsJsonDir, dayYmd);
    prevDayRegression = prevDayIndex.regression || emptyRnDayRegressionStats();
    const prevStations = prevDayIndex.stationSet;
    const endById = prevDayIndex.endById;
    const endFilledById = prevDayIndex.endFilledById;

    const todayQc = buildQcRnDayScaledGrid(frames, timestamps, stationIds);
    midnightNormalizedCount = todayQc.midnightNormalizedCount;
    jsonPresentCount = todayQc.jsonPresentCount;
    rnDayRegression = todayQc.regression;
    rollingQc.midnightNormalized = midnightNormalizedCount;

    for (let fi = 0; fi < frameCount; fi++) {
      const byId = frames[fi];
      if (!byId) continue;
      const hhmm = timestamps[fi].slice(8, 12);
      const prevSameById = prevDayIndex.byTm.get(hhmm);
      const prevSameFilledById = prevDayIndex.filledByTm
        ? prevDayIndex.filledByTm.get(hhmm)
        : null;

      for (let si = 0; si < stationCount; si++) {
        const stnId = stationIds[si];
        const row = byId.get(stnId);
        if (!row) {
          rollingQc.stationMismatch += 1;
          continue;
        }
        if (!prevStations.has(stnId)) {
          rollingQc.stationMismatch += 1;
          continue;
        }

        const idx = fi * stationCount + si;
        const todayScaled = todayQc.rollingGrid[idx];
        const todayReason = todayQc.reasonGrid ? todayQc.reasonGrid[idx] : null;
        const todayFilled =
          todayQc.packGrid[idx] == null && todayQc.rollingGrid[idx] != null;
        const todaySpikeHold =
          todayReason === 'upwardSpikeRejected' || todayReason === 'spikeRecoveryPending';

        const prevEndScaled = endById ? endById.get(stnId) : null;
        const prevSameScaled =
          prevSameById && typeof prevSameById.get === 'function' ? prevSameById.get(stnId) : null;
        const endVal = endById == null ? null : prevEndScaled === undefined ? null : prevEndScaled;
        const sameVal =
          prevSameById == null ? null : prevSameScaled === undefined ? null : prevSameScaled;
        const endFilled = Boolean(endFilledById && endFilledById.get(stnId));
        const sameFilled = Boolean(prevSameFilledById && prevSameFilledById.get(stnId));

        const derived = deriveRolling24hScaled(todayScaled, endVal, sameVal);
        if (derived.reason) {
          if (
            derived.reason === 'missing_today' ||
            derived.reason === 'missing_prev_end' ||
            derived.reason === 'missing_prev_same'
          ) {
            rollingQc.sourceMissingSampleCount += 1;
          }
          if (derived.reason === 'missing_today') rollingQc.missingToday += 1;
          else if (derived.reason === 'missing_prev_end') rollingQc.missingPrevEnd += 1;
          else if (derived.reason === 'missing_prev_same') rollingQc.missingPrevSame += 1;
          else if (derived.reason === 'counter_decrease') rollingQc.counterDecrease += 1;
          else if (derived.reason === 'negative') rollingQc.negative += 1;
          else if (derived.reason === 'overflow') {
            rollingQc.overflow += 1;
            overflowCount += 1;
          }
          continue;
        }
        if (todaySpikeHold) {
          rollingQc.upwardSpikeRejectedSampleCount += 1;
          rollingQc.upwardSpikeContaminationPreventedSampleCount += 1;
        } else if (todayFilled || endFilled || sameFilled) {
          rollingQc.counterRegressionFilledSampleCount += 1;
        }
        int16[fi * stationCount + si] = derived.value;
      }
    }
  } else if (spec.normalizeMidnightRnDay || name === 'RN_DAY') {
    const dayQc = buildQcRnDayScaledGrid(frames, timestamps, stationIds);
    midnightNormalizedCount = dayQc.midnightNormalizedCount;
    jsonPresentCount = dayQc.jsonPresentCount;
    rnDayRegression = dayQc.regression;

    for (let i = 0; i < dayQc.scaledGrid.length; i++) {
      const scaled = dayQc.scaledGrid[i];
      if (scaled == null) continue;
      if (scaled > 32767) {
        overflowCount += 1;
        continue;
      }
      int16[i] = scaled;
    }
  } else {
    for (let fi = 0; fi < frameCount; fi++) {
      const byId = frames[fi];
      if (!byId) continue;
      for (let si = 0; si < stationCount; si++) {
        const row = byId.get(stationIds[si]);
        if (!row) continue;
        const raw = readJsonFieldRaw(row, jsonField);
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
  if (spec.derive === 'rolling24hFromDayCounters') {
    const qcTotal =
      rollingQc.missingToday +
      rollingQc.missingPrevEnd +
      rollingQc.missingPrevSame +
      rollingQc.counterDecrease +
      rollingQc.negative +
      rollingQc.overflow +
      rollingQc.stationMismatch;
    if (rollingQc.counterDecrease > 0) {
      warnings.push(
        `RN_24HR counter decrease (prev 23:59 < prev same time) → missing for ${rollingQc.counterDecrease} samples`
      );
    }
    if (rollingQc.negative > 0) {
      warnings.push(`RN_24HR negative derive → missing for ${rollingQc.negative} samples`);
    }
    if (rollingQc.midnightNormalized > 0) {
      warnings.push(
        `RN_24HR applied Hub midnight RN-DAY normalize (00:00→0) for ${rollingQc.midnightNormalized} samples`
      );
    }
    if (rollingQc.counterRegressionFilledSampleCount > 0) {
      warnings.push(
        `RN_24HR used last accepted RN_DAY for ${rollingQc.counterRegressionFilledSampleCount} counter-regression samples`
      );
    }
    if (rollingQc.upwardSpikeContaminationPreventedSampleCount > 0) {
      warnings.push(
        `RN_24HR blocked upward-spike RN_DAY contamination for ${rollingQc.upwardSpikeContaminationPreventedSampleCount} samples`
      );
    }
    if (rnDayRegression.regressionSampleCount > 0 || prevDayRegression.regressionSampleCount > 0) {
      warnings.push(
        `RN_24HR RN_DAY pack-regression samples today=${rnDayRegression.regressionSampleCount}, prevDay=${prevDayRegression.regressionSampleCount}`
      );
    }
    if (
      rnDayRegression.upwardSpikeRejectedSampleCount > 0 ||
      prevDayRegression.upwardSpikeRejectedSampleCount > 0
    ) {
      warnings.push(
        `RN_24HR RN_DAY upward-spike rejected today=${rnDayRegression.upwardSpikeRejectedSampleCount}, prevDay=${prevDayRegression.upwardSpikeRejectedSampleCount}`
      );
    }
    if (qcTotal > 0) {
      warnings.push(`RN_24HR rolling QC missing reasons totaling ${qcTotal} sample slots`);
    }
  }
  if (midnightNormalizedCount > 0 && (spec.normalizeMidnightRnDay || name === 'RN_DAY')) {
    warnings.push(
      `RN_DAY Hub midnight normalize: forced ${midnightNormalizedCount} samples at 00:00 to 0 (Hub resets at 00:01)`
    );
  }
  if (rnDayRegression.regressionSampleCount > 0 && (spec.normalizeMidnightRnDay || name === 'RN_DAY')) {
    warnings.push(
      `RN_DAY counter-regression → missing for ${rnDayRegression.regressionSampleCount} samples across ${rnDayRegression.regressionStationCount} stations`
    );
  }
  if (
    rnDayRegression.upwardSpikeRejectedSampleCount > 0 &&
    (spec.normalizeMidnightRnDay || name === 'RN_DAY')
  ) {
    warnings.push(
      `RN_DAY upward-spike → missing for ${rnDayRegression.upwardSpikeRejectedSampleCount} samples across ${rnDayRegression.upwardSpikeStationCount} stations`
    );
  }
  if (coverage.status === 'empty') {
    warnings.push(`${name} has no valid samples (all missing)`);
  } else if (coverage.status === 'degraded') {
    warnings.push(
      `${name} coverage ${(coverage.validRatio * 100).toFixed(1)}% is abnormally low (status=degraded)`
    );
  }
  if (jsonPresentCount === 0 && spec.derive !== 'rolling24hFromDayCounters') {
    warnings.push(
      `JSON field ${fieldLabel} is missing for the whole day (likely DB-only source without Hub fill)`
    );
  }
  if (jsonPresentCount === 0 && spec.derive === 'rolling24hFromDayCounters') {
    warnings.push('RN_DAY source (RN_DAY|legacy RN_24HR) missing for the whole day');
  }

  const manifest = {
    schemaVersion: PACK_SCHEMA_VERSION,
    contractRevision: PACK_CONTRACT_REVISION,
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
  if (spec.dependency) {
    manifest.dependency = {
      ...spec.dependency,
      previousDay: prevDayIndex ? prevDayIndex.prevDay : undefined
    };
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
  if (spec.derive === 'rolling24hFromDayCounters') {
    manifest.qc.rolling24h = { ...rollingQc };
  }
  if (spec.normalizeMidnightRnDay || spec.derive === 'rolling24hFromDayCounters' || name === 'RN_DAY') {
    manifest.qc.midnightRnDay = {
      enabled: true,
      forcedZeroAt0000: midnightNormalizedCount,
      note: 'Hub RN-DAY often retains previous-day total at 00:00; reset appears at 00:01'
    };
  }
  if (spec.normalizeMidnightRnDay || spec.derive === 'rolling24hFromDayCounters' || name === 'RN_DAY') {
    const qcBlock = {
      regressionSampleCount: rnDayRegression.regressionSampleCount,
      regressionStationCount: rnDayRegression.regressionStationCount,
      counterRegressionFilledSampleCount: rnDayRegression.counterRegressionFilledSampleCount,
      sourceMissingSampleCount: rnDayRegression.sourceMissingSampleCount,
      upwardSpikeCandidateSampleCount: rnDayRegression.upwardSpikeCandidateSampleCount,
      upwardSpikeRejectedSampleCount: rnDayRegression.upwardSpikeRejectedSampleCount,
      upwardSpikeStationCount: rnDayRegression.upwardSpikeStationCount,
      spikeRecoverySampleCount: rnDayRegression.spikeRecoverySampleCount,
      byReason: { ...rnDayRegression.byReason }
    };
    if (spec.derive === 'rolling24hFromDayCounters') {
      qcBlock.previousDay = {
        regressionSampleCount: prevDayRegression.regressionSampleCount,
        regressionStationCount: prevDayRegression.regressionStationCount,
        counterRegressionFilledSampleCount: prevDayRegression.counterRegressionFilledSampleCount,
        sourceMissingSampleCount: prevDayRegression.sourceMissingSampleCount,
        upwardSpikeCandidateSampleCount: prevDayRegression.upwardSpikeCandidateSampleCount,
        upwardSpikeRejectedSampleCount: prevDayRegression.upwardSpikeRejectedSampleCount,
        upwardSpikeStationCount: prevDayRegression.upwardSpikeStationCount,
        spikeRecoverySampleCount: prevDayRegression.spikeRecoverySampleCount,
        byReason: { ...prevDayRegression.byReason }
      };
      qcBlock.counterRegressionFilledSampleCount = rollingQc.counterRegressionFilledSampleCount;
      qcBlock.sourceMissingSampleCount = rollingQc.sourceMissingSampleCount;
      qcBlock.upwardSpikeRejectedSampleCount = rollingQc.upwardSpikeRejectedSampleCount;
    }
    manifest.qc.rnDayRegression = qcBlock;
    manifest.qc.rnDayQc = {
      sourceMissingSampleCount: rnDayRegression.sourceMissingSampleCount,
      counterRegressionSampleCount: rnDayRegression.regressionSampleCount,
      counterRegressionFilledSampleCount:
        spec.derive === 'rolling24hFromDayCounters'
          ? rollingQc.counterRegressionFilledSampleCount
          : rnDayRegression.counterRegressionFilledSampleCount,
      upwardSpikeCandidateSampleCount: rnDayRegression.upwardSpikeCandidateSampleCount,
      upwardSpikeRejectedSampleCount: rnDayRegression.upwardSpikeRejectedSampleCount,
      upwardSpikeStationCount: rnDayRegression.upwardSpikeStationCount,
      spikeRecoverySampleCount: rnDayRegression.spikeRecoverySampleCount
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
  if (
    !(
      cached &&
      cached.complete === true &&
      cached.schemaVersion === PACK_SCHEMA_VERSION &&
      cached.contractRevision === PACK_CONTRACT_REVISION &&
      cached.variable === name &&
      cached.from === from &&
      cached.to === to &&
      cached.sourceField != null &&
      typeof cached.validSampleCount === 'number' &&
      cached.coverage &&
      cached.coverage.status
    )
  ) {
    return false;
  }
  // Reject legacy day-accumulation RN_24HR packs (slug rn_24hr / accumulation.type=day).
  if (name === 'RN_24HR') {
    const acc = cached.accumulation;
    if (!acc || acc.type !== 'rolling' || acc.windowMinutes !== 1440) return false;
    if (cached.sourceField !== 'derived:RN-DAY') return false;
    if (!cached.data || !cached.data.url || !String(cached.data.url).includes('rn_24hr_rolling')) {
      return false;
    }
  }
  if (name === 'RN_DAY') {
    const acc = cached.accumulation;
    if (!acc || acc.type !== 'day') return false;
  }
  return true;
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
  PACK_CONTRACT_REVISION,
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
  readRnDayRaw,
  normalizeRnDayScaledAtHhmm,
  createRnDayRunningMaxTracker,
  applyRnDayCounterRegression,
  evaluateRnDayUpwardSpike,
  readRainCrossScaled,
  deriveRolling24hScaled,
  prevYmd,
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
