// 식비 집계 + 밀키트 + 장보기 리스트 — API + 브라우저 검증.
const { chromium } = require('playwright-core');
const { pool } = require('../db');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:3300';
const EMAIL = `vision_${Date.now()}@t.com`;

const api = async (m, u, { token, body } = {}) => {
  const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
let pass = 0, fail = 0;
const ok = (c, l, e = '') => { c ? (pass++, console.log('  ✓', l)) : (fail++, console.log('  ✗', l, e)); };

(async () => {
  const token = (await api('POST', '/api/auth/signup', { body: { email: EMAIL, password: 'pw123456' } })).data.token;
  const uid = require('jsonwebtoken').verify(token, process.env.JWT_SECRET).uid;

  // ── ① 식비 집계 ──
  await api('POST', '/api/items', { token, body: { name: '한돈 삼겹살', ingredient: '돼지고기', capacity: 600, unit: 'g', price: 13900, storage: 'fridge' } });
  await api('POST', '/api/items', { token, body: { name: '서울우유', ingredient: '우유', capacity: 1000, unit: 'ml', price: 3000, storage: 'fridge' } });
  const w = await api('GET', '/api/stats/waste?months=6', { token });
  const nowMonth = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()).slice(0, 7);
  const spentThis = ((w.data.spend || []).find((r) => r.month === nowMonth) || {}).spent || 0;
  ok(Array.isArray(w.data.spend), '리포트에 spend(월별 식비) 포함');
  ok(spentThis === 16900, '이번 달 식비 = 13900+3000 집계', `spent=${spentThis}`);

  // ── ② 밀키트 링크 ──
  const mk = await api('POST', '/api/mealkit-link', { token, body: { dish: '김치찌개' } });
  ok(mk.status === 200 && /coupang\.com/.test(mk.data.url) && /%EB.*%B0%80%EB%A6%AC/.test(encodeURI(mk.data.url)) === false, '밀키트 링크 = 쿠팡 검색', mk.data.url);
  ok(decodeURIComponent(mk.data.url).includes('김치찌개 밀키트'), '검색어에 "김치찌개 밀키트" 포함');

  // ── ③ 장보기 리스트 ──
  // 부분 소비된 재료(곧 떨어질 것 자동)
  const DP = (n) => `((now() AT TIME ZONE 'Asia/Seoul')::date + ${n})`;
  await pool.query(`INSERT INTO fridge_items (user_id,name,ingredient,capacity,remaining,unit,price,purchased_on,expiry_date,expiry_source,storage,status)
    VALUES ($1,'대파','대파',200,60,'g',2000,${DP(-3)},${DP(8)},'manual','fridge','confirmed')`, [uid]);
  const addM = await api('POST', '/api/shopping', { token, body: { name: '화장지' } });
  ok(addM.status === 201, '장보기 직접 추가(화장지) → 201');
  const list = await api('GET', '/api/shopping', { token });
  ok(list.data.manual.some((m) => m.name === '화장지'), 'GET: 직접 추가 목록에 화장지');
  ok(list.data.soon.some((s) => s.ingredient === '대파'), 'GET: 곧 떨어질 것에 대파(예측 자동)', `soon=${JSON.stringify(list.data.soon)}`);
  await api('DELETE', `/api/shopping/${addM.data.item.id}`, { token });
  const list2 = await api('GET', '/api/shopping', { token });
  ok(!list2.data.manual.some((m) => m.name === '화장지'), 'DELETE: 화장지 제거됨');

  // ── UI: 홈 → 장보기 → 추가 → 표시 / 리포트 식비 카드 ──
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 402, height: 848 } });
  await ctx.addInitScript((t) => localStorage.setItem('nowaste.token', t), token);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('button:has-text("장보기")').first().click();
  await page.waitForSelector('text=장 보기 전에 확인', { timeout: 8000 });
  ok(await page.waitForSelector('text=곧 떨어질 것', { timeout: 6000 }).then(() => true).catch(() => false), 'UI: 장보기에 "곧 떨어질 것" 표시');
  await page.locator('input[placeholder*="화장지"]').fill('계란');
  await page.getByRole('button', { name: '추가', exact: true }).click();
  ok(await page.waitForSelector('section:has-text("살 것") >> text=계란', { timeout: 6000 }).then(() => true).catch(() => false), 'UI: 직접 추가한 계란이 목록에 뜸');

  await page.locator('nav button:has-text("리포트")').click();
  await page.waitForSelector('text=이번 달 식비', { timeout: 8000 });
  ok(await page.locator('text=이번 달 식비').isVisible(), 'UI: 리포트에 "이번 달 식비" 카드');

  await browser.close();
  await pool.query('DELETE FROM fridge_users WHERE email = $1', [EMAIL]);
  await pool.end();
  console.log(`\n${fail === 0 ? '✅ 통과' : '❌ 실패'} (${pass}/${pass + fail})`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await pool.query('DELETE FROM fridge_users WHERE email=$1', [EMAIL]); } catch {} process.exit(1); });
