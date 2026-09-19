/**
 * KMA API Hub 적설관측 (stn_snow.php / kma_snow1.php)
 *
 * Stations:
 *   https://apihub-pub.kma.go.kr/api/typ01/url/stn_snow.php
 * Obs:
 *   https://apihub-pub.kma.go.kr/api/typ01/url/kma_snow1.php?sd=tot|24h&tm=...&stn=0&snow=2
 */
const axios = require('axios');

const STN_SNOW_BASE = 'https://apihub-pub.kma.go.kr/api/typ01/url/stn_snow.php';
const SNOW_OBS_BASE = 'https://apihub-pub.kma.go.kr/api/typ01/url/kma_snow1.php';
const MISSING_LT = -50;

const SD_KINDS = Object.freeze(['tot', '24h', 'day', '3hr']);

function resolveAuthKey(options = {}) {
  return options.authKey || process.env.API_KEY || process.env.KMA_API_KEY || null;
}

function requireAuthKey(options = {}) {
  const authKey = resolveAuthKey(options);
  if (!authKey) {
    const err = new Error('API_KEY (or KMA_API_KEY) required for snow Hub fetch');
    err.code = 'NO_API_KEY';
    throw err;
  }
  return authKey;
}

/** Hub text is often EUC-KR/CP949; try UTF-8 then euc-kr. */
function decodeHubBuffer(buf) {
  const utf8 = Buffer.from(buf).toString('utf8');
  const replacementCount = (utf8.match(/\uFFFD/g) || []).length;
  if (replacementCount === 0 && !/[\x80-\xff]{3,}/.test(utf8.slice(0, 200))) {
    return utf8;
  }
  try {
    const dec = new TextDecoder('euc-kr');
    return dec.decode(Buffer.from(buf));
  } catch (_) {
    try {
      const dec = new TextDecoder('windows-949');
      return dec.decode(Buffer.from(buf));
    } catch (_) {
      return utf8;
    }
  }
}

function assertHubOk(status, text, label) {
  if (status !== 200) {
    const err = new Error(`${label} HTTP ${status}: ${text.slice(0, 200)}`);
    err.status = status;
    throw err;
  }
  if (/인증|authKey|Unauthorized|오류|error|신청/i.test(text) && !/\d+\s+[-\d.]+\s+[-\d.]/.test(text) && !/\d{12}/.test(text)) {
    throw new Error(`${label} error body: ${text.slice(0, 300)}`);
  }
}

async function hubGet(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 120000,
    validateStatus: () => true
  });
  const text = decodeHubBuffer(res.data);
  return { status: res.status, text, raw: Buffer.from(res.data) };
}

function isMissingPhysical(v) {
  return v == null || Number.isNaN(v) || v <= MISSING_LT;
}

function scale10Cm(v) {
  if (v == null || Number.isNaN(v)) return null;
  if (v <= MISSING_LT) return null;
  return Math.round(v * 10);
}

function stripTrailingEquals(parts) {
  if (parts.length && parts[parts.length - 1] === '=') {
    return parts.slice(0, -1);
  }
  return parts;
}

/**
 * stn_snow.php data line (comma or whitespace).
 * Observed help layout:
 *   STN_ID LON LAT STN_SP HT STN_AD STN_KO FCT_ID LAW_ID
 * (STN_AD often equals STN_ID; LAW_ID is 10-digit 법정동코드)
 */
function parseStationLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  if (/^STN/i.test(trimmed) || /^ID\b/i.test(trimmed)) return null;

  let parts = stripTrailingEquals(trimmed.split(/[,\s]+/).filter(Boolean));
  if (parts.length < 6) return null;
  if (!/^\d+$/.test(parts[0])) return null;

  const STN_ID = Number(parts[0]);
  const LON = Number(parts[1]);
  const LAT = Number(parts[2]);
  if (!Number.isFinite(LON) || !Number.isFinite(LAT)) return null;

  let STN_SP = parts[3] || null;
  let HT = Number(parts[4]);
  let restStart = 5;
  if (!Number.isFinite(HT)) {
    HT = Number(parts[3]);
    STN_SP = null;
    restStart = 4;
  }

  const rest = parts.slice(restStart);
  let STN_AD = null;
  let STN_NAME = null;
  let FCT_ID = null;
  let LAW_ID = null;
  let STN_CD = null;

  const lawIdx = rest.findIndex((t) => /^\d{10}$/.test(t));
  if (lawIdx >= 0) {
    LAW_ID = rest[lawIdx];
    const before = rest.slice(0, lawIdx);
    // Prefer: [STN_AD, STN_KO..., FCT_ID]
    if (before.length >= 1 && /^\d+$/.test(before[0])) {
      STN_AD = before[0];
      STN_CD = before[0];
      if (before.length >= 3 && /^[0-9A-Za-z]+$/.test(before[before.length - 1])) {
        FCT_ID = before[before.length - 1];
        STN_NAME = before.slice(1, -1).join(' ') || null;
      } else {
        STN_NAME = before.slice(1).join(' ') || null;
      }
    } else if (before.length) {
      STN_NAME = before.join(' ');
    }
  } else if (rest.length >= 2) {
    if (/^\d+$/.test(rest[0])) {
      STN_AD = rest[0];
      STN_NAME = rest.slice(1).join(' ') || null;
    } else {
      STN_NAME = rest.join(' ');
    }
  }

  return {
    STN_ID,
    STN_NAME: STN_NAME || null,
    LAT: Number.isFinite(LAT) ? LAT : null,
    LON: Number.isFinite(LON) ? LON : null,
    HT: Number.isFinite(HT) ? HT : null,
    STN_SP,
    STN_CD,
    STN_AD,
    FCT_ID,
    LAW_ID
  };
}

function parseStationsText(text) {
  const stations = [];
  for (const raw of text.split(/\r?\n/)) {
    const row = parseStationLine(raw);
    if (row) stations.push(row);
  }
  stations.sort((a, b) => a.STN_ID - b.STN_ID);
  return stations;
}

/**
 * kma_snow1.php line: TM, STN_ID, STN_KO, LON, LAT, STN_SP, SD, =
 * (sd=tot / 24h — SD column is the requested kind)
 */
function parseSnowObsLine(line, sdKind) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  if (/^YYMMDDHHMI/i.test(trimmed) || /^KST\b/i.test(trimmed) || /^TM\b/i.test(trimmed)) {
    return null;
  }

  let parts = stripTrailingEquals(
    trimmed.includes(',')
      ? trimmed.split(',').map((p) => p.trim()).filter(Boolean)
      : trimmed.split(/\s+/).filter(Boolean)
  );
  if (parts.length < 7) return null;
  if (!/^\d{12}$/.test(parts[0])) return null;
  if (!/^\d+$/.test(parts[1])) return null;

  const tm = parts[0];
  const STN_ID = Number(parts[1]);
  const STN_NAME = parts[2] || null;
  const LON = Number(parts[3]);
  const LAT = Number(parts[4]);
  const STN_SP = parts[5] || null;
  const sdRaw = Number(parts[6]);
  const sdScaled = scale10Cm(sdRaw);

  const row = {
    TM: tm,
    STN_ID,
    STN_NAME,
    LON: Number.isFinite(LON) ? LON : null,
    LAT: Number.isFinite(LAT) ? LAT : null,
    STN_SP,
    SD: sdScaled
  };

  if (sdKind === 'tot') row.SD_TOT = sdScaled;
  else if (sdKind === '24h') row.SD_24H = sdScaled;
  else if (sdKind === 'day') row.SD_DAY = sdScaled;
  else if (sdKind === '3hr') row.SD_HR3 = sdScaled;

  return row;
}

function parseSnowObsText(text, sdKind) {
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const row = parseSnowObsLine(raw, sdKind);
    if (row) rows.push(row);
  }
  return rows;
}

