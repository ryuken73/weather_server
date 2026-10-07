const fs = require('fs/promises');
const fsRaw = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const api = require('./services/api');
const schedule = require('./services/scheduler');
const { downloadStreamToFile, hasNonEmptyFile } = require('./utils/download');
const { deriveKimTextDirs } = require('./utils/kim_text_paths');
const {
  API_ENDPOINT_KIM_TXT,
  BASE_DIR,
  KIM_TEXT_PNG_GENERATOR,
  KIM_TEXT_MAX_HOURS,
  KIM_TEXT_INTERVAL_MINUTES,
  KIM_TEXT_DOWNSAMPLE_FACTOR,
  KIM_TEXT_FORECAST_HOURS,
  KIM_TEXT_CYCLE_HOURS,
  KIM_TEXT_CANDIDATE_COUNT,
  KIM_TEXT_DELAY_HOURS,
  KIM_TEXT_LEVELS
} = require('./config/env');

const { inputDir: kimTextInputDir, outputDir: kimTextOutputDir } = deriveKimTextDirs(BASE_DIR);
const KIM_TEXT_GRID_HEADER_RE = /^#.*=\s*hgt\s*,\s*unit\s*=\s*m\s*,\s*level\s*=\s*[-+0-9.eE]+\s*,\s*i\s*=\s*\d+\s*,\s*j\s*=\s*\d+\s*,\s*map\s*=/i;
const KIM_TEXT_ERROR_RE = /^#\s*ERROR\b|file is not exist/i;

const LEVEL_PROFILES = Object.freeze({
  500: {
    level: 500,
    slug: 'hgt500',
    datasetPrefix: 'kim-glob-hgt500',
    inputSubdir: 'hgt500_txt',
    latestPointer: 'hgt500.json'
  },
  850: {
    level: 850,
    slug: 'hgt850',
    datasetPrefix: 'kim-glob-hgt850',
    inputSubdir: 'hgt850_txt',
    latestPointer: 'hgt850.json'
  }
});

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

function parseLevels(value) {
  const levels = String(value || '500')
    .split(',')
    .map(item => parseInt(item.trim(), 10))
    .filter(item => LEVEL_PROFILES[item]);
  return levels.length > 0 ? [...new Set(levels)] : [500];
}

function resolveFromKmaFetch(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(__dirname, filePath);
}

function levelProfile(level) {
  const profile = LEVEL_PROFILES[level];
  if (!profile) {
    throw new Error(`Unsupported KIM HGT level=${level}`);
  }
  return profile;
}

function datasetIdFor(tmfc, level) {
  return `${levelProfile(level).datasetPrefix}-${tmfc}`;
}

function tmfcToIso(tmfc) {
  return `${tmfc.slice(0, 4)}-${tmfc.slice(4, 6)}-${tmfc.slice(6, 8)}T${tmfc.slice(8, 10)}:00:00Z`;
}

