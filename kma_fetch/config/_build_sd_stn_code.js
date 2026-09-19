/**
 * Build sd_stn_code_YYYYMMDD.json from stn_snow Hub (or local raw txt).
 *
 *   USE_API=false NODE_ENV=production node kma_fetch/config/_build_sd_stn_code.js
 *   node kma_fetch/config/_build_sd_stn_code.js --from-file work/out/snow/stn_snow_raw.txt
 *
 * Address: AWS STN_ID join first, then LAW_ID → law_code_sido_sigungu.json
 */
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

function loadDotenv() {
  try {
    const dotenv = require('dotenv');
    for (const p of [
      path.join(__dirname, '..', '.env.production'),
      path.join(__dirname, '..', '.env.development'),
      path.join(__dirname, '..', '..', '.env')
    ]) {
      if (fs.existsSync(p)) dotenv.config({ path: p });
    }
  } catch (_) {
    /* optional */
  }
}

loadDotenv();

const { parseStationsText, fetchSnowStations } = require('../services/kma_apihub_snow');
const { loadStationCatalog } = require('../utils/aws_stn_catalog');
const { loadLawCodeMaster, resolveLawAddr } = require('../utils/law_code_lookup');

const CONFIG_DIR = __dirname;

function takeValue(argv, i, flag) {
  const next = argv[i + 1];
  if (!next || next.startsWith('-')) throw new Error(`${flag} requires a value`);
  return next;
}

function parseArgs(argv) {
  const args = { fromFile: null, ymd: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--from-file') args.fromFile = takeValue(argv, i++, '--from-file');
    else if (a.startsWith('--from-file=')) args.fromFile = a.slice('--from-file='.length);
    else if (a === '--ymd') args.ymd = takeValue(argv, i++, '--ymd');
    else if (a.startsWith('--ymd=')) args.ymd = a.slice('--ymd='.length);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function enrichStations(rawStations) {
  let aws = null;
  try {
    aws = loadStationCatalog();
  } catch (_) {
    aws = null;
  }
  const lawMaster = loadLawCodeMaster();
  const stats = { aws_join: 0, law_code: 0, null: 0 };

  const stations = rawStations.map((s) => {
    const base = {
      STN_ID: s.STN_ID,
      STN_NAME: s.STN_NAME,
      LAT: s.LAT,
      LON: s.LON,
      HT: s.HT,
      STN_SP: s.STN_SP != null ? s.STN_SP : null,
      LAW_ID: s.LAW_ID != null ? String(s.LAW_ID) : null,
      LAW_ADDR_SIDO: null,
      LAW_ADDR_GUGUN: null,
      addrSource: null
    };

    const awsMeta = aws && aws.byId.get(String(s.STN_ID));
    if (awsMeta && (awsMeta.LAW_ADDR_SIDO || awsMeta.LAW_ADDR_GUGUN)) {
      base.LAW_ADDR_SIDO = awsMeta.LAW_ADDR_SIDO != null ? awsMeta.LAW_ADDR_SIDO : null;
      base.LAW_ADDR_GUGUN = awsMeta.LAW_ADDR_GUGUN != null ? awsMeta.LAW_ADDR_GUGUN : null;
      if (!base.STN_NAME && awsMeta.STN_NAME) base.STN_NAME = awsMeta.STN_NAME;
      if (base.LAT == null && awsMeta.LAT != null) base.LAT = awsMeta.LAT;
      if (base.LON == null && awsMeta.LON != null) base.LON = awsMeta.LON;
      if (base.HT == null && awsMeta.HT != null) base.HT = awsMeta.HT;
      base.addrSource = 'aws_join';
      stats.aws_join += 1;
      return base;
    }

    const law = resolveLawAddr(base.LAW_ID, lawMaster);
    if (law.addrSource) {
      base.LAW_ADDR_SIDO = law.LAW_ADDR_SIDO;
      base.LAW_ADDR_GUGUN = law.LAW_ADDR_GUGUN;
      base.addrSource = 'law_code';
      stats.law_code += 1;
    } else {
      stats.null += 1;
    }
    return base;
  });

  stations.sort((a, b) => a.STN_ID - b.STN_ID);
  return { stations, stats, awsStationCount: aws ? aws.stationCount : null };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage:
  node kma_fetch/config/_build_sd_stn_code.js [--ymd YYYYMMDD]
  node kma_fetch/config/_build_sd_stn_code.js --from-file path/to/stn_snow_raw.txt
`);
    return;
  }

  const ymd =
    args.ymd ||
    DateTime.now().setZone('Asia/Seoul').toFormat('yyyyMMdd');

  let rawText;
  let sourceLabel;
  if (args.fromFile) {
    const p = path.resolve(args.fromFile);
    rawText = fs.readFileSync(p, 'utf8');
    sourceLabel = `stn_snow.php file (${path.basename(p)})`;
  } else {
    const result = await fetchSnowStations({ help: 1 });
    rawText = result.text;
    sourceLabel = 'stn_snow.php Hub';
  }

  const rawPath = path.join(CONFIG_DIR, `stn_snow_${ymd}.txt`);
  fs.writeFileSync(rawPath, rawText, 'utf8');

  const rawStations = parseStationsText(rawText);
  const { stations, stats, awsStationCount } = enrichStations(rawStations);

  const codeOut = {
    schemaVersion: 1,
    source: sourceLabel,
    generatedAt: new Date().toISOString(),
    stationCount: stations.length,
    namedCount: stations.filter((s) => s.STN_NAME).length,
    addrStats: stats,
    awsStationCount,
    fields: [
      'STN_ID',
      'STN_NAME',
      'LAT',
      'LON',
      'HT',
      'STN_SP',
      'LAW_ID',
      'LAW_ADDR_SIDO',
      'LAW_ADDR_GUGUN',
      'addrSource'
    ],
    stations
  };

  const codePath = path.join(CONFIG_DIR, `sd_stn_code_${ymd}.json`);
  fs.writeFileSync(codePath, JSON.stringify(codeOut, null, 2) + '\n', 'utf8');

  console.log(
    JSON.stringify(
      {
        rawPath,
        codePath,
        stationCount: stations.length,
        addrStats: stats,
        awsStationCount,
        samples: stations.filter((s) => [90, 108, 100, 119].includes(s.STN_ID))
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
