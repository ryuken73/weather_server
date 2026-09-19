/**
 * Warm snow day packs
 *
 *   NODE_ENV=production USE_API=false node kma_fetch/warm_sd_packs.js 20251202 --force
 *   node kma_fetch/warm_sd_packs.js --from 20251202 --to 20251204 --interval 30
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
  warmSdDayPack,
  parseDayYmd,
  SUPPORTED_SD_PACK_VARIABLES,
  DEFAULT_INTERVAL_MINUTES,
  deriveSdJsonDir,
  deriveSdPackDir
} = require('./utils/sd_pack');
const { loadSdStationCatalog } = require('./utils/sd_stn_catalog');

const PROJECT_ROOT = path.join(__dirname, '..');
const ZONE = 'Asia/Seoul';

function takeValue(argv, i, flag) {
  const next = argv[i + 1];
  if (!next || next.startsWith('-')) throw new Error(`${flag} requires a value`);
  return next;
}

function parseArgs(argv) {
  const args = {
    days: [],
    from: null,
    to: null,
    force: false,
    interval: DEFAULT_INTERVAL_MINUTES,
    variables: [...SUPPORTED_SD_PACK_VARIABLES],
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--from') args.from = takeValue(argv, i++, '--from');
    else if (a.startsWith('--from=')) args.from = a.slice('--from='.length);
    else if (a === '--to') args.to = takeValue(argv, i++, '--to');
    else if (a.startsWith('--to=')) args.to = a.slice('--to='.length);
    else if (a === '--force') args.force = true;
    else if (a === '--interval') args.interval = Number(takeValue(argv, i++, '--interval'));
    else if (a.startsWith('--interval=')) args.interval = Number(a.slice('--interval='.length));
    else if (a === '--variables') {
      args.variables = takeValue(argv, i++, '--variables')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    } else if (a.startsWith('--variables=')) {
      args.variables = a
        .slice('--variables='.length)
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    } else if (/^\d{8}$/.test(a) || /^\d{4}-\d{2}-\d{2}$/.test(a)) {
      args.days.push(parseDayYmd(a));
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function enumerateDays(from, to) {
  let cur = DateTime.fromFormat(parseDayYmd(from), 'yyyyMMdd', { zone: ZONE });
  const end = DateTime.fromFormat(parseDayYmd(to), 'yyyyMMdd', { zone: ZONE });
  const days = [];
  while (cur <= end) {
    days.push(cur.toFormat('yyyyMMdd'));
    cur = cur.plus({ days: 1 });
  }
  return days;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node kma_fetch/warm_sd_packs.js <YYYYMMDD> [--force] [--interval 30]
  node kma_fetch/warm_sd_packs.js --from YYYYMMDD --to YYYYMMDD`);
    return;
  }

  let days = [...args.days];
  if (args.from && args.to) days = enumerateDays(args.from, args.to);
  if (!days.length) throw new Error('day or --from/--to required');

  const jsonRoot = deriveSdJsonDir(PROJECT_ROOT);
  const packRoot = deriveSdPackDir(PROJECT_ROOT);
  const catalog = loadSdStationCatalog();
  console.log(`warm sd packs json=${jsonRoot} pack=${packRoot} stations=${catalog.stationCount}`);

  for (const day of days) {
    const result = await warmSdDayPack(jsonRoot, packRoot, day, {
      force: args.force,
      intervalMinutes: args.interval,
      variables: args.variables,
      catalog
    });
    for (const item of result.items) {
      console.log(
        day,
        item.variable,
        item.ok ? (item.fromCache ? 'cache' : 'built') : 'FAIL',
        item.ok ? `frames=${item.manifest.frameCount}` : item.message
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
