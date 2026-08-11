/**
 * 일회성: 기상청 API허브 AWS 매분자료 → work/out/{yyyy-MM-dd}/AWS_MIN_{tm}.json
 *
 * API:
 *   https://apihub-pub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min
 *   stn=0(전체)일 때 구간 최대 10분 → 10분 창으로 순회
 *
 * 사용:
 *   set API_KEY=...   (또는 kma_fetch/.env.production 에 API_KEY)
 *   node work/fetch_aws_apihub.js --from 20260712 --to 20260803
 *   node work/fetch_aws_apihub.js --from 2026-07-12 --to 2026-08-03 --sleep 300
 *   node work/fetch_aws_apihub.js --from 202607120000 --to 202607120029 --dry-run
 *
 * 옵션:
 *   --from / --to   YYYYMMDD | YYYY-MM-DD | YYYYMMDDHHmm
 *   --sleep N       호출 간격 ms (기본 300)
 *   --even-only     짝수분만 저장 (기본 true, --all-minutes 로 해제)
 *   --save-raw      work/in/apihub/{date}/ 에 원문 저장
 *   --force         기존 JSON 있어도 덮어쓰기
 *   --dry-run       실제 HTTP 없이 창 목록만 출력
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const axios = require('axios');
const { DateTime } = require('luxon');

const WORK_DIR = __dirname;
const OUT_DIR = path.join(WORK_DIR, 'out');
const RAW_DIR = path.join(WORK_DIR, 'in', 'apihub');
const NAME_MAP_PATH = path.join(WORK_DIR, '..', 'kma_fetch', 'config', 'aws_stn_name_map_20260811.json');
const STN_CODE_PATH = path.join(WORK_DIR, '..', 'kma_fetch', 'config', 'aws_stn_code_20260811.json');

const API_BASE = 'https://apihub-pub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min';
const ZONE = 'Asia/Seoul';
const WINDOW_MINUTES = 10;
const MISSING_LT = -50; // 문서: -50 이하면 결측

function loadDotenv() {
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    const dotenv = require('dotenv');
    const candidates = [
      path.join(WORK_DIR, '..', 'kma_fetch', '.env.production'),
      path.join(WORK_DIR, '..', 'kma_fetch', '.env.development'),
      path.join(WORK_DIR, '..', '.env')
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) dotenv.config({ path: p });
    }
  } catch (_) {
    // dotenv optional if API_KEY already in env
  }
}

function usage() {
  console.log(`Usage:
  node work/fetch_aws_apihub.js --from <date> --to <date> [options]

Examples:
  node work/fetch_aws_apihub.js --from 20260712 --to 20260803
  node work/fetch_aws_apihub.js --from 2026-07-12T00:00 --to 2026-07-12T00:29 --sleep 200 --save-raw
`);
}

function parseArgs(argv) {
  const args = {
    from: null,
    to: null,
    sleepMs: 300,
    evenOnly: true,
    saveRaw: false,
    force: false,
    dryRun: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      i += 1;
      return argv[i];
    };
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--from') args.from = next();
    else if (a === '--to') args.to = next();
    else if (a.startsWith('--from=')) args.from = a.slice('--from='.length);
    else if (a.startsWith('--to=')) args.to = a.slice('--to='.length);
    else if (a === '--sleep') args.sleepMs = Number(next());
    else if (a.startsWith('--sleep=')) args.sleepMs = Number(a.slice('--sleep='.length));
    else if (a === '--all-minutes') args.evenOnly = false;
    else if (a === '--even-only') args.evenOnly = true;
    else if (a === '--save-raw') args.saveRaw = true;
    else if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

/** @returns {DateTime} */
function parseKstInput(input, endOfDay) {
  const s = String(input).trim();
  let dt;
  if (/^\d{12}$/.test(s)) {
    dt = DateTime.fromFormat(s, 'yyyyMMddHHmm', { zone: ZONE });
  } else if (/^\d{8}$/.test(s)) {
    dt = DateTime.fromFormat(s, 'yyyyMMdd', { zone: ZONE });
    if (endOfDay) dt = dt.endOf('day').startOf('minute');
    else dt = dt.startOf('day');
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    dt = DateTime.fromISO(s, { zone: ZONE });
    if (endOfDay) dt = dt.endOf('day').startOf('minute');
    else dt = dt.startOf('day');
  } else {
    dt = DateTime.fromISO(s, { zone: ZONE });
  }
  if (!dt.isValid) {
    throw new Error(`Invalid datetime: ${input} (${dt.invalidExplanation})`);
  }
  return dt.set({ second: 0, millisecond: 0 });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function folderDateFromTm(tm) {
  return `${tm.slice(0, 4)}-${tm.slice(4, 6)}-${tm.slice(6, 8)}`;
}

function scale10(v) {
  if (v == null || Number.isNaN(v)) return null;
  if (v <= MISSING_LT) return null;
  return Math.round(v * 10);
}

function scaleRain(v) {
  // DB/내부 JSON은 정수(0.1mm 단위로 보는 편이 기존 #파일과 맞음: 1.0mm → 10)
  return scale10(v);
}

function isMissing(v) {
  return v == null || Number.isNaN(v) || v <= MISSING_LT;
}

/**
 * API 물리단위 → main_AWS MSSQL JSON 과 같은 스케일
 * LAT/LON/HT 는 코드표에서 보강
 */
function apiRowToDbShape(parts, nameMap, stnMeta) {
  // YYMMDDHHMI STN WD1 WS1 WDS WSS WD10 WS10 TA RE RN-15m RN-60m RN-12H RN-DAY HM PA PS TD
  const tm = parts[0];
  const stnId = Number(parts[1]);
  const meta = stnMeta.get(String(stnId)) || {};
  const wd1 = Number(parts[2]);
  const ws1 = Number(parts[3]);
  const wds = Number(parts[4]);
  const wss = Number(parts[5]);
  const ta = Number(parts[8]);
  const re = Number(parts[9]);
  const rn15 = Number(parts[10]);
  const rn60 = Number(parts[11]);
  const rnDay = Number(parts[13]);
  const hm = Number(parts[14]);
  const pa = Number(parts[15]);
  const ps = Number(parts[16]);

  return {
    STN_NAME: nameMap[String(stnId)] == null ? null : nameMap[String(stnId)],
    STN_ID: stnId,
    TM: tm,
    LAT: meta.LAT != null ? meta.LAT : null,
    LON: meta.LON != null ? meta.LON : null,
    HT: meta.HT != null ? meta.HT : null,
    WD: scale10(wd1),
    WS: scale10(ws1),
    TA: scale10(ta),
    HM: scale10(hm),
    PA: scale10(pa),
    PS: scale10(ps),
    RN_YN: isMissing(re) ? null : (re === 0 ? 0 : 1),
    RN_1HR: scaleRain(rn60),
    RN_6HR: null,
    RN_12HR: null,
    RN_24HR: scaleRain(rnDay),
    RN_48HR: null,
    RN_15M: scaleRain(rn15),
    RN_60M: scaleRain(rn60),
    WD_INS: scale10(wds),
    WS_INS: scale10(wss)
  };
}

function parseApiText(text) {
  const byTm = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // skip header-ish
    if (/^YYMMDDHHMI/i.test(line) || /^KST\b/i.test(line)) continue;

    const parts = line.split(/[,\s]+/).filter(Boolean);
    if (parts.length < 17) continue;
    if (!/^\d{12}$/.test(parts[0])) continue;
    if (!/^\d+$/.test(parts[1])) continue;

    const tm = parts[0];
    if (!byTm.has(tm)) byTm.set(tm, []);
    byTm.get(tm).push(parts);
  }
  return byTm;
}

