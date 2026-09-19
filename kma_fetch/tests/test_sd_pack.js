/**
 *   node kma_fetch/tests/test_sd_pack.js
 */
const assert = require('assert');
const path = require('path');
const fsp = require('fs/promises');
const os = require('os');
const {
  encodeSnowToI16,
  buildSdVariablePack,
  MISSING_I16,
  parseSdPackVariables
} = require('../utils/sd_pack');
const { writeSdJson } = require('../utils/sd_json');
const { clearSdStationCatalogCache } = require('../utils/sd_stn_catalog');

assert.strictEqual(encodeSnowToI16(0), 0);
assert.strictEqual(encodeSnowToI16(125), 125);
assert.strictEqual(encodeSnowToI16(null), MISSING_I16);
assert.strictEqual(encodeSnowToI16(-999), MISSING_I16);
assert.deepStrictEqual(parseSdPackVariables('SD_TOT,SD_24H'), ['SD_TOT', 'SD_24H']);

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sd-pack-'));
  const jsonRoot = path.join(tmp, 'json');
  const packRoot = path.join(tmp, 'pack');
  const configDir = path.join(tmp, 'config');
  await fsp.mkdir(configDir, { recursive: true });

  const code = {
    schemaVersion: 1,
    source: 'test',
    generatedAt: new Date().toISOString(),
    stationCount: 2,
    stations: [
      {
        STN_ID: 90,
        STN_NAME: '속초',
        LAT: 38.25,
        LON: 128.56,
        HT: 18,
        LAW_ADDR_SIDO: '강원특별자치도',
        LAW_ADDR_GUGUN: '고성군'
      },
      {
        STN_ID: 108,
        STN_NAME: '서울',
        LAT: 37.57,
        LON: 126.96,
        HT: 85,
        LAW_ADDR_SIDO: '서울특별시',
        LAW_ADDR_GUGUN: '종로구'
      }
    ]
  };
  const codePath = path.join(configDir, 'sd_stn_code_20990101.json');
  await fsp.writeFile(codePath, JSON.stringify(code) + '\n');
  clearSdStationCatalogCache();
  const { loadSdStationCatalog } = require('../utils/sd_stn_catalog');
  const catalog = loadSdStationCatalog({ codePath, force: true });

  await writeSdJson(jsonRoot, '202512021200', [
    { STN_ID: 90, TM: '202512021200', SD_TOT: 450, SD_24H: 120 },
    { STN_ID: 108, TM: '202512021200', SD_TOT: 0, SD_24H: null }
  ]);
  await writeSdJson(jsonRoot, '202512021230', [
    { STN_ID: 90, TM: '202512021230', SD_TOT: 460, SD_24H: 130 },
    { STN_ID: 108, TM: '202512021230', SD_TOT: 5, SD_24H: 5 }
  ]);

  const result = await buildSdVariablePack(jsonRoot, packRoot, '20251202', 'SD_TOT', {
    catalog,
    intervalMinutes: 30,
    force: true
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.manifest.frameCount, 2);
  assert.strictEqual(result.manifest.stationCount, 2);
  assert.strictEqual(result.manifest.data.byteLength, 2 * 2 * 2);
  assert.strictEqual(result.manifest.unit, 'cm');

  console.log('OK test_sd_pack');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
