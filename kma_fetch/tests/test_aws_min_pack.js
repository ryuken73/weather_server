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
  buildAwsVariablePack,
  publishAwsTaPack,
  encodeTaToI16,
  encodeRainToI16,
  parsePackVariables,
  packDayBounds,
  isPackImmutableCacheable,
  packManifestCacheHeaders,
  PACK_SCHEMA_VERSION,
  MISSING_I16
} = require('../utils/aws_min_pack');
const { parseApiText, apiRowToDbShape } = require('../services/aws_apihub_min');

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
  assert.deepStrictEqual(parsePackVariables('TA,RN_60M,rn_15m'), ['TA', 'RN_60M', 'RN_15M']);

  assert.strictEqual(encodeRainToI16(0), 0);
  assert.strictEqual(encodeRainToI16(15), 15);
  assert.strictEqual(encodeRainToI16(null), MISSING_I16);
  assert.strictEqual(encodeRainToI16('x'), MISSING_I16);
  assert.strictEqual(encodeRainToI16(-999), MISSING_I16); // -99.9 Hub missing ×10
  assert.strictEqual(encodeRainToI16(-997), MISSING_I16); // -99.7
  assert.strictEqual(encodeRainToI16(-992), MISSING_I16); // -99.2
  assert.strictEqual(encodeRainToI16(-1), MISSING_I16); // negative rain invalid
  assert.strictEqual(encodeRainToI16(-500), MISSING_I16);
  assert.strictEqual(encodeRainToI16(32768), MISSING_I16); // Int16 overflow → missing

  assert.strictEqual(isPackImmutableCacheable({ complete: true, schemaVersion: PACK_SCHEMA_VERSION }), true);
  assert.strictEqual(isPackImmutableCacheable({ complete: true, schemaVersion: 1 }), false);
  assert.strictEqual(isPackImmutableCacheable({ complete: false, schemaVersion: PACK_SCHEMA_VERSION }), false);
  assert.strictEqual(
    packManifestCacheHeaders({ complete: true, schemaVersion: PACK_SCHEMA_VERSION, datasetId: 'x' })['Cache-Control'],
    'public, max-age=31536000, immutable'
  );
  assert.strictEqual(
    packManifestCacheHeaders({ complete: false, schemaVersion: PACK_SCHEMA_VERSION, datasetId: 'x' })['Cache-Control'],
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
  assert.strictEqual(manifest.schemaVersion, PACK_SCHEMA_VERSION);
  assert.strictEqual(manifest.data.sha256.length, 64);
  assert.ok(manifest.qc && manifest.qc.taTemporal);

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

  // 서석(535) 유형: 연속 비현실 급락 — 첫 분만 유지, 이후 QC 제외
  const glitchRoot = path.join(tmp, 'aws-glitch');
  const stn535 = 535;
  const glitchTemps = [-30, -73, -108, -134, -142, -149]; // -3.0 → -14.9℃
  for (let i = 0; i < glitchTemps.length; i++) {
    const mm = String(50 + i).padStart(2, '0');
    const tm = `2026081210${mm}`;
    await writeFrame(glitchRoot, tm, [
      { STN_ID: stn535, TM: tm, TA: glitchTemps[i], STN_NAME: '서석' }
    ]);
  }
  const glitchBuilt = await buildAwsTaPack(glitchRoot, '202608121050', '202608121055', {
    catalog: { byId: new Map(), stations: [{ STN_ID: stn535, STN_NAME: '서석' }] }
  });
  const gv = new Int16Array(
    glitchBuilt.binary.buffer,
    glitchBuilt.binary.byteOffset,
    glitchBuilt.binary.length / 2
  );
  assert.strictEqual(gv[0], -30);
  for (let fi = 1; fi < 6; fi++) {
    assert.strictEqual(gv[fi], MISSING_I16, `frame ${fi} should be QC excluded`);
  }
  assert.ok(glitchBuilt.manifest.qc.taTemporal.excludedSampleCount >= 5);

  const fixtureText = fs.readFileSync(
    path.join(__dirname, '..', '..', 'skills', 'aws-min-json-pipeline', 'assets', 'nph-aws2_min_202608131200.txt'),
    'utf8'
  );
  const fixtureParts = parseApiText(fixtureText).get('202608131200');
  const fixtureRows = fixtureParts.map((p) => apiRowToDbShape(p, {}, new Map()));
  const rainRoot = path.join(tmp, 'aws-rain');
  await writeFrame(rainRoot, '202608131200', fixtureRows);
  const rainCatalog = {
    byId: new Map(),
    stations: fixtureRows.map((r) => ({ STN_ID: r.STN_ID, STN_NAME: null }))
  };
  const rn60 = await buildAwsVariablePack(rainRoot, '202608131200', '202608131200', 'RN_60M', {
    catalog: rainCatalog
  });
  assert.strictEqual(rn60.manifest.variable, 'RN_60M');
  assert.strictEqual(rn60.manifest.sourceField, 'RN-60m');
  assert.strictEqual(rn60.manifest.unit, 'mm');
  assert.strictEqual(rn60.manifest.accumulation.type, 'rolling');
  assert.strictEqual(rn60.manifest.accumulation.windowMinutes, 60);
  assert.strictEqual(rn60.manifest.frameCount, 1);
  assert.strictEqual(rn60.manifest.stationCount, 736);
  assert.strictEqual(rn60.manifest.data.byteLength, 736 * 2);
  assert.strictEqual(rn60.binary.length, rn60.manifest.data.byteLength);
  assert.strictEqual(rn60.manifest.validSampleCount, 712);
  assert.strictEqual(rn60.manifest.missingSampleCount, 24);
  assert.ok(!rn60.manifest.qc || !rn60.manifest.qc.taTemporal);

  const stationIndex = new Map(rn60.manifest.stations.map((s, i) => [s.STN_ID, i]));
  const rainView = new Int16Array(rn60.binary.buffer, rn60.binary.byteOffset, rn60.binary.length / 2);
  assert.strictEqual(rainView[stationIndex.get(530)], 60);
  assert.strictEqual(rainView[stationIndex.get(679)], 0);
  assert.strictEqual(rainView[stationIndex.get(793)], 10);

  const rn15 = await buildAwsVariablePack(rainRoot, '202608131200', '202608131200', 'RN_15M', {
    catalog: rainCatalog
  });
  const rn12 = await buildAwsVariablePack(rainRoot, '202608131200', '202608131200', 'RN_12HR', {
    catalog: rainCatalog
  });
  const rn24 = await buildAwsVariablePack(rainRoot, '202608131200', '202608131200', 'RN_24HR', {
    catalog: rainCatalog
  });
  const v15 = new Int16Array(rn15.binary.buffer, rn15.binary.byteOffset, rn15.binary.length / 2);
  const v12 = new Int16Array(rn12.binary.buffer, rn12.binary.byteOffset, rn12.binary.length / 2);
  const v24 = new Int16Array(rn24.binary.buffer, rn24.binary.byteOffset, rn24.binary.length / 2);
  assert.strictEqual(v15[stationIndex.get(530)], 5);
  assert.strictEqual(v12[stationIndex.get(530)], 95);
  assert.strictEqual(v24[stationIndex.get(530)], 95);
  assert.strictEqual(v12[stationIndex.get(679)], 245);
  assert.strictEqual(v24[stationIndex.get(679)], 245);
  assert.deepStrictEqual(
    rn60.manifest.stations.map((s) => s.STN_ID),
    rn15.manifest.stations.map((s) => s.STN_ID)
  );

  // rain must not use TA temporal QC even on huge 1-min jumps
  const spikeRoot = path.join(tmp, 'aws-rain-spike');
  await writeFrame(spikeRoot, '202608121000', [{ STN_ID: 1, RN_60M: 0, TA: 200 }]);
  await writeFrame(spikeRoot, '202608121001', [{ STN_ID: 1, RN_60M: 80, TA: -100 }]);
  const spikePack = await buildAwsVariablePack(spikeRoot, '202608121000', '202608121001', 'RN_60M', {
    catalog: { byId: new Map(), stations: [{ STN_ID: 1 }] }
  });
  const sv = new Int16Array(spikePack.binary.buffer, spikePack.binary.byteOffset, spikePack.binary.length / 2);
  assert.strictEqual(sv[0], 0);
  assert.strictEqual(sv[1], 80);

  console.log('OK test_aws_min_pack');
  await fsp.rm(tmp, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
