/**
 * KMA-style apparent temperature (체감온도) from AWS fields.
 * Summer (May–Sep): humidity-based. Winter (Oct–Apr): wind-chill-based.
 *
 * Physical inputs only (℃ / % / m/s). Returns ℃ rounded to 1 decimal, or null if missing.
 */
'use strict';

function isMissingScalar(v) {
  if (v == null || v === '') return true;
  if (v === '.') return true;
  const n = Number(v);
  return !Number.isFinite(n);
}

function toFiniteNumber(v) {
  if (isMissingScalar(v)) return null;
  return Number(v);
}

function isSummerMonth(month) {
  return month >= 5 && month <= 9;
}

/**
 * @param {{ tC: number|null|string, rhPct: number|null|string, wsMs: number|null|string, month: number }} input
 * @returns {number|null} apparent temperature ℃ (1 decimal) or null
 */
function computeApparentTempC(input = {}) {
  const month = Number(input.month);
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;

  const tC = toFiniteNumber(input.tC);
  if (tC == null) return null;

  let tFeel;
  if (isSummerMonth(month)) {
    const rhPct = toFiniteNumber(input.rhPct);
    if (rhPct == null) return null;
    const T = tC;
    const RH = rhPct;
    const Tw =
      T * Math.atan(0.151977 * Math.sqrt(RH + 8.313659)) +
      Math.atan(T + RH) -
      Math.atan(RH - 1.676331) +
      0.00391838 * Math.pow(RH, 1.5) * Math.atan(0.023101 * RH) -
      4.686035;
    tFeel = -0.2442 + 0.45535 * T + 3.0 + (0.55399 + 0.00278 * T) * Tw - 0.0022 * (Tw * Tw);
  } else {
    const wsMs = toFiniteNumber(input.wsMs);
    if (wsMs == null) return null;
    if (wsMs <= 1.3) {
      tFeel = tC;
    } else {
      const V_kmh = wsMs * 3.6;
      const v16 = Math.pow(V_kmh, 0.16);
      tFeel = 13.12 + 0.6215 * tC - 11.37 * v16 + 0.3965 * v16 * tC;
    }
  }

  if (!Number.isFinite(tFeel)) return null;
  return Math.round(tFeel * 10) / 10;
}

/**
 * AWS JSON stores ×10 integers. Convert scaled raw → physical, then compute.
 * Hub ≤ -50 (scaled ≤ -500) and non-finite → null.
 *
 * @param {{ taScaled: *, hmScaled: *, wsScaled: *, month: number }} input
 * @returns {number|null} ×10 scaled apparent temp for Int16 encode, or null
 */
function computeApparentTempScaled10(input = {}) {
  const HUB_MISS = -500;
  let ta = toFiniteNumber(input.taScaled);
  let hm = toFiniteNumber(input.hmScaled);
  let ws = toFiniteNumber(input.wsScaled);
  if (ta != null && ta <= HUB_MISS) ta = null;
  if (hm != null && (hm <= HUB_MISS || hm < 0 || hm > 1000)) hm = null;
  if (ws != null && (ws <= HUB_MISS || ws < 0)) ws = null;
  const tC = ta == null ? null : ta / 10;
  const rhPct = hm == null ? null : hm / 10;
  const wsMs = ws == null ? null : ws / 10;
  const c = computeApparentTempC({ tC, rhPct, wsMs, month: input.month });
  if (c == null) return null;
  return Math.round(c * 10);
}

module.exports = {
  isMissingScalar,
  isSummerMonth,
  computeApparentTempC,
  computeApparentTempScaled10
};
