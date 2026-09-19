/**
 * Snow observation JSON I/O
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { DateTime } = require('luxon');
const { sdJsonPath, folderDateFromTm } = require('./sd_paths');

const ZONE = 'Asia/Seoul';

function enumerateTms(from, to, intervalMinutes) {
  let cur = DateTime.fromFormat(from, 'yyyyMMddHHmm', { zone: ZONE });
  const end = DateTime.fromFormat(to, 'yyyyMMddHHmm', { zone: ZONE });
  if (!cur.isValid || !end.isValid || end < cur) {
    throw new Error('Invalid from/to');
  }
  const tms = [];
  while (cur <= end) {
    tms.push(cur.toFormat('yyyyMMddHHmm'));
    cur = cur.plus({ minutes: intervalMinutes });
  }
  return tms;
}

function enumerateTmsForDay(dayYmd, intervalMinutes) {
  const day = String(dayYmd).replace(/-/g, '');
  if (!/^\d{8}$/.test(day)) throw new Error(`Invalid day: ${dayYmd}`);
  return enumerateTms(`${day}0000`, `${day}2359`, intervalMinutes).filter((tm) => {
    const minute = Number(tm.slice(10, 12));
    return minute % intervalMinutes === 0;
  });
}

async function writeSdJson(jsonRoot, tm, rows, options = {}) {
  const outPath = sdJsonPath(jsonRoot, tm);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  const payload = Array.isArray(rows) ? rows : [];
  const partial = `${outPath}.partial`;
  await fsp.writeFile(partial, JSON.stringify(payload) + '\n', 'utf8');
  await fsp.rename(partial, outPath);
  return { path: outPath, stationCount: payload.length };
}

async function readSdJson(jsonRoot, tm) {
  const p = sdJsonPath(jsonRoot, tm);
  const text = await fsp.readFile(p, 'utf8');
  return JSON.parse(text);
}

function listSdJsonTmsForDay(jsonRoot, dayYmd) {
  const day = String(dayYmd).replace(/-/g, '');
  const folder = path.join(jsonRoot, folderDateFromTm(`${day}0000`));
  if (!fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder)
    .map((name) => {
      const m = name.match(/^SD_(\d{12})\.json$/);
      return m ? m[1] : null;
    })
    .filter(Boolean)
    .sort();
}

module.exports = {
  ZONE,
  enumerateTms,
  enumerateTmsForDay,
  writeSdJson,
  readSdJson,
  listSdJsonTmsForDay,
  sdJsonPath
};