function rawTextFileName(tmfc, forecastHour, level) {
  const slug = levelProfile(level).slug;
  return `kim_glob_prs_${slug}_ft${String(forecastHour).padStart(3, '0')}_${tmfc}.txt`;
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

async function validateKimTextFile(filePath) {
  if (!await hasNonEmptyFile(filePath)) {
    return { valid: false, reason: 'file is missing or empty' };
  }

  const stream = fsRaw.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineCount = 0;

  try {
    for await (const line of lines) {
      lineCount++;
      const trimmed = line.trim();

      if (KIM_TEXT_ERROR_RE.test(trimmed)) {
        return { valid: false, reason: trimmed || 'KIM API error response' };
      }

      if (KIM_TEXT_GRID_HEADER_RE.test(trimmed)) {
        return { valid: true };
      }

      if (lineCount >= 200) {
        break;
      }
    }
  } finally {
    stream.destroy();
  }

  return { valid: false, reason: 'KIM hgt grid header not found' };
}

async function hasValidKimTextFile(filePath) {
  const validation = await validateKimTextFile(filePath).catch(err => ({
    valid: false,
    reason: err.message
  }));
  return validation.valid;
}

async function removeInvalidKimTextFile(filePath, reason) {
  console.warn(`[KIM-TXT] Removing invalid TXT file: ${filePath}. reason=${reason}`);
  await fs.rm(filePath, { force: true }).catch(() => {});
}

function generateKimTextPng(inputDir, outputDir, tmfc, maxHours, intervalMinutes, downsampleFactor, level) {
  return new Promise((resolve, reject) => {
    const scriptPath = resolveFromKmaFetch(KIM_TEXT_PNG_GENERATOR);
    console.log(`[KIM-TXT-PNG] Starting sequence generation for tmfc=${tmfc} level=${level}`);

    const pythonProcess = spawn('python', [
      '-u',
      scriptPath,
      '--input-dir', inputDir,
      '--output-dir', outputDir,
      '--tmfc', tmfc,
      '--max-hours', String(maxHours),
      '--interval', String(intervalMinutes),
      '--downsample', String(downsampleFactor),
      '--level', String(level)
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

async function updateLatestPointer(outputDir, tmfc, level) {
  const profile = levelProfile(level);
  const datasetId = datasetIdFor(tmfc, level);
  const manifestPath = path.join(outputDir, 'datasets', datasetId, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const frames = manifest.frames || [];
  const firstFrame = frames[0] || {};
  const lastFrame = frames[frames.length - 1] || {};
  const latestPath = path.join(outputDir, 'latest', profile.latestPointer);

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

async function downloadAndGenerateKimTextForLevel(level, shared) {
  const {
    maxHours,
    intervalMinutes,
    downsampleFactor,
    forecastHours,
    timeCandidates
  } = shared;
  const profile = levelProfile(level);
  const tag = `KIM-TXT-${profile.slug}`;

  console.log(`[${tag}] Fetching candidates:`, timeCandidates);

  for (const tmfc of timeCandidates) {
    const inputDir = path.join(kimTextInputDir, profile.inputSubdir, tmfc);
    const datasetId = datasetIdFor(tmfc, level);
    const outputDir = path.join(kimTextOutputDir, 'datasets', datasetId);
    const manifestPath = path.join(outputDir, 'manifest.json');

    let downloadedCount = 0;
    let failedCount = 0;

    for (const forecastHour of forecastHours) {
      const outputPath = path.join(inputDir, rawTextFileName(tmfc, forecastHour, level));
      if (await hasNonEmptyFile(outputPath)) {
        const validation = await validateKimTextFile(outputPath);
        if (validation.valid) {
          continue;
        }
        await removeInvalidKimTextFile(outputPath, validation.reason);
      }

      const fetchUrl = api.mkUrl.kimText(API_ENDPOINT_KIM_TXT, tmfc, {
        hf: forecastHour,
        level
      });
      try {
        console.log(`[${tag}] Downloading tmfc=${tmfc}, hf=${forecastHour}`);
        const result = await downloadStreamToFile(fetchUrl, outputPath, {
          timeoutMs: 10 * 60 * 1000
        });
        if (!result.skipped) {
          downloadedCount++;
        }
        const validation = await validateKimTextFile(outputPath);
        if (!validation.valid) {
          await removeInvalidKimTextFile(outputPath, validation.reason);
          throw new Error(`Invalid KIM TXT response: ${validation.reason}`);
        }
      } catch (err) {
        failedCount++;
        console.error(`[${tag}] Failed tmfc=${tmfc}, hf=${forecastHour}:`, err.message);
      }
    }

    const missingFiles = [];
    for (const forecastHour of forecastHours) {
      const outputPath = path.join(inputDir, rawTextFileName(tmfc, forecastHour, level));
      if (!await hasValidKimTextFile(outputPath)) {
        missingFiles.push(forecastHour);
      }
    }

    if (missingFiles.length > 0) {
      console.log(`[${tag}] Skip generation for tmfc=${tmfc}. Missing hf: ${missingFiles.join(',')}`);
      continue;
    }

    if (await hasNonEmptyFile(manifestPath) && downloadedCount === 0 && failedCount === 0) {
      console.log(`[${tag}] Dataset already exists for tmfc=${tmfc}`);
      await updateLatestPointer(kimTextOutputDir, tmfc, level);
      continue;
    }

    try {
      await generateKimTextPng(
        inputDir,
        outputDir,
        tmfc,
        maxHours,
        intervalMinutes,
        downsampleFactor,
        level
      );
      await updateLatestPointer(kimTextOutputDir, tmfc, level);
      console.log(`[${tag}] Dataset ready: ${datasetId}`);
    } catch (err) {
      console.error(`[${tag}] Generation failed for tmfc=${tmfc}:`, err.message);
    }
  }
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
  const levels = parseLevels(KIM_TEXT_LEVELS);
  const shared = {
    maxHours,
    intervalMinutes,
    downsampleFactor,
    forecastHours,
    timeCandidates
  };

  console.log(`[KIM-TXT] levels=${levels.join(',')}`);
  for (const level of levels) {
    await downloadAndGenerateKimTextForLevel(level, shared);
  }
}

schedule.scheduleTask(
  'kim-text-hgt',
  'kim_text_custom',
  () => downloadAndGenerateKimText()
);

// downloadAndGenerateKimText();
console.log('KIM TXT Watcher started. Waiting for scheduled tasks...');
