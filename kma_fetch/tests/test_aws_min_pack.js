/**
 * Pack builder parity fixture (15:32 / 15:33 peak / 15:34)
 *
 *   node kma_fetch/tests/test_aws_min_pack.js
 */
const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const {
  buildAwsTaPack,
  publishAwsTaPack,
  encodeTaToI16,
  parsePackVariables,
  packDayBounds,
  isPackImmutableCacheable,
  packManifestCacheHeaders,
  PACK_SCHEMA_VERSION,
  MISSING_I16
} = require('../utils/aws_min_pack');

async function writeFrame(awsRoot, tm, rows) {
  const day = `${tm.slice(0, 4)}-${tm.slice(4, 6)}-${tm.slice(6, 8)}`;
  const dir = path.join(awsRoot, day);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `AWS_MIN_${tm}.json`), JSON.stringify(rows), 'utf8');
}

async function main() {
  assert.strictEqual(encodeTaToI16(408), 408);
  assert.strictEqual(encodeTaToI16(413), 413);
  assert.strictEqual(encodeTaToI16(null), MISSING_I16);
  assert.strictEqual(encodeTaToI16(-999), MISSING_I16); // DB/×10 sentinel
  assert.strictEqual(encodeTaToI16(-500), MISSING_I16); // Hub ≤ -50℃
  assert.strictEqual(encodeTaToI16(-501), MISSING_I16);
  assert.strictEqual(encodeTaToI16(-150), -150); // -15.0℃ keep
  assert.strictEqual(encodeTaToI16(-400), -400); // -40.0℃ keep
  assert.strictEqual(encodeTaToI16(601), MISSING_I16); // > 60℃ out of range
  assert.strictEqual(encodeTaToI16(600), 600);

  assert.deepStrictEqual(parsePackVariables(undefined), ['TA']);
  assert.deepStrictEqual(parsePackVariables('ta'), ['TA']);
  assert.deepStrictEqual(parsePackVariables('TA,TA'), ['TA']);
  assert.deepStrictEqual(packDayBounds('2026-08-11'), {
    yyyymmdd: '20260811',
    from: '202608110000',
    to: '202608112359'
  });
  assert.throws(() => parsePackVariables('FULL'), /FULL is not supported/);
  assert.throws(() => parsePackVariables('WS'), /Unsupported pack variable: WS/);
  assert.throws(() => parsePackVariables('TA,WS'), /Unsupported pack variable: WS/);

  assert.strictEqual(isPackImmutableCacheable({ complete: true, schemaVersion: 2 }), true);
  assert.strictEqual(isPackImmutableCacheable({ complete: true, schemaVersion: 1 }), false);
  assert.strictEqual(isPackImmutableCacheable({ complete: false, schemaVersion: 2 }), false);
  assert.strictEqual(
    packManifestCacheHeaders({ complete: true, schemaVersion: 2, datasetId: 'x' })['Cache-Control'],
    'public, max-age=31536000, immutable'
  );
  assert.strictEqual(
    packManifestCacheHeaders({ complete: false, schemaVersion: 2, datasetId: 'x' })['Cache-Control'],
    'no-store'
  );

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aws-pack-'));
  const awsRoot = path.join(tmp, 'aws');
  const packRoot = path.join(tmp, 'pack');

  const stnA = 9001;
  const stnB = 9002;
  await writeFrame(awsRoot, '202608121532', [
    { STN_ID: stnA, TM: '202608121532', TA: 408, LAT: 1, LON: 2, HT: 3, STN_NAME: 'A' },
    { STN_ID: stnB, TM: '202608121532', TA: 300, LAT: 1, LON: 2, HT: 3, STN_NAME: 'B' }
  ]);
  await writeFrame(awsRoot, '202608121533', [
    { STN_ID: stnA, TM: '202608121533', TA: 413, LAT: 1, LON: 2, HT: 3, STN_NAME: 'A' },
    { STN_ID: stnB, TM: '202608121533', TA: 301, LAT: 1, LON: 2, HT: 3, STN_NAME: 'B' }
  ]);
  await writeFrame(awsRoot, '202608121534', [
    { STN_ID: stnA, TM: '202608121534', TA: 409, LAT: 1, LON: 2, HT: 3, STN_NAME: 'A' },
    { STN_ID: stnB, TM: '202608121534', TA: -999, LAT: 1, LON: 2, HT: 3, STN_NAME: 'B' }
  ]);
  // 15:35 missing entire frame

  const built = await buildAwsTaPack(awsRoot, '202608121532', '202608121535', {
    catalog: {
      byId: new Map([
        [
          String(stnA),
          {
            STN_ID: stnA,
            STN_NAME: 'A',
            LAT: 1,
            LON: 2,
            HT: 3,
            LAW_ADDR_SIDO: '경기도',
            LAW_ADDR_GUGUN: '수원시'
          }
        ],
        [
          String(stnB),
          {
            STN_ID: stnB,
            STN_NAME: 'B',
            LAT: 1,
            LON: 2,
            HT: 3,
            LAW_ADDR_SIDO: '경기도',
            LAW_ADDR_GUGUN: '성남시'
          }
        ]
      ]),
      stations: [
        { STN_ID: stnA, STN_NAME: 'A' },
        { STN_ID: stnB, STN_NAME: 'B' }
      ]
    }
  });

  const { manifest, binary } = built;
  assert.strictEqual(manifest.intervalMinutes, 1);
  assert.strictEqual(manifest.frameCount, 4);
  assert.strictEqual(manifest.stationCount, 2);
  assert.strictEqual(manifest.data.byteLength, 4 * 2 * 2);
  assert.strictEqual(binary.length, manifest.data.byteLength);
  assert.deepStrictEqual(manifest.missingTimestamps, ['202608121535']);
  assert.strictEqual(manifest.stations[0].STN_ID, stnA);
  assert.strictEqual(manifest.stations[0].LAW_ADDR_SIDO, '경기도');

  const view = new Int16Array(binary.buffer, binary.byteOffset, binary.length / 2);
  // frame0 stnA = 408, frame1 stnA = 413 (odd peak), frame2 = 409, frame3 missing row = -32768
  assert.strictEqual(view[0 * 2 + 0], 408);
  assert.strictEqual(view[1 * 2 + 0], 413);
  assert.strictEqual(view[2 * 2 + 0], 409);
  assert.strictEqual(view[2 * 2 + 1], MISSING_I16); // TA=-999 → sentinel
  assert.strictEqual(view[3 * 2 + 0], MISSING_I16);
  assert.strictEqual(view[3 * 2 + 1], MISSING_I16);
  assert.ok(!Array.from(view).includes(-999));
  assert.strictEqual(manifest.schemaVersion, 2);
  assert.strictEqual(manifest.data.sha256.length, 64);

  // daily max for stnA from pack
  let max = MISSING_I16;
  let maxFi = -1;
  for (let fi = 0; fi < 4; fi++) {
    const v = view[fi * 2 + 0];
    if (v === MISSING_I16) continue;
    if (max === MISSING_I16 || v > max) {
      max = v;
      maxFi = fi;
    }
  }
  assert.strictEqual(max, 413);
  assert.strictEqual(maxFi, 1); // 15:33

  await publishAwsTaPack(packRoot, built);
  assert.ok(fs.existsSync(path.join(packRoot, 'ta', '1m', '20260812', 'ta.i16le')));
  assert.ok(fs.existsSync(path.join(packRoot, 'ta', '1m', '20260812', 'manifest.json')));

  console.log('OK test_aws_min_pack');
  await fsp.rm(tmp, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
