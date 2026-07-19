// 고른 재료로 레시피 — 냉장고 다중선택 + 직접 입력(어제 남은 치킨)을 꼭 쓰는 추가 레시피.
const { chromium } = require('playwright-core');
const { pool } = require('../db');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:3300';
const EMAIL = `picks_${Date.now()}@t.com`;

const api = async (m, u, { token, body } = {}) => {
  const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
let pass = 0, fail = 0;
const ok = (c, l, e = '') => { c ? (pass++, console.log('  ✓', l)) : (fail++, console.log('  ✗', l, e)); };

(async () => {
  const token = (await api('POST', '/api/auth/signup', { body: { email: EMAIL, password: 'pw123456' } })).data.token;
  for (const [n, ig] of [['종가집 김치', '김치'], ['풀무원 두부', '두부'], ['대파', '대파']])
    await api('POST', '/api/items', { token, body: { name: n, ingredient: ig, capacity: 300, unit: 'g', price: 3000, storage: 'fridge' } });

  // ── API: 김치(냉장고) + 치킨(직접 입력) 로 레시피 ──
  const r = await api('POST', '/api/recipes/with', { token, body: { ingredients: ['김치', '치킨'], tag: '전체' } });
  const recipes = r.data?.recipes || [];
  console.log('    결과:', recipes.map((x) => x.title).join(' | ') || '없음');
  ok(r.status === 200 && recipes.length > 0, '고른 재료로 레시피 생성됨', `count=${recipes.length}`);
  ok(recipes.every((x) => x.uses.some((u) => ['김치', '치킨'].includes(u.ing))), '모든 결과가 고른 재료(김치/치킨)를 씀');
  ok(recipes.some((x) => x.uses.some((u) => u.ing === '치킨')), '직접 입력한 치킨을 쓰는 레시피가 나옴');
  ok(recipes.every((x) => !(x.missing || []).includes('치킨')), '치킨은 부족(주문 대상)으로 안 뜸 — 가진 걸로 취급');

  // ── UI: 요리 → 냉장고에서 골라 → 김치 선택 + 치킨 입력 → 만들기 ──
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 402, height: 848 } });
  await ctx.addInitScript((t) => localStorage.setItem('nowaste.token', t), token);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('nav button:has-text("요리")').click();
  await page.locator('button:has-text("냉장고에서 골라 레시피")').click();
  await page.getByRole('button', { name: '김치', exact: true }).click();            // 냉장고 칩
  await page.locator('input[placeholder*="남은 치킨"]').fill('치킨');
  await page.getByRole('button', { name: '추가', exact: true }).click();
  await page.locator('button:has-text("이 재료로 레시피 만들기")').click();
  await page.waitForSelector('text=고른 재료로 만든 레시피', { timeout: 60000 });
  ok(await page.locator('text=고른 재료로 만든 레시피').isVisible(), 'UI: 결과 배너가 뜬다');
  ok((await page.locator('article').count()) > 0, 'UI: 레시피 카드가 표시된다');

  await browser.close();
  await pool.query('DELETE FROM fridge_users WHERE email = $1', [EMAIL]);
  await pool.end();
  console.log(`\n${fail === 0 ? '✅ 통과' : '❌ 실패'} (${pass}/${pass + fail})`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await pool.query('DELETE FROM fridge_users WHERE email=$1', [EMAIL]); } catch {} process.exit(1); });
