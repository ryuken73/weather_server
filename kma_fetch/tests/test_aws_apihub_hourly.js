const assert = require('assert');
const {
  parseAwshRnText,
  sanitizeRnAmountNegatives,
  RN_AMOUNT_FIELDS
} = require('../services/aws_apihub_hourly');

/** 명세 컬럼: STN 뒤 RE_SUM, RE_QCM 후 RN_* */
const sample = `
#START7777
# YYMMDDHHMI   STN RE_SUM RE_QCM RN_DAY RN_DAY_MI RN_HR1 RN_HR1_MI RN_60M_MAX RN_60M_MAX_MI RN_60M_QCM RN_15M_MAX RN_15M_MAX_MI RN_15M_QCM
#        KST    ID      n      n     mm        mi     mm        mi         mm            mi        n         mm            mi        n
202609041100   611      0     60    8.5         0    1.2        60        3.4           -50       60        1.0           -10       60
202609041100   108      0     60    0.0         0    0.0        60        0.0             0       60        0.0             0       60
202609041100   999      0      0  -99.9         0  -99.9        60      -99.9             0        0      -99.9             0        0
#7777END
`;

const { tm, rows, qc } = parseAwshRnText(sample);
assert.strictEqual(tm, '202609041100');
assert.strictEqual(rows.length, 3);
assert.strictEqual(qc.negativeAmountNulls.nullCount, 0);

const s611 = rows.find((r) => r.STN_ID === 611);
assert.strictEqual(s611.RE_SUM, 0);
assert.strictEqual(s611.RE_QCM, 60);
assert.strictEqual(s611.RN_DAY, 8.5);
assert.strictEqual(s611.RN_HR1, 1.2);
assert.strictEqual(s611.RN_60M_MAX, 3.4);
assert.strictEqual(s611.RN_60M_MAX_MI, -50);
assert.strictEqual(s611.RN_15M_MAX, 1.0);

const s999 = rows.find((r) => r.STN_ID === 999);
assert.strictEqual(s999.RN_HR1, null);
assert.strictEqual(s999.RN_60M_MAX, null);

/** 소수 지점 음수 → 해당 field만 null, TM 전체 FAIL 아님 */
const sparseNeg = `
202608170800   513      0     60    1.0         0   -0.5        60        2.0             0       60        0.5             0       60
202608170800   108      0     60    0.0         0    0.0        60        0.0             0       60        0.0             0       60
`;
const sparse = parseAwshRnText(sparseNeg);
assert.strictEqual(sparse.rows.length, 2);
const s513 = sparse.rows.find((r) => r.STN_ID === 513);
assert.strictEqual(s513.RN_HR1, null);
assert.strictEqual(s513.RN_DAY, 1.0);
assert.strictEqual(s513.RN_60M_MAX, 2.0);
const s108 = sparse.rows.find((r) => r.STN_ID === 108);
assert.strictEqual(s108.RN_HR1, 0);
assert.strictEqual(sparse.qc.negativeAmountNulls.nullCount, 1);
assert.strictEqual(sparse.qc.negativeAmountNulls.samples[0].STN_ID, 513);

/** 다량 음수 → flood fatal */
const floodRows = [];
for (let i = 0; i < 100; i++) {
  floodRows.push({
    STN_ID: i,
    TM: '202608170800',
    RN_DAY: -0.5,
    RN_HR1: -0.5,
    RN_60M_MAX: -0.5,
    RN_15M_MAX: -0.5
  });
}
let flooded = false;
try {
  sanitizeRnAmountNegatives(floodRows, { context: 'flood-test' });
} catch (err) {
  flooded = err.code === 'RN_AMOUNT_NEGATIVE_FLOOD';
}
assert.ok(flooded, 'expected RN_AMOUNT_NEGATIVE_FLOOD');

for (const f of RN_AMOUNT_FIELDS) {
  assert.ok(s611[f] == null || s611[f] >= 0, `${f} must be null or >= 0`);
}

console.log('ok test_aws_apihub_hourly');
