/**
 * KMA API Hub AWS 시간통계 (awsh.php) — RN
 * https://apihub-pub.kma.go.kr/api/typ01/url/awsh.php?var=RN&tm=YYYYMMDDHHMI
 *
 * var=RN 응답 컬럼 (TM STN 이후, 명세):
 *   RE_SUM, RE_QCM, RN_DAY, RN_DAY_MI, RN_HR1, RN_HR1_MI,
 *   RN_60M_MAX, RN_60M_MAX_MI, RN_60M_QCM, RN_15M_MAX, RN_15M_MAX_MI, RN_15M_QCM
 */
const axios = require('axios');

const API_BASE = 'https://apihub-pub.kma.go.kr/api/typ01/url/awsh.php';
const MISSING_LT = -50;

/** TM STN 이후 고정 컬럼 순서 (help=0) — contractRevision 2+ */
const RN_SOURCE_FIELDS = Object.freeze([
  'RE_SUM',
  'RE_QCM',
  'RN_DAY',
  'RN_DAY_MI',
  'RN_HR1',
  'RN_HR1_MI',
  'RN_60M_MAX',
  'RN_60M_MAX_MI',
  'RN_60M_QCM',
  'RN_15M_MAX',
  'RN_15M_MAX_MI',
  'RN_15M_QCM'
]);

/** pack/API에 노출하는 필드 (source와 동일; RE_* 포함) */
const RN_FIELDS = RN_SOURCE_FIELDS;

/** 강수량(mm) 필드 — 음수는 STN/field만 null (contractRevision 3+) */
const RN_AMOUNT_FIELDS = Object.freeze(['RN_DAY', 'RN_HR1', 'RN_60M_MAX', 'RN_15M_MAX']);

/** 음수 cell 비율 ≥ 이 값이고 절대 건수 하한 이상이면 fatal */
const NEGATIVE_AMOUNT_FATAL_CELL_RATIO = Number(
  process.env.AWS_HOURLY_RN_NEG_FATAL_CELL_RATIO || 0.05
);
/** 음수 보유 지점 비율 ≥ 이 값이고 절대 건수 하한 이상이면 fatal */
const NEGATIVE_AMOUNT_FATAL_STATION_RATIO = Number(
  process.env.AWS_HOURLY_RN_NEG_FATAL_STATION_RATIO || 0.1
);
/** 비율 fatal 적용 전 최소 음수 cell 수 (소수 지점 -0.5 때문에 TM 전체 FAIL 방지) */
const NEGATIVE_AMOUNT_FATAL_MIN_NULLS = Number(
  process.env.AWS_HOURLY_RN_NEG_FATAL_MIN_NULLS || 100
);
/** 비율 fatal 적용 전 최소 음수 보유 지점 수 */
const NEGATIVE_AMOUNT_FATAL_MIN_STATIONS = Number(
  process.env.AWS_HOURLY_RN_NEG_FATAL_MIN_STATIONS || 50
);
const NEGATIVE_AMOUNT_SAMPLE_LIMIT = 20;

function isMissingPhysical(v) {
  return v == null || Number.isNaN(v) || v <= MISSING_LT;
}

function toNumberOrNull(raw, { integer = false, allowNegativeSentinel = false } = {}) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (!allowNegativeSentinel && isMissingPhysical(n)) return null;
  return integer ? Math.round(n) : n;
}

/**
 * 음수 강수량 필드를 해당 STN/field만 null로 바꿈.
 * 다량(비율 임계)이면 컬럼 밀림 의심으로 throw.
 *
 * @param {object[]} rows  in-place mutate
 * @param {object} [options]
 * @returns {{ nullCount: number, stationCount: number, samples: object[], byField: object }}
 */
