/**
 * AWS 지점 코드표 (stn_inf 기반 aws_stn_code_YYYYMMDD.json)
 * - 쓰기 경로: STN_NAME 패치만 (LAW_* 는 디스크 JSON에 넣지 않음)
 * - HTTP: /api/aws/stations + /api/aws/min enrich
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const CODE_FILE_RE = /^aws_stn_code_(\d{8})\.json$/;

let cached = null;

function listCodeFiles(configDir = CONFIG_DIR) {
  return fs
    .readdirSync(configDir)
    .filter((name) => CODE_FILE_RE.test(name))
    .sort();
}

/** 날짜 suffix가 가장 큰 aws_stn_code_*.json */
function resolveLatestCodePath(configDir = CONFIG_DIR) {
  const files = listCodeFiles(configDir);
  if (files.length === 0) {
    const err = new Error(`No aws_stn_code_YYYYMMDD.json in ${configDir}`);
    err.code = 'NO_STN_CODE';
    throw err;
  }
  return path.join(configDir, files[files.length - 1]);
}

function buildMaps(codeDoc) {
  const byId = new Map();
  for (const stn of codeDoc.stations || []) {
    byId.set(String(stn.STN_ID), stn);
  }
  return {
    source: codeDoc.source || null,
    generatedAt: codeDoc.generatedAt || null,
    schemaVersion: codeDoc.schemaVersion || null,
    stationCount: byId.size,
    byId
  };
}

function loadStationCatalog(options = {}) {
  const configDir = options.configDir || CONFIG_DIR;
  const codePath = options.codePath || resolveLatestCodePath(configDir);
  const force = options.force === true;

  if (!force && cached && cached.codePath === codePath) {
    return cached;
  }

  const codeDoc = JSON.parse(fs.readFileSync(codePath, 'utf8'));
  const maps = buildMaps(codeDoc);
  cached = {
    codePath,
    codeFile: path.basename(codePath),
    ...maps,
    stations: codeDoc.stations || []
  };
  return cached;
}

async function loadStationCatalogAsync(options = {}) {
  const configDir = options.configDir || CONFIG_DIR;
  const codePath = options.codePath || resolveLatestCodePath(configDir);
  const force = options.force === true;

  if (!force && cached && cached.codePath === codePath) {
    return cached;
  }

  const codeDoc = JSON.parse(await fsp.readFile(codePath, 'utf8'));
  const maps = buildMaps(codeDoc);
  cached = {
    codePath,
    codeFile: path.basename(codePath),
    ...maps,
    stations: codeDoc.stations || []
  };
  return cached;
}

/**
 * @param {object[]} rows
 * @param {object} [opts]
 * @param {boolean} [opts.patchName=true]
 * @param {boolean} [opts.attachLawAddr=false]  HTTP enrich 전용. 디스크 저장 시 false
 * @param {ReturnType<typeof loadStationCatalog>} [opts.catalog]
 */
function enrichAwsRows(rows, opts = {}) {
  if (!Array.isArray(rows)) return rows;
  const catalog = opts.catalog || loadStationCatalog();
  const patchName = opts.patchName !== false;
  const attachLawAddr = opts.attachLawAddr === true;

  return rows.map((row) => {
    const id = row && row.STN_ID != null ? String(row.STN_ID) : null;
    const meta = id ? catalog.byId.get(id) : null;
    if (!meta) {
      if (!attachLawAddr) return row;
      return {
        ...row,
        LAW_ADDR_SIDO: null,
        LAW_ADDR_GUGUN: null
      };
    }

    const next = { ...row };
    if (patchName && meta.STN_NAME != null) {
      next.STN_NAME = meta.STN_NAME;
    }
    if (attachLawAddr) {
      next.LAW_ADDR_SIDO = meta.LAW_ADDR_SIDO != null ? meta.LAW_ADDR_SIDO : null;
      next.LAW_ADDR_GUGUN = meta.LAW_ADDR_GUGUN != null ? meta.LAW_ADDR_GUGUN : null;
    }
    return next;
  });
}

/** 디스크 저장용: STN_NAME만 코드표로 덮어씀 */
function patchAwsRowsForSave(rows, catalog) {
  return enrichAwsRows(rows, {
    catalog: catalog || loadStationCatalog(),
    patchName: true,
    attachLawAddr: false
  });
}

/** HTTP /api/aws/min 응답용 */
function enrichAwsRowsForHttp(rows, catalog) {
  return enrichAwsRows(rows, {
    catalog: catalog || loadStationCatalog(),
    patchName: true,
    attachLawAddr: true
  });
}

function getStationsPayload(catalog) {
  const cat = catalog || loadStationCatalog();
  return {
    source: cat.source,
    generatedAt: cat.generatedAt,
    schemaVersion: cat.schemaVersion,
    codeFile: cat.codeFile,
    stationCount: cat.stationCount,
    stations: cat.stations.map((s) => ({
      STN_ID: s.STN_ID,
      STN_NAME: s.STN_NAME,
      LAT: s.LAT,
      LON: s.LON,
      HT: s.HT,
      LAW_ADDR_SIDO: s.LAW_ADDR_SIDO != null ? s.LAW_ADDR_SIDO : null,
      LAW_ADDR_GUGUN: s.LAW_ADDR_GUGUN != null ? s.LAW_ADDR_GUGUN : null
    }))
  };
}

module.exports = {
  CONFIG_DIR,
  resolveLatestCodePath,
  loadStationCatalog,
  loadStationCatalogAsync,
  enrichAwsRows,
  patchAwsRowsForSave,
  enrichAwsRowsForHttp,
  getStationsPayload
};
