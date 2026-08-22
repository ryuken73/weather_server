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
const PACK_CONTRACT_REVISION = 8;

/**
 * RN_DAY upward-spike QC thresholds (scaled ×10 mm).
 * Soft/extreme rates are candidate detectors only — never sole reject criteria.
 * @see docs/rainfall-producer-spike-qc-safety-review.md
 * @see docs/rainfall-producer-spike-qc-final-review.md
 */
const RN_DAY_SPIKE_EXTREME_RATE_PER_MIN = 200; // 20.0 mm/min → extreme candidate (not hard reject)
const RN_DAY_SPIKE_SOFT_RATE_PER_MIN = 50; // 5.0 mm/min
const RN_DAY_SPIKE_SOFT_JUMP = 100; // 10.0 mm
const RN_DAY_SPIKE_CROSS_SLACK = 20; // 2.0 mm
const RN_DAY_SPIKE_REPEAT_JUMP_MIN = 500; // 50.0 mm mechanical repeat floor
const RN_DAY_SPIKE_REPEAT_TOL = 50; // 5.0 mm
const RN_DAY_SPIKE_ISOLATED_PEAK_MIN = 50; // 5.0 mm
const RN_DAY_SPIKE_RECOVERY_STREAK = 2;
const RN_DAY_EPISODE_PEAK_TOL = 1; // 0.1 mm — repeated peak must be nearly identical (31.0, not 10.5→11.0)
const RN_DAY_EPISODE_LOW_MAX = 20; // 2.0 mm separator (0 / near-dry)
const RN_DAY_EPISODE_MAX_SPAN_MINUTES = 120;
const RN_DAY_LARGE_STEP_SUSPECT_MIN = 500; // 50.0 mm single-step → suspect-retained
/** RN_24HR may use last-confirmed RN_DAY for rejected frames only up to this many consecutive minutes. */
const RN_24HR_SUBSTITUTION_MAX_MINUTES = 30;

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

function packBinaryFileName(spec, contentSha256) {
  const short = String(contentSha256 || 'pending').slice(0, 8);
  return `${spec.slug}-v${short}.i16le`;
}

function packBinaryUrl(spec, dayKey, contentSha256) {
  return `/datasets/aws/${spec.slug}/1m/${dayKey}/${packBinaryFileName(spec, contentSha256)}`;
}

function isContentAddressedPackBinaryUrl(url, slug) {
  if (!url || !slug) return false;
  return new RegExp(`/${slug}-v[a-f0-9]{8}\\.i16le$`, 'i').test(String(url));
}

/** Immutable-friendly QC detail URL (content hash in filename). */
function packQcDetailUrl(spec, dayKey, contentSha256) {
  const short = String(contentSha256 || 'pending').slice(0, 16);
  return `/datasets/aws/${spec.slug}/1m/${dayKey}/qc-v${short}.json`;
}

function packQcDetailFileName(contentSha256) {
  const short = String(contentSha256 || 'pending').slice(0, 16);
  return `qc-v${short}.json`;
}

/** Exact on-disk QC JSON (pretty, no trailing newline). Hash this UTF-8 string for qcDetailSha256. */
function serializeQcDetailJson(qcBody) {
  return JSON.stringify(qcBody, null, 2);
}