function sanitizeRnAmountNegatives(rows, options = {}) {
  const context = options.context || 'awsh RN';
  const sampleLimit = options.sampleLimit == null ? NEGATIVE_AMOUNT_SAMPLE_LIMIT : options.sampleLimit;
  const fatalCellRatio =
    options.fatalCellRatio == null ? NEGATIVE_AMOUNT_FATAL_CELL_RATIO : options.fatalCellRatio;
  const fatalStationRatio =
    options.fatalStationRatio == null
      ? NEGATIVE_AMOUNT_FATAL_STATION_RATIO
      : options.fatalStationRatio;
  const fatalMinNulls =
    options.fatalMinNulls == null ? NEGATIVE_AMOUNT_FATAL_MIN_NULLS : options.fatalMinNulls;
  const fatalMinStations =
    options.fatalMinStations == null
      ? NEGATIVE_AMOUNT_FATAL_MIN_STATIONS
      : options.fatalMinStations;

  const samples = [];
  const byField = Object.fromEntries(RN_AMOUNT_FIELDS.map((f) => [f, 0]));
  const stationsHit = new Set();
  let nullCount = 0;

  for (const row of rows) {
    for (const name of RN_AMOUNT_FIELDS) {
      const v = row[name];
      if (v == null || typeof v !== 'number') continue;
      if (v >= 0) continue;
      if (samples.length < sampleLimit) {
        samples.push({
          TM: row.TM || null,
          STN_ID: row.STN_ID,
          field: name,
          value: v
        });
      }
      row[name] = null;
      nullCount += 1;
      byField[name] += 1;
      stationsHit.add(String(row.STN_ID));
    }
  }

  const stationCount = rows.length;
  const amountCellCount = Math.max(1, stationCount * RN_AMOUNT_FIELDS.length);
  const cellRatio = nullCount / amountCellCount;
  const stationRatio = stationCount > 0 ? stationsHit.size / stationCount : 0;

  const report = {
    nullCount,
    stationCount: stationsHit.size,
    rowCount: stationCount,
    cellRatio,
    stationRatio,
    byField,
    samples,
    fatalCellRatio,
    fatalStationRatio,
    fatalMinNulls,
    fatalMinStations
  };

  const cellFlood = nullCount >= fatalMinNulls && cellRatio >= fatalCellRatio;
  const stationFlood =
    stationsHit.size >= fatalMinStations && stationRatio >= fatalStationRatio;

  if (nullCount > 0 && (cellFlood || stationFlood)) {
    const err = new Error(
      `${context}: too many negative rain amounts (nulls=${nullCount}, ` +
        `stations=${stationsHit.size}/${stationCount}, cellRatio=${cellRatio.toFixed(3)}, ` +
        `stationRatio=${stationRatio.toFixed(3)}) — possible column shift`
    );
    err.code = 'RN_AMOUNT_NEGATIVE_FLOOD';
    err.report = report;
    throw err;
  }

  return report;
}

/** @deprecated */
function assertRnAmountNonNegative(rows, context = 'awsh RN') {
  return sanitizeRnAmountNegatives(rows, {
    context,
    fatalMinNulls: 1,
    fatalMinStations: 1,
    fatalCellRatio: 0,
    fatalStationRatio: 0
  });
}

/**
 * @param {string} text
 * @returns {{ tm: string, rows: object[], qc: object }}
 */
