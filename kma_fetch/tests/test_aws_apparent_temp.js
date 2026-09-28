/**
 *   node kma_fetch/tests/test_aws_apparent_temp.js
 */
const assert = require('assert');
const {
  computeApparentTempC,
  computeApparentTempScaled10,
  isSummerMonth
} = require('../utils/aws_apparent_temp');

assert.strictEqual(isSummerMonth(5), true);
assert.strictEqual(isSummerMonth(9), true);
assert.strictEqual(isSummerMonth(4), false);
assert.strictEqual(isSummerMonth(10), false);

// Missing inputs
assert.strictEqual(computeApparentTempC({ tC: null, rhPct: 50, wsMs: 2, month: 7 }), null);
assert.strictEqual(computeApparentTempC({ tC: 25, rhPct: null, wsMs: 2, month: 7 }), null);
assert.strictEqual(computeApparentTempC({ tC: 0, rhPct: 50, wsMs: null, month: 1 }), null);
assert.strictEqual(computeApparentTempC({ tC: 10, rhPct: 50, wsMs: 2, month: 13 }), null);
assert.strictEqual(computeApparentTempC({ tC: '.', rhPct: 50, wsMs: 2, month: 7 }), null);

// Winter: V <= 1.3 → equals T
assert.strictEqual(computeApparentTempC({ tC: -5, rhPct: 80, wsMs: 1.3, month: 1 }), -5);
assert.strictEqual(computeApparentTempC({ tC: -5, rhPct: 80, wsMs: 0.5, month: 12 }), -5);

// Winter: V > 1.3 wind-chill (snapshot)
const winter = computeApparentTempC({ tC: -5, rhPct: 80, wsMs: 5, month: 1 });
assert.ok(winter != null && Number.isFinite(winter));
assert.strictEqual(winter, Math.round(winter * 10) / 10);
assert.ok(winter < -5); // wind chill colder than air

// Summer humidity formula (snapshot)
const summer = computeApparentTempC({ tC: 25, rhPct: 70, wsMs: 0, month: 7 });
assert.ok(summer != null && Number.isFinite(summer));
assert.strictEqual(summer, Math.round(summer * 10) / 10);

// Month boundary: April winter, May summer
const apr = computeApparentTempC({ tC: 20, rhPct: 60, wsMs: 5, month: 4 });
const may = computeApparentTempC({ tC: 20, rhPct: 60, wsMs: 5, month: 5 });
assert.ok(apr != null && may != null);
assert.notStrictEqual(apr, may);

const sep = computeApparentTempC({ tC: 20, rhPct: 60, wsMs: 5, month: 9 });
const oct = computeApparentTempC({ tC: 20, rhPct: 60, wsMs: 5, month: 10 });
assert.ok(sep != null && oct != null);
assert.notStrictEqual(sep, oct);

// Scaled helper: TA=250, HM=700, WS=50 → physical 25°C, 70%, 5 m/s
const scaledSummer = computeApparentTempScaled10({
  taScaled: 250,
  hmScaled: 700,
  wsScaled: 50,
  month: 7
});
assert.strictEqual(scaledSummer, Math.round(summer * 10));

assert.strictEqual(
  computeApparentTempScaled10({ taScaled: -999, hmScaled: 700, wsScaled: 50, month: 7 }),
  null
);
assert.strictEqual(
  computeApparentTempScaled10({ taScaled: -600, hmScaled: 700, wsScaled: 50, month: 7 }),
  null
);

// Deterministic winter snapshot for pack docs
const winterSnap = computeApparentTempC({ tC: -10, rhPct: 50, wsMs: 4, month: 2 });
assert.ok(winterSnap != null);
assert.strictEqual(winterSnap, Math.round(winterSnap * 10) / 10);

console.log('OK test_aws_apparent_temp', { summer, winter, winterSnap, apr, may });
