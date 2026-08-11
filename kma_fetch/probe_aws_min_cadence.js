/**
 * 운영 Gate0: DB / in_data 에 1분(홀수분) 자료가 있는지 확인
 *
 *   set USE_API=false
 *   node kma_fetch/probe_aws_min_cadence.js
 *   NODE_ENV=production USE_API=false node kma_fetch/probe_aws_min_cadence.js --day 2026-08-11
 */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const envMode = process.env.NODE_ENV || 'development';
dotenv.config({ path: path.resolve(__dirname, `.env.${envMode}`) });

const BASE_DIR = process.env.BASE_DIR || './data/weather';

function resolveInDataAws() {
  const normalized = path.normalize(
    path.isAbsolute(BASE_DIR) ? BASE_DIR : path.resolve(__dirname, '..', BASE_DIR)
  );
  const baseName = path.basename(normalized);
  if (baseName === 'in_data') return path.join(normalized, 'aws');
  if (baseName === 'out_data') return path.join(path.dirname(normalized), 'in_data', 'aws');
  return path.join(normalized, 'in_data', 'aws');
}

function probeDisk(dayFilter) {
  const root = resolveInDataAws();
  const out = { root, exists: fs.existsSync(root), days: [] };
  if (!out.exists) return out;

  const days = fs
    .readdirSync(root)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .filter((d) => !dayFilter || d === dayFilter)
    .sort()
    .slice(-5);

  for (const day of days) {
    const files = fs
      .readdirSync(path.join(root, day))
      .filter((f) => /^AWS_MIN_\d{12}\.json$/.test(f));
    const odd = files.filter((f) => Number(f.slice(16, 18)) % 2 === 1);
    const even = files.filter((f) => Number(f.slice(16, 18)) % 2 === 0);
    out.days.push({
      day,
      total: files.length,
      even: even.length,
      odd: odd.length,
      oddSample: odd.slice(0, 5)
    });
  }
  return out;
}

async function probeDb() {
  if (!process.env.MSSQL_HOST) {
    return { configured: false, oddSamples: [] };
  }
  // lazy require — env.js API_KEY 검사 회피 위해 mssql 직접
  const sql = require('mssql');
  const pool = new sql.ConnectionPool({
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWD,
    server: process.env.MSSQL_HOST,
    database: process.env.MSSQL_DB,
    options: { encrypt: false }
  });
  await pool.connect();
  try {
    const result = await pool.request().query(`
      SELECT TOP 10 TM, COUNT(*) AS cnt
      FROM dbo.wx_AWS_MIN
      WHERE CAST(SUBSTRING(TM, 11, 2) AS INT) % 2 = 1
      GROUP BY TM
      ORDER BY TM DESC
    `);
    return { configured: true, oddSamples: result.recordset };
  } finally {
    await pool.close();
  }
}

async function main() {
  const dayArgIdx = process.argv.indexOf('--day');
  const dayFilter = dayArgIdx >= 0 ? process.argv[dayArgIdx + 1] : null;
  const disk = probeDisk(dayFilter);
  let dbProbe;
  try {
    dbProbe = await probeDb();
  } catch (err) {
    dbProbe = { configured: !!process.env.MSSQL_HOST, error: err.message, oddSamples: [] };
  }

  const report = {
    probedAt: new Date().toISOString(),
    BASE_DIR,
    disk,
    db: dbProbe,
    verdict: {
      diskHasOdd: (disk.days || []).some((d) => d.odd > 0),
      dbHasOdd: (dbProbe.oddSamples || []).length > 0
    }
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
