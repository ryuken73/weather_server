/**
 * stn_inf_aws_*.txt → aws_stn_code_*.json + aws_stn_name_map_*.json
 * Usage: node kma_fetch/config/_build_stn_code_from_stn_inf.js [stn_inf_path]
 */
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = __dirname;
const DEFAULT_INF = path.join(CONFIG_DIR, 'stn_inf_aws_20260811.txt');
const infPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_INF;

// JS \b는 한글에 안 맞음 → 시·도명 뒤 공백/끝으로 구분
const SIDO_RE =
  /(\(산지\))?(서울특별시|부산광역시|대구광역시|인천광역시|광주광역시|대전광역시|울산광역시|세종특별자치시|경기도|강원특별자치도|강원도|충청북도|충청남도|전북특별자치도|전라북도|전남광주통합특별시|전라남도|경상북도|경상남도|제주특별자치도)(?=\s|$)/;

/** LAW_ADDR에서 시도 다음 시·군·구 추출. 없으면 읍·면·동(없으면 리) */
function extractGugun(lawAddr, sido) {
  if (!lawAddr) return null;
  let rest = lawAddr.replace(/^\(산지\)/, '').trim();
  if (sido) {
    const i = rest.indexOf(sido);
    if (i >= 0) rest = rest.slice(i + sido.length).trim();
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;

  const t0 = tokens[0];
  // 전주시 덕진구, 창원시 마산합포구 등: 시 + 구
  if (/시$/.test(t0) && tokens[1] && /구$/.test(tokens[1])) {
    return `${t0} ${tokens[1]}`;
  }
  // 종로구 / 군산시 / 해남군 / 수원시권선구 / 포항시남구
  if (/(시|군|구)$/.test(t0) || /시.+구$/.test(t0)) {
    return t0;
  }
  // 구·군 없음(세종 등) → 읍·면·동, 없으면 리
  if (/(읍|면|동)$/.test(t0)) return t0;
  if (/리$/.test(t0)) return t0;
  return tokens[0] || null;
}

function parseStnInf(text) {
  const rows = [];
  const warnings = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!/^\s*\d+\s+/.test(line)) continue;

    const head = line.match(
      /^\s*(\d+)\s+([-\d.]+)\s+([-\d.]+)\s+(\S+)\s+([-\d.]+)\s+([-\d.]+)\s+(\S+)\s+(\S+)\s+(.*)$/
    );
    if (!head) {
      warnings.push({ type: 'unparsed', line: line.slice(0, 100) });
      continue;
    }

    const STN_ID = Number(head[1]);
    const LON = Number(head[2]);
    const LAT = Number(head[3]);
    const HT = Number(head[5]);
    const rest = head[9];

    // STN_KO is left-padded field (~20), then STN_EN, FCT_ID, LAW_ID, BASIN, LAW_ADDR
    const nameMatch = rest.match(
      /^(.+?)\s{2,}(\S+)\s+(\S+)\s+(\d{10}|-+\d*)\s+(\S+)\s+(.*)$/
    );

    let STN_NAME;
    let LAW_ADDR = '';
    if (nameMatch) {
      STN_NAME = nameMatch[1].replace(/\s*\*\s*$/, '').trim();
      LAW_ADDR = nameMatch[6].trim();
    } else {
      STN_NAME = rest.split(/\s{2,}/)[0].replace(/\s*\*\s*$/, '').trim();
    }

    const sidoHit = LAW_ADDR.match(SIDO_RE) || line.match(SIDO_RE);
    let LAW_ADDR_SIDO = null;
    if (sidoHit) {
      LAW_ADDR_SIDO = sidoHit[2];
      if (!LAW_ADDR || !LAW_ADDR.includes(LAW_ADDR_SIDO)) {
        const idx = line.indexOf(sidoHit[0].startsWith('(산지)') ? sidoHit[0] : LAW_ADDR_SIDO);
        if (idx >= 0) LAW_ADDR = line.slice(idx).replace(/^\(산지\)/, '').trim();
      } else {
        LAW_ADDR = LAW_ADDR.replace(/^\(산지\)/, '').trim();
      }
    } else {
      warnings.push({ type: 'no_sido', STN_ID, STN_NAME, rest: rest.slice(0, 80) });
    }

    const LAW_ADDR_GUGUN = extractGugun(LAW_ADDR, LAW_ADDR_SIDO);
    if (LAW_ADDR_SIDO && !LAW_ADDR_GUGUN) {
      warnings.push({ type: 'no_gugun', STN_ID, STN_NAME, LAW_ADDR });
    }

    rows.push({
      STN_ID,
      STN_NAME,
      LAT,
      LON,
      HT,
      LAW_ADDR_SIDO,
      LAW_ADDR_GUGUN
    });
  }

  rows.sort((a, b) => a.STN_ID - b.STN_ID);
  return { rows, warnings };
}

function main() {
  const base = path.basename(infPath);
  const m = base.match(/stn_inf_aws_(\d{8})/);
  const ymd = m ? m[1] : 'unknown';
  const text = fs.readFileSync(infPath, 'utf8');
  const { rows, warnings } = parseStnInf(text);

  const codeOut = {
    schemaVersion: 3,
    source: `stn_inf.php inf=AWS (${base})`,
    generatedAt: new Date().toISOString(),
    stationCount: rows.length,
    namedCount: rows.filter((r) => r.STN_NAME).length,
    fields: ['STN_ID', 'STN_NAME', 'LAT', 'LON', 'HT', 'LAW_ADDR_SIDO', 'LAW_ADDR_GUGUN'],
    stations: rows
  };

  const nameMap = {};
  for (const r of rows) nameMap[String(r.STN_ID)] = r.STN_NAME;

  const codePath = path.join(CONFIG_DIR, `aws_stn_code_${ymd}.json`);
  const mapPath = path.join(CONFIG_DIR, `aws_stn_name_map_${ymd}.json`);
  fs.writeFileSync(codePath, JSON.stringify(codeOut, null, 2) + '\n', 'utf8');
  fs.writeFileSync(mapPath, JSON.stringify(nameMap, null, 2) + '\n', 'utf8');

  const sidoBag = new Map();
  const noGugun = [];
  for (const r of rows) {
    const k = r.LAW_ADDR_SIDO || '(null)';
    sidoBag.set(k, (sidoBag.get(k) || 0) + 1);
    if (!r.LAW_ADDR_GUGUN) noGugun.push(r);
  }

  console.log(
    JSON.stringify(
      {
        infPath,
        codePath,
        mapPath,
        stationCount: rows.length,
        withGugun: rows.filter((r) => r.LAW_ADDR_GUGUN).length,
        warningCount: warnings.length,
        noGugunWarnings: warnings.filter((w) => w.type === 'no_gugun'),
        sidoCounts: [...sidoBag.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ko')),
        samples: [42, 90, 100, 108, 116, 128, 146, 249, 373, 549, 972].map((id) =>
          rows.find((r) => r.STN_ID === id)
        )
      },
      null,
      2
    )
  );
}

main();
