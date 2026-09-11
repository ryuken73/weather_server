const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { DateTime } = require('luxon');
const {
  enumerateClosedHourlyTmsLookback,
  ensureHourlyRnHours,
  hourlyRnJsonPath,
  DEFAULT_HOURLY_LOOKBACK_HOURS
} = require('../utils/aws_hourly_stat');
const { resolveInterval } = require('../services/scheduler');

const ZONE = 'Asia/Seoul';

/** 10:12 → 최신 1000, lookback 6 → 0500..1000 */
{
  const now = DateTime.fromObject(
    { year: 2026, month: 9, day: 11, hour: 10, minute: 12 },
    { zone: ZONE }
  );
  const tms = enumerateClosedHourlyTmsLookback(now, 6);
  assert.strictEqual(tms.length, 6);
  assert.strictEqual(tms[0], '202609110500');
  assert.strictEqual(tms[tms.length - 1], '202609111000');
  assert.ok(!tms.includes('202609111100'), 'must not include in-progress next hour');
}

/** 자정 직후 lookback이 전일 포함 */
{
  const now = DateTime.fromObject(
    { year: 2026, month: 9, day: 11, hour: 0, minute: 12 },
    { zone: ZONE }
  );
  const tms = enumerateClosedHourlyTmsLookback(now, 6);
  assert.deepStrictEqual(tms, [
    '202609101900',
    '202609102000',
    '202609102100',
    '202609102200',
    '202609102300',
    '202609110000'
  ]);
}

/** 기본 lookback */
{
  const tms = enumerateClosedHourlyTmsLookback(
    DateTime.fromObject({ year: 2026, month: 1, day: 1, hour: 3, minute: 0 }, { zone: ZONE }),
    DEFAULT_HOURLY_LOOKBACK_HOURS
  );
  assert.strictEqual(tms.length, DEFAULT_HOURLY_LOOKBACK_HOURS);
}

/** scheduler hourly_stat minute override */
{
  assert.strictEqual(resolveInterval('hourly_stat', {}), '12 * * * *');
  assert.strictEqual(resolveInterval('hourly_stat', { AWS_HOURLY_STAT_MINUTE: '15' }), '15 * * * *');
  assert.strictEqual(resolveInterval('hourly_stat', { AWS_HOURLY_STAT_MINUTE: '99' }), '59 * * * *');
  assert.strictEqual(resolveInterval('5min'), '4-59/5 * * * *');
}

/** ensureHourlyRnHours: missing-only skip + write */
async function testEnsure() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aws-hourly-ensure-'));
  try {
    const tmExist = '202609111000';
    const tmNew = '202609110900';
    const existPath = hourlyRnJsonPath(tmp, tmExist);
    await fsp.mkdir(path.dirname(existPath), { recursive: true });
    await fsp.writeFile(existPath, '{}', 'utf8');

    let fetchCalls = 0;
    const summary = await ensureHourlyRnHours(tmp, [tmExist, tmNew], {
      force: false,
      sleepMs: 0,
      fetchFn: async (tm) => {
        fetchCalls += 1;
        assert.strictEqual(tm, tmNew);
        return {
          rows: [{ STN_ID: 108, RN_DAY: 1, RN_HR1: 0.1 }],
          qc: { negativeAmountNulls: { nullCount: 0 } }
        };
      }
    });

    assert.strictEqual(summary.skipped, 1);
    assert.strictEqual(summary.ok, 1);
    assert.strictEqual(fetchCalls, 1);
    assert.deepStrictEqual(summary.writtenTms, [tmNew]);
    assert.deepStrictEqual(summary.writtenDays, ['20260911']);
    assert.ok(fs.existsSync(hourlyRnJsonPath(tmp, tmNew)));
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

testEnsure()
  .then(() => {
    console.log('ok test_aws_hourly_stat_ensure');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
