/**
 * 기존 AWS_MIN_*.json 의 STN_NAME 을 stn_inf 코드표로 갱신.
 * LAW_ADDR_* 는 디스크에 넣지 않음 (HTTP enrich /stations 용).
 *
 * Usage:
 *   node kma_fetch/patch_aws_min_stn_names.js --dry-run
 *   node kma_fetch/patch_aws_min_stn_names.js
 *   node kma_fetch/patch_aws_min_stn_names.js --root /path/to/in_data/aws
 *   node kma_fetch/patch_aws_min_stn_names.js --day 2026-08-10
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { deriveAwsJsonDir } = require('./utils/aws_min_json');
const { loadStationCatalog, patchAwsRowsForSave } = require('./utils/aws_stn_catalog');

const FILE_RE = /^AWS_MIN_\d{12}\.json$/;

function parseArgs(argv) {
  const args = { dryRun: false, root: null, day: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--root') args.root = argv[++i];
    else if (a.startsWith('--root=')) args.root = a.slice('--root='.length);
    else if (a === '--day') args.day = argv[++i];
    else if (a.startsWith('--day=')) args.day = a.slice('--day='.length);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function resolveAwsRoot(args) {
  if (args.root) return path.resolve(args.root);
  // server.js 와 동일: 프로젝트 루트 기준 derive
  const projectRoot = path.join(__dirname, '..');
  return deriveAwsJsonDir(projectRoot);
}

async function listDayDirs(awsRoot, dayFilter) {
  const entries = await fsp.readdir(awsRoot, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .filter((name) => !dayFilter || name === dayFilter)
    .sort();
}

async function patchFile(filePath, catalog, dryRun) {
  const raw = await fsp.readFile(filePath, 'utf8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) {
    return { status: 'bad_shape' };
  }

  let renamed = 0;
  let unknown = 0;
  for (const row of data) {
    const id = row && row.STN_ID != null ? String(row.STN_ID) : null;
    const meta = id ? catalog.byId.get(id) : null;
    if (!meta) {
      unknown += 1;
      continue;
    }
    if (meta.STN_NAME != null && row.STN_NAME !== meta.STN_NAME) {
      renamed += 1;
    }
  }

  if (renamed === 0) {
    return { status: 'unchanged', renamed: 0, unknown, rows: data.length };
  }

  const next = patchAwsRowsForSave(data, catalog);
  if (!dryRun) {
    await fsp.writeFile(filePath, JSON.stringify(next), 'utf8');
  }
  return { status: dryRun ? 'would_patch' : 'patched', renamed, unknown, rows: data.length };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (args.help) {
    console.log(`Usage: node kma_fetch/patch_aws_min_stn_names.js [--dry-run] [--root DIR] [--day YYYY-MM-DD]`);
    process.exit(0);
  }

  const awsRoot = resolveAwsRoot(args);
  const catalog = loadStationCatalog();

  console.log('=== patch AWS_MIN STN_NAME ===');
  console.log('awsRoot  :', awsRoot);
  console.log('codeFile :', catalog.codeFile);
  console.log('stations :', catalog.stationCount);
  console.log('dry-run  :', args.dryRun);
  console.log('day      :', args.day || '(all)');

  if (!fs.existsSync(awsRoot)) {
    console.error('AWS root does not exist:', awsRoot);
    process.exit(1);
  }

  const days = await listDayDirs(awsRoot, args.day);
  const summary = {
    files: 0,
    patched: 0,
    would_patch: 0,
    unchanged: 0,
    bad_shape: 0,
    renamedTotal: 0,
    errors: 0
  };

  for (const day of days) {
    const dayDir = path.join(awsRoot, day);
    const names = (await fsp.readdir(dayDir)).filter((n) => FILE_RE.test(n)).sort();
    for (const name of names) {
      const fp = path.join(dayDir, name);
      summary.files += 1;
      try {
        const r = await patchFile(fp, catalog, args.dryRun);
        summary[r.status] = (summary[r.status] || 0) + 1;
        if (r.renamed) summary.renamedTotal += r.renamed;
        if (r.status === 'patched' || r.status === 'would_patch') {
          console.log(r.status, day, name, 'renamedRows=', r.renamed, 'unknown=', r.unknown);
        }
      } catch (err) {
        summary.errors += 1;
        console.error('error', fp, err.message);
      }
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
