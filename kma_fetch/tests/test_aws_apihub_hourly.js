const assert = require('assert');
const { parseAwshRnText } = require('../services/aws_apihub_hourly');

const sample = `
#START7777
# YYMMDDHHMI   STN  RN_DAY RN_DAY_MI RN_HR1 RN_HR1_MI RN_60M_MAX RN_60M_MAX_MI RN_60M_QCM RN_15M_MAX RN_15M_MAX_MI RN_15M_QCM
#        KST    ID      mm        mi     mm        mi         mm            mi        n         mm            mi        n
202609041100   611     8.5         0    1.2        60        3.4           -50       60        1.0           -10       60
202609041100   108     0.0         0    0.0        60        0.0             0       60        0.0             0       60
202609041100   999   -99.9         0  -99.9        60      -99.9             0        0      -99.9             0        0
#7777END
`;

const { tm, rows } = parseAwshRnText(sample);
assert.strictEqual(tm, '202609041100');
assert.strictEqual(rows.length, 3);

const s611 = rows.find((r) => r.STN_ID === 611);
assert.strictEqual(s611.RN_HR1, 1.2);
assert.strictEqual(s611.RN_60M_MAX, 3.4);
assert.strictEqual(s611.RN_60M_MAX_MI, -50);
assert.strictEqual(s611.RN_DAY, 8.5);

const s108 = rows.find((r) => r.STN_ID === 108);
assert.strictEqual(s108.RN_HR1, 0);
assert.strictEqual(s108.RN_60M_MAX, 0);

const s999 = rows.find((r) => r.STN_ID === 999);
assert.strictEqual(s999.RN_HR1, null);
assert.strictEqual(s999.RN_60M_MAX, null);

console.log('ok test_aws_apihub_hourly');
