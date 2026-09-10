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

/** 음수가 나오면 안 되는 강수량(mm) 필드 — 매핑 밀림 smoke invariant */
const RN_AMOUNT_FIELDS = Object.freeze(['RN_DAY', 'RN_HR1', 'RN_60M_MAX', 'RN_15M_MAX']);

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
 * RN_* 강수량(mm)이 음수면 매핑 오류 가능성 → throw
 * @param {object[]} rows
 * @param {string} [context]
 */
function assertRnAmountNonNegative(rows, context = 'awsh RN') {
  for (const row of rows) {
    for (const name of RN_AMOUNT_FIELDS) {
      const v = row[name];
      if (v == null) continue;
      if (typeof v === 'number' && v < 0) {
        const err = new Error(
          `${context}: negative ${name}=${v} at STN_ID=${row.STN_ID} TM=${row.TM} (column mapping?)`
        );
        err.code = 'RN_AMOUNT_NEGATIVE';
        err.stnId = row.STN_ID;
        err.field = name;
        err.value = v;
        throw err;
      }
    }
  }
}

/**
 * @param {string} text
 * @returns {{ tm: string, rows: object[] }}
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

  assertRnAmountNonNegative(rows, 'parseAwshRnText');
  return { tm: tmFromRows, rows };
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
 * @returns {Promise<{ tm: string, rows: object[], rawText: string }>}
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
    rawText
  };
}

module.exports = {
  API_BASE,
  RN_SOURCE_FIELDS,
  RN_FIELDS,
  RN_AMOUNT_FIELDS,
  assertRnAmountNonNegative,
  parseAwshRnText,
  fetchAwshRnWindow,
  fetchAwsHourlyRnRows
};
