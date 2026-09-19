/**
 * Fetch Hub snow obs (SD_TOT + SD_24H) → in_data/sd JSON
 *
 *   NODE_ENV=production node kma_fetch/fetch_snow.js --from 202512020000 --to 202512042330 --interval 30
 *   node kma_fetch/fetch_snow.js --date 20251202 --force
 *
 * API_KEY required.
 */
const path = require('path');
const fs = require('fs');

function loadDotenv() {
  try {
    const dotenv = require('dotenv');
    for (const p of [
      path.join(__dirname, '.env.production'),
      path.join(__dirname, '.env.development'),
      path.join(__dirname, '..', '.env')
    ]) {
      if (fs.existsSync(p)) dotenv.config({ path: p });
    }
  } catch (_) {
    /* optional */
  }
}

loadDotenv();

const { fetchSnowObsMerged } = require('./services/kma_apihub_snow');
const { deriveSdJsonDir } = require('./utils/sd_paths');
const { enumerateTms, enumerateTmsForDay, writeSdJson, sdJsonPath } = require('./utils/sd_json');
const { DEFAULT_INTERVAL_MINUTES } = require('./utils/sd_pack');

const PROJECT_ROOT = path.join(__dirname, '..');

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
    interval: DEFAULT_INTERVAL_MINUTES,
    force: false,
    sleepMs: 400,
    dryRun: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--date') args.date = takeValue(argv, i++, '--date');
    else if (a.startsWith('--date=')) args.date = a.slice('--date='.length);
    else if (a === '--from') args.from = takeValue(argv, i++, '--from');
    else if (a.startsWith('--from=')) args.from = a.slice('--from='.length);
    else if (a === '--to') args.to = takeValue(argv, i++, '--to');
    else if (a.startsWith('--to=')) args.to = a.slice('--to='.length);
    else if (a === '--interval') args.interval = Number(takeValue(argv, i++, '--interval'));
    else if (a.startsWith('--interval=')) args.interval = Number(a.slice('--interval='.length));
    else if (a === '--sleep') args.sleepMs = Number(takeValue(argv, i++, '--sleep'));
    else if (a.startsWith('--sleep=')) args.sleepMs = Number(a.slice('--sleep='.length));
    else if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveTms(args) {
  if (args.date) return enumerateTmsForDay(args.date, args.interval);
  if (!args.from || !args.to) throw new Error('--date or --from/--to required');
  return enumerateTms(args.from, args.to, args.interval);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage:
  node kma_fetch/fetch_snow.js --date YYYYMMDD [--interval 30] [--force]
  node kma_fetch/fetch_snow.js --from YYYYMMDDHHmm --to YYYYMMDDHHmm [--interval 30]
`);
    return;
  }

  const authKey = process.env.API_KEY || process.env.KMA_API_KEY;
  if (!authKey) {
    console.error('API_KEY (or KMA_API_KEY) env is required');
    process.exit(2);
  }

  const jsonRoot = deriveSdJsonDir(PROJECT_ROOT);
  const tms = resolveTms(args);
  console.log(`fetch snow → ${jsonRoot} tms=${tms.length} interval=${args.interval}`);

  if (args.dryRun) {
    console.log(tms.slice(0, 20).join('\n'), tms.length > 20 ? '...' : '');
    return;
  }

  let ok = 0;
  let skip = 0;
  let fail = 0;
  let empty = 0;

  for (let i = 0; i < tms.length; i++) {
    const tm = tms[i];
    const outPath = sdJsonPath(jsonRoot, tm);
    if (!args.force && fs.existsSync(outPath)) {
      skip += 1;
      continue;
    }
    try {
      const { rows } = await fetchSnowObsMerged(tm, { authKey, snow: 2 });
      const slim = rows.map((r) => ({
        STN_ID: r.STN_ID,
        TM: r.TM,
        STN_NAME: r.STN_NAME,
        LAT: r.LAT,
        LON: r.LON,
        SD_TOT: r.SD_TOT,
        SD_24H: r.SD_24H
      }));
      if (!slim.length) {
        empty += 1;
        console.log('empty', tm);
      } else {
        await writeSdJson(jsonRoot, tm, slim);
        ok += 1;
        console.log('ok', tm, `stations=${slim.length}`);
      }
    } catch (err) {
      fail += 1;
      console.error('FAIL', tm, err.message);
    }
    if (i < tms.length - 1) await sleep(args.sleepMs);
  }

  console.log(JSON.stringify({ ok, skip, empty, fail, jsonRoot }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
