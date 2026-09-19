/**
 * Snow data paths (in_data/sd, out_data/sd/pack)
 */
const path = require('path');
const {
  isProductionNodeEnv,
  resolveEnvPath
} = require('./aws_paths');

const PRODUCTION_SD_JSON_DIR = '/data/node_project/weather_data/in_data/sd';
const PRODUCTION_SD_PACK_DIR = '/data/node_project/weather_data/out_data/sd/pack';

function deriveSdJsonDirFromBase(projectRoot, base) {
  const resolved = resolveEnvPath(projectRoot, base);
  const normalized = path.normalize(resolved);
  const baseName = path.basename(normalized);
  if (baseName === 'in_data') return path.join(normalized, 'sd');
  if (baseName === 'out_data') return path.join(path.dirname(normalized), 'in_data', 'sd');
  return path.join(normalized, 'in_data', 'sd');
}

function deriveSdPackDirFromBase(projectRoot, base) {
  const resolved = resolveEnvPath(projectRoot, base);
  const normalized = path.normalize(resolved);
  const baseName = path.basename(normalized);
  if (baseName === 'in_data') return path.join(path.dirname(normalized), 'out_data', 'sd', 'pack');
  if (baseName === 'out_data') return path.join(normalized, 'sd', 'pack');
  return path.join(normalized, 'out_data', 'sd', 'pack');
}

function deriveSdJsonDir(projectRoot, env = process.env) {
  const override = resolveEnvPath(projectRoot, env.SD_JSON_DIR);
  if (override) return override;
  if (isProductionNodeEnv(env)) return PRODUCTION_SD_JSON_DIR;
  const base = resolveEnvPath(projectRoot, env.BASE_DIR || './data/weather');
  return deriveSdJsonDirFromBase(projectRoot, base);
}

function deriveSdPackDir(projectRoot, env = process.env) {
  const override = resolveEnvPath(projectRoot, env.SD_PACK_DIR);
  if (override) return override;
  if (isProductionNodeEnv(env)) return PRODUCTION_SD_PACK_DIR;
  const base = resolveEnvPath(projectRoot, env.BASE_DIR || './data/weather');
  return deriveSdPackDirFromBase(projectRoot, base);
}

function folderDateFromTm(tm) {
  return `${tm.slice(0, 4)}-${tm.slice(4, 6)}-${tm.slice(6, 8)}`;
}

function sdJsonPath(jsonRoot, tm) {
  return path.join(jsonRoot, folderDateFromTm(tm), `SD_${tm}.json`);
}

module.exports = {
  PRODUCTION_SD_JSON_DIR,
  PRODUCTION_SD_PACK_DIR,
  deriveSdJsonDir,
  deriveSdPackDir,
  deriveSdJsonDirFromBase,
  deriveSdPackDirFromBase,
  folderDateFromTm,
  sdJsonPath
};
