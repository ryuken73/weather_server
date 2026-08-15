/**
 * AWS_MIN JSON 일 단위 backfill (1분 슬롯 1,440개/일)
 *
 * JSON 경로: deriveAwsJsonDir() — 운영 고정
 *   /data/node_project/weather_data/in_data/aws/{yyyy-MM-dd}/AWS_MIN_{yyyyMMddHHmm}.json
 * Pack 경로: deriveAwsPackDir()
 *
 * 사용 예:
 *   node kma_fetch/backfill_aws_min.js 20260810
 *   node kma_fetch/backfill_aws_min.js --from 20260801 --to 20260813 --refresh-fields RN_12HR --skip-pack
 *   AWS_FETCH_SOURCE=hub node kma_fetch/backfill_aws_min.js --from 20260801 --to 20260813 --force-refetch
 *
 * 옵션:
 *   --dry-run          조회/저장 없이 대상 목록만 출력
 *   --sleep N          저장 성공 후 대기 ms (기본 200)
 *   --skip-pack        pack 워밍 생략
 *   --variables LIST   종료 후 워밍할 pack 변수 (기본: 지원 변수 전부)
 *   --refresh-fields F 기존 JSON이 있어도 필드가 null이면 Hub 재수집 (예: RN_12HR,TD)
 *   --force-refetch    기존 JSON을 Hub 응답으로 atomic 교체
 *
 * env AWS_FETCH_SOURCE=auto|db|hub (기본 auto: DB 후 Hub)
 * --refresh-fields / --force-refetch 는 Hub만 사용한다.
 */

const path = require('path');
const fsp = require('fs/promises');
const fs = require('fs');
const { DateTime } = require('luxon');
const db = require('./utils/db');
const sql = require('mssql');
const env = require('./config/env');
const { TIMEZONE } = env;
const { patchAwsRowsForSave, loadStationCatalog } = require('./utils/aws_stn_catalog');
const { fetchAwsMinRowsFromHub } = require('./services/aws_apihub_min');
const { deriveAwsJsonDir } = require('./utils/aws_min_json');
const {
  deriveAwsPackDir,
  warmAwsDayPack,
  parsePackVariables,
  SUPPORTED_PACK_VARIABLES
} = require('./utils/aws_min_pack');

const PROJECT_ROOT = path.join(__dirname, '..');

const PATTERN_BASE = 'AWS_MIN_';
const INTERVAL_MINUTES = 1;
const SLOTS_PER_DAY = (24 * 60) / INTERVAL_MINUTES;
const AWS_FETCH_SOURCE = (process.env.AWS_FETCH_SOURCE || 'auto').toLowerCase();
const REFRESHABLE_FIELDS = Object.freeze(['RN_12HR', 'TD']);

async function fetchRowsForTm(tm, pool, stnCatalog, source) {
  if (source === 'hub') {
    return fetchAwsMinRowsFromHub(tm, { catalog: stnCatalog });
  }
  if (pool && (source === 'db' || source === 'auto')) {
    const result = await pool.request().input('tm', sql.VarChar, tm).query(db.sqls.queryAwsMin);
    if (result.recordset && result.recordset.length > 0) return result.recordset;
    if (source === 'db') return [];
  }
  try {
    return await fetchAwsMinRowsFromHub(tm, { catalog: stnCatalog });
  } catch (err) {
    if (err.code === 'NO_API_KEY') return [];
    throw err;
  }
}

function usage() {
  const awsJsonDir = deriveAwsJsonDir(PROJECT_ROOT);
  const awsPackDir = deriveAwsPackDir(PROJECT_ROOT);
  console.log(`Usage:
  node kma_fetch/backfill_aws_min.js <YYYYMMDD|YYYY-MM-DD> [options]
  node kma_fetch/backfill_aws_min.js --from YYYYMMDD --to YYYYMMDD [options]

Options:
  --dry-run
  --sleep ms
  --skip-pack
  --variables TA,RN_15M,RN_60M,RN_12HR,RN_24HR   (default: all)
  --refresh-fields RN_12HR,TD
  --force-refetch

JSON: ${awsJsonDir}/{yyyy-MM-dd}/AWS_MIN_{yyyyMMddHHmm}.json
Pack: ${awsPackDir}/{slug}/1m/{YYYYMMDD}/
Supported pack variables: ${SUPPORTED_PACK_VARIABLES.join(', ')}
NODE_ENV=${env.NODE_ENV} BASE_DIR=${env.BASE_DIR}
`);
}

function takeValue(argv, i, flag) {
  const next = argv[i + 1];
  if (!next || next.startsWith('-')) throw new Error(`${flag} requires a value`);
  return next;
}

