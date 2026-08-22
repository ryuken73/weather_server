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
  warmAwsDayPack,
  encodeTaToI16,
  encodeRainToI16,
  encodeWindSpeedToI16,
  encodeWindDirToI16,
  encodeHumidityToI16,
  encodeDewpointToI16,
  assessPackCoverage,
  isReusableCachedManifest,
  parsePackVariables,
  packDayBounds,
  isPackImmutableCacheable,
  packManifestCacheHeaders,
  deriveRolling24hScaled,
  normalizeRnDayScaledAtHhmm,
  createRnDayRunningMaxTracker,
  applyRnDayCounterRegression,
  evaluateRnDayUpwardSpike,
  PACK_SCHEMA_VERSION,
  PACK_CONTRACT_REVISION,
  PACK_VARIABLES,
  MISSING_I16,
  SUPPORTED_PACK_VARIABLES,
  REQUIRED_PACK_VARIABLES
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
  assert.throws(() => parsePackVariables('PA'), /Unsupported pack variable: PA/);
  assert.throws(() => parsePackVariables('TA,PA'), /Unsupported pack variable: PA/);
  assert.deepStrictEqual(parsePackVariables('TA,RN_60M,rn_15m'), ['TA', 'RN_60M', 'RN_15M']);
  assert.throws(() => parsePackVariables('RN_1HR'), /alias of RN_60M/);
  assert.throws(() => parsePackVariables('RN_YN'), /not packed/);
  assert.deepStrictEqual(REQUIRED_PACK_VARIABLES, [
    'TA',
    'RN_15M',
    'RN_60M',
    'RN_12HR',
    'RN_24HR',
    'RN_DAY',
    'WS_INS'
  ]);
  assert.ok(SUPPORTED_PACK_VARIABLES.includes('WS_INS'));
  assert.ok(SUPPORTED_PACK_VARIABLES.includes('TD'));
  assert.ok(SUPPORTED_PACK_VARIABLES.includes('RN_DAY'));
  assert.strictEqual(PACK_VARIABLES.RN_24HR.slug, 'rn_24hr_rolling');
  assert.strictEqual(PACK_VARIABLES.RN_24HR.accumulation.type, 'rolling');
  assert.strictEqual(PACK_VARIABLES.RN_24HR.accumulation.windowMinutes, 1440);
  assert.strictEqual(PACK_VARIABLES.RN_DAY.slug, 'rn_day');
  assert.strictEqual(PACK_VARIABLES.RN_DAY.accumulation.type, 'day');

  // Pure derive unit checks
  assert.deepStrictEqual(deriveRolling24hScaled(10, 100, 40), { value: 70, reason: null });
  assert.deepStrictEqual(deriveRolling24hScaled(0, 0, 0), { value: 0, reason: null }); // dry 24h
  assert.strictEqual(deriveRolling24hScaled(null, 100, 40).reason, 'missing_today');
  assert.strictEqual(deriveRolling24hScaled(10, null, 40).reason, 'missing_prev_end');
  assert.strictEqual(deriveRolling24hScaled(10, 100, null).reason, 'missing_prev_same');
  assert.strictEqual(deriveRolling24hScaled(10, 30, 40).reason, 'counter_decrease');
  assert.strictEqual(deriveRolling24hScaled(-20, 10, 5).reason, 'negative');
  assert.strictEqual(deriveRolling24hScaled(1, 32767, 0).reason, 'overflow');
  assert.strictEqual(normalizeRnDayScaledAtHhmm(3245, '0000'), 0);
  assert.strictEqual(normalizeRnDayScaledAtHhmm(5, '0001'), 5);
  assert.strictEqual(normalizeRnDayScaledAtHhmm(null, '0000'), null);

  const tracker = createRnDayRunningMaxTracker();
  assert.strictEqual(tracker.push(5, { frameIndex: 0 }).reason, null);
  assert.strictEqual(tracker.acceptedRnDay, 5);
  assert.strictEqual(tracker.push(0, { frameIndex: 1 }).reason, 'counterRegression');
  assert.strictEqual(tracker.push(3, { frameIndex: 2 }).reason, 'counterRegression');
  assert.strictEqual(tracker.push(12, { frameIndex: 3 }).reason, null);
  assert.strictEqual(tracker.acceptedRnDay, 12);
  assert.strictEqual(tracker.hadRegression, true);
  assert.strictEqual(tracker.push(null, { frameIndex: 4 }).reason, 'source_missing');

  const hard = evaluateRnDayUpwardSpike(1015, 0, 1, { rn15: 1015, rn60: 1015, rn12: 1015 });
  assert.strictEqual(hard.rejected, true);
  assert.strictEqual(hard.reason, 'hard_rate');
  const multi = evaluateRnDayUpwardSpike(310, 0, 5, { rn15: 310, rn60: 310, rn12: 310 });
  assert.strictEqual(multi.rejected, true);
  assert.strictEqual(multi.reason, 'multi_field_equal');
  const okHeavy = evaluateRnDayUpwardSpike(50, 0, 1, { rn15: 50, rn60: 80, rn12: 100 });
  assert.strictEqual(okHeavy.rejected, false);

  const grid = [10, 0, 3, 12];
  const { packGrid, rollingGrid, stats: regStats } = applyRnDayCounterRegression(grid, 4, 1);
  assert.deepStrictEqual(packGrid, [10, null, null, 12]);
  assert.deepStrictEqual(rollingGrid, [10, 10, 10, 12]);
  assert.strictEqual(regStats.regressionSampleCount, 2);
  assert.strictEqual(regStats.counterRegressionFilledSampleCount, 2);
  assert.strictEqual(regStats.regressionStationCount, 1);
  assert.strictEqual(PACK_CONTRACT_REVISION, 6);

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

  assert.strictEqual(encodeWindSpeedToI16(0), 0);
  assert.strictEqual(encodeWindSpeedToI16(40), 40);
  assert.strictEqual(encodeWindSpeedToI16(-1), MISSING_I16);
  assert.strictEqual(encodeWindDirToI16(0), 0);
  assert.strictEqual(encodeWindDirToI16(3600), 3600); // calm 360.0
  assert.strictEqual(encodeWindDirToI16(3601), MISSING_I16);
  assert.strictEqual(encodeWindDirToI16(-10), MISSING_I16);
  assert.strictEqual(encodeHumidityToI16(0), 0);
  assert.strictEqual(encodeHumidityToI16(1000), 1000);
  assert.strictEqual(encodeHumidityToI16(1001), MISSING_I16);
  assert.strictEqual(encodeDewpointToI16(208), 208);
  assert.strictEqual(encodeDewpointToI16(-150), -150);
  assert.strictEqual(encodeDewpointToI16(-999), MISSING_I16);
  assert.strictEqual(encodeDewpointToI16(601), 601); // no TA >60 clip

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
  assert.strictEqual(manifest.sourceField, 'TA');
  assert.ok(typeof manifest.validSampleCount === 'number');
  assert.ok(typeof manifest.missingSampleCount === 'number');
  assert.ok(manifest.coverage && manifest.coverage.status);
  assert.strictEqual(manifest.validRatio, manifest.coverage.validRatio);
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
  const rnDay = await buildAwsVariablePack(rainRoot, '202608131200', '202608131200', 'RN_DAY', {
    catalog: rainCatalog
  });
  const v15 = new Int16Array(rn15.binary.buffer, rn15.binary.byteOffset, rn15.binary.length / 2);
  const v12 = new Int16Array(rn12.binary.buffer, rn12.binary.byteOffset, rn12.binary.length / 2);
  const vDay = new Int16Array(rnDay.binary.buffer, rnDay.binary.byteOffset, rnDay.binary.length / 2);
  assert.strictEqual(v15[stationIndex.get(530)], 5);
  assert.strictEqual(v12[stationIndex.get(530)], 95);
  assert.strictEqual(vDay[stationIndex.get(530)], 95);
  assert.strictEqual(v12[stationIndex.get(679)], 245);
  assert.strictEqual(vDay[stationIndex.get(679)], 245);
  assert.strictEqual(rnDay.manifest.variable, 'RN_DAY');
  assert.strictEqual(rnDay.manifest.sourceField, 'RN-DAY');
  assert.strictEqual(rnDay.manifest.accumulation.type, 'day');
  assert.strictEqual(rnDay.manifest.accumulation.timezone, 'Asia/Seoul');
  assert.ok(String(rnDay.manifest.data.url).includes('/rn_day/'));
  assert.deepStrictEqual(
    rn60.manifest.stations.map((s) => s.STN_ID),
    rn15.manifest.stations.map((s) => s.STN_ID)
  );

  // RN_24HR without previous day → dependency-missing
  await assert.rejects(
    () => buildAwsVariablePack(rainRoot, '202608131200', '202608131200', 'RN_24HR', { catalog: rainCatalog }),
    (err) => err && err.code === 'DEPENDENCY_MISSING'
  );

  const wsIns = await buildAwsVariablePack(rainRoot, '202608131200', '202608131200', 'WS_INS', {
    catalog: rainCatalog
  });
  const wd = await buildAwsVariablePack(rainRoot, '202608131200', '202608131200', 'WD', {
    catalog: rainCatalog
  });
  const hm = await buildAwsVariablePack(rainRoot, '202608131200', '202608131200', 'HM', {
    catalog: rainCatalog
  });
  const td = await buildAwsVariablePack(rainRoot, '202608131200', '202608131200', 'TD', {
    catalog: rainCatalog
  });
  const vWsIns = new Int16Array(wsIns.binary.buffer, wsIns.binary.byteOffset, wsIns.binary.length / 2);
  const vWd = new Int16Array(wd.binary.buffer, wd.binary.byteOffset, wd.binary.length / 2);
  const vHm = new Int16Array(hm.binary.buffer, hm.binary.byteOffset, hm.binary.length / 2);
  const vTd = new Int16Array(td.binary.buffer, td.binary.byteOffset, td.binary.length / 2);
  assert.strictEqual(wsIns.manifest.sourceField, 'WSS');
  assert.ok(!wsIns.manifest.qc || !wsIns.manifest.qc.taTemporal);
  assert.strictEqual(vWsIns[stationIndex.get(42)], 40);
  assert.strictEqual(vWd[stationIndex.get(42)], 410);
  assert.strictEqual(vHm[stationIndex.get(42)], 588);
  assert.strictEqual(vTd[stationIndex.get(42)], 208);
  assert.strictEqual(rn60.manifest.validSampleCount, 712);
  assert.ok(rn60.manifest.coverage.status === 'ok');
  assert.ok(rn12.manifest.validSampleCount > 0);
  assert.ok(rn12.manifest.validRatio >= 0.9, 'RN_12HR fixture coverage should match other rain vars');
  assert.strictEqual(rn12.manifest.sourceField, 'RN-12H');
  assert.strictEqual(td.manifest.sourceField, 'TD');
  assert.ok(td.manifest.validSampleCount > 0);
  assert.ok(td.manifest.coverage.status === 'ok');

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

  // Rolling RN_24HR from day counters + RN_DAY midnight reset vs rolling continuity
  const rollRoot = path.join(tmp, 'aws-roll');
  const rollCatalog = { byId: new Map(), stations: [{ STN_ID: 1 }, { STN_ID: 2 }] };
  // Prev day: at 1200 counter=40, at 2359 counter=100 (legacy RN_24HR field only on one station)
  await writeFrame(rollRoot, '202608161200', [
    { STN_ID: 1, RN_24HR: 40, RN_12HR: 30 },
    { STN_ID: 2, RN_DAY: 50, RN_12HR: 20 }
  ]);
  await writeFrame(rollRoot, '202608162359', [
    { STN_ID: 1, RN_24HR: 100, RN_12HR: 40 },
    { STN_ID: 2, RN_DAY: 80, RN_12HR: 25 }
  ]);
  // Today just after midnight: day counter resets; rolling must not reset to ~0
  await writeFrame(rollRoot, '202608170000', [
    { STN_ID: 1, RN_DAY: 0, RN_12HR: 40 },
    { STN_ID: 2, RN_DAY: 1, RN_12HR: 25 }
  ]);
  await writeFrame(rollRoot, '202608171200', [
    { STN_ID: 1, RN_DAY: 25, RN_12HR: 20 },
    { STN_ID: 2, RN_DAY: 10, RN_12HR: 5 }
  ]);
  // Counter decrease fixture station (prev end < prev same) → missing
  await writeFrame(rollRoot, '202608161200', [
    { STN_ID: 1, RN_24HR: 40, RN_12HR: 30 },
    { STN_ID: 2, RN_DAY: 50, RN_12HR: 20 },
    { STN_ID: 3, RN_DAY: 90, RN_12HR: 10 }
  ]);
  await writeFrame(rollRoot, '202608162359', [
    { STN_ID: 1, RN_24HR: 100, RN_12HR: 40 },
    { STN_ID: 2, RN_DAY: 80, RN_12HR: 25 },
    { STN_ID: 3, RN_DAY: 70, RN_12HR: 10 }
  ]);
  await writeFrame(rollRoot, '202608171200', [
    { STN_ID: 1, RN_DAY: 25, RN_12HR: 20 },
    { STN_ID: 2, RN_DAY: 10, RN_12HR: 5 },
    { STN_ID: 3, RN_DAY: 5, RN_12HR: 1 }
  ]);
  const rollCatalog3 = { byId: new Map(), stations: [{ STN_ID: 1 }, { STN_ID: 2 }, { STN_ID: 3 }] };

  const rn24Pack = await buildAwsVariablePack(rollRoot, '202608171200', '202608171200', 'RN_24HR', {
    catalog: rollCatalog3
  });
  assert.strictEqual(rn24Pack.manifest.variable, 'RN_24HR');
  assert.strictEqual(rn24Pack.manifest.accumulation.type, 'rolling');
  assert.strictEqual(rn24Pack.manifest.accumulation.windowMinutes, 1440);
  assert.strictEqual(rn24Pack.manifest.sourceField, 'derived:RN-DAY');
  assert.ok(String(rn24Pack.manifest.data.url).includes('rn_24hr_rolling'));
  assert.ok(!String(rn24Pack.manifest.data.url).includes('/rn_24hr/1m/'));
  const r24 = new Int16Array(
    rn24Pack.binary.buffer,
    rn24Pack.binary.byteOffset,
    rn24Pack.binary.length / 2
  );
  const rollIdx = new Map(rn24Pack.manifest.stations.map((s, i) => [s.STN_ID, i]));
  // 25 + 100 - 40 = 85
  assert.strictEqual(r24[rollIdx.get(1)], 85);
  // 10 + 80 - 50 = 40
  assert.strictEqual(r24[rollIdx.get(2)], 40);
  // prev-day 23:59=70 < 12:00=90 → pack missing, rolling holds 90 ⇒ 5+90-90=5
  assert.strictEqual(r24[rollIdx.get(3)], 5);
  assert.ok(
    rn24Pack.manifest.qc.rolling24h.counterRegressionFilledSampleCount >= 1 ||
      (rn24Pack.manifest.qc.rnDayRegression &&
        rn24Pack.manifest.qc.rnDayRegression.previousDay &&
        rn24Pack.manifest.qc.rnDayRegression.previousDay.counterRegressionFilledSampleCount >= 1)
  );

  const rnDayMidnight = await buildAwsVariablePack(rollRoot, '202608170000', '202608170000', 'RN_DAY', {
    catalog: rollCatalog
  });
  const mDay = new Int16Array(
    rnDayMidnight.binary.buffer,
    rnDayMidnight.binary.byteOffset,
    rnDayMidnight.binary.length / 2
  );
  const mIdx = new Map(rnDayMidnight.manifest.stations.map((s, i) => [s.STN_ID, i]));
  // Hub may leave residual at 00:00; pack forces 0 for day semantics
  assert.strictEqual(mDay[mIdx.get(1)], 0);
  assert.strictEqual(mDay[mIdx.get(2)], 0);
  // Write prev 0000 (stale Hub-like values) then rebuild rolling at midnight
  await writeFrame(rollRoot, '202608160000', [
    { STN_ID: 1, RN_24HR: 5 },
    { STN_ID: 2, RN_DAY: 2 }
  ]);
  const midnightPack2 = await buildAwsVariablePack(rollRoot, '202608170000', '202608170000', 'RN_24HR', {
    catalog: rollCatalog
  });
  const m24b = new Int16Array(
    midnightPack2.binary.buffer,
    midnightPack2.binary.byteOffset,
    midnightPack2.binary.length / 2
  );
  const mIdx2 = new Map(midnightPack2.manifest.stations.map((s, i) => [s.STN_ID, i]));
  // today 0000→0, prev 0000→0 ⇒ RN_24HR = prev 23:59
  assert.strictEqual(m24b[mIdx2.get(1)], 100);
  assert.strictEqual(m24b[mIdx2.get(2)], 80);
  assert.notStrictEqual(m24b[mIdx2.get(1)], mDay[mIdx.get(1)]);

  // Hub stale 00:00: 23:59→00:00→00:01 continuity + midnight not period max
  const hubRoot = path.join(tmp, 'aws-hub-midnight');
  const hubCatalog = { byId: new Map(), stations: [{ STN_ID: 1 }] };
  // Prev day: stale-looking 00:00, small 00:01, end 3245 (=324.5mm)
  await writeFrame(hubRoot, '202608160000', [{ STN_ID: 1, RN_DAY: 3000 }]);
  await writeFrame(hubRoot, '202608160001', [{ STN_ID: 1, RN_DAY: 5 }]);
  await writeFrame(hubRoot, '202608162359', [{ STN_ID: 1, RN_DAY: 3245 }]);
  // Today: Hub still shows yesterday total at 00:00; reset at 00:01; midday peak
  await writeFrame(hubRoot, '202608170000', [{ STN_ID: 1, RN_DAY: 3245 }]);
  await writeFrame(hubRoot, '202608170001', [{ STN_ID: 1, RN_DAY: 5 }]);
  await writeFrame(hubRoot, '202608171200', [{ STN_ID: 1, RN_DAY: 500 }]);

  const hubDay = await buildAwsVariablePack(hubRoot, '202608170000', '202608171200', 'RN_DAY', {
    catalog: hubCatalog
  });
  const hub24 = await buildAwsVariablePack(hubRoot, '202608170000', '202608171200', 'RN_24HR', {
    catalog: hubCatalog
  });
  const hd = new Int16Array(hubDay.binary.buffer, hubDay.binary.byteOffset, hubDay.binary.length / 2);
  const h24 = new Int16Array(hub24.binary.buffer, hub24.binary.byteOffset, hub24.binary.length / 2);
  assert.strictEqual(hubDay.manifest.from, '202608170000');
  assert.strictEqual(hubDay.manifest.to, '202608171200');
  const i0000 = 0;
  const i0001 = 1;
  const i1200 = 12 * 60;
  assert.strictEqual(hd[i0000], 0); // normalized, not 3245
  assert.strictEqual(hd[i0001], 5);
  assert.strictEqual(hd[i1200], 500);
  // RN_24HR(0000)=0+3245-0=3245; (0001)=5+3245-5=3245 — continuous across midnight
  assert.strictEqual(h24[i0000], 3245);
  assert.strictEqual(h24[i0001], 3245);
  assert.ok(hubDay.manifest.qc.midnightRnDay.forcedZeroAt0000 >= 1);
  assert.ok(hub24.manifest.qc.midnightRnDay.forcedZeroAt0000 >= 1);

  // Period max / rank: midnight must not win because of Hub stale total
  let dayMax = { v: -1, fi: -1 };
  let r24Max = { v: -1, fi: -1 };
  for (let fi = 0; fi < hubDay.manifest.frameCount; fi++) {
    const dv = hd[fi];
    const rv = h24[fi];
    if (dv !== MISSING_I16 && dv > dayMax.v) dayMax = { v: dv, fi };
    if (rv !== MISSING_I16 && rv > r24Max.v) r24Max = { v: rv, fi };
  }
  assert.strictEqual(dayMax.v, 500);
  assert.strictEqual(dayMax.fi, i1200);
  assert.notStrictEqual(dayMax.fi, i0000);
  // rolling at 00:00 equals prev-day end, not 2× stale Hub total
  assert.ok(h24[i0000] < 3245 * 2);
  assert.strictEqual(h24[i0000], h24[i0001]);
  void r24Max;

  // Counter-regression QC: 개천(929) 07:01→07:02, 춘장대(646) peak→0, recovery
  const regRoot = path.join(tmp, 'aws-regression');
  const regCatalog = {
    byId: new Map(),
    stations: [{ STN_ID: 929 }, { STN_ID: 646 }, { STN_ID: 1 }]
  };
  await writeFrame(regRoot, '202608190000', [
    { STN_ID: 929, RN_DAY: 0 },
    { STN_ID: 646, RN_DAY: 0 },
    { STN_ID: 1, RN_DAY: 0 }
  ]);
  await writeFrame(regRoot, '202608190701', [
    { STN_ID: 929, RN_DAY: 8 },
    { STN_ID: 646, RN_DAY: 12 },
    { STN_ID: 1, RN_DAY: 4 }
  ]);
  await writeFrame(regRoot, '202608190702', [
    { STN_ID: 929, RN_DAY: 9 },
    { STN_ID: 646, RN_DAY: 13 },
    { STN_ID: 1, RN_DAY: 5 }
  ]);
  await writeFrame(regRoot, '202608192359', [
    { STN_ID: 929, RN_DAY: 20 },
    { STN_ID: 646, RN_DAY: 30 },
    { STN_ID: 1, RN_DAY: 10 }
  ]);
  // 개천: 07:01=0.5mm, 07:02=0.0mm (scaled 5 → 0)
  await writeFrame(regRoot, '202608200701', [
    { STN_ID: 929, RN_DAY: 5 },
    { STN_ID: 646, RN_DAY: 105 },
    { STN_ID: 1, RN_DAY: 10 }
  ]);
  await writeFrame(regRoot, '202608200702', [
    { STN_ID: 929, RN_DAY: 0 },
    { STN_ID: 646, RN_DAY: 0 },
    { STN_ID: 1, RN_DAY: 3 }
  ]);
  // recovery: 646 back above 105; 1 recovers to 12; 929 still below 5
  await writeFrame(regRoot, '202608200800', [
    { STN_ID: 929, RN_DAY: 4 },
    { STN_ID: 646, RN_DAY: 110 },
    { STN_ID: 1, RN_DAY: 12 }
  ]);
  await writeFrame(regRoot, '202608200801', [
    { STN_ID: 929, RN_DAY: 6 },
    { STN_ID: 646, RN_DAY: 110 },
    { STN_ID: 1, RN_DAY: 12 }
  ]);

  const regDay = await buildAwsVariablePack(regRoot, '202608200701', '202608200801', 'RN_DAY', {
    catalog: regCatalog
  });
  assert.strictEqual(regDay.manifest.contractRevision, 6);
  assert.ok(regDay.manifest.qc.rnDayRegression.regressionSampleCount >= 3);
  assert.ok(regDay.manifest.qc.rnDayRegression.regressionStationCount >= 2);
  const rd = new Int16Array(regDay.binary.buffer, regDay.binary.byteOffset, regDay.binary.length / 2);
  const rIdx = new Map(regDay.manifest.stations.map((s, i) => [s.STN_ID, i]));
  const scR = regDay.manifest.stationCount;
  // frames: 0701,0702,...,0801 → 61 frames; index of 0701=0, 0702=1, 0800=59, 0801=60
  const f0701 = 0;
  const f0702 = 1;
  const f0800 = 59;
  const f0801 = 60;
  assert.strictEqual(rd[f0701 * scR + rIdx.get(929)], 5);
  assert.strictEqual(rd[f0702 * scR + rIdx.get(929)], MISSING_I16);
  assert.strictEqual(rd[f0800 * scR + rIdx.get(929)], MISSING_I16); // 4 < max 5
  assert.strictEqual(rd[f0801 * scR + rIdx.get(929)], 6);
  assert.strictEqual(rd[f0701 * scR + rIdx.get(646)], 105);
  assert.strictEqual(rd[f0702 * scR + rIdx.get(646)], MISSING_I16);
  assert.strictEqual(rd[f0800 * scR + rIdx.get(646)], 110);
  assert.strictEqual(rd[f0701 * scR + rIdx.get(1)], 10);
  assert.strictEqual(rd[f0702 * scR + rIdx.get(1)], MISSING_I16); // 3 < 10
  assert.strictEqual(rd[f0800 * scR + rIdx.get(1)], 12);

  const reg24 = await buildAwsVariablePack(regRoot, '202608200701', '202608200702', 'RN_24HR', {
    catalog: regCatalog
  });
  const r24v = new Int16Array(reg24.binary.buffer, reg24.binary.byteOffset, reg24.binary.length / 2);
  const r24Idx = new Map(reg24.manifest.stations.map((s, i) => [s.STN_ID, i]));
  const sc24 = reg24.manifest.stationCount;
  // 0701: 5+20-8=17; 0702 regression holds today=5 → 5+20-9=16 (not missing)
  assert.strictEqual(r24v[0 * sc24 + r24Idx.get(929)], 17);
  assert.strictEqual(r24v[1 * sc24 + r24Idx.get(929)], 16);
  assert.ok(reg24.manifest.qc.rnDayRegression.counterRegressionFilledSampleCount >= 1);
  assert.ok(
    (reg24.manifest.warnings || []).some((w) =>
      /used last accepted RN_DAY for \d+ counter-regression samples/.test(w)
    )
  );
  assert.ok(reg24.manifest.qc.rnDayRegression.previousDay);

  // Source missing must not forward-fill into RN_24HR
  const missRoot = path.join(tmp, 'aws-src-miss');
  await writeFrame(missRoot, '202608190000', [{ STN_ID: 1, RN_DAY: 0 }]);
  await writeFrame(missRoot, '202608190100', [{ STN_ID: 1, RN_DAY: 2 }]);
  await writeFrame(missRoot, '202608190101', [{ STN_ID: 1, RN_DAY: 3 }]);
  await writeFrame(missRoot, '202608192359', [{ STN_ID: 1, RN_DAY: 50 }]);
  await writeFrame(missRoot, '202608200100', [{ STN_ID: 1, RN_DAY: 10 }]);
  // 01:01 frame present but RN_DAY absent → source missing
  await writeFrame(missRoot, '202608200101', [{ STN_ID: 1, TA: 200 }]);
  const missDay = await buildAwsVariablePack(missRoot, '202608200100', '202608200101', 'RN_DAY', {
    catalog: { byId: new Map(), stations: [{ STN_ID: 1 }] }
  });
  const miss24 = await buildAwsVariablePack(missRoot, '202608200100', '202608200101', 'RN_24HR', {
    catalog: { byId: new Map(), stations: [{ STN_ID: 1 }] }
  });
  const md = new Int16Array(missDay.binary.buffer, missDay.binary.byteOffset, missDay.binary.length / 2);
  const m24 = new Int16Array(miss24.binary.buffer, miss24.binary.byteOffset, miss24.binary.length / 2);
  assert.strictEqual(md[0], 10);
  assert.strictEqual(md[1], MISSING_I16);
  // 10+50-2=58
  assert.strictEqual(m24[0], 58);
  assert.strictEqual(m24[1], MISSING_I16);
  assert.ok(miss24.manifest.qc.rnDayRegression.sourceMissingSampleCount >= 1);

  // Legacy RN_DAY field fallback: row with only RN_24HR
  const legacyDay = await buildAwsVariablePack(rollRoot, '202608162359', '202608162359', 'RN_DAY', {
    catalog: rollCatalog
  });
  const ld = new Int16Array(
    legacyDay.binary.buffer,
    legacyDay.binary.byteOffset,
    legacyDay.binary.length / 2
  );
  const ldIdx = new Map(legacyDay.manifest.stations.map((s, i) => [s.STN_ID, i]));
  assert.strictEqual(ld[ldIdx.get(1)], 100);

  const warmRoot = path.join(tmp, 'pack-all');
  const warmJson = path.join(tmp, 'aws-warm');
  await writeFrame(warmJson, '202608141000', [
    { STN_ID: 1, TA: 200, RN_15M: 1, RN_60M: 2, RN_12HR: 3, RN_24HR: 4, RN_DAY: 4 }
  ]);
  // Prev day for RN_24HR warm
  await writeFrame(warmJson, '202608131000', [{ STN_ID: 1, RN_DAY: 1 }]);
  await writeFrame(warmJson, '202608132359', [{ STN_ID: 1, RN_DAY: 9 }]);
  const warmed = await warmAwsDayPack(warmJson, warmRoot, '20260814', {
    catalog: { byId: new Map(), stations: [{ STN_ID: 1 }] }
  });
  assert.deepStrictEqual(
    (warmed.items || []).map((i) => i.variable),
    [...SUPPORTED_PACK_VARIABLES]
  );
  for (const v of SUPPORTED_PACK_VARIABLES) {
    const item = warmed.items.find((i) => i.variable === v);
    assert.ok(item && item.ok, `${v} pack should succeed`);
    assert.ok(item.manifest.sourceField, `${v} sourceField`);
    assert.ok(typeof item.manifest.validSampleCount === 'number', `${v} validSampleCount`);
    assert.ok(item.manifest.coverage && item.manifest.coverage.status, `${v} coverage`);
  }
  const warmRn24 = warmed.items.find((i) => i.variable === 'RN_24HR');
  assert.ok(String(warmRn24.manifest.data.url).includes('rn_24hr_rolling'));
  assert.strictEqual(warmRn24.manifest.schemaVersion, PACK_SCHEMA_VERSION);
  assert.strictEqual(warmRn24.manifest.contractRevision, PACK_CONTRACT_REVISION);

  const emptyTd = await buildAwsVariablePack(warmJson, '202608141000', '202608141000', 'TD', {
    catalog: { byId: new Map(), stations: [{ STN_ID: 1 }] }
  });
  assert.strictEqual(emptyTd.manifest.validSampleCount, 0);
  assert.strictEqual(emptyTd.manifest.coverage.status, 'empty');
  assert.strictEqual(emptyTd.manifest.dataComplete, false);
  assert.ok(emptyTd.manifest.warnings.some((w) => /no valid samples/.test(w)));
  assert.ok(emptyTd.manifest.warnings.some((w) => /JSON field TD is missing/.test(w)));

  assert.deepStrictEqual(assessPackCoverage(0, 100).status, 'empty');
  assert.deepStrictEqual(assessPackCoverage(10, 90).status, 'degraded');
  assert.strictEqual(assessPackCoverage(90, 10).status, 'ok');
  assert.strictEqual(
    isReusableCachedManifest(
      { complete: true, schemaVersion: PACK_SCHEMA_VERSION, variable: 'TA', from: 'a', to: 'b' },
      'TA',
      'a',
      'b'
    ),
    false
  );
  assert.strictEqual(
    isReusableCachedManifest(
      {
        complete: true,
        schemaVersion: PACK_SCHEMA_VERSION,
        contractRevision: PACK_CONTRACT_REVISION,
        variable: 'TA',
        from: 'a',
        to: 'b',
        sourceField: 'TA',
        validSampleCount: 1,
        coverage: { status: 'ok' }
      },
      'TA',
      'a',
      'b'
    ),
    true
  );
  // Legacy day-accumulation RN_24HR must not be reused as rolling
  assert.strictEqual(
    isReusableCachedManifest(
      {
        complete: true,
        schemaVersion: PACK_SCHEMA_VERSION,
        contractRevision: PACK_CONTRACT_REVISION,
        variable: 'RN_24HR',
        from: 'a',
        to: 'b',
        sourceField: 'RN-DAY',
        accumulation: { type: 'day', timezone: 'Asia/Seoul' },
        validSampleCount: 1,
        coverage: { status: 'ok' },
        data: { url: '/datasets/aws/rn_24hr/1m/x/rn_24hr.i16le' }
      },
      'RN_24HR',
      'a',
      'b'
    ),
    false
  );
  assert.strictEqual(
    isReusableCachedManifest(
      {
        complete: true,
        schemaVersion: PACK_SCHEMA_VERSION,
        contractRevision: PACK_CONTRACT_REVISION,
        variable: 'RN_24HR',
        from: 'a',
        to: 'b',
        sourceField: 'derived:RN-DAY',
        accumulation: { type: 'rolling', windowMinutes: 1440 },
        validSampleCount: 1,
        coverage: { status: 'ok' },
        data: { url: '/datasets/aws/rn_24hr_rolling/1m/x/rn_24hr_rolling.i16le' }
      },
      'RN_24HR',
      'a',
      'b'
    ),
    true
  );

  // --- upward spike QC: 동래 940 continuous + 북강릉 104 isolated multi-equal ---
  const upwardSpikeRoot = path.join(tmp, 'aws-upward-spike');
  const spikeCatalog = {
    byId: new Map(),
    stations: [{ STN_ID: 940 }, { STN_ID: 104 }, { STN_ID: 277 }, { STN_ID: 688 }]
  };
  await writeFrame(upwardSpikeRoot, '202608200000', [
    { STN_ID: 940, RN_DAY: 0 },
    { STN_ID: 104, RN_DAY: 0 },
    { STN_ID: 277, RN_DAY: 0 },
    { STN_ID: 688, RN_DAY: 0 }
  ]);
  // 북강릉: isolated 31.0 with all rain fields equal
  await writeFrame(upwardSpikeRoot, '202608201153', [
    { STN_ID: 104, RN_DAY: 310, RN_15M: 310, RN_60M: 310, RN_12HR: 310 },
    { STN_ID: 940, RN_DAY: 0 },
    { STN_ID: 277, RN_DAY: 0 },
    { STN_ID: 688, RN_DAY: 540 }
  ]);
  await writeFrame(upwardSpikeRoot, '202608201155', [
    { STN_ID: 104, RN_DAY: 0, RN_15M: 0, RN_60M: 0 },
    { STN_ID: 940, RN_DAY: 0 },
    { STN_ID: 277, RN_DAY: 0 },
    { STN_ID: 688, RN_DAY: 540 }
  ]);
  await writeFrame(upwardSpikeRoot, '202608202359', [
    { STN_ID: 940, RN_DAY: 0 },
    { STN_ID: 104, RN_DAY: 0 },
    { STN_ID: 277, RN_DAY: 0 },
    { STN_ID: 688, RN_DAY: 540 }
  ]);
  // 동래 continuous spike 09:23–09:27
  await writeFrame(upwardSpikeRoot, '202608210923', [
    { STN_ID: 940, RN_DAY: 0, RN_15M: 0, RN_60M: 0 },
    { STN_ID: 104, RN_DAY: 0 },
    { STN_ID: 277, RN_DAY: 0 },
    { STN_ID: 688, RN_DAY: 5 }
  ]);
  await writeFrame(upwardSpikeRoot, '202608210924', [
    { STN_ID: 940, RN_DAY: 1015, RN_15M: 1015, RN_60M: 1015 },
    { STN_ID: 104, RN_DAY: 0 },
    { STN_ID: 277, RN_DAY: 0 },
    { STN_ID: 688, RN_DAY: 5 }
  ]);
  await writeFrame(upwardSpikeRoot, '202608210925', [
    { STN_ID: 940, RN_DAY: 2215, RN_15M: null, RN_60M: 2215 },
    { STN_ID: 104, RN_DAY: 0 },
    { STN_ID: 277, RN_DAY: 0 },
    { STN_ID: 688, RN_DAY: 5 }
  ]);
  await writeFrame(upwardSpikeRoot, '202608210926', [
    { STN_ID: 940, RN_DAY: 3415 },
    { STN_ID: 104, RN_DAY: 0 },
    { STN_ID: 277, RN_DAY: 0 },
    { STN_ID: 688, RN_DAY: 5 }
  ]);
  await writeFrame(upwardSpikeRoot, '202608210927', [
    { STN_ID: 940, RN_DAY: 4615 },
    { STN_ID: 104, RN_DAY: 0 },
    { STN_ID: 277, RN_DAY: 0 },
    { STN_ID: 688, RN_DAY: 5 }
  ]);
  // 영덕: +64.4mm/min with RN_15M missing, RN_60M inconsistent
  await writeFrame(upwardSpikeRoot, '202608211413', [
    { STN_ID: 277, RN_DAY: 4, RN_15M: 0, RN_60M: 4 },
    { STN_ID: 940, RN_DAY: 0 },
    { STN_ID: 104, RN_DAY: 0 },
    { STN_ID: 688, RN_DAY: 5 }
  ]);
  await writeFrame(upwardSpikeRoot, '202608211414', [
    { STN_ID: 277, RN_DAY: 648, RN_60M: 189 },
    { STN_ID: 940, RN_DAY: 0 },
    { STN_ID: 104, RN_DAY: 0 },
    { STN_ID: 688, RN_DAY: 5 }
  ]);

  const spikeDay20 = await buildAwsVariablePack(upwardSpikeRoot, '202608201153', '202608201155', 'RN_DAY', {
    catalog: spikeCatalog
  });
  const sd20 = new Int16Array(
    spikeDay20.binary.buffer,
    spikeDay20.binary.byteOffset,
    spikeDay20.binary.length / 2
  );
  const s20Idx = new Map(spikeDay20.manifest.stations.map((s, i) => [s.STN_ID, i]));
  const sc20 = spikeDay20.manifest.stationCount;
  assert.strictEqual(sd20[0 * sc20 + s20Idx.get(104)], MISSING_I16); // 11:53 31.0 rejected
  assert.strictEqual(sd20[1 * sc20 + s20Idx.get(104)], MISSING_I16); // 11:54 frame missing
  assert.strictEqual(sd20[2 * sc20 + s20Idx.get(104)], 0); // 11:55 0.0 accepted, not regression vs spike
  assert.ok(spikeDay20.manifest.qc.rnDayQc.upwardSpikeRejectedSampleCount >= 1);

  const spikeDay21 = await buildAwsVariablePack(upwardSpikeRoot, '202608210923', '202608210927', 'RN_DAY', {
    catalog: spikeCatalog
  });
  const sd21 = new Int16Array(
    spikeDay21.binary.buffer,
    spikeDay21.binary.byteOffset,
    spikeDay21.binary.length / 2
  );
  const s21Idx = new Map(spikeDay21.manifest.stations.map((s, i) => [s.STN_ID, i]));
  const sc21 = spikeDay21.manifest.stationCount;
  assert.strictEqual(sd21[0 * sc21 + s21Idx.get(940)], 0);
  for (let fi = 1; fi <= 4; fi++) {
    assert.strictEqual(sd21[fi * sc21 + s21Idx.get(940)], MISSING_I16);
  }
  assert.ok(spikeDay21.manifest.qc.rnDayQc.upwardSpikeRejectedSampleCount >= 4);
  assert.ok(
    (spikeDay21.manifest.warnings || []).some((w) => /upward-spike/.test(w))
  );

  const yeong = await buildAwsVariablePack(upwardSpikeRoot, '202608211413', '202608211414', 'RN_DAY', {
    catalog: spikeCatalog
  });
  const yd = new Int16Array(yeong.binary.buffer, yeong.binary.byteOffset, yeong.binary.length / 2);
  const yIdx = new Map(yeong.manifest.stations.map((s, i) => [s.STN_ID, i]));
  const ysc = yeong.manifest.stationCount;
  assert.strictEqual(yd[0 * ysc + yIdx.get(277)], 4);
  assert.strictEqual(yd[1 * ysc + yIdx.get(277)], MISSING_I16);

  const spike24 = await buildAwsVariablePack(upwardSpikeRoot, '202608210923', '202608210927', 'RN_24HR', {
    catalog: spikeCatalog
  });
  const s24 = new Int16Array(spike24.binary.buffer, spike24.binary.byteOffset, spike24.binary.length / 2);
  const s24Idx = new Map(spike24.manifest.stations.map((s, i) => [s.STN_ID, i]));
  const sc24s = spike24.manifest.stationCount;
  for (let fi = 0; fi < spike24.manifest.frameCount; fi++) {
    const v = s24[fi * sc24s + s24Idx.get(940)];
    if (v !== MISSING_I16) assert.ok(v < 4615, `RN_24HR must not carry 461.5mm spike, got ${v}`);
  }
  assert.ok(
    spike24.manifest.qc.rolling24h.upwardSpikeContaminationPreventedSampleCount >= 1 ||
      spike24.manifest.qc.rnDayQc.upwardSpikeRejectedSampleCount >= 1
  );

  const headers = packManifestCacheHeaders({
    complete: true,
    schemaVersion: PACK_SCHEMA_VERSION,
    datasetId: 'aws-ta-1m-x'
  });
  assert.ok(headers['Cache-Control'].includes('immutable'));
  assert.ok(headers.ETag);

  console.log('OK test_aws_min_pack');
  await fsp.rm(tmp, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