function buildWindows(fromDt, toDt) {
  const windows = [];
  let cur = fromDt;
  while (cur <= toDt) {
    const winEnd = DateTime.min(cur.plus({ minutes: WINDOW_MINUTES - 1 }), toDt);
    windows.push({
      tm1: cur.toFormat('yyyyMMddHHmm'),
      tm2: winEnd.toFormat('yyyyMMddHHmm')
    });
    cur = cur.plus({ minutes: WINDOW_MINUTES });
  }
  return windows;
}

async function fetchWindow(authKey, tm1, tm2) {
  const url = `${API_BASE}?tm1=${tm1}&tm2=${tm2}&stn=0&disp=0&help=0&authKey=${encodeURIComponent(authKey)}`;
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 120000,
    validateStatus: () => true
  });
  const buf = Buffer.from(res.data);
  // 숫자 위주라 utf8/latin1 모두 가능. 헬프 문구는 help=0 이라 거의 ASCII.
  const text = buf.toString('utf8');
  if (res.status !== 200) {
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    err.body = text.slice(0, 500);
    throw err;
  }
  if (/인증|authKey|Unauthorized|오류|error/i.test(text) && !/\d{12}\s+\d+/.test(text)) {
    const err = new Error(`API error body: ${text.slice(0, 300)}`);
    err.body = text.slice(0, 500);
    throw err;
  }
  return text;
}

