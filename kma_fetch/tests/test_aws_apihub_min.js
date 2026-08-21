/**
 *   node kma_fetch/tests/test_aws_apihub_min.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseApiText, apiRowToDbShape } = require('../services/aws_apihub_min');

const FIXTURE = path.join(
  __dirname,
  '..',
  '..',
  'skills',
  'aws-min-json-pipeline',
  'assets',
  'nph-aws2_min_202608131200.txt'
);

function main() {
  const text = fs.readFileSync(FIXTURE, 'utf8');
  const byTm = parseApiText(text);
  const rowsParts = byTm.get('202608131200');
  assert.ok(rowsParts, 'fixture minute missing');
  assert.strictEqual(rowsParts.length, 736);

  const emptyMeta = new Map();
  const rows = rowsParts.map((p) => apiRowToDbShape(p, {}, emptyMeta));

  const byId = new Map(rows.map((r) => [r.STN_ID, r]));
  assert.deepStrictEqual(
    {
      RN_15M: byId.get(530).RN_15M,
      RN_60M: byId.get(530).RN_60M,
      RN_1HR: byId.get(530).RN_1HR,
      RN_12HR: byId.get(530).RN_12HR,
      RN_DAY: byId.get(530).RN_DAY,
      RN_24HR: byId.get(530).RN_24HR,
      WD: byId.get(42).WD,
      WS: byId.get(42).WS,
      WD_INS: byId.get(42).WD_INS,
      WS_INS: byId.get(42).WS_INS,
      HM: byId.get(42).HM,
      TD: byId.get(42).TD
    },
    {
      RN_15M: 5,
      RN_60M: 60,
      RN_1HR: 60,
      RN_12HR: 95,
      RN_DAY: 95,
      RN_24HR: 95,
      WD: 410,
      WS: 36,
      WD_INS: 424,
      WS_INS: 40,
      HM: 588,
      TD: 208
    }
  );
  assert.strictEqual(byId.get(679).RN_15M, 0);
  assert.strictEqual(byId.get(679).RN_60M, 0);
  assert.strictEqual(byId.get(679).RN_12HR, 245);
  assert.strictEqual(byId.get(679).RN_DAY, 245);
  assert.strictEqual(byId.get(679).RN_24HR, 245);
  assert.strictEqual(byId.get(793).RN_15M, 10);
  assert.strictEqual(byId.get(793).RN_60M, 10);
  assert.strictEqual(byId.get(793).RN_1HR, 10);
  assert.strictEqual(byId.get(793).RN_12HR, 10);
  assert.strictEqual(byId.get(793).RN_DAY, 10);
  assert.strictEqual(byId.get(793).RN_24HR, 10);

  // RN_1HR is RN-60m alias, not a distinct Hub field
  for (const row of rows) {
    assert.strictEqual(row.RN_1HR, row.RN_60M);
    // Migration: RN_DAY canonical, RN_24HR legacy mirror of day total
    assert.strictEqual(row.RN_DAY, row.RN_24HR);
  }

  const rainValid = rows.filter((r) => r.RN_15M != null).length;
  const rainMissing = rows.length - rainValid;
  const reValid = rows.filter((r) => r.RN_YN != null).length;
  assert.strictEqual(rainValid, 712);
  assert.strictEqual(rainMissing, 24);
  assert.strictEqual(reValid, 0);

  let max15 = { v: -1, id: null };
  let max60 = { v: -1, id: null };
  let max12 = { v: -1, id: null };
  let maxDay = { v: -1, id: null };
  for (const row of rows) {
    if (row.RN_15M != null && row.RN_15M > max15.v) max15 = { v: row.RN_15M, id: row.STN_ID };
    if (row.RN_60M != null && row.RN_60M > max60.v) max60 = { v: row.RN_60M, id: row.STN_ID };
    if (row.RN_12HR != null && row.RN_12HR > max12.v) max12 = { v: row.RN_12HR, id: row.STN_ID };
    if (row.RN_DAY != null && row.RN_DAY > maxDay.v) maxDay = { v: row.RN_DAY, id: row.STN_ID };
  }
  assert.deepStrictEqual(max15, { v: 10, id: 793 });
  assert.deepStrictEqual(max60, { v: 60, id: 530 });
  assert.deepStrictEqual(max12, { v: 245, id: 679 });
  assert.deepStrictEqual(maxDay, { v: 245, id: 679 });

  console.log('OK test_aws_apihub_min');
}

main();
