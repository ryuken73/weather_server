/**
 * Snow watcher: Hub SD_TOT/SD_24H lookback + daily station catalog refresh.
 *
 * PM2 candidate name: kma_fetch_sd
 */
const path = require('path');
const fs = require('fs');
const { DateTime } = require('luxon');
const schedule = require('./services/scheduler');
const env = require('./config/env');
const { fetchSnowObsMerged, fetchSnowStations } = require('./services/kma_apihub_snow');
const { deriveSdJsonDir, deriveSdPackDir } = require('./utils/sd_paths');
const { writeSdJson, sdJsonPath } = require('./utils/sd_json');
const {
  warmSdDayPack,
  DEFAULT_INTERVAL_MINUTES,
  SUPPORTED_SD_PACK_VARIABLES
} = require('./utils/sd_pack');
const { clearSdStationCatalogCache } = require('./utils/sd_stn_catalog');
const { loadLawCodeMaster, resolveLawAddr } = require('./utils/law_code_lookup');
const { loadStationCatalog } = require('./utils/aws_stn_catalog');

const PROJECT_ROOT = path.join(__dirname, '..');
const ZONE = 'Asia/Seoul';
const sdJsonDir = deriveSdJsonDir(PROJECT_ROOT);
const sdPackDir = deriveSdPackDir(PROJECT_ROOT);

const INTERVAL_MINUTES = (() => {
  const raw = Number(process.env.SD_FETCH_INTERVAL || DEFAULT_INTERVAL_MINUTES);
  if (![10, 15, 30, 60].includes(raw)) return DEFAULT_INTERVAL_MINUTES;
  return raw;
})();

const LOOKBACK_SLOTS = (() => {
  const raw = Number(process.env.SD_LOOKBACK_SLOTS || 8);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(48, Math.floor(raw)) : 8;
})();

const SD_REFRESH_ENABLED = String(process.env.SD_FETCH_REFRESH ?? '1').trim() !== '0';
const SD_STN_DAILY_ENABLED = String(process.env.SD_STN_DAILY_REFRESH ?? '1').trim() !== '0';

function mkCandidates(intervalMinutes, count) {
  const now = DateTime.now().setZone(ZONE);
  const baseMinute = Math.floor(now.minute / intervalMinutes) * intervalMinutes;
  let cur = now.set({ minute: baseMinute, second: 0, millisecond: 0 });
  const tms = [];
  for (let i = 0; i < count; i++) {
    tms.push(cur.toFormat('yyyyMMddHHmm'));
    cur = cur.minus({ minutes: intervalMinutes });
  }
  return tms;
}

async function refreshStationCatalog() {
  const ymd = DateTime.now().setZone(ZONE).toFormat('yyyyMMdd');
  const { text, stations: raw } = await fetchSnowStations({ help: 0 });
  const rawPath = path.join(__dirname, 'config', `stn_snow_${ymd}.txt`);
  await fs.promises.writeFile(rawPath, text, 'utf8');

  let aws = null;
  try {
    aws = loadStationCatalog();
  } catch (_) {
    aws = null;
  }
  const lawMaster = loadLawCodeMaster();
  const stations = raw.map((s) => {
    const base = {
      STN_ID: s.STN_ID,
      STN_NAME: s.STN_NAME,
      LAT: s.LAT,
      LON: s.LON,
      HT: s.HT,
      STN_SP: s.STN_SP,
      LAW_ID: s.LAW_ID != null ? String(s.LAW_ID) : null,
      LAW_ADDR_SIDO: null,
      LAW_ADDR_GUGUN: null,
      addrSource: null
    };
    const awsMeta = aws && aws.byId.get(String(s.STN_ID));
    if (awsMeta && (awsMeta.LAW_ADDR_SIDO || awsMeta.LAW_ADDR_GUGUN)) {
      base.LAW_ADDR_SIDO = awsMeta.LAW_ADDR_SIDO;
      base.LAW_ADDR_GUGUN = awsMeta.LAW_ADDR_GUGUN;
      base.addrSource = 'aws_join';
      return base;
    }
    const law = resolveLawAddr(base.LAW_ID, lawMaster);
    if (law.addrSource) {
      base.LAW_ADDR_SIDO = law.LAW_ADDR_SIDO;
      base.LAW_ADDR_GUGUN = law.LAW_ADDR_GUGUN;
      base.addrSource = 'law_code';
    }
    return base;
  });
  stations.sort((a, b) => a.STN_ID - b.STN_ID);

  const codePath = path.join(__dirname, 'config', `sd_stn_code_${ymd}.json`);
  const codeOut = {
    schemaVersion: 1,
    source: 'stn_snow.php Hub (main_SD daily)',
    generatedAt: new Date().toISOString(),
    stationCount: stations.length,
    stations
  };
  await fs.promises.writeFile(codePath, JSON.stringify(codeOut, null, 2) + '\n', 'utf8');
  clearSdStationCatalogCache();
  console.log('sd stations refreshed', stations.length, path.basename(codePath));
}

