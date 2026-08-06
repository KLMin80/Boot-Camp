// 장보기 모드 BuySheet 스크린샷.
const { chromium } = require('playwright-core');
const { pool } = require('../db');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:3300';
const OUT = require('path').join(require('os').tmpdir(), 'nowaste-shopping-mode.png');
const EMAIL = `shopshot_${Date.now()}@t.com`;
const api = async (m, u, { token, body } = {}) => {
  const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
(async () => {
  const token = (await api('POST', '/api/auth/signup', { body: { email: EMAIL, password: 'pw123456' } })).data.token;
  for (const ig of ['두부', '대파', '김치', '계란', '돼지고기']) await api('POST', '/api/items', { token, body: { name: ig, ingredient: ig, capacity: 300, remaining: 300, unit: 'g', price: 3000, storage: 'fridge' } });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 440, height: 1500 }, deviceScaleFactor: 2 });
  await ctx.addInitScript((t) => localStorage.setItem('nowaste.token', t), token);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
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
  await page.waitForSelector('text=한 마켓에서 다 담고', { timeout: 8000 });
  // 체크 2개 눌러서 상태 보여주기
  const rows = page.locator('.max-h-\\[34vh\\] button');
  await rows.nth(0).click(); await rows.nth(2).click();
  await page.waitForTimeout(400);
  await page.locator('.slideup').screenshot({ path: OUT });
  console.log('saved', OUT);
  await browser.close();
  await pool.query('DELETE FROM fridge_users WHERE email = $1', [EMAIL]);
  await pool.end();
})().catch(async (e) => { console.error(e); try { await pool.query('DELETE FROM fridge_users WHERE email=$1', [EMAIL]); } catch {} process.exit(1); });
