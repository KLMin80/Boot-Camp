// Phase C — 영수증 스캔. 합성 영수증 이미지를 만들어 실제 OCR로 품목·가격을 뽑고,
// pending 생성 + 클라이언트 흐름(담기→영수증→확인)까지 실브라우저로 검증한다.
const { chromium } = require('playwright-core');
const { pool } = require('../db');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:3300';
const EMAIL = `receipt_${Date.now()}@t.com`;
const IMG = path.resolve(__dirname, '..', 'demo-video', '_receipt_test.png');

// 정답: 이 5개 식료품이 영수증에 있다
const GROUND = [
  { name: '서울우유 1A 900ml', price: 3150 },
  { name: '풀무원 국산콩두부', price: 2480 },
  { name: '대파 한단', price: 1980 },
  { name: '신선란 15구', price: 6990 },
  { name: '국내산 삼겹살 500g', price: 13900 },
];
const RECEIPT_HTML = `<div id="r" style="width:380px;padding:24px;font-family:'Malgun Gothic',sans-serif;background:#fff;color:#111">
  <div style="text-align:center;font-weight:800;font-size:20px">행복마트 수지점</div>
  <div style="text-align:center;font-size:12px;color:#555;margin:4px 0 12px">2026-07-18 19:24 · POS 03</div>
  <div style="border-top:1px dashed #999;border-bottom:1px dashed #999;padding:8px 0;font-size:14px">
    <div style="display:flex;justify-content:space-between;font-size:12px;color:#777"><span>상품명</span><span>금액</span></div>
    ${GROUND.map((g) => `<div style="display:flex;justify-content:space-between;margin-top:6px"><span>${g.name}</span><span>${g.price.toLocaleString()}</span></div>`).join('')}
    <div style="display:flex;justify-content:space-between;margin-top:6px;color:#888"><span>종량제봉투 20L</span><span>500</span></div>
  </div>
  <div style="display:flex;justify-content:space-between;font-weight:800;margin-top:10px;font-size:16px"><span>합계</span><span>${(GROUND.reduce((s, g) => s + g.price, 0) + 500).toLocaleString()}</span></div>
  <div style="text-align:center;font-size:11px;color:#888;margin-top:12px">감사합니다 · 교환/환불은 7일 이내</div>
</div>`;

const api = async (m, u, { token, body } = {}) => {
  const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
let pass = 0, fail = 0;
const ok = (c, l, e = '') => { c ? (pass++, console.log('  ✓', l)) : (fail++, console.log('  ✗', l, e)); };

(async () => {
  const token = (await api('POST', '/api/auth/signup', { body: { email: EMAIL, password: 'pw123456' } })).data.token;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });

  // 1) 합성 영수증 PNG 렌더
  const gen = await browser.newPage({ viewport: { width: 420, height: 700 }, deviceScaleFactor: 2 });
  await gen.setContent(`<body style="margin:0;background:#ddd;padding:20px">${RECEIPT_HTML}</body>`);
  await gen.waitForTimeout(300);
  await gen.locator('#r').screenshot({ path: IMG });
  await gen.close();

  // 2) OCR 파싱 (실제 OpenAI 호출)
  const buf = require('fs').readFileSync(IMG).toString('base64');
  const parsed = await api('POST', '/api/receipt/parse', { token, body: { image: `data:image/png;base64,${buf}` } });
  ok(parsed.status === 201, '영수증 파싱 201', `status=${parsed.status} ${JSON.stringify(parsed.data).slice(0, 120)}`);
  const items = parsed.data?.items || [];
  console.log('    추출:', items.map((i) => `${i.name}(${i.price})`).join(' | '));
  ok(items.length >= 4, `식료품 4개 이상 추출 (봉투 제외)`, `count=${items.length}`);
  const prices = items.map((i) => i.price);
  ok(prices.includes(3150) && prices.includes(13900), '핵심 가격(우유3150·삼겹살13900) 정확', `prices=${prices}`);
  ok(items.every((i) => i.status === 'pending'), '전부 확인 대기(pending)로 들어감');
  ok(!items.some((i) => /봉투/.test(i.name)), '종량제봉투는 제외됨');

  // 3) 클라이언트 흐름: 담기 → 영수증 → 업로드 → 확인 큐
  const ctx = await browser.newContext({ viewport: { width: 402, height: 848 } });
  await ctx.addInitScript((t) => localStorage.setItem('nowaste.token', t), token);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('nav button:has-text("담기")').click();
  await page.locator('button:has-text("영수증으로 한 번에")').click();
  await page.setInputFiles('input[type="file"]', IMG);           // 갤러리 업로드처럼
  await page.waitForSelector('text=담았어요', { timeout: 60000 });  // OCR 대기
  ok(await page.locator('text=담았어요').first().isVisible(), 'UI: N개 담았어요 결과가 뜬다');
  await page.locator('button:has-text("유통기한 확인하러 가기")').click();
  await page.waitForSelector('text=읽어둔 값이 맞는지만', { timeout: 10000 });
  ok(true, 'UI: 확인 화면으로 넘어가 유통기한 보충 대기');

  await browser.close();
  require('fs').unlinkSync(IMG);
  await pool.query('DELETE FROM fridge_users WHERE email = $1', [EMAIL]);
  await pool.end();
  console.log(`\n${fail === 0 ? '✅ 통과' : '❌ 실패'} (${pass}/${pass + fail})`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { require('fs').unlinkSync(IMG); } catch {} try { await pool.query('DELETE FROM fridge_users WHERE email=$1', [EMAIL]); } catch {} process.exit(1); });
