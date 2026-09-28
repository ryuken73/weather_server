/**
 * Pack smoke: AT derive from TA/HM/WS
 *   node kma_fetch/tests/test_aws_at_pack.js
 */
const assert = require('assert');
const path = require('path');
const fsp = require('fs/promises');
const os = require('os');
const { buildAwsVariablePack, MISSING_I16, PACK_VARIABLES } = require('../utils/aws_min_pack');
const { computeApparentTempScaled10 } = require('../utils/aws_apparent_temp');

assert.strictEqual(PACK_VARIABLES.AT.slug, 'at');
assert.strictEqual(PACK_VARIABLES.AT.derive, 'apparentTemperature');

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aws-at-pack-'));
  const jsonRoot = path.join(tmp, 'json');
  const packRoot = path.join(tmp, 'pack');
  const dayDir = path.join(jsonRoot, '2025-12-04');
  await fsp.mkdir(dayDir, { recursive: true });

  const rows = [
    { STN_ID: 90, TM: '202512040000', TA: -50, HM: 800, WS: 40 }, // -5C, 80%, 4m/s winter
    { STN_ID: 108, TM: '202512040000', TA: 100, HM: 500, WS: 10 } // 10C, WS<=1.3 → AT=TA
  ];
  await fsp.writeFile(path.join(dayDir, 'AWS_MIN_202512040000.json'), JSON.stringify(rows) + '\n');

  const rows2 = [
    { STN_ID: 90, TM: '202512040001', TA: -50, HM: 800, WS: 40 },
    { STN_ID: 108, TM: '202512040001', TA: null, HM: 500, WS: 20 }
  ];
  await fsp.writeFile(path.join(dayDir, 'AWS_MIN_202512040001.json'), JSON.stringify(rows2) + '\n');

  const catalog = {
    stations: [
      { STN_ID: 90, STN_NAME: '속초', LAT: 38.25, LON: 128.56, HT: 18 },
      { STN_ID: 108, STN_NAME: '서울', LAT: 37.57, LON: 126.96, HT: 85 }
    ],
    byId: new Map([
      ['90', { STN_ID: 90, STN_NAME: '속초', LAT: 38.25, LON: 128.56, HT: 18 }],
      ['108', { STN_ID: 108, STN_NAME: '서울', LAT: 37.57, LON: 126.96, HT: 85 }]
    ]),
    codeFile: 'test',
    stationCount: 2
  };

  const result = await buildAwsVariablePack(
    jsonRoot,
    '202512040000',
    '202512040001',
    'AT',
    { catalog, force: true, packRoot }
  );
  assert.ok(result.manifest);
  assert.strictEqual(result.manifest.variable, 'AT');
  assert.strictEqual(result.manifest.sourceField, 'derived:apparent_temp');
  assert.strictEqual(result.manifest.frameCount, 2);
  assert.strictEqual(result.manifest.stationCount, 2);
  assert.strictEqual(result.binary.length, 2 * 2 * 2);

  const expected90 = computeApparentTempScaled10({
    taScaled: -50,
    hmScaled: 800,
    wsScaled: 40,
    month: 12
  });
  const view = new Int16Array(
    result.binary.buffer,
    result.binary.byteOffset,
    result.binary.length / 2
  );
  assert.strictEqual(view[0], expected90); // frame0 stn90
  assert.strictEqual(view[1], 100); // frame0 stn108 WS=1.0 → AT=TA
  assert.strictEqual(view[2], expected90); // frame1 stn90
  assert.strictEqual(view[3], MISSING_I16); // frame1 stn108 TA null

  console.log('OK test_aws_at_pack', { expected90, url: result.manifest.data.url });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
