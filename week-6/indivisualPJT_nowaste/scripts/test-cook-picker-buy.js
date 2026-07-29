// 요리 화면 두 개선 검증:
//  (1) '냉장고에서 골라' picker가 열릴 때 서버에서 최신 냉장고를 다시 불러온다 (다른 화면 변경도 반영).
//  (2) 레시피 상세의 양념 코멘트 옆 '🛒 장보기' 버튼 → 양념 '이름만'(양 제거)으로 BuySheet 오픈.
const { chromium } = require('playwright-core');
const { pool } = require('../db');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:3300';
const EMAIL = `cpb_${Date.now()}@t.com`;
const api = async (m, u, { token, body } = {}) => {
  const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
let pass = 0, fail = 0;
const ok = (c, l, e = '') => { c ? (pass++, console.log('  ✓', l)) : (fail++, console.log('  ✗', l, e)); };
// 앱과 동일한 '양념 이름만 추출' 규칙
const stripAmt = (s) => s.replace(/\s*(?:\d.*|약간.*|조금.*|적당량.*|살짝.*|톡톡.*|넉넉.*|톡.*)$/, '').trim();
const addItem = (token, name, ingredient) => api('POST', '/api/items', { token, body: { name, ingredient, capacity: 300, unit: 'g', price: 3000, storage: 'fridge' } });

(async () => {
  const token = (await api('POST', '/api/auth/signup', { body: { email: EMAIL, password: 'pw123456' } })).data.token;
  for (const ig of ['두부', '대파', '김치', '계란']) await addItem(token, ig, ig);

  // ── 순수 규칙 검증: 실제 캐시의 양념 문자열들로 '이름만' 추출이 되는지 ──
  const seasSample = await pool.query("SELECT DISTINCT unnest(seasonings) s FROM fridge_recipe_cache WHERE seasonings IS NOT NULL LIMIT 40");
  const bad = seasSample.rows.map((r) => [r.s, stripAmt(r.s)]).filter(([, name]) => !name || /[0-9]|큰술|작은술|약간|적당량/.test(name));
  ok(seasSample.rows.length > 0 && bad.length === 0, `양념 이름 추출: ${seasSample.rows.length}개 중 양 제거 실패 ${bad.length}건`, JSON.stringify(bad.slice(0, 5)));
  console.log('    예:', seasSample.rows.slice(0, 6).map((r) => `${r.s}→${stripAmt(r.s)}`).join(' | '));

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 402, height: 848 } });
  await ctx.addInitScript((t) => localStorage.setItem('nowaste.token', t), token);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('nav button:has-text("요리")').click();
  await page.waitForSelector('article', { timeout: 60000 });

  // ── (1) picker: 냉장고 4종이 보인다 ──
  await page.locator('button:has-text("냉장고에서 골라")').click();
  await page.waitForSelector('text=오늘 쓸 재료 고르기', { timeout: 8000 });
  for (const ig of ['두부', '대파', '김치', '계란'])
    ok(await page.getByRole('button', { name: ig, exact: true }).isVisible(), `picker에 '${ig}' 보임`);

  // ── (1b) 신선도: picker 닫은 뒤 서버에 재료 추가 → 재오픈 시 새 재료가 보인다(=열 때 재조회) ──
  await page.mouse.click(200, 25); // 백드롭 클릭으로 시트 닫기
  await page.waitForSelector('text=오늘 쓸 재료 고르기', { state: 'hidden', timeout: 3000 }).catch(() => {});
  await addItem(token, '양파', '양파'); // App은 모르는 새 재료(리프레시 안 함)
  await page.locator('button:has-text("냉장고에서 골라")').click();
  await page.waitForSelector('text=오늘 쓸 재료 고르기', { timeout: 8000 });
  await page.waitForTimeout(700); // 서버 재조회 대기
  ok(await page.getByRole('button', { name: '양파', exact: true }).isVisible(), 'picker 재오픈 시 새로 추가한 양파가 보임(열 때 서버 재조회)');
  await page.mouse.click(200, 25);
  await page.waitForSelector('text=오늘 쓸 재료 고르기', { state: 'hidden', timeout: 3000 }).catch(() => {});

  // ── (2) 레시피 상세: 양념 옆 '🛒 장보기' → BuySheet가 양념 이름(양 제거)으로 열림 ──
  // 양념이 있는 카드를 찾아 연다
  let opened = false, seasNames = [];
  const count = await page.locator('article').count();
  for (let i = 0; i < Math.min(count, 8); i++) {
    await page.locator('article button').nth(i).click();
    await page.waitForSelector('text=몇 인분?', { timeout: 8000 });
    const seasLoc = page.getByText(/^양념:/);
    if (await seasLoc.count()) {
      const txt = await seasLoc.first().textContent();
      const inner = txt.replace(/^양념:\s*/, '').replace(/\s*\(집에.*$/, '');
      seasNames = inner.split(',').map((x) => stripAmt(x.trim())).filter(Boolean);
      opened = true;
      break;
    }
    await page.locator('button:has-text("닫기")').first().click();
    await page.waitForTimeout(200);
  }
  ok(opened && seasNames.length > 0, `양념 있는 레시피 상세 오픈 (양념 이름: ${seasNames.join('/')})`);
  ok(await page.getByRole('button', { name: /장보기/ }).isVisible(), "양념 옆 '🛒 장보기' 버튼 보임");

  await page.getByRole('button', { name: /장보기/ }).click();
  await page.waitForSelector('text=사러 가기', { timeout: 8000 });
  ok(await page.locator('text=사러 가기').isVisible(), '장보기 → BuySheet 열림');
  // BuySheet에 양념 '이름'이 그대로 노출(양 없이). 첫 양념 이름으로 확인.
  const first = seasNames[0];
  const shownName = await page.locator('.font-extrabold', { hasText: first }).first().isVisible().catch(() => false);
  ok(shownName, `BuySheet에 양념 이름 '${first}' 노출(양 제거됨)`);
  // 쿠팡(제휴) 마켓 버튼도 있어야
  ok(await page.locator('text=쿠팡').first().isVisible(), 'BuySheet에 마켓(쿠팡) 노출');

  await browser.close();
  await pool.query('DELETE FROM fridge_users WHERE email = $1', [EMAIL]);
  await pool.end();
  console.log(`\n${fail === 0 ? '✅ 통과' : '❌ 실패'} (${pass}/${pass + fail})`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await pool.query('DELETE FROM fridge_users WHERE email=$1', [EMAIL]); } catch {} process.exit(1); });
