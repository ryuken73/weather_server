/**
 * KMA API Hub AWS 시간통계 (awsh.php) — RN
 * https://apihub-pub.kma.go.kr/api/typ01/url/awsh.php?var=RN&tm=YYYYMMDDHHMI
 */
const axios = require('axios');

const API_BASE = 'https://apihub-pub.kma.go.kr/api/typ01/url/awsh.php';
const MISSING_LT = -50;

/** var=RN, help=0 일 때 기대 컬럼 (TM STN 이후) */
const RN_FIELDS = [
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
];

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
      // e.g. YYMMDDHHMI STN RN_DAY ...
      if (parts.length >= 3 && /RN_/i.test(line)) {
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
    if (parts.length < 4) continue;
    if (!/^\d{12}$/.test(parts[0])) continue;
    if (!/^\d+$/.test(parts[1])) continue;

    const tm = parts[0];
    const stn = Number(parts[1]);
    tmFromRows = tmFromRows || tm;

    const fieldNames = headerFields && headerFields.length
      ? headerFields
      : RN_FIELDS;

    const row = { TM: tm, STN_ID: stn };
    for (let i = 0; i < fieldNames.length; i++) {
      const name = fieldNames[i];
      const raw = parts[2 + i];
      if (raw == null) {
        row[name] = null;
        continue;
      }
      const isMiOrQcm = /(_MI|_QCM)$/i.test(name);
      row[name] = toNumberOrNull(raw, {
        integer: isMiOrQcm,
        allowNegativeSentinel: isMiOrQcm
      });
    }

    // 필수 키가 헤더에 없으면 고정 순서로 보강
    for (const name of RN_FIELDS) {
      if (!(name in row)) row[name] = null;
    }

    rows.push(row);
  }

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
  RN_FIELDS,
  parseAwshRnText,
  fetchAwshRnWindow,
  fetchAwsHourlyRnRows
};
