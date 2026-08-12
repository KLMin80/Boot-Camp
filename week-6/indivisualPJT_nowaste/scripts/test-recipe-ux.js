// 레시피 UX 개선 — 탭 필터(전체/아이/건강, 어른 제거) + 초보용(양념 양) 검증.
const { chromium } = require('playwright-core');
const { pool } = require('../db');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:3300';
const EMAIL = `rux_${Date.now()}@t.com`;
const api = async (m, u, { token, body } = {}) => {
  const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
let pass = 0, fail = 0;
const ok = (c, l, e = '') => { c ? (pass++, console.log('  ✓', l)) : (fail++, console.log('  ✗', l, e)); };
const hasAmt = (s) => /[0-9]|큰술|작은술|약간|스푼|컵|톨|줌/.test(s);

(async () => {
  const token = (await api('POST', '/api/auth/signup', { body: { email: EMAIL, password: 'pw123456' } })).data.token;
  for (const [n, ig] of [['두부', '두부'], ['대파', '대파'], ['김치', '김치'], ['돼지고기', '돼지고기']])
    await api('POST', '/api/items', { token, body: { name: n, ingredient: ig, capacity: 300, unit: 'g', price: 3000, storage: 'fridge' } });

  // ① want 파라미터 — 더 많이 받아서 클라 필터
  const s = await api('POST', '/api/recipes/suggest', { token, body: { tag: '전체', want: 16 } });
  ok(s.status === 200 && (s.data.recipes || []).length > 0 && s.data.recipes.length <= 16, `전체 추천 ${s.data.recipes?.length}개(≤16)`);
  const tags = [...new Set((s.data.recipes || []).map((r) => r.tag))];
  console.log('    태그 분포:', tags.join(','));

  // ② 초보용 — 새로 생성한 레시피의 양념에 양 포함
  const dish = `초보김치두부볶음_${Date.now()}`;
  const bn = await api('POST', '/api/recipes/byname', { token, body: { dish } });
  const rec = bn.data?.recipe;
  ok(!!rec, '직접 입력 레시피 생성됨');
  const seas = rec?.seasonings || [];
  console.log('    양념:', JSON.stringify(seas));
  ok(seas.length > 0 && seas.some(hasAmt), '양념에 양(큰술/약간 등)이 들어감', JSON.stringify(seas));
  ok((rec?.steps || []).length >= 4, '만드는 법 4단계 이상');

  // ③ UI — 탭이 전체/아이/건강 (어른 없음), 클릭해도 재호출 없이 필터
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 402, height: 848 } });
  await ctx.addInitScript((t) => localStorage.setItem('nowaste.token', t), token);
  const page = await ctx.newPage();
  let recipeCalls = 0;
  page.on('request', (r) => { if (r.url().includes('/api/recipes/suggest')) recipeCalls++; });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('nav button:has-text("요리")').click();
  await page.waitForSelector('article', { timeout: 60000 });
  // 2단계(캐시 표시 후 백그라운드 생성)가 끝나 호출 수가 고정된 뒤 기준을 잡는다
  await page.waitForFunction(() => !document.body.innerText.includes('레시피 더 찾는 중'), { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(500);
  const callsAfterLoad = recipeCalls;
  ok(await page.getByRole('button', { name: '어른', exact: true }).count() === 0, "UI: '어른' 탭 제거됨(정확히 '어른'인 버튼 없음)");
  ok(await page.locator('button:has-text("아이")').first().isVisible(), "UI: '아이' 탭 있음");
  await page.locator('button:has-text("아이")').first().click();
  await page.waitForTimeout(1200);
  ok(recipeCalls === callsAfterLoad, "UI: 탭 클릭 시 서버 재호출 안 함(클라 필터)", `calls ${callsAfterLoad}→${recipeCalls}`);

  await browser.close();
  await pool.query('DELETE FROM fridge_users WHERE email = $1', [EMAIL]);
  await pool.query("DELETE FROM fridge_recipe_cache WHERE title LIKE '초보김치두부볶음%'"); // 테스트 레시피 정리
  await pool.end();
  console.log(`\n${fail === 0 ? '✅ 통과' : '❌ 실패'} (${pass}/${pass + fail})`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await pool.query('DELETE FROM fridge_users WHERE email=$1', [EMAIL]); } catch {} process.exit(1); });
