const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const api = require('./services/api');
const schedule = require('./services/scheduler');
const { downloadStreamToFile, hasNonEmptyFile } = require('./utils/download');
const {
  API_ENDPOINT_KIM_TXT,
  KIM_TEXT_IN_DIR,
  KIM_TEXT_OUT_DIR,
  KIM_TEXT_PNG_GENERATOR,
  KIM_TEXT_MAX_HOURS,
  KIM_TEXT_INTERVAL_MINUTES,
  KIM_TEXT_DOWNSAMPLE_FACTOR,
  KIM_TEXT_FORECAST_HOURS,
  KIM_TEXT_CYCLE_HOURS,
  KIM_TEXT_CANDIDATE_COUNT,
  KIM_TEXT_DELAY_HOURS
} = require('./config/env');

function parseNumber(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseForecastHours(value, maxHours) {
  return String(value)
    .split(',')
    .map(item => parseInt(item.trim(), 10))
    .filter(item => Number.isFinite(item) && item >= 0 && item <= maxHours)
    .sort((a, b) => a - b);
}

function parseCycleHours(value) {
  const hours = String(value)
    .split(',')
    .map(item => parseInt(item.trim(), 10))
    .filter(item => Number.isFinite(item) && item >= 0 && item <= 23)
    .sort((a, b) => a - b);
  return hours.length > 0 ? hours : [0, 6, 12, 18];
}

function resolveFromKmaFetch(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(__dirname, filePath);
}

function datasetIdFor(tmfc) {
  return `kim-glob-hgt500-${tmfc}`;
}

function tmfcToIso(tmfc) {
  return `${tmfc.slice(0, 4)}-${tmfc.slice(4, 6)}-${tmfc.slice(6, 8)}T${tmfc.slice(8, 10)}:00:00Z`;
}

function rawTextFileName(tmfc, forecastHour) {
  return `kim_glob_prs_hgt500_ft${String(forecastHour).padStart(3, '0')}_${tmfc}.txt`;
}

function formatTmfc(date) {
  return date.getFullYear().toString() +
    String(date.getMonth() + 1).padStart(2, '0') +
    String(date.getDate()).padStart(2, '0') +
    String(date.getHours()).padStart(2, '0');
}

function mkKimTextFetchCandidates(delayHours, count, cycleHours) {
  const baseTime = new Date(Date.now() - (delayHours * 60 * 60 * 1000));
  const candidates = [];

  for (let dayOffset = 0; dayOffset > -14 && candidates.length < count; dayOffset--) {
    const checkDate = new Date(baseTime);
    checkDate.setDate(baseTime.getDate() + dayOffset);

    for (const cycleHour of [...cycleHours].sort((a, b) => b - a)) {
      const candidate = new Date(
        checkDate.getFullYear(),
        checkDate.getMonth(),
        checkDate.getDate(),
        cycleHour,
        0,
        0,
        0
      );

      if (candidate.getTime() <= baseTime.getTime()) {
        candidates.push(formatTmfc(candidate));
        if (candidates.length >= count) break;
      }
    }
  }

  return candidates;
}

async function writeJsonAtomic(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const partialPath = `${filePath}.partial`;
  await fs.writeFile(partialPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await fs.rename(partialPath, filePath);
}

function generateKimTextPng(inputDir, outputDir, tmfc, maxHours, intervalMinutes, downsampleFactor) {
  return new Promise((resolve, reject) => {
    const scriptPath = resolveFromKmaFetch(KIM_TEXT_PNG_GENERATOR);
    console.log(`[KIM-TXT-PNG] Starting sequence generation for tmfc=${tmfc}`);

    const pythonProcess = spawn('python', [
      '-u',
      scriptPath,
      '--input-dir', inputDir,
      '--output-dir', outputDir,
      '--tmfc', tmfc,
      '--max-hours', String(maxHours),
      '--interval', String(intervalMinutes),
      '--downsample', String(downsampleFactor)
    ], {
      env: {
        ...process.env
      }
    });

    pythonProcess.stdout.on('data', data => {
      console.log(`[KIM-TXT-PNG] ${data.toString().trim()}`);
    });

    pythonProcess.stderr.on('data', data => {
      console.error(`[KIM-TXT-PNG Err] ${data.toString().trim()}`);
    });

    pythonProcess.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Python process exited with code ${code}`));
      }
    });
  });
}

async function updateLatestPointer(outputDir, tmfc) {
  const datasetId = datasetIdFor(tmfc);
  const manifestPath = path.join(outputDir, 'datasets', datasetId, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const frames = manifest.frames || [];
  const firstFrame = frames[0] || {};
  const lastFrame = frames[frames.length - 1] || {};
  const latestPath = path.join(outputDir, 'latest', 'hgt500.json');

  await writeJsonAtomic(latestPath, {
    datasetId,
    tmfc,
    status: 'succeeded',
    sourceFormat: 'kim-api-text',
    downsampleFactor: manifest.source ? manifest.source.downsampleFactor : null,
    analysisTime: tmfcToIso(tmfc),
    validTimeStart: firstFrame.validTime || null,
    validTimeEnd: lastFrame.validTime || null,
    sourceForecastIntervalMinutes: manifest.sourceForecastIntervalMinutes,
    outputFrameIntervalMinutes: manifest.outputFrameIntervalMinutes,
    frameCount: frames.length,
    manifestUrl: `/datasets/${datasetId}/manifest.json`
  });
}

async function downloadAndGenerateKimText() {
  const maxHours = parseNumber(KIM_TEXT_MAX_HOURS, 72);
  const intervalMinutes = parseNumber(KIM_TEXT_INTERVAL_MINUTES, 10);
  const downsampleFactor = parseNumber(KIM_TEXT_DOWNSAMPLE_FACTOR, 3);
  const candidateCount = parseNumber(KIM_TEXT_CANDIDATE_COUNT, 1);
  const delayHours = parseNumber(KIM_TEXT_DELAY_HOURS, 12);
  const forecastHours = parseForecastHours(KIM_TEXT_FORECAST_HOURS, maxHours);
  const cycleHours = parseCycleHours(KIM_TEXT_CYCLE_HOURS);
  const timeCandidates = mkKimTextFetchCandidates(delayHours, candidateCount, cycleHours);

  console.log(`[KIM-TXT] Fetching candidates:`, timeCandidates);

  for (const tmfc of timeCandidates) {
    const inputDir = path.join(KIM_TEXT_IN_DIR, 'hgt500_txt', tmfc);
    const datasetId = datasetIdFor(tmfc);
    const outputDir = path.join(KIM_TEXT_OUT_DIR, 'datasets', datasetId);
    const manifestPath = path.join(outputDir, 'manifest.json');

    let downloadedCount = 0;
    let failedCount = 0;

    for (const forecastHour of forecastHours) {
      const outputPath = path.join(inputDir, rawTextFileName(tmfc, forecastHour));
      if (await hasNonEmptyFile(outputPath)) {
        continue;
      }

      const fetchUrl = api.mkUrl.kimText(API_ENDPOINT_KIM_TXT, tmfc, { hf: forecastHour });
      try {
        console.log(`[KIM-TXT] Downloading tmfc=${tmfc}, hf=${forecastHour}`);
        const result = await downloadStreamToFile(fetchUrl, outputPath, {
          timeoutMs: 10 * 60 * 1000
        });
        if (!result.skipped) {
          downloadedCount++;
        }
      } catch (err) {
        failedCount++;
        console.error(`[KIM-TXT] Failed tmfc=${tmfc}, hf=${forecastHour}:`, err.message);
      }
    }

    const missingFiles = [];
    for (const forecastHour of forecastHours) {
      const outputPath = path.join(inputDir, rawTextFileName(tmfc, forecastHour));
      if (!await hasNonEmptyFile(outputPath)) {
        missingFiles.push(forecastHour);
      }
    }

    if (missingFiles.length > 0) {
      console.log(`[KIM-TXT] Skip generation for tmfc=${tmfc}. Missing hf: ${missingFiles.join(',')}`);
      continue;
    }

    if (await hasNonEmptyFile(manifestPath) && downloadedCount === 0 && failedCount === 0) {
      console.log(`[KIM-TXT] Dataset already exists for tmfc=${tmfc}`);
      await updateLatestPointer(KIM_TEXT_OUT_DIR, tmfc);
      continue;
    }

    await generateKimTextPng(
      inputDir,
      outputDir,
      tmfc,
      maxHours,
      intervalMinutes,
      downsampleFactor
    );
    await updateLatestPointer(KIM_TEXT_OUT_DIR, tmfc);
    console.log(`[KIM-TXT] Dataset ready: ${datasetId}`);
  }
}

schedule.scheduleTask(
  'kim-text-hgt500',
  'kim_text_custom',
  () => downloadAndGenerateKimText()
);

// downloadAndGenerateKimText();
console.log('KIM TXT Watcher started. Waiting for scheduled tasks...');
