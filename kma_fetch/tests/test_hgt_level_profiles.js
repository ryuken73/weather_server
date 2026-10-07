/**
 * HGT500/850 list util + level profile naming smoke
 *   node kma_fetch/tests/test_hgt_level_profiles.js
 */
const assert = require('assert');
const path = require('path');
const fsp = require('fs/promises');
const os = require('os');
const {
  DATASET_ID_RE,
  DATASET_ID_RE_BY_LEVEL,
  listHgt500Datasets,
  listHgt850Datasets
} = require('../utils/hgt500_dataset_list');

assert.ok(DATASET_ID_RE.test('kim-glob-hgt500-2026070100'));
assert.ok(!DATASET_ID_RE.test('kim-glob-hgt850-2026070100'));
assert.ok(DATASET_ID_RE_BY_LEVEL[850].test('kim-glob-hgt850-2026070100'));
assert.ok(!DATASET_ID_RE_BY_LEVEL[850].test('kim-glob-hgt500-2026070100'));

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hgt-levels-'));
  const ds500 = path.join(tmp, 'kim-glob-hgt500-2026070100');
  const ds850 = path.join(tmp, 'kim-glob-hgt850-2026070100');
  await fsp.mkdir(ds500, { recursive: true });
  await fsp.mkdir(ds850, { recursive: true });

  const manifestBase = {
    schemaVersion: 1,
    sourceForecastIntervalMinutes: 180,
    outputFrameIntervalMinutes: 10,
    source: { format: 'kim-api-text', downsampleFactor: 3 },
    frames: [
      { index: 0, validTime: '2026-07-01T00:00:00Z' },
      { index: 1, validTime: '2026-07-01T00:10:00Z' }
    ]
  };
  await fsp.writeFile(
    path.join(ds500, 'manifest.json'),
    JSON.stringify({ ...manifestBase, datasetId: 'kim-glob-hgt500-2026070100' })
  );
  await fsp.writeFile(
    path.join(ds850, 'manifest.json'),
    JSON.stringify({ ...manifestBase, datasetId: 'kim-glob-hgt850-2026070100' })
  );

  const r500 = await listHgt500Datasets(tmp);
  const r850 = await listHgt850Datasets(tmp);
  assert.strictEqual(r500.items.length, 1);
  assert.strictEqual(r500.items[0].datasetId, 'kim-glob-hgt500-2026070100');
  assert.strictEqual(r850.items.length, 1);
  assert.strictEqual(r850.items[0].datasetId, 'kim-glob-hgt850-2026070100');
  assert.strictEqual(r850.items[0].manifestUrl, '/datasets/kim-glob-hgt850-2026070100/manifest.json');

  console.log('OK test_hgt_level_profiles');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
