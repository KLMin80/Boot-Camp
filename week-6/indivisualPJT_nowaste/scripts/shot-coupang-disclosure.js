// 쿠팡파트너스 승인 증빙 스크린샷 — BuySheet에 쿠팡(제휴) 링크 + 필수 고지 문구가 함께 보이게.
const { chromium } = require('playwright-core');
const { pool } = require('../db');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:3300';
const OUT = require('path').join(require('os').tmpdir(), 'coupang-partners-proof.png');
const EMAIL = `cpproof_${Date.now()}@t.com`;
const api = async (m, u, { token, body } = {}) => {
  const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
(async () => {
  const token = (await api('POST', '/api/auth/signup', { body: { email: EMAIL, password: 'pw123456' } })).data.token;
  for (const ig of ['두부', '대파', '김치', '계란', '돼지고기']) await api('POST', '/api/items', { token, body: { name: ig, ingredient: ig, capacity: 300, remaining: 300, unit: 'g', price: 3000, storage: 'fridge' } });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 440, height: 1400 }, deviceScaleFactor: 2 });
  await ctx.addInitScript((t) => localStorage.setItem('nowaste.token', t), token);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('nav button:has-text("요리")').click();
  await page.waitForSelector('article', { timeout: 60000 });
  // 양념이 있는 레시피 열어 장보기 → BuySheet
  const cnt = await page.locator('article').count();
  for (let i = 0; i < Math.min(cnt, 8); i++) {
    await page.locator('article button').nth(i).click();
    await page.waitForSelector('text=몇 인분?', { timeout: 8000 });
    if (await page.getByText(/^양념:/).count()) break;
    await page.locator('button:has-text("닫기")').first().click(); await page.waitForTimeout(150);
  }
  await page.getByRole('button', { name: /장보기/ }).click();
  await page.waitForSelector('text=쿠팡 파트너스', { timeout: 8000 });
  await page.waitForTimeout(500);
  // 시트 카드만 깔끔하게 캡처
  await page.locator('.slideup').screenshot({ path: OUT });
  console.log('saved', OUT);
  await browser.close();
  await pool.query('DELETE FROM fridge_users WHERE email = $1', [EMAIL]);
  await pool.end();
})().catch(async (e) => { console.error(e); try { await pool.query('DELETE FROM fridge_users WHERE email=$1', [EMAIL]); } catch {} process.exit(1); });
