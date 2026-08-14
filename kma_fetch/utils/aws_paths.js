const path = require('path');

/** 운영 고정: AWS_MIN JSON (fetch / backfill) */
const PRODUCTION_AWS_JSON_DIR = '/data/node_project/weather_data/in_data/aws';

/** 운영 고정: TA pack (server static /datasets/aws/...) */
const PRODUCTION_AWS_PACK_DIR =
  '/data/node_project/weather_server/data/weather/out_data/aws/pack';

function isProductionNodeEnv(env = process.env) {
  const mode = String(env.NODE_ENV || '').toLowerCase();
  return mode === 'production' || mode === 'prod';
}

function resolveEnvPath(projectRoot, dir) {
  if (!dir) return null;
  return path.isAbsolute(dir) ? dir : path.resolve(projectRoot, dir);
}

function deriveAwsJsonDirFromBase(projectRoot, base) {
  const resolved = resolveEnvPath(projectRoot, base);
  const normalized = path.normalize(resolved);
  const baseName = path.basename(normalized);

  if (baseName === 'in_data') {
    return path.join(normalized, 'aws');
  }
  if (baseName === 'out_data') {
    return path.join(path.dirname(normalized), 'in_data', 'aws');
  }
  return path.join(normalized, 'in_data', 'aws');
}

function deriveAwsPackDirFromBase(projectRoot, base) {
  const resolved = resolveEnvPath(projectRoot, base);
  const normalized = path.normalize(resolved);
  const baseName = path.basename(normalized);

  if (baseName === 'in_data') {
    return path.join(path.dirname(normalized), 'out_data', 'aws', 'pack');
  }
  if (baseName === 'out_data') {
    return path.join(normalized, 'aws', 'pack');
  }
  return path.join(normalized, 'out_data', 'aws', 'pack');
}

module.exports = {
  PRODUCTION_AWS_JSON_DIR,
  PRODUCTION_AWS_PACK_DIR,
  isProductionNodeEnv,
  resolveEnvPath,
  deriveAwsJsonDirFromBase,
  deriveAwsPackDirFromBase
};
