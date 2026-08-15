/**
 * 하위 호환 wrapper. warm_aws_min_packs.js 를 TA만 생성하도록 호출한다.
 *
 *   node kma_fetch/warm_aws_ta_pack.js 20260811
 *   node kma_fetch/warm_aws_ta_pack.js --from 20260801 --to 20260811 --force
 */
const hasVariables = process.argv.some(
  (a) => a === '--variables' || String(a).startsWith('--variables=')
);
if (!hasVariables) {
  process.argv.push('--variables', 'TA');
}
require('./warm_aws_min_packs');
