/**
 * Resolve LAW_ID (10-digit 법정동코드) → LAW_ADDR_SIDO / LAW_ADDR_GUGUN
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_LAW_PATH = path.join(__dirname, '..', 'config', 'law_code_sido_sigungu.json');

let cached = null;

function loadLawCodeMaster(filePath = DEFAULT_LAW_PATH) {
  if (cached && cached.filePath === filePath) return cached;
  const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  cached = {
    filePath,
    sido: doc.sido || {},
    sigungu: doc.sigungu || {}
  };
  return cached;
}

/**
 * @param {string|null} lawId
 * @returns {{ LAW_ADDR_SIDO: string|null, LAW_ADDR_GUGUN: string|null, addrSource: 'law_code'|null }}
 */
function resolveLawAddr(lawId, master) {
  const m = master || loadLawCodeMaster();
  const id = lawId != null ? String(lawId).replace(/\D/g, '') : '';
  if (id.length < 2) {
    return { LAW_ADDR_SIDO: null, LAW_ADDR_GUGUN: null, addrSource: null };
  }
  const sidoCode = id.slice(0, 2);
  const sigunguCode = id.length >= 5 ? id.slice(0, 5) : null;
  const sido = m.sido[sidoCode] || null;
  const gugun = sigunguCode ? m.sigungu[sigunguCode] || null : null;
  if (!sido && !gugun) {
    return { LAW_ADDR_SIDO: null, LAW_ADDR_GUGUN: null, addrSource: null };
  }
  return {
    LAW_ADDR_SIDO: sido,
    LAW_ADDR_GUGUN: gugun,
    addrSource: 'law_code'
  };
}

module.exports = {
  DEFAULT_LAW_PATH,
  loadLawCodeMaster,
  resolveLawAddr
};
