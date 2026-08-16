/**
 *   node kma_fetch/tests/test_aws_hub_fill.js
 */
const assert = require('assert');
const {
  isFieldPresent,
  fieldCoverage,
  rowsNeedHubSupplement,
  rowsNeedFieldRefresh,
  mergeHubSupplement,
  shouldRejectHubReplace,
  supplementDbRowsFromHub
} = require('../utils/aws_hub_fill');

async function main() {
  assert.strictEqual(isFieldPresent({ TD: -150 }, 'TD'), true); // -15.0℃
  assert.strictEqual(isFieldPresent({ TD: null }, 'TD'), false);
  assert.strictEqual(isFieldPresent({ TD: -999 }, 'TD'), false);
  assert.strictEqual(isFieldPresent({ RN_12HR: 0 }, 'RN_12HR'), true);
  assert.strictEqual(isFieldPresent({ RN_12HR: null }, 'RN_12HR'), false);

  const dbRows = [
    { STN_ID: 1, TA: 200, WS_INS: 40, RN_12HR: null, TD: null },
    { STN_ID: 2, TA: 210, WS_INS: 12, RN_12HR: null, TD: null }
  ];
  const hubRows = [
    { STN_ID: 1, TA: 999, WS_INS: 1, RN_12HR: 95, TD: -80 },
    { STN_ID: 2, TA: 888, WS_INS: 2, RN_12HR: 10, TD: 208 }
  ];

  assert.strictEqual(rowsNeedHubSupplement(dbRows), true);
  assert.strictEqual(fieldCoverage(dbRows, 'TD'), 0);
  assert.strictEqual(rowsNeedFieldRefresh(dbRows, ['RN_12HR', 'TD']), true);

  const merged = mergeHubSupplement(dbRows, hubRows);
  assert.strictEqual(merged.rows[0].TA, 200, 'DB TA must be kept');
  assert.strictEqual(merged.rows[0].WS_INS, 40, 'DB wind must be kept');
  assert.strictEqual(merged.rows[0].RN_12HR, 95);
  assert.strictEqual(merged.rows[0].TD, -80);
  assert.strictEqual(merged.rows[1].TA, 210);
  assert.strictEqual(merged.rows[1].TD, 208);
  assert.strictEqual(merged.filled, 4);

  const alreadyFilled = [
    { STN_ID: 1, TA: 200, RN_12HR: 20, TD: 10 }
  ];
  assert.strictEqual(rowsNeedHubSupplement(alreadyFilled), false);
  const noClobber = mergeHubSupplement(alreadyFilled, [{ STN_ID: 1, RN_12HR: 99, TD: 99 }]);
  assert.strictEqual(noClobber.rows[0].RN_12HR, 20);
  assert.strictEqual(noClobber.filled, 0);

  const lowCoverage = Array.from({ length: 10 }, (_, i) => ({
    STN_ID: i,
    RN_12HR: i === 0 ? 10 : null,
    TD: null
  }));
  assert.ok(fieldCoverage(lowCoverage, 'RN_12HR') < 0.8);
  assert.strictEqual(rowsNeedFieldRefresh(lowCoverage, ['RN_12HR']), true);

  assert.strictEqual(shouldRejectHubReplace(dbRows, []).reject, true);
  assert.strictEqual(shouldRejectHubReplace([{ STN_ID: 1 }, { STN_ID: 2 }, { STN_ID: 3 }], [{ STN_ID: 1 }]).reject, true);
  assert.strictEqual(shouldRejectHubReplace(dbRows, hubRows).reject, false);

  const ok = await supplementDbRowsFromHub({
    tm: '202608151200',
    dbRows,
    fetchHub: async () => hubRows
  });
  assert.strictEqual(ok.source, 'db+hub');
  assert.strictEqual(ok.rows[0].TA, 200);
  assert.strictEqual(ok.rows[0].TD, -80);
  assert.strictEqual(ok.warning, null);

  const failed = await supplementDbRowsFromHub({
    tm: '202608151200',
    dbRows,
    fetchHub: async () => {
      throw new Error('hub down');
    }
  });
  assert.strictEqual(failed.source, 'db');
  assert.strictEqual(failed.rows[0].TA, 200);
  assert.strictEqual(failed.rows[0].TD, null);
  assert.strictEqual(failed.warning.type, 'aws_hub_supplement_failed');
  assert.match(failed.warning.message, /hub down/);

  console.log('OK test_aws_hub_fill');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
