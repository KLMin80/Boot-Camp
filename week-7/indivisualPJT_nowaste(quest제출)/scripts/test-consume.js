// 부분 차감(consume) — API 로직 + 시트 UI를 실서버·실브라우저로 검증.
const { chromium } = require('playwright-core');
const { pool } = require('../db');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:3300';
const EMAIL = `consume_${Date.now()}@t.com`;

const api = async (m, u, { token, body } = {}) => {
  const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
let pass = 0, fail = 0;
const ok = (c, l, e = '') => { c ? (pass++, console.log('  ✓', l)) : (fail++, console.log('  ✗', l, e)); };

(async () => {
  const token = (await api('POST', '/api/auth/signup', { body: { email: EMAIL, password: 'pw123456' } })).data.token;

  // ── API: 부분 차감 → 남은 양 감소, 0 이하 → 자동 '다 먹음' ──
  const tofu = (await api('POST', '/api/items', { token, body: { name: '풀무원 두부', ingredient: '두부', capacity: 300, unit: 'g', price: 2400, storage: 'fridge' } })).data.item;
  ok(tofu.remaining === 300, '처음 남은 양 300g');

  const c1 = await api('POST', `/api/items/${tofu.id}/consume`, { token, body: { amount: 100 } });
  ok(c1.status === 200 && c1.data.item.remaining === 200 && !c1.data.closed, '100g 차감 → 200g 남고 안 닫힘', `rem=${c1.data.item?.remaining}`);

  const bad = await api('POST', `/api/items/${tofu.id}/consume`, { token, body: { amount: 0 } });
  ok(bad.status === 400, '0 차감 → 400 거절');

  const c2 = await api('POST', `/api/items/${tofu.id}/consume`, { token, body: { amount: 500 } });
  ok(c2.data.item.remaining === 0 && c2.data.closed && c2.data.item.outcome === 'eaten', '남은 양보다 많이 차감 → 0·자동 eaten 마감', `rem=${c2.data.item?.remaining} out=${c2.data.item?.outcome}`);

  const gone = await api('GET', '/api/items?status=confirmed', { token });
  ok(!(gone.data.items || []).some((x) => x.id === tofu.id), '다 쓴 재료는 냉장고 목록에서 빠짐');

  const w = await api('GET', '/api/stats/waste?months=6', { token });
  ok(w.data.eaten === 1, '리포트 "다 먹은 재료" 카운트에 잡힘 (버림 아님)', `eaten=${w.data.eaten}`);

  // ── UI: 시트에서 '조금 썼어요' → ½ → 빼기 ──
  const milk = (await api('POST', '/api/items', { token, body: { name: '서울우유', ingredient: '우유', capacity: 1000, unit: 'ml', price: 3000, storage: 'fridge' } })).data.item;

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 402, height: 848 } });
  await ctx.addInitScript((t) => localStorage.setItem('nowaste.token', t), token);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=서울우유', { timeout: 10000 });
  await page.locator('text=서울우유').first().click();          // 아이템 탭 → 시트
  await page.locator('button:has-text("조금 썼어요")').click();
  ok(await page.locator('button:has-text("½")').isVisible().catch(() => false), '½ 빠른 버튼이 뜬다');
  await page.locator('button:has-text("½")').click();            // 500 채움
  await page.locator('button:has-text("빼기")').click();
  let after = null;
  for (let k = 0; k < 20; k++) { const r = await api('GET', '/api/items?status=confirmed', { token }); after = (r.data.items || []).find((x) => x.id === milk.id); if (after && after.remaining !== 1000) break; await new Promise((r) => setTimeout(r, 300)); }
  ok(after && after.remaining === 500, 'UI에서 ½ 빼기 → 500ml 남음', `rem=${after && after.remaining}`);
  await browser.close();

  await pool.query('DELETE FROM fridge_users WHERE email = $1', [EMAIL]);
  await pool.end();
  console.log(`\n${fail === 0 ? '✅ 통과' : '❌ 실패'} (${pass}/${pass + fail})`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await pool.query('DELETE FROM fridge_users WHERE email=$1', [EMAIL]); } catch {} process.exit(1); });
