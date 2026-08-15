/**
 * KMA API Hub nph-aws2_min → main_AWS/MSSQL JSON shape
 * (work/fetch_aws_apihub.js 와 동일 계약, kma_fetch에서 재사용)
 */
const axios = require('axios');
const { loadStationCatalog } = require('../utils/aws_stn_catalog');

const API_BASE = 'https://apihub-pub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min';
const MISSING_LT = -50;

function scale10(v) {
  if (v == null || Number.isNaN(v)) return null;
  if (v <= MISSING_LT) return null;
  return Math.round(v * 10);
}

function isMissing(v) {
  return v == null || Number.isNaN(v) || v <= MISSING_LT;
}

function apiRowToDbShape(parts, nameById, stnMeta) {
  const tm = parts[0];
  const stnId = Number(parts[1]);
  const meta = stnMeta.get(String(stnId)) || {};
  const wd1 = Number(parts[2]);
  const ws1 = Number(parts[3]);
  const wds = Number(parts[4]);
  const wss = Number(parts[5]);
  const ta = Number(parts[8]);
  const re = Number(parts[9]);
  const rn15 = Number(parts[10]);
  const rn60 = Number(parts[11]);
  const rn12 = Number(parts[12]); // RN-12H
  const rnDay = Number(parts[13]); // RN-DAY
  const hm = Number(parts[14]);
  const pa = Number(parts[15]);
  const ps = Number(parts[16]);
  const td = parts.length > 17 ? Number(parts[17]) : NaN;
  const rn60Scaled = scale10(rn60);

  return {
    STN_NAME: nameById[String(stnId)] == null ? null : nameById[String(stnId)],
    STN_ID: stnId,
    TM: tm,
    LAT: meta.LAT != null ? meta.LAT : null,
    LON: meta.LON != null ? meta.LON : null,
    HT: meta.HT != null ? meta.HT : null,
    WD: scale10(wd1),
    WS: scale10(ws1),
    TA: scale10(ta),
    HM: scale10(hm),
    PA: scale10(pa),
    PS: scale10(ps),
    TD: scale10(td),
    RN_YN: isMissing(re) ? null : re === 0 ? 0 : 1,
    // RN_1HR is an alias of RN-60m (not a distinct Hub field). Keep for JSON consumers; pack uses RN_60M.
    RN_1HR: rn60Scaled,
    RN_6HR: null,
    RN_12HR: scale10(rn12),
    RN_24HR: scale10(rnDay),
    RN_48HR: null,
    RN_15M: scale10(rn15),
    RN_60M: rn60Scaled,
    WD_INS: scale10(wds),
    WS_INS: scale10(wss)
  };
}

function parseApiText(text) {
  const byTm = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^YYMMDDHHMI/i.test(line) || /^KST\b/i.test(line)) continue;
    const parts = line.split(/[,\s]+/).filter(Boolean);
    if (parts.length < 17) continue;
    if (!/^\d{12}$/.test(parts[0])) continue;
    if (!/^\d+$/.test(parts[1])) continue;
    const tm = parts[0];
    if (!byTm.has(tm)) byTm.set(tm, []);
    byTm.get(tm).push(parts);
  }
  return byTm;
}

async function fetchAwsApiHubWindow(authKey, tm1, tm2) {
  const url = `${API_BASE}?tm1=${tm1}&tm2=${tm2}&stn=0&disp=0&help=0&authKey=${encodeURIComponent(authKey)}`;
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 120000,
    validateStatus: () => true
  });
  const text = Buffer.from(res.data).toString('utf8');
  if (res.status !== 200) {
    const err = new Error(`API Hub HTTP ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  if (/인증|authKey|Unauthorized|오류|error/i.test(text) && !/\d{12}\s+\d+/.test(text)) {
    throw new Error(`API Hub error body: ${text.slice(0, 300)}`);
  }
  return text;
}

/**
 * 단일 시각(또는 짧은 창) Hub → DB shape rows (해당 tm만)
 */
async function fetchAwsMinRowsFromHub(tm, options = {}) {
  const authKey = options.authKey || process.env.API_KEY || process.env.KMA_API_KEY;
  if (!authKey) {
    const err = new Error('API_KEY (or KMA_API_KEY) required for Hub fetch');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const catalog = options.catalog || loadStationCatalog();
  const nameById = {};
  for (const s of catalog.stations) {
    nameById[String(s.STN_ID)] = s.STN_NAME;
  }
  const stnMeta = catalog.byId;

  const text = await fetchAwsApiHubWindow(authKey, tm, tm);
  const byTm = parseApiText(text);
  const partsList = byTm.get(tm) || [];
  return partsList.map((p) => apiRowToDbShape(p, nameById, stnMeta));
}

module.exports = {
  API_BASE,
  parseApiText,
  apiRowToDbShape,
  fetchAwsApiHubWindow,
  fetchAwsMinRowsFromHub
};