function hashQcDetailJson(qcJson) {
  return crypto.createHash('sha256').update(qcJson, 'utf8').digest('hex');
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

function countTrailingMissing(scaledSeries, fromIdx) {
  let c = 0;
  for (let i = fromIdx; i < scaledSeries.length; i++) {
    if (scaledSeries[i] != null) break;
    c += 1;
  }
  return c;
}

function nextNonNullIndex(scaledSeries, fromIdx) {
  for (let i = fromIdx; i < scaledSeries.length; i++) {
    if (scaledSeries[i] != null) return i;
  }
  return -1;
}

function prevNonNullIndex(scaledSeries, fromIdx) {
  for (let i = fromIdx; i >= 0; i--) {
    if (scaledSeries[i] != null) return i;
  }
  return -1;
}

function hhmmToMinutes(hhmm) {
  const s = String(hhmm || '');
  if (s.length < 4) return null;
  const h = Number(s.slice(0, 2));
  const m = Number(s.slice(2, 4));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/** Wall-clock minutes between frame indices (KST HHMM), not frame-gap dilution. */
function elapsedMinutesBetween(hhmmSeries, fromIdx, toIdx) {
  if (fromIdx == null || toIdx == null || fromIdx < 0 || toIdx < 0) {
    return Math.max(1, toIdx - fromIdx);
  }
  if (!hhmmSeries) return Math.max(1, toIdx - fromIdx);
  const a = hhmmToMinutes(hhmmSeries[fromIdx]);
  const b = hhmmToMinutes(hhmmSeries[toIdx]);
  if (a == null || b == null) return Math.max(1, toIdx - fromIdx);
  const delta = b - a;
  if (delta <= 0) return Math.max(1, toIdx - fromIdx);
  return delta;
}

function peakValuesMatch(a, b) {
  return Math.abs(a - b) <= RN_DAY_EPISODE_PEAK_TOL;
}

function isEpisodeSeparatorValue(v) {
  return v == null || v <= RN_DAY_EPISODE_LOW_MAX;
}

function crossFieldsReplicatePeak(cross, peakScaled) {
  if (!cross) return true;
  const fields = [cross.rn15, cross.rn60, cross.rn12].filter((x) => x != null);
  if (fields.length === 0) return true;
  return fields.every((f) => peakValuesMatch(f, peakScaled));
}

/**
 * Repeated peak episode (북강릉): same abnormal peak reappears after 0/missing separators.
 * Consecutive same-value frames count as one burst; monotonic rain recovery is not an episode.
 */
function findContaminatedPeakEpisodeRejects(scaledSeries, crossSeries, hhmmSeries) {
  const rejects = new Set();
  const episodeMeta = new Map();
  const n = scaledSeries.length;

  const peakIndices = [];
  for (let i = 0; i < n; i++) {
    const v = scaledSeries[i];
    if (v == null || v < RN_DAY_SPIKE_ISOLATED_PEAK_MIN) continue;
    if (!crossFieldsReplicatePeak(crossSeries ? crossSeries[i] : null, v)) continue;
    peakIndices.push(i);
  }
  if (peakIndices.length < 2) return { rejects, episodeMeta };

  const byPeakValue = new Map();
  for (const pi of peakIndices) {
    const v = scaledSeries[pi];
    let key = null;
    for (const k of byPeakValue.keys()) {
      if (peakValuesMatch(k, v)) {
        key = k;
        break;
      }
    }
    if (key == null) {
      key = v;
      byPeakValue.set(key, []);
    }
    byPeakValue.get(key).push(pi);
  }

  for (const [peakValue, indices] of byPeakValue.entries()) {
    const sorted = [...indices].sort((a, b) => a - b);
    const episodeIndices = [];

    for (let k = 0; k < sorted.length; k++) {
      const cur = sorted[k];
      if (k === 0) {
        episodeIndices.push(cur);
        continue;
      }
      const prev = sorted[k - 1];
      let onlySeparators = true;
      for (let j = prev + 1; j < cur; j++) {
        if (!isEpisodeSeparatorValue(scaledSeries[j])) {
          onlySeparators = false;
          break;
        }
      }
      if (onlySeparators) {
        episodeIndices.push(cur);
        continue;
      }
      if (cur === prev + 1 && peakValuesMatch(scaledSeries[cur], scaledSeries[prev])) {
        episodeIndices.push(cur);
        continue;
      }
      // Broken chain — evaluate accumulated episode and start fresh.
      if (episodeIndices.length >= 2) {
        stampEpisode(scaledSeries, hhmmSeries, episodeIndices, peakValue, rejects, episodeMeta);
      }
      episodeIndices.length = 0;
      episodeIndices.push(cur);
    }

    if (episodeIndices.length >= 2) {
      stampEpisode(scaledSeries, hhmmSeries, episodeIndices, peakValue, rejects, episodeMeta);
    }
  }

  return { rejects, episodeMeta };
}

function stampEpisode(scaledSeries, hhmmSeries, indices, peakValue, rejects, episodeMeta) {
  const firstIdx = indices[0];
  let baseline = 0;
  for (let j = 0; j < firstIdx; j++) {
    const x = scaledSeries[j];
    if (x != null && x > baseline) baseline = x;
  }
  const peakMax = Math.max(...indices.map((i) => scaledSeries[i]));
  const peakMin = Math.min(...indices.map((i) => scaledSeries[i]));
  if (peakMax - peakMin > RN_DAY_EPISODE_PEAK_TOL) return;
  // Repeated pollution must jump well above recent baseline (not monotonic rain recovery).
  if (peakMax - baseline <= RN_DAY_SPIKE_SOFT_JUMP) return;
  if (peakValue <= baseline + RN_DAY_SPIKE_ISOLATED_PEAK_MIN) return;
  if (hhmmSeries && indices.length >= 2) {
    const span = elapsedMinutesBetween(hhmmSeries, indices[0], indices[indices.length - 1]);
    if (span > RN_DAY_EPISODE_MAX_SPAN_MINUTES) return;
  }
  const episodeId = `peak-ep-${firstIdx}-${peakValue}`;
  const meta = {
    episodeId,
    startIdx: indices[0],
    endIdx: indices[indices.length - 1],
    peakValue
  };
  for (const idx of indices) {
    rejects.add(idx);
    episodeMeta.set(idx, meta);
  }
}

function evaluateStepSpikeSignals(scaledSeries, hhmmSeries, i) {
  const stepPrev = prevNonNullIndex(scaledSeries, i - 1);
  if (stepPrev < 0 || stepPrev === i) {
    return { stepExtreme: false, stepSoft: false, largeStepSuspect: false, signals: [] };
  }
  const stepMin = elapsedMinutesBetween(hhmmSeries, stepPrev, i);
  const stepInc = scaledSeries[i] - scaledSeries[stepPrev];
  if (stepInc <= 0) {
    return { stepExtreme: false, stepSoft: false, largeStepSuspect: false, signals: [] };
  }
  const stepRate = stepInc / Math.max(1, stepMin);
  const signals = [];
  const stepExtreme = stepRate >= RN_DAY_SPIKE_EXTREME_RATE_PER_MIN;
  const stepSoft =
    stepRate >= RN_DAY_SPIKE_SOFT_RATE_PER_MIN || stepInc >= RN_DAY_SPIKE_SOFT_JUMP;
  const largeStepSuspect = stepInc >= RN_DAY_LARGE_STEP_SUSPECT_MIN;
  if (stepExtreme) signals.push('extreme_step_rate');
  else if (stepSoft) signals.push('soft_step_rate');
  if (largeStepSuspect) signals.push('large_step_increase');
  return { stepExtreme, stepSoft, largeStepSuspect, signals };
}

/**
 * Classify increase vs baseline for candidate detection (never sole reject).
 * RN_DAY/RN_15M/RN_60M equality is intentionally NOT a reject signal.
 */
function classifyRnDayIncrease(scaled, accepted, elapsedMinutes, cross) {
  const elapsed = Math.max(1, elapsedMinutes | 0);
  const baseline = accepted == null ? 0 : accepted;
  const increase = scaled - baseline;
  if (increase <= 0) {
    return {
      softCandidate: false,
      extremeCandidate: false,
      ratePerMinute: 0,
      increase,
      elapsedMinutes: elapsed,
      crossContradiction: false,
      signals: []
    };
  }
  const ratePerMinute = increase / elapsed;
  const softCandidate =
    ratePerMinute >= RN_DAY_SPIKE_SOFT_RATE_PER_MIN || increase >= RN_DAY_SPIKE_SOFT_JUMP;
  const extremeCandidate = ratePerMinute >= RN_DAY_SPIKE_EXTREME_RATE_PER_MIN;
  const signals = [];
  if (extremeCandidate) signals.push('extreme_rate');
  else if (softCandidate) signals.push('soft_rate');

  let crossContradiction = false;
  const slack = RN_DAY_SPIKE_CROSS_SLACK;
  if (cross) {
    if (elapsed <= 15 && cross.rn15 != null && increase > cross.rn15 + slack) {
      crossContradiction = true;
      signals.push('cross_contradiction_rn15');
    } else if (elapsed <= 60 && cross.rn60 != null && increase > cross.rn60 + slack) {
      crossContradiction = true;
      signals.push('cross_contradiction_rn60');
    }
  }
  return {
    softCandidate,
    extremeCandidate,
    ratePerMinute,
    increase,
    elapsedMinutes: elapsed,
    crossContradiction,
    signals
  };
}

/** Candidate classifier for tests — never sets rejected:true by itself. */
function evaluateRnDayUpwardSpike(scaled, accepted, elapsedMinutes, cross) {
  const c = classifyRnDayIncrease(scaled, accepted, elapsedMinutes, cross);
  return {
    spike: c.extremeCandidate || c.softCandidate,
    candidate: c.softCandidate || c.extremeCandidate,
    rejected: false,
    extremeCandidate: c.extremeCandidate,
    reason: c.extremeCandidate ? 'extreme_candidate' : c.softCandidate ? 'soft_candidate' : null,
    ratePerMinute: c.ratePerMinute,
    increase: c.increase,
    elapsedMinutes: c.elapsedMinutes,
    signals: c.signals
  };
}

/**
 * Mechanical large equal jumps (동래 +120mm repeat) → reject polluted run indices.
 */
function findMechanicalRepeatRejects(scaledSeries) {
  const rejects = new Set();
  const idxs = [];
  for (let i = 0; i < scaledSeries.length; i++) {
    if (scaledSeries[i] != null) idxs.push(i);
  }
  if (idxs.length < 3) return rejects;

  for (let a = 0; a < idxs.length - 2; a++) {
    const i0 = idxs[a];
    const i1 = idxs[a + 1];
    const i2 = idxs[a + 2];
    const d1 = scaledSeries[i1] - scaledSeries[i0];
    const d2 = scaledSeries[i2] - scaledSeries[i1];
    if (d1 < RN_DAY_SPIKE_REPEAT_JUMP_MIN || d2 < RN_DAY_SPIKE_REPEAT_JUMP_MIN) continue;
    if (Math.abs(d1 - d2) > RN_DAY_SPIKE_REPEAT_TOL) {
      // First jump may differ (101.5 vs 120); still start a run if d2 matches subsequent
      // Fall through only when d1 also large — handled below with looser first jump
    }

    const run = [];
    // Require at least two consecutive large similar deltas among d1,d2,...
    let matched = Math.abs(d1 - d2) <= RN_DAY_SPIKE_REPEAT_TOL;
    if (!matched && d1 >= RN_DAY_SPIKE_REPEAT_JUMP_MIN && d2 >= RN_DAY_SPIKE_REPEAT_JUMP_MIN) {
      // Allow first jump mismatch up to 30mm (101.5 vs 120)
      matched = Math.abs(d1 - d2) <= 300;
    }
    if (!matched) continue;

    run.push(i1, i2);
    let prev = i2;
    let prevDelta = d2;
    for (let b = a + 3; b < idxs.length; b++) {
      const ix = idxs[b];
      const d = scaledSeries[ix] - scaledSeries[prev];
      if (d < RN_DAY_SPIKE_REPEAT_JUMP_MIN) break;
      if (Math.abs(d - prevDelta) > RN_DAY_SPIKE_REPEAT_TOL) break;
      run.push(ix);
      prev = ix;
      prevDelta = d;
    }
    if (run.length < 2) continue;
    for (const ri of run) rejects.add(ri);
  }
  return rejects;
}

/**
 * Isolated peak between missings then reset low (북강릉). Equality alone is not used.
 */
function findIsolatedPeakResetRejects(scaledSeries) {
  const rejects = new Set();
  for (let i = 0; i < scaledSeries.length; i++) {
    const v = scaledSeries[i];
    if (v == null || v < RN_DAY_SPIKE_ISOLATED_PEAK_MIN) continue;
    const prev = prevNonNullIndex(scaledSeries, i - 1);
    const next = nextNonNullIndex(scaledSeries, i + 1);
    const gapBefore = prev < 0 ? true : i - prev >= 2;
    const gapAfter = next < 0 ? i < scaledSeries.length - 1 : next - i >= 2;
    if (!gapBefore || !gapAfter) continue;
    if (next < 0) {
      if (countTrailingMissing(scaledSeries, i + 1) >= 1) rejects.add(i);
      continue;
    }
    const nv = scaledSeries[next];
    if (nv <= 20 || nv <= v * 0.2) rejects.add(i);
  }
  return rejects;
}

/**
 * Extreme/large jump then long source-missing is NOT a reject by itself
 * (extreme rain can be followed by telemetry gaps). Those samples stay
 * suspect-retained via the normal extreme-candidate path.
 * Kept as a no-op helper so call sites/docs stay explicit.
 */
function findExtremeThenLongMissingRejects(_scaledSeries) {
  return new Set();
}

/**
 * Offline per-station QC.
 * status: valid | suspect-retained | rejected | missing | counterRegression
 * Reject requires multi-signal patterns only (mechanical repeat, isolated peak→reset).
 * extreme + long missing alone → NOT rejected.
 */
function qcRnDayStationSeries(scaledSeries, crossSeries, hhmmSeries) {
  const n = scaledSeries.length;
  const pack = new Array(n);
  const rolling = new Array(n);
  const reason = new Array(n);
  const status = new Array(n);
  const signals = new Array(n);
  const episodeMeta = new Array(n).fill(null);

  const mechRejects = findMechanicalRepeatRejects(scaledSeries);
  const isolatedRejects = findIsolatedPeakResetRejects(scaledSeries);
  const episodeResult = findContaminatedPeakEpisodeRejects(scaledSeries, crossSeries, hhmmSeries);
  const episodeRejects = episodeResult.rejects;
  for (const [idx, meta] of episodeResult.episodeMeta.entries()) {
    episodeMeta[idx] = meta;
  }
  const rejectMask = new Set([...mechRejects, ...isolatedRejects, ...episodeRejects]);
  // extreme + long missing alone is intentionally NOT a reject path.

  let accepted = null;
  let acceptedIdx = null;
  let pendingSuspect = null;
  let recoveryStreak = 0;
  let afterReject = false;

  for (let i = 0; i < n; i++) {
    const v = scaledSeries[i];
    const hhmm = hhmmSeries ? hhmmSeries[i] : null;
    const cross = crossSeries ? crossSeries[i] : null;
    signals[i] = [];

    if (v == null) {
      pack[i] = null;
      rolling[i] = null;
      reason[i] = 'source_missing';
      status[i] = 'missing';
      recoveryStreak = 0;
      continue;
    }

    if (hhmm === '0000' && v === 0) {
      accepted = 0;
      acceptedIdx = i;
      pendingSuspect = null;
      afterReject = false;
      recoveryStreak = 0;
      pack[i] = 0;
      rolling[i] = 0;
      reason[i] = null;
      status[i] = 'valid';
      continue;
    }

    if (rejectMask.has(i)) {
      const sig = [];
      if (mechRejects.has(i)) sig.push('mechanical_repeat');
      if (isolatedRejects.has(i)) sig.push('isolated_peak_reset');
      if (episodeRejects.has(i)) sig.push('repeated_peak_episode');
      signals[i] = sig;
      pack[i] = null;
      rolling[i] = accepted;
      reason[i] = 'upwardSpikeRejected';
      status[i] = 'rejected';
      pendingSuspect = null;
      afterReject = true;
      recoveryStreak = 0;
      continue;
    }

    if (accepted != null && v < accepted) {
      pack[i] = null;
      rolling[i] = accepted;
      reason[i] = 'counterRegression';
      status[i] = 'counterRegression';
      recoveryStreak = 0;
      pendingSuspect = null;
      continue;
    }

    if (accepted == null) {
      const cls0 = classifyRnDayIncrease(v, 0, 1, cross);
      const step0 = evaluateStepSpikeSignals(scaledSeries, hhmmSeries, i);
      signals[i] = [...cls0.signals, ...step0.signals];
      const extremeCandidate = cls0.extremeCandidate || step0.stepExtreme || step0.largeStepSuspect;
      if (extremeCandidate || (cls0.softCandidate && cls0.crossContradiction) || step0.largeStepSuspect) {
        pendingSuspect = { value: v, idx: i };
        pack[i] = v;
        rolling[i] = v;
        reason[i] = 'suspectRetained';
        status[i] = 'suspect-retained';
        continue;
      }
      accepted = v;
      acceptedIdx = i;
      pack[i] = v;
      rolling[i] = v;
      reason[i] = null;
      status[i] = 'valid';
      continue;
    }

    const elapsed = elapsedMinutesBetween(hhmmSeries, acceptedIdx, i);
    const cls = classifyRnDayIncrease(v, accepted, elapsed, cross);
    const stepSig = evaluateStepSpikeSignals(scaledSeries, hhmmSeries, i);
    signals[i] = [...cls.signals, ...stepSig.signals];

    if (pendingSuspect) {
      if (!cls.extremeCandidate && cls.increase >= 0 && cls.increase <= RN_DAY_SPIKE_SOFT_JUMP) {
        accepted = pendingSuspect.value;
        acceptedIdx = pendingSuspect.idx;
        pendingSuspect = null;
      } else {
        pendingSuspect = null;
      }
    }

    // Extreme / large single-step / soft+cross contradiction → suspect-retained
    const extremeCandidate =
      cls.extremeCandidate || stepSig.stepExtreme || stepSig.largeStepSuspect;
    const softCandidate = cls.softCandidate || stepSig.stepSoft;
    if (
      extremeCandidate ||
      (softCandidate && cls.crossContradiction) ||
      stepSig.largeStepSuspect
    ) {
      pendingSuspect = { value: v, idx: i };
      pack[i] = v;
      rolling[i] = v;
      reason[i] = 'suspectRetained';
      status[i] = 'suspect-retained';
      continue;
    }

    if (afterReject) {
      recoveryStreak += 1;
      if (recoveryStreak < RN_DAY_SPIKE_RECOVERY_STREAK) {
        pack[i] = null;
        rolling[i] = accepted;
        reason[i] = 'spikeRecoveryPending';
        status[i] = 'rejected';
        continue;
      }
      afterReject = false;
      recoveryStreak = 0;
      accepted = v;
      acceptedIdx = i;
      pack[i] = v;
      rolling[i] = v;
      reason[i] = 'spikeRecovery';
      status[i] = 'valid';
      continue;
    }

    accepted = v;
    acceptedIdx = i;
    pendingSuspect = null;
    pack[i] = v;
    rolling[i] = v;
    reason[i] = cls.softCandidate ? 'softCandidateAccepted' : null;
    status[i] = 'valid';
  }

  return { pack, rolling, reason, status, signals, rejectMask, episodeMeta };
}

/**
 * Regression-focused tracker for simple unit tests.
 * Full spike safety uses qcRnDayStationSeries inside applyRnDayCounterRegression.
 */
function createRnDayRunningMaxTracker() {
  let acceptedRnDay = null;
  let hadRegression = false;
  return {
    push(scaled, meta = {}) {
      if (scaled == null) {
        return {
          packValue: null,
          forRolling: null,
          reason: 'source_missing',
          status: 'missing',
          spikeEval: null
        };
      }
      const hhmm = meta.hhmm != null ? String(meta.hhmm) : null;
      if (hhmm === '0000' && scaled === 0) {
        acceptedRnDay = 0;
        return { packValue: 0, forRolling: 0, reason: null, status: 'valid', spikeEval: null };
      }
      if (acceptedRnDay != null && scaled < acceptedRnDay) {
        hadRegression = true;
        return {
          packValue: null,
          forRolling: acceptedRnDay,
          reason: 'counterRegression',
          status: 'counterRegression',
          spikeEval: null
        };
      }
      const spikeEval = evaluateRnDayUpwardSpike(scaled, acceptedRnDay, 1, meta.cross || null);
      acceptedRnDay = scaled;
      return {
        packValue: scaled,
        forRolling: scaled,
        reason: spikeEval.candidate ? 'softCandidateAccepted' : null,
        status: spikeEval.extremeCandidate ? 'suspect-retained' : 'valid',
        spikeEval
      };
    },
    get acceptedRnDay() {
      return acceptedRnDay;
    },
    get hadRegression() {
      return hadRegression;
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
    extremeCandidateSampleCount: 0,
    suspectRetainedSampleCount: 0,
    spikeRecoverySampleCount: 0,
    byReason: {
      counterRegression: 0,
      sourceMissing: 0,
      upwardSpikeRejected: 0,
      suspectRetained: 0,
      spikeRecoveryPending: 0,
      spikeRecovery: 0
    }
  };
}

/**
 * Apply RN_DAY QC (offline multi-signal spike → regression) to midnight-normalized grids.
 */
function applyRnDayCounterRegression(scaledGrid, frameCount, stationCount, options = {}) {
  const crossGrid = options.crossGrid || null;
  const timestamps = options.timestamps || null;
  const packGrid = new Array(frameCount * stationCount);
  const rollingGrid = new Array(frameCount * stationCount);
  const reasonGrid = new Array(frameCount * stationCount);
  const statusGrid = new Array(frameCount * stationCount);
  const signalsGrid = new Array(frameCount * stationCount);
  const episodeMetaGrid = new Array(frameCount * stationCount).fill(null);
  const stats = emptyRnDayRegressionStats();
  const stationHadRegression = new Uint8Array(stationCount);
  const stationHadSpike = new Uint8Array(stationCount);

  for (let si = 0; si < stationCount; si++) {
    const scaledSeries = new Array(frameCount);
    const crossSeries = new Array(frameCount);
    const hhmmSeries = new Array(frameCount);
    for (let fi = 0; fi < frameCount; fi++) {
      const idx = fi * stationCount + si;
      scaledSeries[fi] = scaledGrid[idx];
      crossSeries[fi] = crossGrid ? crossGrid[idx] : null;
      hhmmSeries[fi] = timestamps ? timestamps[fi].slice(8, 12) : null;
    }

    const qc = qcRnDayStationSeries(scaledSeries, crossSeries, hhmmSeries);
    for (let fi = 0; fi < frameCount; fi++) {
      const idx = fi * stationCount + si;
      packGrid[idx] = qc.pack[fi];
      rollingGrid[idx] = qc.rolling[fi];
      reasonGrid[idx] = qc.reason[fi];
      statusGrid[idx] = qc.status[fi];
      signalsGrid[idx] = qc.signals ? qc.signals[fi] : [];
      episodeMetaGrid[idx] = qc.episodeMeta ? qc.episodeMeta[fi] : null;

      const st = qc.status[fi];
      const rs = qc.reason[fi];
      if (st === 'missing' || rs === 'source_missing') {
        stats.sourceMissingSampleCount += 1;
        stats.byReason.sourceMissing += 1;
      } else if (rs === 'counterRegression') {
        stats.regressionSampleCount += 1;
        stats.counterRegressionFilledSampleCount += 1;
        stats.byReason.counterRegression += 1;
        stationHadRegression[si] = 1;
      } else if (st === 'rejected' || rs === 'upwardSpikeRejected') {
        stats.upwardSpikeRejectedSampleCount += 1;
        stats.byReason.upwardSpikeRejected += 1;
        stationHadSpike[si] = 1;
      } else if (st === 'suspect-retained' || rs === 'suspectRetained') {
        stats.suspectRetainedSampleCount += 1;
        stats.extremeCandidateSampleCount += 1;
        stats.upwardSpikeCandidateSampleCount += 1;
        stats.byReason.suspectRetained += 1;
      } else if (rs === 'spikeRecoveryPending') {
        stats.byReason.spikeRecoveryPending += 1;
        stationHadSpike[si] = 1;
      } else if (rs === 'spikeRecovery') {
        stats.spikeRecoverySampleCount += 1;
        stats.byReason.spikeRecovery += 1;
      } else if (rs === 'softCandidateAccepted') {
        stats.upwardSpikeCandidateSampleCount += 1;
      }
    }
    if (stationHadRegression[si]) stats.regressionStationCount += 1;
    if (stationHadSpike[si]) stats.upwardSpikeStationCount += 1;
  }

  return { packGrid, rollingGrid, reasonGrid, statusGrid, signalsGrid, episodeMetaGrid, stats };
}

function scaledToMm(scaled) {
  if (scaled == null) return null;
  return Number((scaled * 0.1).toFixed(1));
}

/**
 * Sparse QC records for suspect-retained / rejected / substituted / substitution-expired.
 * Field names match docs/rainfall-producer-contract-v8-verification-request.md.
 */
function buildSparseRnDayQcRecords({
  dayYmd,
  timestamps,
  stationIds,
  stations,
  rawScaledGrid,
  packGrid,
  rollingGrid,
  statusGrid,
  reasonGrid,
  signalsGrid,
  episodeMetaGrid,
  frameCount,
  stationCount
}) {
  const records = [];
  for (let fi = 0; fi < frameCount; fi++) {
    const tm = timestamps[fi];
    for (let si = 0; si < stationCount; si++) {
      const idx = fi * stationCount + si;
      const st = statusGrid[idx];
      const rs = reasonGrid[idx];
      let state = null;
      if (st === 'suspect-retained' || rs === 'suspectRetained') state = 'suspect-retained';
      else if (st === 'rejected' || rs === 'upwardSpikeRejected' || rs === 'spikeRecoveryPending') {
        state = 'rejected';
      } else if (rs === 'counterRegression') {
        // Counter-regression is pack-missing with rolling hold; expose as rejected-style sparse for tracing.
        state = 'rejected';
      }
      if (!state) continue;

      const rawValue = rawScaledGrid[idx];
      const packValue = packGrid[idx];
      const rollValue = rollingGrid[idx];
      const substitutionUsed =
        packValue == null && rollValue != null && state === 'rejected';
      const meta = stations && stations[si] ? stations[si] : null;
      const ep = episodeMetaGrid ? episodeMetaGrid[idx] : null;
      const record = {
        TM: tm,
        STN_ID: stationIds[si],
        stationName: meta && (meta.STN_KO || meta.STN_NAME) ? meta.STN_KO || meta.STN_NAME : undefined,
        state,
        rawValue: rawValue == null ? null : rawValue,
        scale: 0.1,
        valueMm: scaledToMm(rawValue),
        signals: signalsGrid && signalsGrid[idx] ? [...signalsGrid[idx]] : [],
        acceptedUpdated: false,
        substitutionUsed: Boolean(substitutionUsed),
        reason: rs || state,
        // Extra trace fields (optional for consumers)
        packRawValue: packValue,
        packValueMm: scaledToMm(packValue),
        date: dayYmd,
        variable: 'RN_DAY'
      };
      if (ep) {
        record.episodeId = ep.episodeId;
        record.episodeStartTm = timestamps[ep.startIdx] || undefined;
        record.episodeEndTm = timestamps[ep.endIdx] || undefined;
        record.episodePeakRawValue = ep.peakValue;
        record.episodePeakValueMm = scaledToMm(ep.peakValue);
      }
      records.push(record);
    }
  }
  return records;
}

/**
 * Consecutive spike-reject minutes ending at frame fi for one station.
 */
function consecutiveSpikeRejectMinutes(reasonGrid, statusGrid, fi, si, stationCount) {
  let mins = 0;
  for (let f = fi; f >= 0; f--) {
    const idx = f * stationCount + si;
    const rs = reasonGrid[idx];
    const st = statusGrid[idx];
    if (
      rs === 'upwardSpikeRejected' ||
      rs === 'spikeRecoveryPending' ||
      st === 'rejected'
    ) {
      mins += 1;
      continue;
    }
    break;
  }
  return mins;
}

/**
 * Build midnight-normalized + dual QC grids (spike/regression pack missing; rolling holds accepted).
 */
function buildQcRnDayScaledGrid(frames, timestamps, stationIds, options = {}) {
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

  const rawScaledGrid = scaledGrid.slice();
  const {
    packGrid,
    rollingGrid,
    reasonGrid,
    statusGrid,
    signalsGrid,
    episodeMetaGrid,
    stats: regression
  } = applyRnDayCounterRegression(scaledGrid, frameCount, stationCount, { crossGrid, timestamps });

  const dayYmd = timestamps[0] ? timestamps[0].slice(0, 8) : null;
  const sparseQcRecords = buildSparseRnDayQcRecords({
    dayYmd,
    timestamps,
    stationIds,
    stations: options.stations || null,
    rawScaledGrid,
    packGrid,
    rollingGrid,
    statusGrid,
    reasonGrid,
    signalsGrid,
    episodeMetaGrid,
    frameCount,
    stationCount
  });

  return {
    packGrid,
    rollingGrid,
    reasonGrid,
    statusGrid,
    signalsGrid,
    episodeMetaGrid,
    rawScaledGrid,
    sparseQcRecords,
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
    upwardSpikeContaminationPreventedSampleCount: 0,
    qcRejectedSourceSampleCount: 0,
    lastConfirmedSubstitutionSampleCount: 0,
    substitutionExpiredSampleCount: 0,
    substitutionMaxMinutes: RN_24HR_SUBSTITUTION_MAX_MINUTES
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
  let sparseQcRecords = [];
  let qcDetail = null;

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

    const todayQc = buildQcRnDayScaledGrid(frames, timestamps, stationIds, { stations });
    midnightNormalizedCount = todayQc.midnightNormalizedCount;
    jsonPresentCount = todayQc.jsonPresentCount;
    rnDayRegression = todayQc.regression;
    sparseQcRecords = todayQc.sparseQcRecords || [];
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
        let todayScaled = todayQc.rollingGrid[idx];
        const todayReason = todayQc.reasonGrid ? todayQc.reasonGrid[idx] : null;
        const todayStatus = todayQc.statusGrid ? todayQc.statusGrid[idx] : null;
        const todayFilled =
          todayQc.packGrid[idx] == null && todayQc.rollingGrid[idx] != null;
        const todaySpikeHold =
          todayReason === 'upwardSpikeRejected' || todayReason === 'spikeRecoveryPending';

        if (todaySpikeHold && todayScaled != null) {
          const holdMins = consecutiveSpikeRejectMinutes(
            todayQc.reasonGrid,
            todayQc.statusGrid,
            fi,
            si,
            stationCount
          );
          if (holdMins > RN_24HR_SUBSTITUTION_MAX_MINUTES) {
            todayScaled = null;
            rollingQc.substitutionExpiredSampleCount += 1;
            rollingQc.qcRejectedSourceSampleCount += 1;
            sparseQcRecords.push({
              TM: timestamps[fi],
              STN_ID: stnId,
              state: 'substitution-expired',
              rawValue: todayQc.rawScaledGrid ? todayQc.rawScaledGrid[idx] : null,
              scale: 0.1,
              valueMm: scaledToMm(todayQc.rawScaledGrid ? todayQc.rawScaledGrid[idx] : null),
              signals: ['substitution_max_exceeded'],
              acceptedUpdated: false,
              substitutionUsed: false,
              substitutionMinutes: holdMins,
              substitutionMaxMinutes: RN_24HR_SUBSTITUTION_MAX_MINUTES,
              reason: 'last_confirmed_expired',
              date: dayYmd,
              variable: 'RN_24HR'
            });
          }
        }

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
            if (todaySpikeHold || todayStatus === 'rejected') {
              rollingQc.qcRejectedSourceSampleCount += 1;
            }
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
        if (todaySpikeHold && todayQc.rollingGrid[idx] != null) {
          const holdMins = consecutiveSpikeRejectMinutes(
            todayQc.reasonGrid,
            todayQc.statusGrid,
            fi,
            si,
            stationCount
          );
          if (holdMins <= RN_24HR_SUBSTITUTION_MAX_MINUTES) {
            rollingQc.lastConfirmedSubstitutionSampleCount += 1;
            rollingQc.upwardSpikeContaminationPreventedSampleCount += 1;
            rollingQc.upwardSpikeRejectedSampleCount += 1;
            sparseQcRecords.push({
              TM: timestamps[fi],
              STN_ID: stnId,
              state: 'substituted',
              rawValue: todayQc.rawScaledGrid ? todayQc.rawScaledGrid[idx] : null,
              scale: 0.1,
              valueMm: scaledToMm(todayQc.rawScaledGrid ? todayQc.rawScaledGrid[idx] : null),
              signals: ['last_confirmed_rn_day'],
              acceptedUpdated: false,
              substitutionUsed: true,
              substitutionMinutes: holdMins,
              substitutionMaxMinutes: RN_24HR_SUBSTITUTION_MAX_MINUTES,
              rn24hrValueMm: scaledToMm(derived.value),
              reason: 'last_confirmed_rn_day',
              date: dayYmd,
              variable: 'RN_24HR'
            });
          }
        } else if (todayFilled || endFilled || sameFilled) {
          rollingQc.counterRegressionFilledSampleCount += 1;
        }
        int16[fi * stationCount + si] = derived.value;
      }
    }
  } else if (spec.normalizeMidnightRnDay || name === 'RN_DAY') {
    const dayQc = buildQcRnDayScaledGrid(frames, timestamps, stationIds, { stations });
    midnightNormalizedCount = dayQc.midnightNormalizedCount;
    jsonPresentCount = dayQc.jsonPresentCount;
    rnDayRegression = dayQc.regression;
    sparseQcRecords = dayQc.sparseQcRecords || [];

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
    if (rollingQc.substitutionExpiredSampleCount > 0) {
      warnings.push(
        `RN_24HR last-confirmed substitution expired (>${RN_24HR_SUBSTITUTION_MAX_MINUTES}min) for ${rollingQc.substitutionExpiredSampleCount} samples`
      );
    }
    if (rollingQc.lastConfirmedSubstitutionSampleCount > 0) {
      warnings.push(
        `RN_24HR used last-confirmed RN_DAY substitution for ${rollingQc.lastConfirmedSubstitutionSampleCount} samples (max ${RN_24HR_SUBSTITUTION_MAX_MINUTES}min)`
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
      url: packBinaryUrl(spec, dayKey, sha256),
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
      extremeCandidateSampleCount: rnDayRegression.extremeCandidateSampleCount,
      suspectRetainedSampleCount: rnDayRegression.suspectRetainedSampleCount,
      upwardSpikeCandidateSampleCount: rnDayRegression.upwardSpikeCandidateSampleCount,
      upwardSpikeRejectedSampleCount: rnDayRegression.upwardSpikeRejectedSampleCount,
      upwardSpikeRejectedStationCount: rnDayRegression.upwardSpikeStationCount,
      upwardSpikeStationCount: rnDayRegression.upwardSpikeStationCount,
      spikeRecoverySampleCount: rnDayRegression.spikeRecoverySampleCount,
      recoverySampleCount: rnDayRegression.spikeRecoverySampleCount
    };
  }
  if (
    (name === 'RN_DAY' || name === 'RN_24HR') &&
    Array.isArray(sparseQcRecords) &&
    sparseQcRecords.length > 0
  ) {
    const suspectRetainedSampleCount = sparseQcRecords.filter(
      (r) => r.state === 'suspect-retained'
    ).length;
    const rejectedSampleCount = sparseQcRecords.filter((r) => r.state === 'rejected').length;
    const substitutedSampleCount = sparseQcRecords.filter((r) => r.state === 'substituted').length;
    const substitutionExpiredSampleCount = sparseQcRecords.filter(
      (r) => r.state === 'substitution-expired'
    ).length;
    const qcStates = {
      suspectRetainedSampleCount,
      rejectedSampleCount,
      substitutedSampleCount,
      substitutionExpiredSampleCount,
      recordCount: sparseQcRecords.length
    };
    // Hash the exact bytes that will be written to disk (no in-file sha256 field).
    const qcBody = {
      schemaVersion: 1,
      contractRevision: PACK_CONTRACT_REVISION,
      datasetId,
      date: from.slice(0, 8),
      variable: name,
      generatedAt: manifest.generatedAt,
      scale: 0.1,
      unit: 'mm',
      note:
        'Sparse QC only: suspect-retained | rejected | substituted | substitution-expired. Lookup by (TM, STN_ID). rawValue=Int16×10, valueMm=rawValue*0.1',
      qcStates,
      records: sparseQcRecords
    };
    const qcJson = serializeQcDetailJson(qcBody);
    const qcSha256 = hashQcDetailJson(qcJson);
    const qcUrl = packQcDetailUrl(spec, dayKey, qcSha256);
    const qcFileName = packQcDetailFileName(qcSha256);
    manifest.qcDetailUrl = qcUrl;
    manifest.qcDetailSha256 = qcSha256;
    manifest.qcDetailFile = qcFileName;
    manifest.qc.qcStates = qcStates;
    qcDetail = {
      ...qcBody,
      _publishJson: qcJson,
      _publishFileName: qcFileName,
      _publishAlsoAs: 'qc.json'
    };
  }

  return {
    manifest,
    binary,
    dayKey,
    datasetId,
    revision,
    variable: name,
    qcDetail,
    binaryFileName: packBinaryFileName(spec, sha256)
  };
}

async function buildAwsTaPack(awsJsonDir, fromKor, toKor, options = {}) {
  return buildAwsVariablePack(awsJsonDir, fromKor, toKor, VARIABLE_TA, options);
}

async function publishAwsVariablePack(packRoot, built) {
  const { manifest, binary, dayKey, variable, qcDetail, binaryFileName } = built;
  const { spec } = getPackVariableSpec(variable || manifest.variable);
  const outDir = path.join(packRoot, packRelDir(spec, dayKey));
  await fsp.mkdir(outDir, { recursive: true });

  const binName =
    binaryFileName ||
    (manifest.data && manifest.data.sha256
      ? packBinaryFileName(spec, manifest.data.sha256)
      : `${spec.slug}.i16le`);
  const binTmp = path.join(outDir, `${binName}.${process.pid}.tmp`);
  const binFinal = path.join(outDir, binName);
  const manTmp = path.join(outDir, `manifest.json.${process.pid}.tmp`);
  const manFinal = path.join(outDir, 'manifest.json');

  await fsp.writeFile(binTmp, binary);
  await fsp.rename(binTmp, binFinal);
  await fsp.writeFile(manTmp, JSON.stringify(manifest, null, 2), 'utf8');
  await fsp.rename(manTmp, manFinal);

  let qcDetailPath = null;
  if (qcDetail) {
    const publishName =
      qcDetail._publishFileName ||
      (manifest.qcDetailFile
        ? manifest.qcDetailFile
        : packQcDetailFileName(manifest.qcDetailSha256));
    const alsoAs = qcDetail._publishAlsoAs || 'qc.json';
    const json =
      qcDetail._publishJson ||
      serializeQcDetailJson(
        Object.fromEntries(
          Object.entries(qcDetail).filter(([k]) => !k.startsWith('_publish'))
        )
      );
    if (manifest.qcDetailSha256) {
      const actualSha = hashQcDetailJson(json);
      if (actualSha !== manifest.qcDetailSha256) {
        const fail = new Error(
          `QC JSON SHA mismatch: manifest=${manifest.qcDetailSha256} bytes=${actualSha}`
        );
        fail.code = 'QC_SHA_MISMATCH';
        throw fail;
      }
    }
    const qcTmp = path.join(outDir, `${publishName}.${process.pid}.tmp`);
    const qcFinal = path.join(outDir, publishName);
    await fsp.writeFile(qcTmp, json, 'utf8');
    await fsp.rename(qcTmp, qcFinal);
    qcDetailPath = qcFinal;
    // Convenience alias (may be overwritten next warm; consumers should prefer qcDetailUrl).
    const aliasTmp = path.join(outDir, `${alsoAs}.${process.pid}.tmp`);
    const aliasFinal = path.join(outDir, alsoAs);
    await fsp.writeFile(aliasTmp, json, 'utf8');
    await fsp.rename(aliasTmp, aliasFinal);
  }

  if (manifest.qcDetailUrl) {
    const expectedQc =
      qcDetailPath ||
      path.join(outDir, manifest.qcDetailFile || packQcDetailFileName(manifest.qcDetailSha256));
    try {
      await fsp.access(expectedQc);
    } catch (err) {
      const fail = new Error(
        `Pack publish incomplete: qcDetailUrl ${manifest.qcDetailUrl} file missing on disk`
      );
      fail.code = 'QC_DETAIL_MISSING';
      throw fail;
    }
  }
  if (manifest.data && manifest.data.url) {
    try {
      await fsp.access(binFinal);
    } catch (err) {
      const fail = new Error(
        `Pack publish incomplete: data.url ${manifest.data.url} binary missing on disk`
      );
      fail.code = 'PACK_BINARY_MISSING';
      throw fail;
    }
  }

  return { manifest, binaryPath: binFinal, manifestPath: manFinal, qcDetailPath };
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
    if (!isContentAddressedPackBinaryUrl(cached.data.url, 'rn_24hr_rolling')) return false;
    if (!cached.qcDetailUrl || !String(cached.qcDetailUrl).includes('qc-v')) return false;
  }
  if (name === 'RN_DAY') {
    const acc = cached.accumulation;
    if (!acc || acc.type !== 'day') return false;
    if (!isContentAddressedPackBinaryUrl(cached.data.url, 'rn_day')) return false;
    if (!cached.qcDetailUrl || !String(cached.qcDetailUrl).includes('qc-v')) return false;
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
  classifyRnDayIncrease,
  qcRnDayStationSeries,
  findExtremeThenLongMissingRejects,
  findContaminatedPeakEpisodeRejects,
  evaluateStepSpikeSignals,
  packBinaryUrl,
  packBinaryFileName,
  isContentAddressedPackBinaryUrl,
  serializeQcDetailJson,
  hashQcDetailJson,
  RN_24HR_SUBSTITUTION_MAX_MINUTES,
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
