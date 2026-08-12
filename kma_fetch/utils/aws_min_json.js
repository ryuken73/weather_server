const path = require('path');
const fs = require('fs/promises');

const AWS_INTERVAL_MINUTES = 2;
/** 2분 간격 기준 최대 12시간 */
const AWS_RANGE_MAX_FRAMES = 360;
/** parsed JSON LRU. 5일×360 frame 대비 기본 2500 */
const AWS_FILE_CACHE_MAX = Number(process.env.AWS_JSON_CACHE_MAX || 2500);
const AWS_READ_CONCURRENCY = Number(process.env.AWS_READ_CONCURRENCY || 24);
/** 과거 range stringify 결과. 24개 × ~8MB ≈ 200MB 상한 */
const AWS_RANGE_CACHE_MAX = Number(process.env.AWS_RANGE_CACHE_MAX || 24);

const awsFileCache = new Map();
const awsRangePayloadCache = new Map();

function cacheGet(filePath, mtimeMs) {
  const hit = awsFileCache.get(filePath);
  if (!hit || hit.mtimeMs !== mtimeMs) return null;
  awsFileCache.delete(filePath);
  awsFileCache.set(filePath, hit);
  return hit.data;
}

function cacheSet(filePath, mtimeMs, data) {
  if (awsFileCache.size >= AWS_FILE_CACHE_MAX) {
    const oldest = awsFileCache.keys().next().value;
    awsFileCache.delete(oldest);
  }
  awsFileCache.set(filePath, { mtimeMs, data });
}

async function mapLimit(items, limit, fn) {
  const n = items.length;
  const out = new Array(n);
  if (n === 0) return out;
  const concurrency = Math.max(1, Math.min(limit, n));
  let next = 0;
  async function worker() {
    while (next < n) {
      const idx = next;
      next += 1;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}

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

function enumerateTimestamps(
  fromKor,
  toKor,
  intervalMinutes = AWS_INTERVAL_MINUTES,
  maxFrames = AWS_RANGE_MAX_FRAMES
) {
  const start = parseTimestampKor(fromKor);
  const end = parseTimestampKor(toKor);
  if (start.getTime() > end.getTime()) {
    const err = new Error('`from` must be less than or equal to `to`');
    err.code = 'BAD_QUERY';
    throw err;
  }

  const stepMs = intervalMinutes * 60 * 1000;
  const limit = Number.isFinite(maxFrames) && maxFrames > 0 ? maxFrames : AWS_RANGE_MAX_FRAMES;
  const timestamps = [];
  for (let t = start.getTime(); t <= end.getTime(); t += stepMs) {
    timestamps.push(formatTimestampKor(new Date(t)));
    if (timestamps.length > limit) {
      const err = new Error(
        `Range too large. Max ${limit} frames at ${intervalMinutes}-minute interval`
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
    const st = await fs.stat(filePath);
    const cached = cacheGet(filePath, st.mtimeMs);
    if (cached) {
      return {
        timestamp_kor: timestampKor,
        count: cached.length,
        data: cached,
        missing: false
      };
    }
    const raw = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      const err = new Error(`Invalid AWS JSON shape at ${filePath}`);
      err.code = 'BAD_DATA';
      throw err;
    }
    cacheSet(filePath, st.mtimeMs, data);
    return {
      timestamp_kor: timestampKor,
      count: data.length,
      data,
      missing: false
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      awsFileCache.delete(filePath);
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

async function readAwsMinFiles(awsJsonDir, timestamps, options = {}) {
  const concurrency = options.concurrency || AWS_READ_CONCURRENCY;
  return mapLimit(timestamps, concurrency, (tm) => readAwsMinFile(awsJsonDir, tm));
}

function kstYmdNow() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
    .format(new Date())
    .replace(/-/g, '');
}

/** to 시각의 날짜가 오늘(KST)보다 이전이면 과거 완결 구간으로 본다 */
function isPastAwsRange(toSnap) {
  return String(toSnap).slice(0, 8) < kstYmdNow();
}

function awsRangeCacheKey(fromSnap, toSnap, skipEnrich) {
  return `${fromSnap}:${toSnap}:${skipEnrich ? '0' : '1'}`;
}

function getAwsRangePayload(key) {
  const hit = awsRangePayloadCache.get(key);
  if (!hit) return null;
  awsRangePayloadCache.delete(key);
  awsRangePayloadCache.set(key, hit);
  return hit;
}

function setAwsRangePayload(key, body) {
  while (awsRangePayloadCache.size >= AWS_RANGE_CACHE_MAX) {
    const oldest = awsRangePayloadCache.keys().next().value;
    awsRangePayloadCache.delete(oldest);
  }
  const etag = `"${key}:${body.length}"`;
  awsRangePayloadCache.set(key, { body, etag });
  return { body, etag };
}

module.exports = {
  AWS_INTERVAL_MINUTES,
  AWS_RANGE_MAX_FRAMES,
  AWS_READ_CONCURRENCY,
  deriveAwsJsonDir,
  awsMinJsonPath,
  enumerateTimestamps,
  readAwsMinFile,
  readAwsMinFiles,
  folderDateFromTimestampKor,
  isPastAwsRange,
  awsRangeCacheKey,
  getAwsRangePayload,
  setAwsRangePayload
};