async function downloadLookback() {
  const authKey = process.env.API_KEY || process.env.KMA_API_KEY;
  if (!authKey) {
    console.warn('sd fetch skip (no API_KEY)');
    return;
  }
  const tms = mkCandidates(INTERVAL_MINUTES, LOOKBACK_SLOTS);
  // drop newest 1 slot (may still be publishing)
  const [, ...toFetch] = tms;
  console.log('sd lookback', toFetch[toFetch.length - 1], '→', toFetch[0]);

  let written = 0;
  for (const tm of [...toFetch].reverse()) {
    const outPath = sdJsonPath(sdJsonDir, tm);
    if (fs.existsSync(outPath)) continue;
    try {
      const { rows } = await fetchSnowObsMerged(tm, { authKey, snow: 2 });
      if (!rows.length) {
        console.log('sd empty', tm);
        continue;
      }
      const slim = rows.map((r) => ({
        STN_ID: r.STN_ID,
        TM: r.TM,
        STN_NAME: r.STN_NAME,
        LAT: r.LAT,
        LON: r.LON,
        SD_TOT: r.SD_TOT,
        SD_24H: r.SD_24H
      }));
      await writeSdJson(sdJsonDir, tm, slim);
      written += 1;
      console.log('sd saved', tm, slim.length);
    } catch (err) {
      console.error('sd FAIL', tm, err.message);
    }
  }

  if (written > 0) {
    const today = DateTime.now().setZone(ZONE).toFormat('yyyyMMdd');
    try {
      const result = await warmSdDayPack(sdJsonDir, sdPackDir, today, {
        force: true,
        intervalMinutes: INTERVAL_MINUTES,
        variables: [...SUPPORTED_SD_PACK_VARIABLES]
      });
      for (const item of result.items) {
        console.log(
          'sd pack',
          today,
          item.variable,
          item.ok ? (item.fromCache ? 'cache' : 'built') : item.message
        );
      }
    } catch (err) {
      console.error('sd pack warm failed', err.message);
    }
  }
}

if (SD_REFRESH_ENABLED) {
  const cronKey =
    INTERVAL_MINUTES === 10
      ? '10min'
      : INTERVAL_MINUTES === 60
        ? '4 * * * *'
        : INTERVAL_MINUTES === 15
          ? '*/15 * * * *'
          : INTERVAL_MINUTES === 30
            ? '4,34 * * * *'
            : '5min';
  schedule.scheduleTask('SD-OBS', cronKey, () => downloadLookback());
  downloadLookback().catch((err) => console.error('sd startup fetch failed', err.message));
  console.log(`Snow obs refresh: enabled interval=${INTERVAL_MINUTES}m cron=${cronKey} lookback=${LOOKBACK_SLOTS}`);
} else {
  console.log('Snow obs refresh: disabled (SD_FETCH_REFRESH=0)');
}

if (SD_STN_DAILY_ENABLED) {
  schedule.scheduleTask('SD-STN-DAILY', '1day', () =>
    refreshStationCatalog().catch((err) => console.error('sd stn daily failed', err.message))
  );
  // startup once
  refreshStationCatalog().catch((err) => console.warn('sd stn startup skipped', err.message));
  console.log('Snow station catalog: daily refresh enabled');
}

console.log('Snow watcher started', { NODE_ENV: env.NODE_ENV, sdJsonDir, sdPackDir });
