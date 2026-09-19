/**
 * Probe Hub snow APIs (stations + SD_TOT / SD_24H).
 *
 *   USE_API=false NODE_ENV=production node kma_fetch/probe_snow.js
 *   node kma_fetch/probe_snow.js --from 202512020000 --to 202512042330 --interval 30
 *
 * Saves raw under work/out/snow/ (gitignored). Writes summary JSON + prints stats.
 * Does not print API_KEY.
 */
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
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
  fetchSnowStations,
  fetchSnowObs,
  mergeSnowObsByStation
} = require('./services/kma_apihub_snow');
const { loadStationCatalog } = require('./utils/aws_stn_catalog');

const ZONE = 'Asia/Seoul';
const PROJECT_ROOT = path.join(__dirname, '..');
const OUT_ROOT = path.join(PROJECT_ROOT, 'work', 'out', 'snow');

function takeValue(argv, i, flag) {
  const next = argv[i + 1];
  if (!next || next.startsWith('-')) throw new Error(`${flag} requires a value`);
  return next;
}

function parseArgs(argv) {
  const args = {
    from: '202512020000',
    to: '202512042330',
    interval: 30,
    sleepMs: 400,
    maxTms: 0,
    skipObs: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--from') args.from = takeValue(argv, i++, '--from');
    else if (a.startsWith('--from=')) args.from = a.slice('--from='.length);
    else if (a === '--to') args.to = takeValue(argv, i++, '--to');
    else if (a.startsWith('--to=')) args.to = a.slice('--to='.length);
    else if (a === '--interval') args.interval = Number(takeValue(argv, i++, '--interval'));
    else if (a.startsWith('--interval=')) args.interval = Number(a.slice('--interval='.length));
    else if (a === '--sleep') args.sleepMs = Number(takeValue(argv, i++, '--sleep'));
    else if (a.startsWith('--sleep=')) args.sleepMs = Number(a.slice('--sleep='.length));
    else if (a === '--max-tms') args.maxTms = Number(takeValue(argv, i++, '--max-tms'));
    else if (a.startsWith('--max-tms=')) args.maxTms = Number(a.slice('--max-tms='.length));
    else if (a === '--skip-obs') args.skipObs = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function enumerateTms(from, to, intervalMinutes) {
  let cur = DateTime.fromFormat(from, 'yyyyMMddHHmm', { zone: ZONE });
  const end = DateTime.fromFormat(to, 'yyyyMMddHHmm', { zone: ZONE });
  if (!cur.isValid || !end.isValid || end < cur) {
    throw new Error('Invalid from/to');
  }
  const tms = [];
  while (cur <= end) {
    tms.push(cur.toFormat('yyyyMMddHHmm'));
    cur = cur.plus({ minutes: intervalMinutes });
  }
  return tms;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function summarizeValues(rows, field) {
  let valid = 0;
  let zero = 0;
  let missing = 0;
  let max = null;
  let maxStn = null;
  for (const r of rows) {
    const v = r[field];
    if (v == null) {
      missing += 1;
      continue;
    }
    valid += 1;
    if (v === 0) zero += 1;
    if (max == null || v > max) {
      max = v;
      maxStn = r.STN_ID;
    }
  }
  return { valid, zero, missing, maxScaled: max, maxCm: max == null ? null : max / 10, maxStn };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node kma_fetch/probe_snow.js [--from YYYYMMDDHHmm] [--to YYYYMMDDHHmm] [--interval 30] [--max-tms N] [--skip-obs]`);
    return;
  }

  await fsp.mkdir(OUT_ROOT, { recursive: true });

  console.log('[probe] fetching stn_snow.php …');
  const stnResult = await fetchSnowStations({ help: 1 });
  await fsp.writeFile(path.join(OUT_ROOT, 'stn_snow_raw.txt'), stnResult.text, 'utf8');
  await fsp.writeFile(
    path.join(OUT_ROOT, 'stn_snow_parsed.json'),
    JSON.stringify(stnResult.stations, null, 2) + '\n',
    'utf8'
  );

  const withLaw = stnResult.stations.filter((s) => s.LAW_ID);
  const withName = stnResult.stations.filter((s) => s.STN_NAME);
  let awsOverlap = 0;
  let awsCatalog = null;
  try {
    awsCatalog = loadStationCatalog();
    for (const s of stnResult.stations) {
      if (awsCatalog.byId.has(String(s.STN_ID))) awsOverlap += 1;
    }
  } catch (err) {
    console.warn('[probe] AWS catalog unavailable:', err.message);
  }

  const stationSummary = {
    stationCount: stnResult.stations.length,
    withLawId: withLaw.length,
    withName: withName.length,
    awsOverlap,
    awsStationCount: awsCatalog ? awsCatalog.stationCount : null,
    sample: stnResult.stations.slice(0, 5)
  };
  console.log('[probe] stations', JSON.stringify(stationSummary, null, 2));

  if (args.skipObs) {
    await fsp.writeFile(
      path.join(OUT_ROOT, 'probe_summary.json'),
      JSON.stringify({ stationSummary, obs: null }, null, 2) + '\n'
    );
    return;
  }

  let tms = enumerateTms(args.from, args.to, args.interval);
  if (args.maxTms > 0) tms = tms.slice(0, args.maxTms);
  console.log(`[probe] obs tms=${tms.length} interval=${args.interval}m ${args.from}→${args.to}`);

  const obsFrames = [];
  let prevFingerprint = null;
  let changeCount = 0;

  for (let i = 0; i < tms.length; i++) {
    const tm = tms[i];
    try {
      const tot = await fetchSnowObs('tot', tm, { snow: 2 });
      await sleep(args.sleepMs);
      const h24 = await fetchSnowObs('24h', tm, { snow: 2 });
      const merged = mergeSnowObsByStation(tot.rows, h24.rows, tm);

      const dayDir = path.join(OUT_ROOT, 'raw', tm.slice(0, 8));
      await fsp.mkdir(dayDir, { recursive: true });
      await fsp.writeFile(path.join(dayDir, `tot_${tm}.txt`), tot.text, 'utf8');
      await fsp.writeFile(path.join(dayDir, `h24_${tm}.txt`), h24.text, 'utf8');

      const totSum = summarizeValues(merged, 'SD_TOT');
      const h24Sum = summarizeValues(merged, 'SD_24H');
      const fingerprint = merged
        .map((r) => `${r.STN_ID}:${r.SD_TOT ?? 'n'}:${r.SD_24H ?? 'n'}`)
        .join('|');
      const changed = prevFingerprint != null && fingerprint !== prevFingerprint;
      if (changed) changeCount += 1;
      prevFingerprint = fingerprint;

      const frame = {
        tm,
        totRows: tot.rows.length,
        h24Rows: h24.rows.length,
        mergedRows: merged.length,
        tot: totSum,
        h24: h24Sum,
        changedFromPrev: changed
      };
      obsFrames.push(frame);
      console.log(
        `[probe] ${tm} tot=${tot.rows.length} h24=${h24.rows.length} maxTot=${totSum.maxCm} max24=${h24Sum.maxCm} changed=${changed}`
      );
    } catch (err) {
      console.error(`[probe] FAIL ${tm}`, err.message);
      obsFrames.push({ tm, error: err.message });
    }
    if (i < tms.length - 1) await sleep(args.sleepMs);
  }

  const okFrames = obsFrames.filter((f) => !f.error);
  const withData = okFrames.filter((f) => (f.tot && f.tot.valid > 0) || (f.h24 && f.h24.valid > 0));
  const recommendedInterval =
    changeCount > 0 && okFrames.length > 1
      ? Math.max(args.interval, Math.round((okFrames.length * args.interval) / (changeCount + 1)))
      : args.interval;

  const summary = {
    generatedAt: new Date().toISOString(),
    stationSummary,
    from: args.from,
    to: args.to,
    intervalMinutes: args.interval,
    frameCount: obsFrames.length,
    okFrameCount: okFrames.length,
    framesWithValidData: withData.length,
    changeCount,
    recommendedIntervalMinutesHint: recommendedInterval,
    frames: obsFrames
  };

  await fsp.writeFile(path.join(OUT_ROOT, 'probe_summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('[probe] wrote', path.join(OUT_ROOT, 'probe_summary.json'));
  console.log(
    JSON.stringify(
      {
        stationCount: stationSummary.stationCount,
        withLawId: stationSummary.withLawId,
        awsOverlap,
        okFrameCount: okFrames.length,
        framesWithValidData: withData.length,
        changeCount,
        recommendedIntervalMinutesHint: recommendedInterval
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
