/**
 * STN 574 RN_DAY QC trace against live Hub exact API + local pack builder path.
 *
 *   node kma_fetch/tests/debug_stn574_qc.js
 *   node kma_fetch/tests/debug_stn574_qc.js --json-dir D:/path/to/in_data/aws
 */
const https = require('https');
const path = require('path');
const fsp = require('fs/promises');
const os = require('os');
const {
  buildAwsVariablePack,
  debugRnDayQcTrace,
  readRnDayRaw,
  normalizeRnDayScaledAtHhmm,
  readRainCrossScaled,
  RN_DAY_QC_LOGIC_REVISION,
  MISSING_I16
} = require('../utils/aws_min_pack');
const { readAwsMinFile } = require('../utils/aws_min_json');

const STN = 574;
const DAY = '20260823';
const SPIKE_HHMM = ['1051', '1056', '1133', '1449'];

function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => resolve(JSON.parse(d)));
      })
      .on('error', reject);
  });
}

function toScaled(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function scaledRnDayOrNull(raw) {
  const s = toScaled(raw);
  if (s == null || s <= -500 || s < 0) return null;
  return s;
}

function scaledFromRow(row, hhmm) {
  return normalizeRnDayScaledAtHhmm(scaledRnDayOrNull(readRnDayRaw(row)), hhmm);
}

async function fetchExactDayRows() {
  const tms = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m++) {
      tms.push(DAY + String(h).padStart(2, '0') + String(m).padStart(2, '0'));
    }
  }
  const rowsByTm = new Map();
  for (let i = 0; i < tms.length; i += 40) {
    await Promise.all(
      tms.slice(i, i + 40).map(async (tm) => {
        const j = await get(`https://weather-map.sbs.co.kr/api/aws/min/exact?timestamp_kor=${tm}`);
        const row = (j.data || []).find((x) => Number(x.STN_ID) === STN);
        if (row) rowsByTm.set(tm, row);
      })
    );
  }
  return { tms, rowsByTm };
}

async function writeFramesFromRows(root, rowsByTm) {
  for (const [tm, row] of rowsByTm) {
    const dayDir = `${tm.slice(0, 4)}-${tm.slice(4, 6)}-${tm.slice(6, 8)}`;
    const dir = path.join(root, dayDir);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `AWS_MIN_${tm}.json`), JSON.stringify([row]), 'utf8');
  }
  await writeFrame(root, '202608222359', [{ STN_ID: STN, RN_DAY: 280, RN_24HR: 280 }]);
  await writeFrame(root, '202608221050', [{ STN_ID: STN, RN_DAY: 0 }]);
}

async function writeFrame(root, tm, rows) {
  const dayDir = `${tm.slice(0, 4)}-${tm.slice(4, 6)}-${tm.slice(6, 8)}`;
  const dir = path.join(root, dayDir);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `AWS_MIN_${tm}.json`), JSON.stringify(rows), 'utf8');
}

async function loadFromJsonDir(jsonDir, tms) {
  const rowsByTm = new Map();
  for (const tm of tms) {
    const { rows } = await readAwsMinFile(jsonDir, tm);
    const row = (rows || []).find((x) => Number(x.STN_ID) === STN);
    if (row) rowsByTm.set(tm, row);
  }
  return rowsByTm;
}

async function main() {
  const jsonDirArg = process.argv.includes('--json-dir')
    ? process.argv[process.argv.indexOf('--json-dir') + 1]
    : null;

  const { tms } = await fetchExactDayRows();
  let rowsByTm;
  let sourceLabel;
  if (jsonDirArg) {
    rowsByTm = await loadFromJsonDir(jsonDirArg, tms);
    sourceLabel = `disk JSON ${jsonDirArg}`;
  } else {
    const fetched = await fetchExactDayRows();
    rowsByTm = fetched.rowsByTm;
    sourceLabel = 'Hub exact API';
  }

  const scaledSeries = [];
  const crossSeries = [];
  const hhmmSeries = [];
  for (const tm of tms) {
    const hhmm = tm.slice(8, 12);
    hhmmSeries.push(hhmm);
    const row = rowsByTm.get(tm) || null;
    if (!row) {
      scaledSeries.push(null);
      crossSeries.push(null);
      continue;
    }
    scaledSeries.push(scaledFromRow(row, hhmm));
    crossSeries.push(readRainCrossScaled(row));
  }

  const targetIndices = SPIKE_HHMM.map((hh) => hhmmSeries.indexOf(hh)).filter((i) => i >= 0);
  const trace = debugRnDayQcTrace(scaledSeries, crossSeries, hhmmSeries, targetIndices);

  console.log('RN_DAY_QC_LOGIC_REVISION', RN_DAY_QC_LOGIC_REVISION);
  console.log('source', sourceLabel, 'rows', rowsByTm.size);
  console.log('rejectMaskSize', trace.rejectMaskSize);
  console.log(JSON.stringify(trace.traces, null, 2));

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'stn574-debug-'));
  await writeFramesFromRows(tmpRoot, rowsByTm);
  const cat = { byId: new Map(), stations: [{ STN_ID: STN }] };
  const latest = [...rowsByTm.keys()].sort().pop() || `${DAY}1749`;
  const pack = await buildAwsVariablePack(tmpRoot, `${DAY}0000`, latest, 'RN_DAY', { catalog: cat });
  const arr = new Int16Array(pack.binary.buffer, pack.binary.byteOffset, pack.binary.length / 2);
  console.log('manifest', {
    rnDayQcLogicRevision: pack.manifest.rnDayQcLogicRevision,
    datasetId: pack.manifest.datasetId,
    generatedAt: pack.manifest.generatedAt
  });
  for (const hh of SPIKE_HHMM) {
    const fi = Number(hh.slice(0, 2)) * 60 + Number(hh.slice(2, 4));
    const v = arr[fi];
    const rec = (pack.qcDetail.records || []).find((r) => r.STN_ID === STN && r.TM === DAY + hh);
    console.log('pack', hh, v === MISSING_I16 ? 'MISSING' : v * 0.1, rec || null);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
