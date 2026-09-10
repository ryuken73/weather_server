const assert = require('assert');
const {
  parseAwshRnText,
  RN_AMOUNT_FIELDS,
  assertRnAmountNonNegative
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

const { tm, rows } = parseAwshRnText(sample);
assert.strictEqual(tm, '202609041100');
assert.strictEqual(rows.length, 3);

const s611 = rows.find((r) => r.STN_ID === 611);
assert.strictEqual(s611.RE_SUM, 0);
assert.strictEqual(s611.RE_QCM, 60);
assert.strictEqual(s611.RN_DAY, 8.5);
assert.strictEqual(s611.RN_DAY_MI, 0);
assert.strictEqual(s611.RN_HR1, 1.2);
assert.strictEqual(s611.RN_HR1_MI, 60);
assert.strictEqual(s611.RN_60M_MAX, 3.4);
assert.strictEqual(s611.RN_60M_MAX_MI, -50);
assert.strictEqual(s611.RN_15M_MAX, 1.0);
assert.strictEqual(s611.RN_15M_MAX_MI, -10);

const s108 = rows.find((r) => r.STN_ID === 108);
assert.strictEqual(s108.RN_HR1, 0);
assert.strictEqual(s108.RN_60M_MAX, 0);

const s999 = rows.find((r) => r.STN_ID === 999);
assert.strictEqual(s999.RN_HR1, null);
assert.strictEqual(s999.RN_60M_MAX, null);

assertRnAmountNonNegative(rows);

/** 예전 버그: RE_* 없이 RN_DAY부터 매핑하면 RN_15M_MAX에 MI(-50)가 들어감 */
const shiftedBugSample = `
202609041100   611    8.5         0    1.2        60        3.4           -50       60        1.0           -10       60
`;
// 위는 컬럼 부족/밀림 시나리오가 아니라 RE 없는 짧은 줄 — 명시적 음수 amount로 invariant 검증
let threw = false;
try {
  assertRnAmountNonNegative([
    { STN_ID: 611, TM: '202609041100', RN_15M_MAX: -50, RN_DAY: 1, RN_HR1: 1, RN_60M_MAX: 1 }
  ]);
} catch (err) {
  threw = err.code === 'RN_AMOUNT_NEGATIVE' && err.field === 'RN_15M_MAX';
}
assert.ok(threw, 'expected RN_AMOUNT_NEGATIVE for negative RN_15M_MAX');

for (const f of RN_AMOUNT_FIELDS) {
  assert.ok(s611[f] == null || s611[f] >= 0, `${f} must be null or >= 0`);
}

console.log('ok test_aws_apihub_hourly');
