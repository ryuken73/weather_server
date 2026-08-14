/**
 *   node kma_fetch/tests/test_aws_paths.js
 */
const assert = require('assert');
const path = require('path');
const {
  PRODUCTION_AWS_JSON_DIR,
  PRODUCTION_AWS_PACK_DIR,
  isProductionNodeEnv,
  deriveAwsJsonDirFromBase,
  deriveAwsPackDirFromBase
} = require('../utils/aws_paths');
const { deriveAwsJsonDir } = require('../utils/aws_min_json');
const { deriveAwsPackDir } = require('../utils/aws_min_pack');

const ROOT = path.join(__dirname, '..', '..');

function main() {
  assert.strictEqual(isProductionNodeEnv({ NODE_ENV: 'production' }), true);
  assert.strictEqual(isProductionNodeEnv({ NODE_ENV: 'prod' }), true);
  assert.strictEqual(isProductionNodeEnv({ NODE_ENV: 'development' }), false);

  assert.strictEqual(
    deriveAwsJsonDir(ROOT, { NODE_ENV: 'production' }),
    PRODUCTION_AWS_JSON_DIR
  );
  assert.strictEqual(
    deriveAwsPackDir(ROOT, { NODE_ENV: 'production' }),
    PRODUCTION_AWS_PACK_DIR
  );

  const customJson = '/tmp/custom/aws';
  assert.strictEqual(
    deriveAwsJsonDir(ROOT, { NODE_ENV: 'production', AWS_JSON_DIR: customJson }),
    customJson
  );

  assert.strictEqual(
    deriveAwsJsonDirFromBase(ROOT, './data/weather'),
    path.join(ROOT, 'data', 'weather', 'in_data', 'aws')
  );
  assert.strictEqual(
    deriveAwsPackDirFromBase(ROOT, './data/weather'),
    path.join(ROOT, 'data', 'weather', 'out_data', 'aws', 'pack')
  );

  console.log('test_aws_paths: ok');
}

main();
