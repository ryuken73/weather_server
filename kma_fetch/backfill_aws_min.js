/**
 * AWS_MIN JSON 일 단위 backfill (1분 슬롯 1,440개/일)
 *
 * main_AWS.js 와 동일한 경로 규칙:
 *   {resolveBaseDir('in_data')}/aws/{yyyy-MM-dd}/AWS_MIN_{yyyyMMddHHmm}.json
 *
 * 사용 예:
 *   node kma_fetch/backfill_aws_min.js 20260810
 *   node kma_fetch/backfill_aws_min.js 2026-08-10 --dry-run
 *   AWS_FETCH_SOURCE=auto NODE_ENV=production node kma_fetch/backfill_aws_min.js 20260810 --sleep 200
 *
 * 옵션:
 *   --dry-run   DB/Hub 조회/저장 없이 누락 목록만 출력
 *   --sleep N   저장 성공 후 대기 ms (기본 200)
 *
 * env AWS_FETCH_SOURCE=auto|db|hub (기본 auto: DB 후 Hub)
 */

const path = require('path');
const { DateTime } = require('luxon');
const db = require('./utils/db');
const sql = require('mssql');
const file = require('./utils/file');
const time = require('./utils/time');
const env = require('./config/env');
const { TIMEZONE } = env;
const { patchAwsRowsForSave, loadStationCatalog } = require('./utils/aws_stn_catalog');
const { fetchAwsMinRowsFromHub } = require('./services/aws_apihub_min');

const AWS_DATA_ROOT = 'in_data';
const AWS_FILE_OPTIONS = { dataRoot: AWS_DATA_ROOT };
const SUB_DIR = 'aws';
const PATTERN_BASE = 'AWS_MIN_';
const INTERVAL_MINUTES = 1;
const SLOTS_PER_DAY = (24 * 60) / INTERVAL_MINUTES; // 1440
const AWS_FETCH_SOURCE = (process.env.AWS_FETCH_SOURCE || 'auto').toLowerCase();

async function fetchRowsForTm(tm, pool, stnCatalog) {
  if (AWS_FETCH_SOURCE === 'hub') {
    return fetchAwsMinRowsFromHub(tm, { catalog: stnCatalog });
  }
  if (pool && (AWS_FETCH_SOURCE === 'db' || AWS_FETCH_SOURCE === 'auto')) {
    const result = await pool.request().input('tm', sql.VarChar, tm).query(db.sqls.queryAwsMin);
    if (result.recordset && result.recordset.length > 0) return result.recordset;
    if (AWS_FETCH_SOURCE === 'db') return [];
  }
  try {
    return await fetchAwsMinRowsFromHub(tm, { catalog: stnCatalog });
  } catch (err) {
    if (err.code === 'NO_API_KEY') return [];
    throw err;
  }
}

function usage() {
  console.log(`Usage: node kma_fetch/backfill_aws_min.js <YYYYMMDD|YYYY-MM-DD> [--dry-run] [--sleep ms]

Path (same as main_AWS.js):
  \${resolveBaseDir('in_data')}/aws/{yyyy-MM-dd}/AWS_MIN_{yyyyMMddHHmm}.json
  BASE_DIR=${env.BASE_DIR}
`);
}

