/**
 * Snow station catalog (sd_stn_code_YYYYMMDD.json)
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const CODE_FILE_RE = /^sd_stn_code_(\d{8})\.json$/;

let cached = null;

function listCodeFiles(configDir = CONFIG_DIR) {
  if (!fs.existsSync(configDir)) return [];
  return fs
    .readdirSync(configDir)
    .filter((name) => CODE_FILE_RE.test(name))
    .sort();
}

function resolveLatestCodePath(configDir = CONFIG_DIR) {
  const files = listCodeFiles(configDir);
  if (files.length === 0) {
    const err = new Error(`No sd_stn_code_YYYYMMDD.json in ${configDir}`);
    err.code = 'NO_SD_STN_CODE';
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

function loadSdStationCatalog(options = {}) {
  const configDir = options.configDir || CONFIG_DIR;
  const codePath = options.codePath || resolveLatestCodePath(configDir);
  const force = options.force === true;
  if (!force && cached && cached.codePath === codePath) return cached;
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

async function loadSdStationCatalogAsync(options = {}) {
  const configDir = options.configDir || CONFIG_DIR;
  const codePath = options.codePath || resolveLatestCodePath(configDir);
  const force = options.force === true;
  if (!force && cached && cached.codePath === codePath) return cached;
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

function getSdStationsPayload(catalog) {
  const cat = catalog || loadSdStationCatalog();
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
      STN_SP: s.STN_SP != null ? s.STN_SP : null,
      LAW_ID: s.LAW_ID != null ? s.LAW_ID : null,
      LAW_ADDR_SIDO: s.LAW_ADDR_SIDO != null ? s.LAW_ADDR_SIDO : null,
      LAW_ADDR_GUGUN: s.LAW_ADDR_GUGUN != null ? s.LAW_ADDR_GUGUN : null,
      addrSource: s.addrSource != null ? s.addrSource : null
    }))
  };
}

function clearSdStationCatalogCache() {
  cached = null;
}

module.exports = {
  CONFIG_DIR,
  resolveLatestCodePath,
  listCodeFiles,
  loadSdStationCatalog,
  loadSdStationCatalogAsync,
  getSdStationsPayload,
  clearSdStationCatalogCache
};
