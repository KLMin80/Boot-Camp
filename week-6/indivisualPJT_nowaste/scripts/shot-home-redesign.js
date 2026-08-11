// 개편된 홈(냉장고) 화면 스크린샷 — 담기 버튼·확인 필요·곧 상해요·오늘 추천요리·재고.
const { chromium } = require('playwright-core');
const { pool } = require('../db');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:3300';
const OUT = require('path').join(require('os').tmpdir(), 'nowaste-home-redesign.png');
const EMAIL = `homeshot_${Date.now()}@t.com`;
const api = async (m, u, { token, body } = {}) => {
  const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
(async () => {
  const token = (await api('POST', '/api/auth/signup', { body: { email: EMAIL, password: 'pw123456' } })).data.token;
  // 급한 재료(곧 상해요) + 여유 재고
  await api('POST', '/api/items', { token, body: { name: '풀무원 두부', ingredient: '두부', capacity: 300, remaining: 300, unit: 'g', price: 2500, storage: 'fridge', expiry_date: '2026-08-07' } });
  await api('POST', '/api/items', { token, body: { name: '대파 한단', ingredient: '대파', capacity: 200, remaining: 200, unit: 'g', price: 2000, storage: 'fridge', expiry_date: '2026-08-08' } });
  for (const [n, ig, e] of [['김치 500g', '김치', '2026-09-20'], ['돼지고기 앞다리', '돼지고기', '2026-08-15']])
    await api('POST', '/api/items', { token, body: { name: n, ingredient: ig, capacity: 500, remaining: 500, unit: 'g', price: 8000, storage: 'fridge', expiry_date: e } });
  // 확인 필요(pending)
  await api('POST', '/api/items', { token, body: { name: '서울우유 1L', ingredient: '우유', capacity: 1000, remaining: 1000, unit: 'ml', price: 2800, storage: 'fridge', status: 'pending' } });
  await api('POST', '/api/items', { token, body: { name: '대란 15구', ingredient: '계란', capacity: 15, remaining: 15, unit: '개', price: 6000, storage: 'fridge', status: 'pending', expiry_date: '2026-09-01' } });

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 440, height: 2200 }, deviceScaleFactor: 2 });
  await ctx.addInitScript((t) => localStorage.setItem('nowaste.token', t), token);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=오늘 추천요리', { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(600);
  await page.screenshot({ path: OUT, fullPage: true });
  console.log('saved', OUT);
  await browser.close();
  await pool.query('DELETE FROM fridge_users WHERE email = $1', [EMAIL]);
  await pool.end();
})().catch(async (e) => { console.error(e); try { await pool.query('DELETE FROM fridge_users WHERE email=$1', [EMAIL]); } catch {} process.exit(1); });
