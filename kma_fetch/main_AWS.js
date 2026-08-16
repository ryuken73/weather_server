const path = require('path');
const db = require('./utils/db');
const sql = require('mssql');
const api = require('./services/api');
const file = require('./utils/file');
const time = require('./utils/time');
const schedule = require('./services/scheduler');
const env = require('./config/env');
const { TIMEZONE } = env;
const { patchAwsRowsForSave, loadStationCatalog } = require('./utils/aws_stn_catalog');
const { fetchAwsMinRowsFromHub } = require('./services/aws_apihub_min');
const { deriveAwsJsonDir } = require('./utils/aws_min_json');
const {
  supplementDbRowsFromHub,
  logHubSupplementWarning
} = require('./utils/aws_hub_fill');
const {
  deriveAwsPackDir,
  warmAwsDayPack,
  kstYmdDaysAgo,
  SUPPORTED_PACK_VARIABLES
} = require('./utils/aws_min_pack');

const PROJECT_ROOT = path.join(__dirname, '..');
const awsJsonDir = deriveAwsJsonDir(PROJECT_ROOT);
const awsPackDir = deriveAwsPackDir(PROJECT_ROOT);

let yesterdayPackWarmed = null;
let yesterdayPackWarmInFlight = null;

function kstHourMinute() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const parts = fmt.formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === 'hour').value);
  const minute = Number(parts.find((p) => p.type === 'minute').value);
  return { hour, minute };
}

function scheduleYesterdayPackWarm(catalog) {
  const yesterday = kstYmdDaysAgo(1);
  if (yesterdayPackWarmed === yesterday || yesterdayPackWarmInFlight) return;
  yesterdayPackWarmInFlight = (async () => {
    try {
      const result = await warmAwsDayPack(awsJsonDir, awsPackDir, yesterday, {
        catalog,
        variables: [...SUPPORTED_PACK_VARIABLES]
      });
      const complete = Boolean(result.manifest && result.manifest.complete);
      const { hour, minute } = kstHourMinute();
      // lookback ~30분이 어제 끝분을 더 채울 수 있으면 다음 틱에 재시도
      const pastLookback = hour > 0 || minute >= 40;
      if (complete || pastLookback) {
        yesterdayPackWarmed = yesterday;
      }
        const itemSummary = (result.items || [])
        .map((i) => `${i.variable}:${i.ok ? (i.fromCache ? 'cache' : 'built') : 'fail'}`)
        .join(' ');
      console.log(
        'yesterday packs',
        yesterday,
        itemSummary || `${result.fromCache ? 'cache' : 'built'} ${complete ? 'complete' : 'incomplete'}`
      );
      for (const item of result.items || []) {
        if (!item.ok) {
          console.error('yesterday pack FAILED', yesterday, item.variable, item.message);
        }
      }
    } catch (err) {
      console.error('yesterday TA pack warm failed', yesterday, err.message || err);
      const { hour, minute } = kstHourMinute();
      if (hour > 0 || minute >= 40) {
        yesterdayPackWarmed = yesterday;
      }
    } finally {
      yesterdayPackWarmInFlight = null;
    }
  })();
}

const AWS_DATA_ROOT = 'in_data';
const AWS_FILE_OPTIONS = { dataRoot: AWS_DATA_ROOT };

/**
 * AWS_FETCH_SOURCE:
 *   auto (기본) — DB 후, RN_12HR/TD가 전부 없으면 같은 TM Hub 1회 merge
 *   db — MSSQL만
 *   hub — API Hub만
 */
const AWS_FETCH_SOURCE = (process.env.AWS_FETCH_SOURCE || 'auto').toLowerCase();

// 1분 원천 보존 (pack / exact). 기존 2분 HTTP snap은 짝수분 파일만 읽음.
const downloadConfigs = [
  {
    dataType: 'AWS_MIN',
    subDirName: 'aws',
    compressed: false,
    fileExt: 'json',
    getCandidate: api.mkFetchCandidate,
    // 1분 격자 × 30 ≈ 약 28분 lookback (최신 2개 drop 후)
    candiateCount: 30,
    candidateMinute: 1,
    interval: '1min'
  }
];

