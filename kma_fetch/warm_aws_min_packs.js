/**
 * 하루 또는 날짜 구간의 AWS 1분 pack을 디스크에 미리 만든다 (각 날 0000–2359).
 *
 *   node kma_fetch/warm_aws_min_packs.js 20260812 --variables TA,RN_15M,RN_60M,RN_12HR,RN_24HR
 *   node kma_fetch/warm_aws_min_packs.js --from 20260801 --to 20260812 --variables RN_15M,RN_60M,RN_12HR,RN_24HR --force
 *   node kma_fetch/warm_aws_min_packs.js --yesterday
 *   node kma_fetch/warm_aws_min_packs.js --from 20260801 --to 20260812 --json-dir /data/node_project/weather_data/in_data/aws --variables RN_15M,RN_60M,RN_24HR
 *
 * --variables 생략 시 TA만 (기존 호환).
 * env.js를 로드하므로 운영은 NODE_ENV=production. API_KEY 검사가 싫으면 USE_API=false.
 */
const path = require('path');
const fs = require('fs');
const { DateTime } = require('luxon');
const env = require('./config/env');
const { TIMEZONE } = env;
const { loadStationCatalog } = require('./utils/aws_stn_catalog');
const { deriveAwsJsonDir, folderDateFromTimestampKor } = require('./utils/aws_min_json');
const {
  deriveAwsPackDir,
  warmAwsDayPack,
  parsePackVariables,
  kstYmdDaysAgo,
  SUPPORTED_PACK_VARIABLES
} = require('./utils/aws_min_pack');

const PROJECT_ROOT = path.join(__dirname, '..');

function usage() {
  console.log(`Usage:
  node kma_fetch/warm_aws_min_packs.js <YYYYMMDD|YYYY-MM-DD> [--variables LIST] [--force]
  node kma_fetch/warm_aws_min_packs.js --from <YYYYMMDD> --to <YYYYMMDD> [--variables LIST] [--force]
  node kma_fetch/warm_aws_min_packs.js --yesterday [--variables LIST] [--force]

Options:
  --variables LIST  comma list. default TA. supported: ${SUPPORTED_PACK_VARIABLES.join(', ')}
  --json-dir DIR    AWS_MIN JSON root
  --pack-dir DIR    pack output root
  --force           rebuild even if complete cache exists

BASE_DIR=${env.BASE_DIR}
`);
}

function resolveDir(dir) {
  if (!dir) return null;
  return path.isAbsolute(dir) ? dir : path.resolve(PROJECT_ROOT, dir);
}

function takeValue(argv, i, flag) {
  const next = argv[i + 1];
  if (!next || next.startsWith('-')) throw new Error(`${flag} requires a value`);
  return next;
}

function parseDay(input) {
  const compact = String(input).replace(/-/g, '');
  if (!/^\d{8}$/.test(compact)) {
    throw new Error(`Invalid date. Expected YYYYMMDD or YYYY-MM-DD, got: ${input}`);
  }
  const dt = DateTime.fromFormat(compact, 'yyyyMMdd', { zone: TIMEZONE });
  if (!dt.isValid) {
    throw new Error(`Invalid calendar date: ${input} (${dt.invalidExplanation})`);
  }
  return compact;
}

function enumerateDaysInclusive(fromYmd, toYmd) {
  let cur = DateTime.fromFormat(fromYmd, 'yyyyMMdd', { zone: TIMEZONE }).startOf('day');
  const end = DateTime.fromFormat(toYmd, 'yyyyMMdd', { zone: TIMEZONE }).startOf('day');
  if (cur > end) {
    throw new Error(`\`from\` must be <= \`to\` (${fromYmd} > ${toYmd})`);
  }
  const days = [];
  while (cur <= end) {
    days.push(cur.toFormat('yyyyMMdd'));
    cur = cur.plus({ days: 1 });
  }
  return days;
}

