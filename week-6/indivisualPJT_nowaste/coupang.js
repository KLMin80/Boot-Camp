// 쿠팡파트너스 딥링크 API — 아무 쿠팡 URL(재료 검색·밀키트 검색)을 '트래킹 링크'로 변환한다.
//  · 이게 있어야 재료별/요리별 정확한 검색 + 수수료 집계가 동시에 된다(고정 링크는 검색어를 못 실음).
//  · HMAC-SHA256(CEA) 서명. 결과는 DB 캐시(fridge_coupang_deeplink)로 재사용 → 호출 한도(초당10) 안전 + 빠름.
//  · 키(.env: COUPANG_API_ACCESS_KEY/SECRET_KEY)가 없거나 API가 막혀도 원본 검색 URL로 폴백 → 앱은 안 죽는다.
const crypto = require('crypto');
const { pool } = require('./db');

const ACCESS = process.env.COUPANG_API_ACCESS_KEY;
const SECRET = process.env.COUPANG_API_SECRET_KEY;
const HOST = 'https://api-gateway.coupang.com';
const PATH = '/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink';
const enabled = Boolean(ACCESS && SECRET);

// 서명용 GMT 시각 — yyMMdd'T'HHmmss'Z' (예: 260828T091500Z)
const gmt = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
};
function authHeader() {
  const dt = gmt();
  const sig = crypto.createHmac('sha256', SECRET).update(dt + 'POST' + PATH).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${ACCESS}, signed-date=${dt}, signature=${sig}`;
}

// 원본 쿠팡 URL 배열 → { [원본URL]: 트래킹URL }. 캐시 우선, 없으면 API, 그래도 없으면 원본 그대로(폴백).
async function deeplinks(urls) {
  const uniq = [...new Set((urls || []).filter(Boolean))];
  const out = {};
  if (!uniq.length) return out;

  // 1) 캐시
  try {
    const c = await pool.query('SELECT url, shorten FROM fridge_coupang_deeplink WHERE url = ANY($1)', [uniq]);
    for (const r of c.rows) out[r.url] = r.shorten;
  } catch { /* 캐시 조회 실패는 무시하고 API로 */ }

  // 2) 캐시에 없는 것만 API로 변환
  const missing = uniq.filter((u) => !out[u]);
  if (missing.length && enabled) {
    try {
      const res = await fetch(HOST + PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authHeader() },
        body: JSON.stringify({ coupangUrls: missing }),
      });
      const j = await res.json().catch(() => null);
      const data = j && Array.isArray(j.data) ? j.data : [];
      const rows = [];
      for (let i = 0; i < missing.length; i++) {
        const d = data.find((x) => x.originalUrl === missing[i]) || data[i];
        const short = d && (d.shortenUrl || d.landingUrl);
        if (short) { out[missing[i]] = short; rows.push([missing[i], short]); }
      }
      if (rows.length) {
        const vals = rows.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(',');
        pool.query(`INSERT INTO fridge_coupang_deeplink(url, shorten) VALUES ${vals} ON CONFLICT (url) DO NOTHING`, rows.flat()).catch(() => {});
      }
    } catch (e) { console.error('[coupang] deeplink 실패:', e.status || '', e.message); }
  }

  // 3) 폴백 — 여전히 없는 건 원본 URL(트래킹은 안 되지만 정확한 검색으로 열림)
  for (const u of uniq) if (!out[u]) out[u] = u;
  return out;
}

module.exports = { deeplinks, enabled };