async function fetchRowsForTm(tm, pool, stnCatalog) {
  const source = AWS_FETCH_SOURCE;
  const fetchHub = () => fetchAwsMinRowsFromHub(tm, { catalog: stnCatalog });

  if (source === 'hub') {
    return fetchHub();
  }

  let dbRows = [];
  if (pool && (source === 'db' || source === 'auto')) {
    const result = await pool
      .request()
      .input('tm', sql.VarChar, tm)
      .query(db.sqls.queryAwsMin);
    if (result.recordset && result.recordset.length > 0) {
      dbRows = result.recordset;
    }
  }

  if (source === 'db') {
    return dbRows;
  }

  if (dbRows.length === 0) {
    try {
      return await fetchHub();
    } catch (err) {
      if (err.code === 'NO_API_KEY') {
        console.warn('Hub fallback skipped (no API_KEY) for', tm);
        return [];
      }
      throw err;
    }
  }

  const filled = await supplementDbRowsFromHub({ tm, dbRows, fetchHub });
  logHubSupplementWarning(filled.warning);
  return filled.rows;
}

async function downloadLatestData(config) {
  const { subDirName, compressed, fileExt, getCandidate, candiateCount, candidateMinute } = config;
  scheduleYesterdayPackWarm(loadStationCatalog());
  try {
    const timeCandidatesRaw = getCandidate(candidateMinute, candiateCount);
    const [, , ...timeCandidates] = timeCandidatesRaw;
    console.log(timeCandidates);

    const folderFiles = {};
    for (const timeCandidate of timeCandidates) {
      const kstTimeString = time.getDateString(timeCandidate);
      if (!folderFiles[kstTimeString]) {
        folderFiles[kstTimeString] = await file.listFiles(
          kstTimeString,
          TIMEZONE,
          subDirName,
          AWS_FILE_OPTIONS
        );
      }
    }

    const patternBase = 'AWS_MIN_';
    const timesToDownload = timeCandidates.filter((timeCandidate) => {
      const kstTimeString = time.getDateString(timeCandidate);
      const fileNameRegex = new RegExp(`^${patternBase}${timeCandidate}\\.${fileExt}$`);
      const existingFiles = folderFiles[kstTimeString] || [];
      return existingFiles.every((fileName) => !fileNameRegex.test(fileName));
    });

    console.log(`Found ${timesToDownload.length} new files to download for AWS (source=${AWS_FETCH_SOURCE})`);
    console.log(timesToDownload);

    const sleep = (interval = 500) =>
      new Promise((resolve) => {
        setTimeout(resolve, interval);
      });

    let pool = null;
    if (AWS_FETCH_SOURCE === 'db' || AWS_FETCH_SOURCE === 'auto') {
      try {
        pool = await db.connect();
      } catch (err) {
        if (AWS_FETCH_SOURCE === 'db') throw err;
        console.warn('DB connect failed; Hub-only for this tick:', err.message);
      }
    }

    const stnCatalog = loadStationCatalog();
    try {
      for await (const timeToDownload of timesToDownload) {
        console.log('download AWS tm =', timeToDownload);
        try {
          const originalFileName = `${patternBase}${timeToDownload}.json`;
          const saveFilename = compressed
            ? file.uncompressedFname(originalFileName, compressed)
            : originalFileName;
          const dateStringForFolder = time.getDateString(timeToDownload);
          const [fileExists] = await file.isFileExists(
            saveFilename,
            dateStringForFolder,
            subDirName,
            AWS_FILE_OPTIONS
          );
          if (fileExists) {
            console.log('skip!! file already exists for tm', timeToDownload);
            continue;
          }

          const rawRows = await fetchRowsForTm(timeToDownload, pool, stnCatalog);
          const jsonData = patchAwsRowsForSave(rawRows, stnCatalog);
          if (jsonData.length === 0) {
            console.log('no data to save.', timeToDownload);
            continue;
          }
          console.log('data to save. length =', jsonData.length);
          const savedPath = await file.saveFile(
            JSON.stringify(jsonData),
            saveFilename,
            dateStringForFolder,
            subDirName,
            compressed,
            false,
            AWS_FILE_OPTIONS
          );
          console.log('File saved!', savedPath);
        } catch (err) {
          console.error(err);
          continue;
        }
        await sleep(500);
      }
    } finally {
      if (pool) await pool.close();
    }
  } catch (error) {
    console.error(error);
  }
}

downloadConfigs.forEach((config) => {
  const { dataType, interval } = config;
  schedule.scheduleTask(`${dataType}-${interval}`, interval, () => downloadLatestData(config));
});

console.log('Watcher started. Waiting for scheduled tasks...');
console.log('AWS_FETCH_SOURCE =', AWS_FETCH_SOURCE);
console.log('AWS interval = 1min (preserve all minutes for pack)');