function parseArgs(argv) {
  const args = { date: null, dryRun: false, sleepMs: 200 };
  for (const a of argv) {
    if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (a.startsWith('--sleep=')) {
      args.sleepMs = Number(a.slice('--sleep='.length));
    } else if (a === '--sleep') {
      args._sleepNext = true;
    } else if (args._sleepNext) {
      args.sleepMs = Number(a);
      args._sleepNext = false;
    } else if (!a.startsWith('-') && !args.date) {
      args.date = a;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  delete args._sleepNext;
  return args;
}

/** @returns {{ yyyymmdd: string, folderDate: string }} */
function normalizeDay(input) {
  const compact = String(input).replace(/-/g, '');
  if (!/^\d{8}$/.test(compact)) {
    throw new Error(`Invalid date. Expected YYYYMMDD or YYYY-MM-DD, got: ${input}`);
  }
  const dt = DateTime.fromFormat(compact, 'yyyyMMdd', { zone: TIMEZONE });
  if (!dt.isValid) {
    throw new Error(`Invalid calendar date: ${input} (${dt.invalidExplanation})`);
  }
  return {
    yyyymmdd: compact,
    folderDate: dt.toFormat('yyyy-MM-dd')
  };
}

function enumerateDayTimestamps(yyyymmdd) {
  const list = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += INTERVAL_MINUTES) {
      list.push(
        yyyymmdd +
          String(h).padStart(2, '0') +
          String(m).padStart(2, '0')
      );
    }
  }
  if (list.length !== SLOTS_PER_DAY) {
    throw new Error(`Expected ${SLOTS_PER_DAY} slots, got ${list.length}`);
  }
  return list;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildFilePath(folderDate, tm) {
  // file.resolveBaseDir('in_data')/aws/yyyy-MM-dd/AWS_MIN_tm.json
  return path.join(
    file.resolveBaseDir(AWS_DATA_ROOT),
    SUB_DIR,
    folderDate,
    `${PATTERN_BASE}${tm}.json`
  );
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    usage();
    process.exit(1);
  }

  if (args.help || !args.date) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  if (!Number.isFinite(args.sleepMs) || args.sleepMs < 0) {
    console.error('Invalid --sleep value');
    process.exit(1);
  }

  const { yyyymmdd, folderDate } = normalizeDay(args.date);
  const timestamps = enumerateDayTimestamps(yyyymmdd);
  const dayDir = path.join(file.resolveBaseDir(AWS_DATA_ROOT), SUB_DIR, folderDate);

  console.log('=== AWS_MIN backfill ===');
  console.log('NODE_ENV    :', env.NODE_ENV);
  console.log('BASE_DIR    :', env.BASE_DIR);
  console.log('resolveRoot :', file.resolveBaseDir(AWS_DATA_ROOT));
  console.log('TIMEZONE    :', TIMEZONE);
  console.log('day         :', folderDate, `(${yyyymmdd})`);
  console.log('day dir     :', dayDir);
  console.log('example     :', buildFilePath(folderDate, timestamps[0]));
  console.log('slots       :', timestamps.length);
  console.log('dry-run     :', args.dryRun);
  console.log('sleepMs     :', args.sleepMs);

  // 하루 폴더를 한 번만 스캔 (main_AWS listFiles 와 동일 경로)
  const existingFiles = await file.listFiles(
    folderDate,
    TIMEZONE,
    SUB_DIR,
    AWS_FILE_OPTIONS
  );
  const existingSet = new Set(
    existingFiles.filter((name) => new RegExp(`^${PATTERN_BASE}\\d{12}\\.json$`).test(name))
  );

  const missing = [];
  for (const tm of timestamps) {
    const saveFilename = `${PATTERN_BASE}${tm}.json`;
    const dateStringForFolder = time.getDateString(tm);
    if (dateStringForFolder !== folderDate) {
      throw new Error(`Folder mismatch for ${tm}: ${dateStringForFolder} !== ${folderDate}`);
    }
    if (!existingSet.has(saveFilename)) {
      missing.push({
        tm,
        saveFilename,
        filePath: buildFilePath(folderDate, tm)
      });
    }
  }

  console.log('existing    :', timestamps.length - missing.length);
  console.log('missing     :', missing.length);

  if (missing.length === 0) {
    console.log('Nothing to backfill.');
    return;
  }

  if (args.dryRun) {
    console.log('--- missing timestamps (dry-run) ---');
    for (const item of missing) {
      console.log(item.tm, '->', item.filePath);
    }
    return;
  }

  console.log('AWS_FETCH_SOURCE:', AWS_FETCH_SOURCE);

  let pool = null;
  if (AWS_FETCH_SOURCE === 'db' || AWS_FETCH_SOURCE === 'auto') {
    try {
      pool = await db.connect();
    } catch (err) {
      if (AWS_FETCH_SOURCE === 'db') throw err;
      console.warn('DB connect failed; Hub-only backfill:', err.message);
    }
  }
  const stnCatalog = loadStationCatalog();
  const summary = { saved: 0, noData: 0, skippedExists: 0, errors: 0 };

  try {
    for (const item of missing) {
      const { tm, saveFilename, filePath } = item;
      const dateStringForFolder = time.getDateString(tm);
      try {
        const [existsNow] = await file.isFileExists(
          saveFilename,
          dateStringForFolder,
          SUB_DIR,
          AWS_FILE_OPTIONS
        );
        if (existsNow) {
          console.log('skip (exists now)', tm, filePath);
          summary.skippedExists += 1;
          continue;
        }

        console.log('backfill try', tm, '->', filePath);
        const rawRows = await fetchRowsForTm(tm, pool, stnCatalog);
        const jsonData = patchAwsRowsForSave(rawRows, stnCatalog);

        if (!jsonData || jsonData.length === 0) {
          console.log('no data to save.', tm);
          summary.noData += 1;
          continue;
        }

        console.log('data to save. length =', jsonData.length, tm);
        const savedPath = await file.saveFile(
          JSON.stringify(jsonData),
          saveFilename,
          dateStringForFolder,
          SUB_DIR,
          false,
          false,
          AWS_FILE_OPTIONS
        );
        console.log('File saved!', savedPath);
        summary.saved += 1;
        if (args.sleepMs > 0) {
          await sleep(args.sleepMs);
        }
      } catch (err) {
        console.error('backfill error', tm, err);
        summary.errors += 1;
      }
    }
  } finally {
    if (pool) await pool.close();
  }

  console.log('=== summary ===');
  console.log(summary);
  if (summary.errors > 0) {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
