/**
 * Hub awsh.php RN → 시간통계 JSON
 *
 *   NODE_ENV=production node kma_fetch/fetch_aws_hourly_stat.js --date 20260904
 *   node kma_fetch/fetch_aws_hourly_stat.js --from 202609040000 --to 202609042300 --force
 *
 * API_KEY 필요. USE_API=false 여도 Hub 키는 별도로 있어야 함.
 */
const path = require('path');
const fs = require('fs');
const { DateTime } = require('luxon');

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

const {
  deriveAwsHourlyStatJsonDir,
  enumerateHourlyTmsForDay,
  ensureHourlyRnHours
} = require('./utils/aws_hourly_stat');

const PROJECT_ROOT = path.join(__dirname, '..');
const ZONE = 'Asia/Seoul';

function usage() {
  console.log(`Usage:
  node kma_fetch/fetch_aws_hourly_stat.js --date YYYYMMDD [--force] [--sleep MS]
  node kma_fetch/fetch_aws_hourly_stat.js --from YYYYMMDDHH00 --to YYYYMMDDHH00 [--force]
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
    force: false,
    sleepMs: 300,
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
    else if (a === '--sleep') args.sleepMs = Number(takeValue(argv, i++, '--sleep'));
    else if (a.startsWith('--sleep=')) args.sleepMs = Number(a.slice('--sleep='.length));
    else if (a === '--force') args.force = true;
    else if (a === '--save-raw') {
      /* ignored: use ensureHourlyRnHours + custom fetch if needed */
    } else if (a === '--dry-run') args.dryRun = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function enumerateTms(args) {
  if (args.date) {
    return enumerateHourlyTmsForDay(args.date);
  }
  if (!args.from || !args.to) {
    throw new Error('--date or --from/--to required');
  }
  if (!/^\d{12}$/.test(args.from) || !/^\d{12}$/.test(args.to)) {
    throw new Error('--from/--to must be YYYYMMDDHHMM');
  }
  let cur = DateTime.fromFormat(args.from, 'yyyyMMddHHmm', { zone: ZONE });
  const end = DateTime.fromFormat(args.to, 'yyyyMMddHHmm', { zone: ZONE });
  if (!cur.isValid || !end.isValid || end < cur) {
    throw new Error('Invalid from/to range');
  }
  const tms = [];
  while (cur <= end) {
    if (cur.minute === 0) tms.push(cur.toFormat('yyyyMMddHHmm'));
    cur = cur.plus({ hours: 1 }).set({ minute: 0, second: 0, millisecond: 0 });
  }
  return tms;
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
    return;
  }

  const tms = enumerateTms(args);
  const outRoot = deriveAwsHourlyStatJsonDir(PROJECT_ROOT, process.env);
  console.log('=== fetch AWS hourly stat RN (awsh.php) ===');
  console.log('hours   :', tms.length, tms[0], '->', tms[tms.length - 1]);
  console.log('out     :', outRoot);
  console.log('force   :', args.force);
  console.log('dryRun  :', args.dryRun);

  if (args.dryRun) {
    tms.forEach((tm) => console.log(tm));
    return;
  }

  const authKey = process.env.API_KEY || process.env.KMA_API_KEY;
  if (!authKey) {
    console.error('API_KEY (or KMA_API_KEY) env is required');
    process.exit(1);
  }

  let i = 0;
  const summary = await ensureHourlyRnHours(outRoot, tms, {
    force: args.force,
    sleepMs: args.sleepMs,
    authKey,
    onHour: ({ tm, status, stationCount, negNulls, message }) => {
      i += 1;
      process.stdout.write(`[${i}/${tms.length}] ${tm} `);
      if (status === 'skip') console.log('skip exists');
      else if (status === 'empty') console.log('EMPTY');
      else if (status === 'ok') {
        console.log(
          `ok stations=${stationCount}` + (negNulls ? ` negNulls=${negNulls}` : '')
        );
      } else if (status === 'fail') console.log('FAIL', message);
    }
  });

  console.log('=== summary ===');
  console.log({
    ok: summary.ok,
    fail: summary.fail,
    skipped: summary.skipped,
    empty: summary.empty
  });
  if (summary.fail > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
