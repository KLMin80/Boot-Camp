// Phase B — 가격 입력 보강. 재료로 담기 + 확인화면(OCR) 두 경로 모두 실브라우저로 검증.
const { chromium } = require('playwright-core');
const { pool } = require('../db');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:3300';
const EMAIL = `price_${Date.now()}@t.com`;

const api = async (m, u, { token, body } = {}) => {
  const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
let pass = 0, fail = 0;
const ok = (c, l, e = '') => { c ? (pass++, console.log('  ✓', l)) : (fail++, console.log('  ✗', l, e)); };
const findItem = async (token, name, status = 'confirmed') => {
  for (let k = 0; k < 20; k++) { const r = await api('GET', `/api/items?status=${status}`, { token }); const it = (r.data.items || []).find((x) => x.name.includes(name)); if (it) return it; await new Promise((r) => setTimeout(r, 300)); }
  return null;
};

(async () => {
  const token = (await api('POST', '/api/auth/signup', { body: { email: EMAIL, password: 'pw123456' } })).data.token;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 402, height: 848 } });
  await ctx.addInitScript((t) => localStorage.setItem('nowaste.token', t), token);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav button:has-text("담기")', { timeout: 10000 });

  // ── ① 재료로 담기 + 가격 ──
  await page.locator('nav button:has-text("담기")').click();
  await page.locator('button:has-text("재료로 담기")').click();
  await page.locator('input[placeholder="재료 찾기"]').fill('양파');
  await page.locator('button:has-text("양파")').first().click();
  await page.locator('button:has-text("냉장")').first().click();     // 양파 fridge 프리셋
  await page.locator('input[placeholder="3150"]').fill('3900');       // 가격
  await page.getByRole('button', { name: '담기', exact: true }).click();
  const onion = await findItem(token, '양파');
  ok(onion && onion.price === 3900, '재료로 담기 → 가격 3900 저장', `price=${onion && onion.price}`);

  // ── ② 확인화면(OCR, 가격 없음) → 고칠게요 → 가격 입력 ──
  const uid = require('jsonwebtoken').verify(token, process.env.JWT_SECRET).uid;
  await pool.query(
    `INSERT INTO fridge_items (user_id, name, ingredient, capacity, remaining, unit, price, expiry_date, expiry_source, storage, status, ocr_text)
     VALUES ($1,'하림 닭가슴살','닭고기',500,500,'g',NULL,(now() AT TIME ZONE 'Asia/Seoul')::date + 5,'ocr','fridge','pending','하림 닭가슴살 500g')`, [uid]);
  await page.reload({ waitUntil: 'domcontentloaded' });        // 삽입한 pending을 클라가 다시 읽게
  await page.locator('nav button:has-text("확인")').click();
  await page.waitForSelector('text=하림 닭가슴살', { timeout: 10000 });
  await page.locator('button:has-text("고칠게요")').click();
  await page.locator('input[placeholder="가격 입력"]').fill('8900');
  await page.locator('button:has-text("고쳐서 냉장고에 넣기")').click();
  const chicken = await findItem(token, '닭가슴살');
  ok(chicken && chicken.price === 8900, 'OCR 확인화면 → 가격 8900 추가', `price=${chicken && chicken.price}`);

  await browser.close();
  await pool.query('DELETE FROM fridge_users WHERE email = $1', [EMAIL]);
  await pool.end();
  console.log(`\n${fail === 0 ? '✅ 통과' : '❌ 실패'} (${pass}/${pass + fail})`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await pool.query('DELETE FROM fridge_users WHERE email=$1', [EMAIL]); } catch {} process.exit(1); });
