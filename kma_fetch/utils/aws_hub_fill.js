/**
 * DB AWS_MIN rows lack RN_12HR / TD (SQL NULL AS ...).
 * auto source: one Hub fetch per TM, merge those fields by STN_ID.
 */
const HUB_SUPPLEMENT_FIELDS = Object.freeze(['RN_12HR', 'TD']);
const HUB_PHYSICAL_MISSING_MAX = -50;
const SCALED_SENTINEL = -999;
/** Refresh a field if station coverage is below this (0.8 ≈ other rain/wind packs). */
const REFRESH_MIN_COVERAGE = 0.8;
/** Reject force-refetch when Hub station count is below this fraction of existing. */
const REPLACE_MIN_STATION_RATIO = 0.5;

function isFieldPresent(row, field) {
  if (row == null || row[field] == null || row[field] === '') return false;
  const n = Number(row[field]);
  if (!Number.isFinite(n)) return false;
  if (n === SCALED_SENTINEL) return false;
  if (n <= HUB_PHYSICAL_MISSING_MAX * 10) return false;
  return true;
}

function fieldCoverage(rows, field) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  let present = 0;
  for (const row of rows) {
    if (isFieldPresent(row, field)) present += 1;
  }
  return present / rows.length;
}

function rowsNeedHubSupplement(rows, fields = HUB_SUPPLEMENT_FIELDS) {
  if (!Array.isArray(rows) || rows.length === 0) return true;
  return fields.some((f) => fieldCoverage(rows, f) === 0);
}

function rowsNeedFieldRefresh(rows, fields, minCoverage = REFRESH_MIN_COVERAGE) {
  if (!Array.isArray(rows) || rows.length === 0) return true;
  return fields.some((f) => fieldCoverage(rows, f) < minCoverage);
}

/**
 * Keep all DB columns. Fill only missing supplement fields from Hub (same TM, STN_ID).
 * Does not add/remove stations.
 */
function mergeHubSupplement(dbRows, hubRows, fields = HUB_SUPPLEMENT_FIELDS) {
  const hubById = new Map();
  for (const hub of hubRows || []) {
    if (hub == null || hub.STN_ID == null) continue;
    hubById.set(Number(hub.STN_ID), hub);
  }
  let filled = 0;
  const rows = (dbRows || []).map((row) => {
    const hub = hubById.get(Number(row.STN_ID));
    if (!hub) return row;
    let next = null;
    for (const field of fields) {
      if (isFieldPresent(row, field) || !isFieldPresent(hub, field)) continue;
      if (!next) next = { ...row };
      next[field] = hub[field];
      filled += 1;
    }
    return next || row;
  });
  return { rows, filled, hubStationCount: hubById.size };
}

function shouldRejectHubReplace(existingRows, hubRows) {
  if (!Array.isArray(hubRows) || hubRows.length === 0) {
    return { reject: true, reason: 'empty_hub' };
  }
  const existingCount = Array.isArray(existingRows) ? existingRows.length : 0;
  if (existingCount > 0 && hubRows.length < existingCount * REPLACE_MIN_STATION_RATIO) {
    return {
      reject: true,
      reason: 'partial_hub',
      existing: existingCount,
      hub: hubRows.length
    };
  }
  return { reject: false };
}

/**
 * @param {object} opts
 * @param {string} opts.tm
 * @param {object[]} [opts.dbRows]
 * @param {() => Promise<object[]>} opts.fetchHub
 * @param {string[]} [opts.fields]
 */
async function supplementDbRowsFromHub(opts) {
  const fields = opts.fields || HUB_SUPPLEMENT_FIELDS;
  const dbRows = opts.dbRows || [];
  if (dbRows.length === 0) {
    const hubRows = await opts.fetchHub();
    return { rows: hubRows, source: 'hub', filled: 0, warning: null };
  }
  if (!rowsNeedHubSupplement(dbRows, fields)) {
    return { rows: dbRows, source: 'db', filled: 0, warning: null };
  }
  try {
    const hubRows = await opts.fetchHub();
    if (!hubRows || hubRows.length === 0) {
      return {
        rows: dbRows,
        source: 'db',
        filled: 0,
        warning: {
          type: 'aws_hub_supplement_empty',
          tm: opts.tm,
          fields,
          message: 'Hub returned no rows; kept DB rows'
        }
      };
    }
    const merged = mergeHubSupplement(dbRows, hubRows, fields);
    return { rows: merged.rows, source: 'db+hub', filled: merged.filled, warning: null };
  } catch (err) {
    return {
      rows: dbRows,
      source: 'db',
      filled: 0,
      warning: {
        type: 'aws_hub_supplement_failed',
        tm: opts.tm,
        fields,
        message: err && err.message ? err.message : String(err)
      }
    };
  }
}

function logHubSupplementWarning(warning) {
  if (!warning) return;
  console.warn(JSON.stringify(warning));
}

module.exports = {
  HUB_SUPPLEMENT_FIELDS,
  REFRESH_MIN_COVERAGE,
  REPLACE_MIN_STATION_RATIO,
  isFieldPresent,
  fieldCoverage,
  rowsNeedHubSupplement,
  rowsNeedFieldRefresh,
  mergeHubSupplement,
  shouldRejectHubReplace,
  supplementDbRowsFromHub,
  logHubSupplementWarning
};
