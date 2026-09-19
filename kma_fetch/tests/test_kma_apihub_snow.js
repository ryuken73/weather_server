/**
 * Parser unit tests (no Hub call).
 *   node kma_fetch/tests/test_kma_apihub_snow.js
 */
const assert = require('assert');
const {
  parseStationsText,
  parseSnowObsText,
  mergeSnowObsByStation,
  scale10Cm
} = require('../services/kma_apihub_snow');

const STN_SAMPLE = `
#START7777
# STN_ID LON LAT STN_SP HT STN_CD STN_KO STN_AD FCT_ID LAW_ID
  90 128.56472000 38.25085000 000----- 18.06 90 속초 11D20401 4282033035
 108 126.96580000 37.57140000 000----- 85.50 108 서울 11B10101 1114055000
#7777END
`;

const OBS_SAMPLE = `
#START7777
# YYMMDDHHMI STN STN LON LAT STN SD
201412051800, 90, 속초, 128.56472000, 38.25085000, 000-----, 0.0,=
201412051800, 108, 서울, 126.96580000, 37.57140000, 000-----, 12.5,=
#7777END
`;

const stations = parseStationsText(STN_SAMPLE);
assert.strictEqual(stations.length, 2);
assert.strictEqual(stations[0].STN_ID, 90);
assert.ok(stations[0].LAW_ID === '4282033035' || stations[0].STN_NAME);
assert.strictEqual(stations[1].STN_ID, 108);

const totRows = parseSnowObsText(OBS_SAMPLE, 'tot');
assert.strictEqual(totRows.length, 2);
assert.strictEqual(totRows[0].SD_TOT, 0);
assert.strictEqual(totRows[1].SD_TOT, 125);

const h24Rows = parseSnowObsText(
  OBS_SAMPLE.replace('0.0', '3.0').replace('12.5', '8.0'),
  '24h'
);
const merged = mergeSnowObsByStation(totRows, h24Rows, '201412051800');
assert.strictEqual(merged.length, 2);
assert.strictEqual(merged.find((r) => r.STN_ID === 108).SD_TOT, 125);
assert.strictEqual(merged.find((r) => r.STN_ID === 108).SD_24H, 80);

assert.strictEqual(scale10Cm(-99.9), null);
assert.strictEqual(scale10Cm(0), 0);
assert.strictEqual(scale10Cm(1.2), 12);

console.log('OK test_kma_apihub_snow');