function parseArgs(argv) {
  const args = {
    date: null,
    from: null,
    to: null,
    yesterday: false,
    force: false,
    help: false,
    jsonDir: null,
    packDir: null,
    variables: [ 'TA' ]
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--yesterday') args.yesterday = true;
    else if (a === '--force') args.force = true;
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
    } else if (a === '--json-dir') {
      args.jsonDir = takeValue(argv, i, '--json-dir');
      i += 1;
    } else if (a.startsWith('--json-dir=')) args.jsonDir = a.slice('--json-dir='.length);
    else if (a === '--pack-dir') {
      args.packDir = takeValue(argv, i, '--pack-dir');
      i += 1;
    } else if (a.startsWith('--pack-dir=')) args.packDir = a.slice('--pack-dir='.length);
    else if (!a.startsWith('-') && !args.date) args.date = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function resolveDays(args) {
  if (args.yesterday) {
    if (args.date || args.from || args.to) {
      throw new Error('--yesterday cannot be combined with a date or --from/--to');
    }
    return [kstYmdDaysAgo(1)];
  }
  if (args.from != null || args.to != null) {
    if (args.date) throw new Error('Use either a single date or --from/--to, not both');
    if (args.from == null || args.to == null) throw new Error('Both --from and --to are required for a range');
    return enumerateDaysInclusive(parseDay(args.from), parseDay(args.to));
  }
  if (args.date) return [parseDay(args.date)];
  throw new Error('Specify a date, --from/--to, or --yesterday');
}

function describeDaySource(awsJsonDir, yyyymmdd) {
  const folder = folderDateFromTimestampKor(`${yyyymmdd}0000`);
  const dayDir = path.join(awsJsonDir, folder);
  if (!fs.existsSync(dayDir)) return `${dayDir} (folder missing)`;
  try {
    const count = fs.readdirSync(dayDir).filter((n) => /^AWS_MIN_\d{12}\.json$/.test(n)).length;
    return `${dayDir} (${count} AWS_MIN_*.json)`;
  } catch (_) {
    return `${dayDir} (unreadable)`;
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

  const awsJsonDir = resolveDir(args.jsonDir) || deriveAwsJsonDir(PROJECT_ROOT);
  const awsPackDir = resolveDir(args.packDir) || deriveAwsPackDir(PROJECT_ROOT);
  const catalog = loadStationCatalog();
  console.log('AWS JSON DIR:', awsJsonDir);
  console.log('AWS PACK DIR:', awsPackDir);
  console.log('variables  :', args.variables.join(','));
  console.log('days       :', days.length, days[0], '→', days[days.length - 1], args.force ? '(force)' : '');

  const summary = {
    ok: 0,
    cache: 0,
    built: 0,
    complete: 0,
    incomplete: 0,
    errors: 0,
    byVariable: {}
  };
  for (const v of args.variables) {
    summary.byVariable[v] = { ok: 0, cache: 0, built: 0, complete: 0, incomplete: 0, errors: 0 };
  }

  for (const yyyymmdd of days) {
    try {
      const result = await warmAwsDayPack(awsJsonDir, awsPackDir, yyyymmdd, {
        catalog,
        force: args.force,
        variables: args.variables
      });
      for (const item of result.items || []) {
        const bucket = summary.byVariable[item.variable] || (summary.byVariable[item.variable] = {
          ok: 0, cache: 0, built: 0, complete: 0, incomplete: 0, errors: 0
        });
        if (!item.ok) {
          summary.errors += 1;
          bucket.errors += 1;
          const hint =
            item.error && item.error.code === 'NOT_FOUND'
              ? ` — checked ${describeDaySource(awsJsonDir, yyyymmdd)}`
              : '';
          console.error(yyyymmdd, item.variable, 'FAILED', (item.message || '') + hint);
          continue;
        }
        summary.ok += 1;
        bucket.ok += 1;
        if (item.fromCache) {
          summary.cache += 1;
          bucket.cache += 1;
        } else {
          summary.built += 1;
          bucket.built += 1;
        }
        if (item.complete) {
          summary.complete += 1;
          bucket.complete += 1;
        } else {
          summary.incomplete += 1;
          bucket.incomplete += 1;
        }
        console.log(
          yyyymmdd,
          item.variable,
          item.fromCache ? 'cache' : 'built',
          'complete=',
          item.complete,
          item.manifest && item.manifest.data && item.manifest.data.url
        );
      }
    } catch (err) {
      summary.errors += 1;
      console.error(yyyymmdd, 'FAILED', err.message || err);
    }
  }

  console.log('=== summary ===');
  console.log(summary);
  if (summary.errors > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