async function fetchSnowStationsText(options = {}) {
  const authKey = requireAuthKey(options);
  const tm = options.tm || '';
  const mode = options.mode != null ? options.mode : 0;
  const stn = options.stn != null ? options.stn : '';
  const help = options.help != null ? options.help : 0;
  const params = new URLSearchParams({
    mode: String(mode),
    stn: String(stn),
    help: String(help),
    authKey
  });
  if (tm) params.set('tm', tm);
  const url = `${STN_SNOW_BASE}?${params.toString()}`;
  const { status, text, raw } = await hubGet(url);
  assertHubOk(status, text, 'stn_snow.php');
  return { text, raw, url: url.replace(authKey, '{API_KEY}') };
}

async function fetchSnowStations(options = {}) {
  const { text, raw, url } = await fetchSnowStationsText(options);
  return { stations: parseStationsText(text), text, raw, url };
}

async function fetchSnowObsText(sdKind, tm, options = {}) {
  if (!SD_KINDS.includes(sdKind)) {
    throw new Error(`Invalid sd kind: ${sdKind}`);
  }
  if (!/^\d{12}$/.test(String(tm))) {
    throw new Error(`tm must be YYYYMMDDHHmm, got ${tm}`);
  }
  const authKey = requireAuthKey(options);
  const snow = options.snow != null ? options.snow : 2;
  const stn = options.stn != null ? options.stn : 0;
  const help = options.help != null ? options.help : 0;
  const params = new URLSearchParams({
    sd: sdKind,
    tm: String(tm),
    stn: String(stn),
    snow: String(snow),
    help: String(help),
    authKey
  });
  const url = `${SNOW_OBS_BASE}?${params.toString()}`;
  const { status, text, raw } = await hubGet(url);
  assertHubOk(status, text, `kma_snow1.php sd=${sdKind}`);
  return { text, raw, url: url.replace(authKey, '{API_KEY}') };
}

async function fetchSnowObs(sdKind, tm, options = {}) {
  const { text, raw, url } = await fetchSnowObsText(sdKind, tm, options);
  return { rows: parseSnowObsText(text, sdKind), text, raw, url };
}

/**
 * Merge tot + 24h rows for same TM into { STN_ID, TM, SD_TOT, SD_24H } (×10 cm).
 */
function mergeSnowObsByStation(totRows, h24Rows, tm) {
  const byId = new Map();
  for (const r of totRows || []) {
    byId.set(String(r.STN_ID), {
      STN_ID: r.STN_ID,
      TM: tm || r.TM,
      STN_NAME: r.STN_NAME,
      LAT: r.LAT,
      LON: r.LON,
      SD_TOT: r.SD_TOT != null ? r.SD_TOT : r.SD,
      SD_24H: null
    });
  }
  for (const r of h24Rows || []) {
    const key = String(r.STN_ID);
    const existing = byId.get(key);
    const sd24 = r.SD_24H != null ? r.SD_24H : r.SD;
    if (existing) {
      existing.SD_24H = sd24;
      if (!existing.STN_NAME && r.STN_NAME) existing.STN_NAME = r.STN_NAME;
    } else {
      byId.set(key, {
        STN_ID: r.STN_ID,
        TM: tm || r.TM,
        STN_NAME: r.STN_NAME,
        LAT: r.LAT,
        LON: r.LON,
        SD_TOT: null,
        SD_24H: sd24
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.STN_ID - b.STN_ID);
}

async function fetchSnowObsMerged(tm, options = {}) {
  const tot = await fetchSnowObs('tot', tm, options);
  const h24 = await fetchSnowObs('24h', tm, options);
  return {
    rows: mergeSnowObsByStation(tot.rows, h24.rows, tm),
    tot,
    h24
  };
}

module.exports = {
  STN_SNOW_BASE,
  SNOW_OBS_BASE,
  SD_KINDS,
  MISSING_LT,
  decodeHubBuffer,
  scale10Cm,
  isMissingPhysical,
  parseStationsText,
  parseSnowObsText,
  parseStationLine,
  parseSnowObsLine,
  mergeSnowObsByStation,
  fetchSnowStationsText,
  fetchSnowStations,
  fetchSnowObsText,
  fetchSnowObs,
  fetchSnowObsMerged,
  resolveAuthKey
};
