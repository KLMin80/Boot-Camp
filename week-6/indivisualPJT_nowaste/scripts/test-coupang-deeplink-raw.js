// 쿠팡파트너스 딥링크 API 서명·엔드포인트 검증(1회 호출). 키 값은 출력하지 않음.
require('dotenv').config();
const crypto = require('crypto');
const ACCESS = process.env.COUPANG_API_ACCESS_KEY;
const SECRET = process.env.COUPANG_API_SECRET_KEY;
const HOST = 'https://api-gateway.coupang.com';
const PATH = '/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink';
const gmt = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`; };
(async () => {
  if (!ACCESS || !SECRET) { console.log('키 없음(.env 확인)'); return; }
  const dt = gmt();
  const sig = crypto.createHmac('sha256', SECRET).update(dt + 'POST' + PATH).digest('hex');
  const auth = `CEA algorithm=HmacSHA256, access-key=${ACCESS}, signed-date=${dt}, signature=${sig}`;
  const res = await fetch(HOST + PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ coupangUrls: ['https://www.coupang.com/np/search?q=우유&channel=user', 'https://www.coupang.com/np/search?q=김치찌개 밀키트'] }),
  });
  console.log('HTTP', res.status);
  const j = await res.json().catch(() => null);
  console.log(JSON.stringify(j, null, 2));
})().catch((e) => console.error('ERR', e.message));
