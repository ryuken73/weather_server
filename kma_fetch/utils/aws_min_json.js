const path = require('path');
const fs = require('fs/promises');

const AWS_INTERVAL_MINUTES = 2;
/** 2분 간격 기준 최대 12시간 */
const AWS_RANGE_MAX_FRAMES = 360;

function resolveLocalPath(baseDir, dir) {
  return path.isAbsolute(dir) ? dir : path.resolve(baseDir, dir);
}

/**
 * main_AWS.js 와 동일: BASE_DIR 기준으로 in_data/aws
 * AWS_JSON_DIR 이 있으면 그 경로를 우선한다.
 */
function deriveAwsJsonDir(projectRoot, env = process.env) {
  if (env.AWS_JSON_DIR) {
    return resolveLocalPath(projectRoot, env.AWS_JSON_DIR);
  }

  const base = env.BASE_DIR || './data/weather';
  const resolved = resolveLocalPath(projectRoot, base);
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

function folderDateFromTimestampKor(timestampKor) {
  return `${timestampKor.slice(0, 4)}-${timestampKor.slice(4, 6)}-${timestampKor.slice(6, 8)}`;
}

function awsMinJsonPath(awsJsonDir, timestampKor) {
  return path.join(
    awsJsonDir,
    folderDateFromTimestampKor(timestampKor),
    `AWS_MIN_${timestampKor}.json`
  );
}

function parseTimestampKor(timestampKor) {
  if (!/^\d{12}$/.test(timestampKor)) {
    const err = new Error(`Invalid timestamp format. Expected YYYYMMDDHHMM, got: ${timestampKor}`);
    err.code = 'BAD_QUERY';
    throw err;
  }
  const year = parseInt(timestampKor.slice(0, 4), 10);
  const month = parseInt(timestampKor.slice(4, 6), 10) - 1;
  const day = parseInt(timestampKor.slice(6, 8), 10);
  const hour = parseInt(timestampKor.slice(8, 10), 10);
  const minute = parseInt(timestampKor.slice(10, 12), 10);
  return new Date(year, month, day, hour, minute, 0, 0);
}

function formatTimestampKor(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes())
  );
}

function enumerateTimestamps(fromKor, toKor, intervalMinutes = AWS_INTERVAL_MINUTES) {
  const start = parseTimestampKor(fromKor);
  const end = parseTimestampKor(toKor);
  if (start.getTime() > end.getTime()) {
    const err = new Error('`from` must be less than or equal to `to`');
    err.code = 'BAD_QUERY';
    throw err;
  }

  const stepMs = intervalMinutes * 60 * 1000;
  const timestamps = [];
  for (let t = start.getTime(); t <= end.getTime(); t += stepMs) {
    timestamps.push(formatTimestampKor(new Date(t)));
    if (timestamps.length > AWS_RANGE_MAX_FRAMES) {
      const err = new Error(
        `Range too large. Max ${AWS_RANGE_MAX_FRAMES} frames at ${intervalMinutes}-minute interval`
      );
      err.code = 'BAD_QUERY';
      throw err;
    }
  }
  return timestamps;
}

async function readAwsMinFile(awsJsonDir, timestampKor) {
  const filePath = awsMinJsonPath(awsJsonDir, timestampKor);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      const err = new Error(`Invalid AWS JSON shape at ${filePath}`);
      err.code = 'BAD_DATA';
      throw err;
    }
    return {
      timestamp_kor: timestampKor,
      count: data.length,
      data,
      missing: false
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        timestamp_kor: timestampKor,
        count: 0,
        data: null,
        missing: true
      };
    }
    throw err;
  }
}

module.exports = {
  AWS_INTERVAL_MINUTES,
  AWS_RANGE_MAX_FRAMES,
  deriveAwsJsonDir,
  awsMinJsonPath,
  enumerateTimestamps,
  readAwsMinFile,
  folderDateFromTimestampKor
};