async function main() {
  loadDotenv();
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    usage();
    process.exit(1);
  }
  if (args.help) {
    usage();
    return;
  }
  if (!args.from || !args.to) {
    console.error('--from and --to are required');
    usage();
    process.exit(1);
  }

  const fromDt = parseKstInput(args.from, false);
  const toDt = parseKstInput(args.to, true);
  if (toDt < fromDt) {
    console.error('to must be >= from');
    process.exit(1);
  }

  const authKey = process.env.API_KEY || process.env.KMA_API_KEY;
  if (!args.dryRun && !authKey) {
    console.error('API_KEY (or KMA_API_KEY) env is required');
    process.exit(1);
  }

  const nameMap = JSON.parse(await fsp.readFile(NAME_MAP_PATH, 'utf8'));
  const codeDoc = JSON.parse(await fsp.readFile(STN_CODE_PATH, 'utf8'));
  const stnMeta = new Map(
    (codeDoc.stations || []).map((s) => [String(s.STN_ID), s])
  );

  const windows = buildWindows(fromDt, toDt);
  console.log('=== fetch AWS API Hub → JSON ===');
  console.log('from      :', fromDt.toISO());
  console.log('to        :', toDt.toISO());
  console.log('windows   :', windows.length, `(${WINDOW_MINUTES} min each)`);
  console.log('evenOnly  :', args.evenOnly);
  console.log('sleepMs   :', args.sleepMs);
  console.log('out       :', OUT_DIR);
  console.log('dryRun    :', args.dryRun);
  console.log('est.calls :', windows.length);

  if (args.dryRun) {
    console.log('--- windows ---');
    for (const w of windows.slice(0, 20)) console.log(w.tm1, '->', w.tm2);
    if (windows.length > 20) console.log(`... +${windows.length - 20} more`);
    return;
  }

  const summary = {
    windowsOk: 0,
    windowsFail: 0,
    saved: 0,
    skippedExists: 0,
    skippedOdd: 0,
    emptyTm: 0
  };

  for (let i = 0; i < windows.length; i++) {
    const { tm1, tm2 } = windows[i];
    process.stdout.write(`[${i + 1}/${windows.length}] ${tm1}-${tm2} `);
    let text;
    try {
      text = await fetchWindow(authKey, tm1, tm2);
      summary.windowsOk += 1;
    } catch (err) {
      summary.windowsFail += 1;
      console.log('FAIL', err.message);
      // simple retry once
      try {
        await sleep(Math.max(args.sleepMs, 1000));
        text = await fetchWindow(authKey, tm1, tm2);
        summary.windowsFail -= 1;
        summary.windowsOk += 1;
        console.log('  retry OK');
      } catch (err2) {
        console.log('  retry FAIL', err2.message);
        await sleep(args.sleepMs);
        continue;
      }
    }

    if (args.saveRaw) {
      const day = folderDateFromTm(tm1);
      const rawDir = path.join(RAW_DIR, day);
      await fsp.mkdir(rawDir, { recursive: true });
      await fsp.writeFile(path.join(rawDir, `${tm1}_${tm2}.txt`), text, 'utf8');
    }

    const byTm = parseApiText(text);
    let savedInWin = 0;
    for (const [tm, rowsParts] of byTm.entries()) {
      const minute = Number(tm.slice(10, 12));
      if (args.evenOnly && minute % 2 !== 0) {
        summary.skippedOdd += 1;
        continue;
      }
      const outDir = path.join(OUT_DIR, folderDateFromTm(tm));
      const outPath = path.join(outDir, `AWS_MIN_${tm}.json`);
      if (!args.force && fs.existsSync(outPath)) {
        summary.skippedExists += 1;
        continue;
      }
      const rows = rowsParts.map((p) => apiRowToDbShape(p, nameMap, stnMeta));
      if (rows.length === 0) {
        summary.emptyTm += 1;
        continue;
      }
      await fsp.mkdir(outDir, { recursive: true });
      await fsp.writeFile(outPath, JSON.stringify(rows), 'utf8');
      summary.saved += 1;
      savedInWin += 1;
    }
    console.log(`ok tms=${byTm.size} saved=${savedInWin}`);
    if (args.sleepMs > 0 && i < windows.length - 1) {
      await sleep(args.sleepMs);
    }
  }

  console.log('=== summary ===');
  console.log(summary);
  if (summary.windowsFail > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