function parseAwshRnText(text) {
  const lines = String(text || '').split(/\r?\n/);
  let headerFields = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^YYMMDDHHMI/i.test(line) || /^KST\b/i.test(line)) {
      const parts = line.split(/[,\s]+/).filter(Boolean);
      // e.g. YYMMDDHHMI STN RE_SUM RE_QCM RN_DAY ...
      if (parts.length >= 3 && (/RN_/i.test(line) || /RE_SUM/i.test(line))) {
        headerFields = parts.slice(2).map((p) => p.replace(/[^A-Za-z0-9_]/g, '').toUpperCase());
      }
      continue;
    }
    break;
  }

  const rows = [];
  let tmFromRows = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^YYMMDDHHMI/i.test(line) || /^KST\b/i.test(line)) continue;

    const parts = line.split(/[,\s]+/).filter(Boolean);
    // TM STN + at least RE_SUM RE_QCM RN_DAY ...
    if (parts.length < 5) continue;
    if (!/^\d{12}$/.test(parts[0])) continue;
    if (!/^\d+$/.test(parts[1])) continue;

    const tm = parts[0];
    const stn = Number(parts[1]);
    tmFromRows = tmFromRows || tm;

    const fieldNames = headerFields && headerFields.length
      ? headerFields
      : RN_SOURCE_FIELDS;

    const row = { TM: tm, STN_ID: stn };
    for (let i = 0; i < fieldNames.length; i++) {
      const name = fieldNames[i];
      const raw = parts[2 + i];
      if (raw == null) {
        row[name] = null;
        continue;
      }
      const isMiOrQcm = /(_MI|_QCM)$/i.test(name);
      // RE_SUM은 분수(카운트) — 음수 sentinel만 결측, 그 외 정수 허용
      const isReSum = name === 'RE_SUM';
      row[name] = toNumberOrNull(raw, {
        integer: isMiOrQcm || isReSum,
        allowNegativeSentinel: isMiOrQcm
      });
    }

    for (const name of RN_SOURCE_FIELDS) {
      if (!(name in row)) row[name] = null;
    }

    rows.push(row);
  }

  const negativeAmountNulls = sanitizeRnAmountNegatives(rows, {
    context: `parseAwshRnText tm=${tmFromRows || '?'}`
  });

  return {
    tm: tmFromRows,
    rows,
    qc: { negativeAmountNulls }
  };
}

async function fetchAwshRnWindow(authKey, tm, options = {}) {
  const stn = options.stn == null ? 0 : options.stn;
  const help = options.help == null ? 0 : options.help;
  const url =
    `${API_BASE}?var=RN&tm=${encodeURIComponent(tm)}` +
    `&stn=${encodeURIComponent(stn)}&help=${encodeURIComponent(help)}` +
    `&authKey=${encodeURIComponent(authKey)}`;

  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: options.timeoutMs || 120000,
    validateStatus: () => true
  });
  const text = Buffer.from(res.data).toString('utf8');
  if (res.status !== 200) {
    const err = new Error(`awsh.php HTTP ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    err.body = text.slice(0, 500);
    throw err;
  }
  if (/인증|authKey|Unauthorized|오류|error/i.test(text) && !/\d{12}\s+\d+/.test(text)) {
    const err = new Error(`awsh.php error body: ${text.slice(0, 300)}`);
    err.body = text.slice(0, 500);
    throw err;
  }
  return text;
}

/**
 * @returns {Promise<{ tm: string, rows: object[], rawText: string, qc: object }>}
 */
async function fetchAwsHourlyRnRows(tm, options = {}) {
  const authKey = options.authKey || process.env.API_KEY || process.env.KMA_API_KEY;
  if (!authKey) {
    const err = new Error('API_KEY (or KMA_API_KEY) required for awsh.php');
    err.code = 'NO_API_KEY';
    throw err;
  }
  const rawText = await fetchAwshRnWindow(authKey, tm, options);
  const parsed = parseAwshRnText(rawText);
  return {
    tm: parsed.tm || String(tm),
    rows: parsed.rows,
    rawText,
    qc: parsed.qc
  };
}

module.exports = {
  API_BASE,
  RN_SOURCE_FIELDS,
  RN_FIELDS,
  RN_AMOUNT_FIELDS,
  NEGATIVE_AMOUNT_FATAL_CELL_RATIO,
  NEGATIVE_AMOUNT_FATAL_STATION_RATIO,
  NEGATIVE_AMOUNT_FATAL_MIN_NULLS,
  NEGATIVE_AMOUNT_FATAL_MIN_STATIONS,
  sanitizeRnAmountNegatives,
  assertRnAmountNonNegative,
  parseAwshRnText,
  fetchAwshRnWindow,
  fetchAwsHourlyRnRows
};
