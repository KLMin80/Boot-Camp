// 이걸로 요리 → 재료 차감. API 정밀 검증 + 상세시트 '다 만들었어요' 실브라우저.
const { chromium } = require('playwright-core');
const { pool } = require('../db');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:3300';
const EMAIL = `cook_${Date.now()}@t.com`;

const api = async (m, u, { token, body } = {}) => {
  const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
let pass = 0, fail = 0;
const ok = (c, l, e = '') => { c ? (pass++, console.log('  ✓', l)) : (fail++, console.log('  ✗', l, e)); };
const itemsOf = async (token) => (await api('GET', '/api/items?status=confirmed', { token })).data.items || [];
const rem = (arr, name) => (arr.find((x) => x.name === name) || {}).remaining;

(async () => {
  const token = (await api('POST', '/api/auth/signup', { body: { email: EMAIL, password: 'pw123456' } })).data.token;
  const add = (b) => api('POST', '/api/items', { token, body: b });
  await add({ name: '두부', ingredient: '두부', capacity: 300, unit: 'g', price: 2400, storage: 'fridge' });
  await add({ name: '대파', ingredient: '대파', capacity: 200, unit: 'g', price: 2000, storage: 'fridge' });
  await add({ name: '양파', ingredient: '양파', capacity: 3, unit: '개', price: 3000, storage: 'room_shade' });

  // ── API: 단위 맞는 것만, 유통기한 임박 순, 없는 재료 무시 ──
  const c1 = await api('POST', '/api/recipes/cook', { token, body: { uses: [
    { ing: '두부', amt: 200, unit: 'g' }, { ing: '대파', amt: 50, unit: 'g' }, { ing: '닭고기', amt: 100, unit: 'g' },
  ] } });
  ok(c1.status === 200, '요리 차감 200');
  let it = await itemsOf(token);
  ok(rem(it, '두부') === 100, '두부 300→100 (200 차감)', `rem=${rem(it, '두부')}`);
  ok(rem(it, '대파') === 150, '대파 200→150 (50 차감)', `rem=${rem(it, '대파')}`);
  ok(!c1.data.deducted.some((d) => d.ing === '닭고기'), '없는 재료(닭고기)는 차감 안 됨');

  // 단위 불일치: 양파(개)에 g 요구 → skipped, 남은 양 그대로
  const c2 = await api('POST', '/api/recipes/cook', { token, body: { uses: [{ ing: '양파', amt: 100, unit: 'g' }] } });
  it = await itemsOf(token);
  ok(rem(it, '양파') === 3 && c2.data.skipped.includes('양파'), '단위 다른 양파(개)는 안 빼고 skipped로 알림', `skipped=${c2.data.skipped}`);

  // 남은 양보다 많이 → 0 되고 자동 마감(냉장고에서 빠짐)
  await api('POST', '/api/recipes/cook', { token, body: { uses: [{ ing: '두부', amt: 500, unit: 'g' }] } });
  it = await itemsOf(token);
  ok(!it.some((x) => x.name === '두부'), '두부 다 쓰면 자동 마감돼 목록에서 빠짐');

  // ── UI: 요리 → 카드 '이걸로 요리' → 상세 '다 만들었어요' → 재고 감소 ──
  await add({ name: '두부2', ingredient: '두부', capacity: 300, unit: 'g', price: 2400, storage: 'fridge' });
  await add({ name: '돼지고기', ingredient: '돼지고기', capacity: 300, unit: 'g', price: 9000, storage: 'fridge' });
  await add({ name: '배추김치', ingredient: '김치', capacity: 300, unit: 'g', price: 5000, storage: 'fridge' });
  const before = (await itemsOf(token)).reduce((s, x) => s + x.remaining, 0);

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 402, height: 848 } });
  await ctx.addInitScript((t) => localStorage.setItem('nowaste.token', t), token);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('nav button:has-text("요리")').click();
  await page.waitForSelector('article', { timeout: 60000 });          // 추천 레시피 로드
  await page.locator('article button:has-text("이걸로 요리")').first().click();
  await page.waitForSelector('text=다 만들었어요', { timeout: 8000 });
  await page.locator('button:has-text("다 만들었어요")').click();
  await page.waitForTimeout(1500);
  const after = (await itemsOf(token)).reduce((s, x) => s + x.remaining, 0);
  ok(after < before, 'UI: 다 만들었어요 → 냉장고 재고가 줄어듦', `before=${before} after=${after}`);

  await browser.close();
  await pool.query('DELETE FROM fridge_users WHERE email = $1', [EMAIL]);
  await pool.end();
  console.log(`\n${fail === 0 ? '✅ 통과' : '❌ 실패'} (${pass}/${pass + fail})`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await pool.query('DELETE FROM fridge_users WHERE email=$1', [EMAIL]); } catch {} process.exit(1); });
