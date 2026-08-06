// 장보기 모드 BuySheet 검증: 체크리스트 + 마켓당 버튼 1개 + 목록복사 + 담은 것 일괄 곧 도착 + 제휴 고지.
const { chromium } = require('playwright-core');
const { pool } = require('../db');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:3300';
const EMAIL = `shop_${Date.now()}@t.com`;
const api = async (m, u, { token, body } = {}) => {
  const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
let pass = 0, fail = 0;
const ok = (c, l, e = '') => { c ? (pass++, console.log('  ✓', l)) : (fail++, console.log('  ✗', l, e)); };
const stripAmt = (s) => s.replace(/\s*(?:\d.*|약간.*|조금.*|적당량.*|살짝.*|톡톡.*|넉넉.*|톡.*)$/, '').trim();

(async () => {
  const token = (await api('POST', '/api/auth/signup', { body: { email: EMAIL, password: 'pw123456' } })).data.token;
  for (const ig of ['두부', '대파', '김치', '계란', '돼지고기']) await api('POST', '/api/items', { token, body: { name: ig, ingredient: ig, capacity: 300, remaining: 300, unit: 'g', price: 3000, storage: 'fridge' } });
  const uid = (await pool.query('SELECT id FROM fridge_users WHERE email = $1', [EMAIL])).rows[0].id;

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 440, height: 1200 } });
  await ctx.addInitScript((t) => localStorage.setItem('nowaste.token', t), token);
  const page = await ctx.newPage();
  const errs = []; page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('nav button:has-text("요리")').click();
  await page.waitForSelector('article', { timeout: 60000 });

  // 양념 있는 레시피 열어 장보기 → BuySheet
  let seas = []; const cnt = await page.locator('article').count();
  for (let i = 0; i < Math.min(cnt, 8); i++) {
    await page.locator('article button').nth(i).click();
    await page.waitForSelector('text=몇 인분?', { timeout: 8000 });
    const loc = page.getByText(/^양념:/);
    if (await loc.count()) { const txt = await loc.first().textContent(); const inner = txt.replace(/^양념:\s*/, '').replace(/\s*\(집에.*$/, ''); seas = inner.split(',').map((x) => stripAmt(x.trim())).filter(Boolean); break; }
    await page.locator('button:has-text("닫기")').first().click(); await page.waitForTimeout(150);
  }
  ok(seas.length > 0, `양념 있는 레시피 (${seas.join('/')})`);
  await page.getByRole('button', { name: /장보기/ }).click();
  await page.waitForSelector('text=한 마켓에서 다 담고', { timeout: 8000 });

  // 구조
  ok(await page.getByRole('heading', { name: '장보기' }).isVisible(), '장보기 헤더');
  ok(await page.getByRole('button', { name: /목록 복사/ }).isVisible(), '목록 복사 버튼');
  ok(await page.getByRole('button', { name: /쿠팡프레시/ }).isVisible(), '마켓당 버튼(쿠팡프레시)');
  ok(await page.getByText(/쿠팡 파트너스/).isVisible(), '쿠팡 파트너스 고지 유지');
  ok(await page.getByRole('button', { name: new RegExp(`전체 ${seas.length}개 곧 도착으로`) }).isVisible(), `초기 일괄버튼 '전체 ${seas.length}개'`);

  // 체크 1개 → 일괄버튼 라벨 변화
  await page.getByRole('button', { name: new RegExp('^' + seas[0]) }).first().click();
  ok(await page.getByRole('button', { name: /체크한 1개 곧 도착으로/ }).isVisible(), '체크 시 일괄버튼이 "체크한 1개"로');

  // 마켓 클릭 → 제휴 클릭 로그 (쿠팡)
  const before = (await pool.query('SELECT count(*)::int n FROM fridge_buy_click WHERE user_id = $1', [uid])).rows[0].n;
  await page.getByRole('button', { name: /쿠팡프레시/ }).click();
  await page.waitForTimeout(900);
  const after = (await pool.query("SELECT count(*)::int n, bool_or(affiliate) aff FROM fridge_buy_click WHERE user_id = $1", [uid])).rows[0];
  ok(after.n > before && after.aff === true, `마켓 클릭 → 제휴 클릭 로그 (${before}→${after.n}, affiliate=${after.aff})`);

  // 담은 것(체크 1개) → 곧 도착 일괄
  const beforeOrd = (await api('GET', '/api/items?status=ordered', { token })).data.items.length;
  await page.getByRole('button', { name: /체크한 1개 곧 도착으로/ }).click();
  await page.waitForSelector('text=한 마켓에서 다 담고', { state: 'hidden', timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(700);
  const ord = (await api('GET', '/api/items?status=ordered', { token })).data.items;
  ok(ord.length === beforeOrd + 1, `체크한 1개가 곧 도착으로 (${beforeOrd}→${ord.length})`);
  ok(ord.some((it) => it.ingredient === seas[0]), `곧 도착에 '${seas[0]}' 들어감`);

  ok(errs.length === 0, '콘솔 에러 없음', errs.join(' | '));

  await browser.close();
  await pool.query('DELETE FROM fridge_users WHERE email = $1', [EMAIL]);
  await pool.end();
  console.log(`\n${fail === 0 ? '✅ 통과' : '❌ 실패'} (${pass}/${pass + fail})`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await pool.query('DELETE FROM fridge_users WHERE email=$1', [EMAIL]); } catch {} process.exit(1); });
