/**
 * 시간통계 RN day pack warm
 *
 *   NODE_ENV=production USE_API=false node kma_fetch/warm_aws_hourly_stat.js 20260904 --force
 *   node kma_fetch/warm_aws_hourly_stat.js --from 20260901 --to 20260904 --force
 */
const path = require('path');
const { DateTime } = require('luxon');
require('./config/env');
const {
  deriveAwsHourlyStatJsonDir,
  deriveAwsHourlyStatPackDir,
  parseDayYmd,
  getOrBuildAwsHourlyRnPack
} = require('./utils/aws_hourly_stat');

const PROJECT_ROOT = path.join(__dirname, '..');
const ZONE = 'Asia/Seoul';

function usage() {
  console.log(`Usage:
  node kma_fetch/warm_aws_hourly_stat.js <YYYYMMDD> [--force]
  node kma_fetch/warm_aws_hourly_stat.js --from YYYYMMDD --to YYYYMMDD [--force]
`);
}

function takeValue(argv, i, flag) {
  const next = argv[i + 1];
  if (!next || next.startsWith('-')) throw new Error(`${flag} requires a value`);
  return next;
}

function parseArgs(argv) {
  const args = { date: null, from: null, to: null, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--from') args.from = takeValue(argv, i++, '--from');
    else if (a === '--to') args.to = takeValue(argv, i++, '--to');
    else if (a === '--force') args.force = true;
    else if (!a.startsWith('-') && !args.date) args.date = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function enumerateDays(fromYmd, toYmd) {
  let cur = DateTime.fromFormat(fromYmd, 'yyyyMMdd', { zone: ZONE }).startOf('day');
  const end = DateTime.fromFormat(toYmd, 'yyyyMMdd', { zone: ZONE }).startOf('day');
  const days = [];
  while (cur <= end) {
    days.push(cur.toFormat('yyyyMMdd'));
    cur = cur.plus({ days: 1 });
  }
  return days;
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

  let days;
  if (args.date) days = [parseDayYmd(args.date)];
  else if (args.from && args.to) days = enumerateDays(parseDayYmd(args.from), parseDayYmd(args.to));
  else {
    usage();
    process.exit(1);
  }

  const jsonRoot = deriveAwsHourlyStatJsonDir(PROJECT_ROOT);
  const packRoot = deriveAwsHourlyStatPackDir(PROJECT_ROOT);
  console.log('=== warm AWS hourly RN pack ===');
  console.log('json :', jsonRoot);
  console.log('pack :', packRoot);
  console.log('days :', days[0], '->', days[days.length - 1], `(${days.length})`);
  console.log('force:', args.force);

  for (const day of days) {
    process.stdout.write(`${day} `);
    try {
      const { manifest, built } = await getOrBuildAwsHourlyRnPack(jsonRoot, packRoot, day, {
        force: args.force,
        manifestOnly: false
      });
      console.log(
        built ? 'built' : 'cached',
        `present=${manifest.presentHourCount}/24`,
        `complete=${manifest.complete}`,
        manifest.data && manifest.data.url
      );
    } catch (err) {
      console.log('FAIL', err.code || '', err.message);
      process.exitCode = 2;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
