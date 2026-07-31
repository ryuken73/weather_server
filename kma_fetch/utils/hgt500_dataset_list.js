const fs = require('fs/promises');
const path = require('path');

const DATASET_ID_RE = /^kim-glob-hgt500-(\d{10})$/;

/**
 * Build list item from datasetId + manifest (same shape as /api/hgt500/latest fields).
 * @param {string} datasetId
 * @param {object} manifest
 */
function itemFromManifest(datasetId, manifest) {
  const match = DATASET_ID_RE.exec(datasetId);
  const tmfc = match ? match[1] : null;
  const frames = Array.isArray(manifest.frames) ? manifest.frames : [];
  const firstFrame = frames[0] || {};
  const lastFrame = frames[frames.length - 1] || {};
  const analysisTime = tmfcToIso(tmfc);

  return {
    datasetId,
    tmfc,
    status: 'succeeded',
    sourceFormat: manifest.source?.format || 'kim-api-text',
    downsampleFactor: Number.isFinite(Number(manifest.source?.downsampleFactor))
      ? Number(manifest.source.downsampleFactor)
      : null,
    analysisTime,
    validTimeStart: firstFrame.validTime || null,
    validTimeEnd: lastFrame.validTime || null,
    sourceForecastIntervalMinutes: manifest.sourceForecastIntervalMinutes ?? null,
    outputFrameIntervalMinutes: manifest.outputFrameIntervalMinutes ?? null,
    frameCount: frames.length,
    manifestUrl: `/datasets/${datasetId}/manifest.json`,
  };
}

/**
 * @param {string|null|undefined} tmfc YYYYMMDDHH UTC
 */
function tmfcToIso(tmfc) {
  if (!tmfc || !/^\d{10}$/.test(tmfc)) return null;
  const y = tmfc.slice(0, 4);
  const m = tmfc.slice(4, 6);
  const d = tmfc.slice(6, 8);
  const h = tmfc.slice(8, 10);
  return `${y}-${m}-${d}T${h}:00:00Z`;
}

/**
 * @param {string|null|undefined} value
 * @returns {number|null}
 */
function parseIsoMs(value) {
  if (value == null || value === '') return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Inclusive overlap of [aStart,aEnd] with [bStart,bEnd]. Open bounds allowed.
 */
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  const a0 = aStart == null ? -Infinity : aStart;
  const a1 = aEnd == null ? Infinity : aEnd;
  const b0 = bStart == null ? -Infinity : bStart;
  const b1 = bEnd == null ? Infinity : bEnd;
  return a0 <= b1 && b0 <= a1;
}

/**
 * @param {string} datasetDir absolute path to .../datasets
 * @param {{
 *   tmfc?: string,
 *   from?: string,
 *   to?: string,
 *   intervalMinutes?: string|number,
 *   downsampleFactor?: string|number,
 *   sourceFormat?: string,
 *   status?: string,
 * }} [query]
 */
async function listHgt500Datasets(datasetDir, query = {}) {
  const statusFilter = query.status == null || query.status === ''
    ? 'succeeded'
    : String(query.status);
  const tmfcFilter = query.tmfc != null && query.tmfc !== ''
    ? String(query.tmfc)
    : null;
  const fromMs = parseIsoMs(query.from);
  const toMs = parseIsoMs(query.to);
  const intervalFilter = query.intervalMinutes != null && query.intervalMinutes !== ''
    ? Number(query.intervalMinutes)
    : null;
  const downsampleFilter = query.downsampleFactor != null && query.downsampleFactor !== ''
    ? Number(query.downsampleFactor)
    : null;
  const sourceFormatFilter = query.sourceFormat != null && query.sourceFormat !== ''
    ? String(query.sourceFormat)
    : null;

  if (tmfcFilter && !/^\d{10}$/.test(tmfcFilter)) {
    const err = new Error('Invalid tmfc (expected YYYYMMDDHH UTC)');
    err.code = 'BAD_QUERY';
    throw err;
  }
  if (query.from && fromMs == null) {
    const err = new Error('Invalid from (expected ISO-8601)');
    err.code = 'BAD_QUERY';
    throw err;
  }
  if (query.to && toMs == null) {
    const err = new Error('Invalid to (expected ISO-8601)');
    err.code = 'BAD_QUERY';
    throw err;
  }

  let entries = [];
  try {
    entries = await fs.readdir(datasetDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { items: [] };
    throw err;
  }

  const items = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const match = DATASET_ID_RE.exec(ent.name);
    if (!match) continue;
    if (tmfcFilter && match[1] !== tmfcFilter) continue;

    const manifestPath = path.join(datasetDir, ent.name, 'manifest.json');
    let manifest;
    try {
      const raw = await fs.readFile(manifestPath, 'utf8');
      manifest = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!manifest || typeof manifest !== 'object') continue;
    if (manifest.schemaVersion != null && Number(manifest.schemaVersion) !== 1) continue;

    const item = itemFromManifest(ent.name, manifest);
    if (statusFilter !== 'all' && item.status !== statusFilter) continue;
    if (sourceFormatFilter && item.sourceFormat !== sourceFormatFilter) continue;
    if (
      Number.isFinite(intervalFilter)
      && Number(item.outputFrameIntervalMinutes) !== intervalFilter
    ) {
      continue;
    }
    if (
      Number.isFinite(downsampleFilter)
      && Number(item.downsampleFactor) !== downsampleFilter
    ) {
      continue;
    }

    const validStartMs = parseIsoMs(item.validTimeStart);
    const validEndMs = parseIsoMs(item.validTimeEnd);
    if (fromMs != null || toMs != null) {
      if (validStartMs == null && validEndMs == null) continue;
      if (!rangesOverlap(validStartMs, validEndMs, fromMs, toMs)) continue;
    }

    items.push(item);
  }

  items.sort((a, b) => String(b.tmfc || '').localeCompare(String(a.tmfc || '')));
  return { items };
}

module.exports = {
  DATASET_ID_RE,
  itemFromManifest,
  listHgt500Datasets,
  tmfcToIso,
};
