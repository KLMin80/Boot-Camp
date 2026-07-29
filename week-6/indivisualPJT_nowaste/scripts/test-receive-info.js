// '곧 도착 → 받았어요' 시 실측 유통기한·가격·용량을 넣는 흐름 검증.
//  A) 서버 receive가 body(expiry_date/price/capacity/unit)를 반영하고, 비우면 프리셋 추정(하위호환).
//  B) 브라우저: 받았어요 → ReceiveSheet에서 날짜·가격 입력 → 냉장고 입고(confirmed) 반영.
//  C) BuySheet 유인 배너 노출.
const { chromium } = require('playwright-core');
const { pool } = require('../db');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:3300';
const EMAIL = `rcv_${Date.now()}@t.com`;
const api = async (m, u, { token, body } = {}) => {
  const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
let pass = 0, fail = 0;
const ok = (c, l, e = '') => { c ? (pass++, console.log('  ✓', l)) : (fail++, console.log('  ✗', l, e)); };
const mkOrdered = async (token, name) => (await api('POST', '/api/items', { token, body: { name, ingredient: name, capacity: 1, remaining: 1, unit: '개', storage: 'fridge', status: 'ordered' } })).data.item;
const getItem = async (token, id) => (await api('GET', '/api/items?status=confirmed', { token })).data.items.find((x) => x.id === id);

(async () => {
  const token = (await api('POST', '/api/auth/signup', { body: { email: EMAIL, password: 'pw123456' } })).data.token;

  // ── A) 서버 로직 ──
  // A1: 실측 유통기한 + 가격
  const a = await mkOrdered(token, '우유');
  await api('POST', `/api/items/${a.id}/receive`, { token, body: { expiry_date: '2026-08-15', price: 4200 } });
  const A = await getItem(token, a.id);
  ok(A && A.expiry_date === '2026-08-15' && A.expiry_source !== 'preset' && Number(A.price) === 4200, 'receive: 실측 유통기한·가격 반영', JSON.stringify(A && { e: A.expiry_date, s: A.expiry_source, p: A.price }));

  // A2: 빈 body → 프리셋 추정 (하위호환), 가격은 그대로 없음
  const b = await mkOrdered(token, '두부');
  await api('POST', `/api/items/${b.id}/receive`, { token, body: {} });
  const B = await getItem(token, b.id);
  ok(B && B.expiry_source === 'preset' && !!B.expiry_date && B.price == null, 'receive: 빈 값이면 프리셋 추정(빠른 경로)', JSON.stringify(B && { e: B.expiry_date, s: B.expiry_source, p: B.price }));

  // A3: 날짜 없이 가격+용량만(라벨 용량 보완) → 프리셋 날짜 + 실측 용량/가격
  const c = await mkOrdered(token, '요거트');
  await api('POST', `/api/items/${c.id}/receive`, { token, body: { price: 3000, capacity: 300, unit: 'g' } });
  const C = await getItem(token, c.id);
  ok(C && C.expiry_source === 'preset' && Number(C.price) === 3000 && Number(C.capacity) === 300 && Number(C.remaining) === 300 && C.unit === 'g', 'receive: 용량/가격 보완 + 프리셋 날짜', JSON.stringify(C && { cap: C.capacity, rem: C.remaining, u: C.unit, p: C.price }));

  // A4: 잘못된 날짜/음수 가격은 무시(프리셋으로)
  const d = await mkOrdered(token, '계란');
  await api('POST', `/api/items/${d.id}/receive`, { token, body: { expiry_date: 'notadate', price: -5 } });
  const D = await getItem(token, d.id);
  ok(D && D.expiry_source === 'preset' && D.price == null, 'receive: 잘못된 날짜·음수 가격은 무시', JSON.stringify(D && { e: D.expiry_date, s: D.expiry_source, p: D.price }));

  // ── B) 브라우저 UI: 받았어요 → 시트 입력 → 입고 ──
  const dItem = await mkOrdered(token, '사과');
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 402, height: 848 } });
  await ctx.addInitScript((t) => localStorage.setItem('nowaste.token', t), token);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=곧 도착', { timeout: 30000 });
  ok(await page.getByText('사과', { exact: true }).first().isVisible(), "홈 '곧 도착'에 주문 재료 보임");

  // 받았어요 → 시트
  await page.locator('button:has-text("받았어요")').first().click();
  await page.waitForSelector('text=사과 받았어요', { timeout: 8000 });
  ok(await page.getByText('사과 받았어요').isVisible(), "받았어요 → ReceiveSheet 열림");
  ok(await page.locator('button:has-text("📷 라벨")').isVisible(), '라벨 찍기 버튼 있음');

  // 날짜·가격 입력 후 입고
  await page.locator('input[type=date]').fill('2026-09-01');
  await page.locator('input[type=number]').fill('2500');
  await page.locator('button:has-text("냉장고에 넣기")').click();
  await page.waitForSelector('text=사과 받았어요', { state: 'hidden', timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);
  const E = await getItem(token, dItem.id);
  ok(E && E.expiry_date === '2026-09-01' && Number(E.price) === 2500 && E.expiry_source !== 'preset', 'UI 입력값이 DB에 반영(유통기한·가격)', JSON.stringify(E && { e: E.expiry_date, s: E.expiry_source, p: E.price }));
  ok(!(await page.getByText('곧 도착').isVisible().catch(() => false)) || !(await page.getByText('사과', { exact: true }).first().isVisible().catch(() => false)), "입고 후 '곧 도착'에서 사라짐");

  // ── C) BuySheet 유인 배너 ──
  await page.locator('nav button:has-text("요리")').click();
  await page.waitForSelector('article', { timeout: 60000 });
  const cnt = await page.locator('article').count();
  for (let i = 0; i < Math.min(cnt, 8); i++) {
    await page.locator('article button').nth(i).click();
    await page.waitForSelector('text=몇 인분?', { timeout: 8000 });
    if (await page.getByText(/^양념:/).count()) break;
    await page.locator('button:has-text("닫기")').first().click(); await page.waitForTimeout(150);
  }
  await page.getByRole('button', { name: /장보기/ }).click();
  await page.waitForSelector('text=사러 가기', { timeout: 8000 });
  ok(await page.getByText(/여기서 주문하면/).isVisible(), 'BuySheet에 유인 배너 노출(자동 정리 안내)');

  await browser.close();
  await pool.query('DELETE FROM fridge_users WHERE email = $1', [EMAIL]);
  await pool.end();
  console.log(`\n${fail === 0 ? '✅ 통과' : '❌ 실패'} (${pass}/${pass + fail})`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await pool.query('DELETE FROM fridge_users WHERE email=$1', [EMAIL]); } catch {} process.exit(1); });
