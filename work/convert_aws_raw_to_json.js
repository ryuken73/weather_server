/**
 * 일회성: work/in 원본 AWS_MIN 텍스트 → work/out/{yyyy-MM-dd}/AWS_MIN_{tm}.json
 *
 * 원본 줄 형식:
 *   STN_ID#TM#LAT#LON#HT#WD#WS#TA#HM#PA#PS#RN_YN#RN_1HR#RN_24HR#RN_15M#RN_60M#WD_INS#WS_INS#=
 *
 * 사용:
 *   node work/convert_aws_raw_to_json.js
 *   node work/convert_aws_raw_to_json.js --dry-run
 *   node work/convert_aws_raw_to_json.js --odd-minutes   # 기본은 짝수분(2분)만
 *
 * 입력: work/in 아래 날짜 폴더의 AWS_MIN_yyyyMMddHHmm (확장자 없어도 됨)
 * 출력: work/out/yyyy-MM-dd/AWS_MIN_yyyyMMddHHmm.json
 * STN_NAME: kma_fetch/config/aws_stn_name_map_20260811.json
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const WORK_DIR = __dirname;
const IN_DIR = path.join(WORK_DIR, 'in');
const OUT_DIR = path.join(WORK_DIR, 'out');
const NAME_MAP_PATH = path.join(
  WORK_DIR,
  '..',
  'kma_fetch',
  'config',
  'aws_stn_name_map_20260811.json'
);

const FILE_RE = /^AWS_MIN_(\d{12})(?:\.json)?$/i;

function parseArgs(argv) {
  const args = { dryRun: false, evenOnly: true };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--odd-minutes') args.evenOnly = false;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function folderDateFromTm(tm) {
  return `${tm.slice(0, 4)}-${tm.slice(4, 6)}-${tm.slice(6, 8)}`;
}

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const body = trimmed.endsWith('=') ? trimmed.slice(0, -1) : trimmed;
  const p = body.split('#');
  if (p.length < 18) {
    throw new Error(`Invalid field count ${p.length}: ${trimmed.slice(0, 80)}`);
  }
  return p;
}

function num(v) {
  if (v === '' || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function filePartsToRow(p, nameMap) {
  const stnId = Number(p[0]);
  const name = nameMap[String(stnId)];
  return {
    STN_NAME: name == null ? null : name,
    STN_ID: stnId,
    TM: p[1],
    LAT: num(p[2]),
    LON: num(p[3]),
    HT: num(p[4]),
    WD: num(p[5]),
    WS: num(p[6]),
    TA: num(p[7]),
    HM: num(p[8]),
    PA: num(p[9]),
    PS: num(p[10]),
    RN_YN: num(p[11]),
    RN_1HR: num(p[12]),
    RN_6HR: null,
    RN_12HR: null,
    RN_24HR: num(p[13]),
    RN_48HR: null,
    RN_15M: num(p[14]),
    RN_60M: num(p[15]),
    WD_INS: num(p[16]),
    WS_INS: num(p[17])
  };
}

async function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await walkFiles(full, out);
    } else if (ent.isFile() && FILE_RE.test(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

async function convertOne(filePath, nameMap, { dryRun, evenOnly }) {
  const base = path.basename(filePath);
  const m = base.match(FILE_RE);
  if (!m) return { status: 'skip_name' };
  const tm = m[1];
  const minute = Number(tm.slice(10, 12));
  if (evenOnly && minute % 2 !== 0) {
    return { status: 'skip_odd', tm };
  }

  const folderDate = folderDateFromTm(tm);
  const outDir = path.join(OUT_DIR, folderDate);
  const outPath = path.join(outDir, `AWS_MIN_${tm}.json`);

  if (!dryRun && fs.existsSync(outPath)) {
    return { status: 'exists', tm, outPath };
  }

  const text = await fsp.readFile(filePath, 'utf8');
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = parseLine(line);
    const row = filePartsToRow(parts, nameMap);
    if (row.TM && row.TM !== tm) {
      // 파일명 TM과 줄 TM이 다르면 줄 TM 우선하지 않고 경고만
      // (정상 원본은 일치)
    }
    rows.push(row);
  }

  if (dryRun) {
    return { status: 'dry', tm, outPath, count: rows.length };
  }

  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(outPath, JSON.stringify(rows), 'utf8');
  return { status: 'saved', tm, outPath, count: rows.length };
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
    console.log(`Usage: node work/convert_aws_raw_to_json.js [--dry-run] [--odd-minutes]
IN : ${IN_DIR}
OUT: ${OUT_DIR}
MAP: ${NAME_MAP_PATH}`);
    return;
  }

  if (!fs.existsSync(NAME_MAP_PATH)) {
    console.error('STN_NAME map not found:', NAME_MAP_PATH);
    process.exit(1);
  }
  const nameMap = JSON.parse(await fsp.readFile(NAME_MAP_PATH, 'utf8'));

  const files = (await walkFiles(IN_DIR)).sort();
  console.log('=== convert AWS raw → JSON ===');
  console.log('in        :', IN_DIR);
  console.log('out       :', OUT_DIR);
  console.log('nameMap   :', NAME_MAP_PATH);
  console.log('files     :', files.length);
  console.log('evenOnly  :', args.evenOnly);
  console.log('dryRun    :', args.dryRun);

  const summary = {
    saved: 0,
    exists: 0,
    dry: 0,
    skip_odd: 0,
    errors: 0
  };

  for (const filePath of files) {
    try {
      const r = await convertOne(filePath, nameMap, args);
      if (r.status === 'saved') {
        summary.saved += 1;
        console.log('saved', r.tm, r.count, '->', r.outPath);
      } else if (r.status === 'exists') {
        summary.exists += 1;
      } else if (r.status === 'dry') {
        summary.dry += 1;
        console.log('dry', r.tm, r.count, '->', r.outPath);
      } else if (r.status === 'skip_odd') {
        summary.skip_odd += 1;
      }
    } catch (err) {
      summary.errors += 1;
      console.error('error', filePath, err.message);
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
