/**
 * 하위 호환 wrapper. 실제 구현은 warm_aws_min_packs.js (기본 variables=TA).
 *
 *   node kma_fetch/warm_aws_ta_pack.js 20260811
 *   node kma_fetch/warm_aws_ta_pack.js --from 20260801 --to 20260811 --force
 */
require('./warm_aws_min_packs');