function parseArgs(argv) {
  const args = {
    date: null,
    from: null,
    to: null,
    dryRun: false,
    skipPack: false,
    forceRefetch: false,
    refreshFields: [],
    variables: [...SUPPORTED_PACK_VARIABLES],
    sleepMs: 200,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--skip-pack') args.skipPack = true;
    else if (a === '--force-refetch') args.forceRefetch = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--from') {
      args.from = takeValue(argv, i, '--from');
      i += 1;
    } else if (a.startsWith('--from=')) args.from = a.slice('--from='.length);
    else if (a === '--to') {
      args.to = takeValue(argv, i, '--to');
      i += 1;
    } else if (a.startsWith('--to=')) args.to = a.slice('--to='.length);
    else if (a === '--variables') {
      args.variables = parsePackVariables(takeValue(argv, i, '--variables'));
      i += 1;
    } else if (a.startsWith('--variables=')) {
      args.variables = parsePackVariables(a.slice('--variables='.length));
    } else if (a === '--refresh-fields') {
      args.refreshFields = parseRefreshFields(takeValue(argv, i, '--refresh-fields'));
      i += 1;
    } else if (a.startsWith('--refresh-fields=')) {
      args.refreshFields = parseRefreshFields(a.slice('--refresh-fields='.length));
    } else if (a.startsWith('--sleep=')) {
      args.sleepMs = Number(a.slice('--sleep='.length));
    } else if (a === '--sleep') {
      args.sleepMs = Number(takeValue(argv, i, '--sleep'));
      i += 1;
    } else if (!a.startsWith('-') && !args.date) {
      args.date = a;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function parseRefreshFields(raw) {
  const fields = String(raw)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  for (const f of fields) {
    if (!REFRESHABLE_FIELDS.includes(f)) {
      throw new Error(`Unsupported --refresh-fields: ${f}. Supported: ${REFRESHABLE_FIELDS.join(', ')}`);
    }
  }
  return fields;
}

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

function enumerateDaysInclusive(fromYmd, toYmd) {
  let cur = DateTime.fromFormat(fromYmd, 'yyyyMMdd', { zone: TIMEZONE }).startOf('day');
  const end = DateTime.fromFormat(toYmd, 'yyyyMMdd', { zone: TIMEZONE }).startOf('day');
  if (cur > end) throw new Error(`\`from\` must be <= \`to\` (${fromYmd} > ${toYmd})`);
  const days = [];
  while (cur <= end) {
    days.push({
      yyyymmdd: cur.toFormat('yyyyMMdd'),
      folderDate: cur.toFormat('yyyy-MM-dd')
    });
    cur = cur.plus({ days: 1 });
  }
  return days;
}

function resolveDays(args) {
  if (args.from != null || args.to != null) {
    if (args.date) throw new Error('Use either a single date or --from/--to, not both');
    if (args.from == null || args.to == null) throw new Error('Both --from and --to are required for a range');
    return enumerateDaysInclusive(normalizeDay(args.from).yyyymmdd, normalizeDay(args.to).yyyymmdd);
  }
  if (args.date) return [normalizeDay(args.date)];
  throw new Error('Specify a date or --from/--to');
}

function enumerateDayTimestamps(yyyymmdd) {
  const list = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += INTERVAL_MINUTES) {
      list.push(yyyymmdd + String(h).padStart(2, '0') + String(m).padStart(2, '0'));
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

function buildFilePath(awsJsonDir, folderDate, tm) {
  return path.join(awsJsonDir, folderDate, `${PATTERN_BASE}${tm}.json`);
}

async function listDayJsonFiles(awsJsonDir, folderDate) {
  const dayDir = path.join(awsJsonDir, folderDate);
  try {
    return await fsp.readdir(dayDir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function ensureParentDir(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

async function atomicWriteJson(filePath, data) {
  await ensureParentDir(filePath);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data), 'utf8');
  await fsp.rename(tmp, filePath);
}

function hasValidField(rows, field) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  return rows.some((row) => {
    if (!row || row[field] == null || row[field] === '') return false;
    const n = Number(row[field]);
    return Number.isFinite(n) && n >= 0;
  });
}

async function readExistingRows(filePath) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
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

  if (args.help) {
    usage();
    process.exit(0);
  }

  let days;
  try {
    days = resolveDays(args);
  } catch (err) {
    console.error(err.message);
    usage();
    process.exit(1);
  }

  if (!Number.isFinite(args.sleepMs) || args.sleepMs < 0) {
    console.error('Invalid --sleep value');
    process.exit(1);
  }

  const awsJsonDir = deriveAwsJsonDir(PROJECT_ROOT);
  const awsPackDir = deriveAwsPackDir(PROJECT_ROOT);
  const refreshMode = args.refreshFields.length > 0 || args.forceRefetch;
  const fetchSource = refreshMode ? 'hub' : AWS_FETCH_SOURCE;

  console.log('=== AWS_MIN backfill ===');
  console.log('NODE_ENV    :', env.NODE_ENV);
  console.log('BASE_DIR    :', env.BASE_DIR);
  console.log('AWS JSON DIR:', awsJsonDir);
  console.log('AWS PACK DIR:', awsPackDir);
  console.log('days        :', days.length, days[0].yyyymmdd, '→', days[days.length - 1].yyyymmdd);
  console.log('dry-run     :', args.dryRun);
  console.log('skip-pack   :', args.skipPack);
  console.log('variables   :', args.variables.join(','));
  console.log('refresh     :', args.refreshFields.join(',') || '-');
  console.log('forceRefetch:', args.forceRefetch);
  console.log('sleepMs     :', args.sleepMs);
  console.log('FETCH_SOURCE:', fetchSource, refreshMode && AWS_FETCH_SOURCE !== 'hub' ? `(forced hub; env was ${AWS_FETCH_SOURCE})` : '');

  const totals = {
    saved: 0,
    refreshed: 0,
    skippedExists: 0,
    skippedFresh: 0,
    noData: 0,
    errors: 0
  };

  if (args.dryRun) {
    for (const day of days) {
      const timestamps = enumerateDayTimestamps(day.yyyymmdd);
      const existing = new Set(
        (await listDayJsonFiles(awsJsonDir, day.folderDate)).filter((n) =>
          new RegExp(`^${PATTERN_BASE}\\d{12}\\.json$`).test(n)
        )
      );
      let missing = 0;
      for (const tm of timestamps) {
        if (!existing.has(`${PATTERN_BASE}${tm}.json`)) missing += 1;
      }
      console.log(
        day.folderDate,
        'existing=',
        timestamps.length - missing,
        'missing=',
        missing,
        args.forceRefetch ? '(force-refetch all existing)' : '',
        args.refreshFields.length ? `(refresh ${args.refreshFields.join(',')})` : ''
      );
    }
    return;
  }

  const stnCatalog = loadStationCatalog();
  let pool = null;
  if (fetchSource === 'db' || fetchSource === 'auto') {
    try {
      pool = await db.connect();
    } catch (err) {
      if (fetchSource === 'db') throw err;
      console.warn('DB connect failed; Hub-only backfill:', err.message);
    }
  }

  try {
    for (const day of days) {
      const timestamps = enumerateDayTimestamps(day.yyyymmdd);
      console.log('--- day', day.folderDate, '---');
      for (const tm of timestamps) {
        const filePath = buildFilePath(awsJsonDir, day.folderDate, tm);
        try {
          const existingRows = await readExistingRows(filePath);
          const exists = existingRows != null;

          if (exists && !args.forceRefetch && args.refreshFields.length === 0) {
            totals.skippedExists += 1;
            continue;
          }

          if (exists && !args.forceRefetch && args.refreshFields.length > 0) {
            const needsRefresh = args.refreshFields.some((field) => !hasValidField(existingRows, field));
            if (!needsRefresh) {
              totals.skippedFresh += 1;
              continue;
            }
          }

          console.log(exists ? 'refresh try' : 'backfill try', tm, '->', filePath);
          const rawRows = await fetchRowsForTm(tm, pool, stnCatalog, fetchSource);
          const jsonData = patchAwsRowsForSave(rawRows, stnCatalog);
          if (!jsonData || jsonData.length === 0) {
            console.log('no data to save.', tm);
            totals.noData += 1;
            continue;
          }
          await atomicWriteJson(filePath, jsonData);
          console.log(exists ? 'File refreshed!' : 'File saved!', filePath);
          if (exists) totals.refreshed += 1;
          else totals.saved += 1;
          if (args.sleepMs > 0) await sleep(args.sleepMs);
        } catch (err) {
          console.error('backfill error', tm, err);
          totals.errors += 1;
        }
      }
      await maybeWarmDayPack(day.yyyymmdd, args.skipPack, args.variables, stnCatalog);
    }
  } finally {
    if (pool) await pool.close();
  }

  console.log('=== summary ===');
  console.log(totals);
  if (totals.errors > 0) process.exitCode = 2;
}

async function maybeWarmDayPack(yyyymmdd, skipPack, variables, catalog) {
  if (skipPack) {
    console.log('skip pack warm (--skip-pack)');
    return;
  }
  const awsJsonDir = deriveAwsJsonDir(PROJECT_ROOT);
  const awsPackDir = deriveAwsPackDir(PROJECT_ROOT);
  console.log('warming packs', yyyymmdd, variables.join(','), '->', awsPackDir);
  try {
    const result = await warmAwsDayPack(awsJsonDir, awsPackDir, yyyymmdd, {
      catalog,
      variables
    });
    for (const item of result.items || []) {
      if (item.ok) {
        console.log(
          'pack',
          item.variable,
          item.fromCache ? 'cache' : 'built',
          'complete=',
          item.complete,
          item.manifest && item.manifest.data && item.manifest.data.url
        );
      } else {
        console.error('pack', item.variable, 'FAILED', item.message);
      }
    }
  } catch (err) {
    console.error('pack warm failed', yyyymmdd, err.message || err);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
