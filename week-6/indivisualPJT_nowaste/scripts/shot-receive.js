// ReceiveSheet(받았어요 → 실측 유통기한·가격 입력) 레이아웃 확인 스크린샷.
const { chromium } = require('playwright-core');
const { pool } = require('../db');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:3300';
const OUT = require('path').join(require('os').tmpdir(), 'nowaste-receive.png');
const EMAIL = `shotr_${Date.now()}@t.com`;
const api = async (m, u, { token, body } = {}) => {
  const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
(async () => {
  const token = (await api('POST', '/api/auth/signup', { body: { email: EMAIL, password: 'pw123456' } })).data.token;
  await api('POST', '/api/items', { token, body: { name: '무항생제 신선한 계란 15구', ingredient: '계란', capacity: 1, remaining: 1, unit: '개', storage: 'fridge', status: 'ordered' } });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 402, height: 848 }, deviceScaleFactor: 2 });
  await ctx.addInitScript((t) => localStorage.setItem('nowaste.token', t), token);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=곧 도착', { timeout: 30000 });
  await page.locator('button:has-text("받았어요")').first().click();
  await page.waitForSelector('text=받았어요', { timeout: 8000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: OUT });
  console.log('saved', OUT);
  await browser.close();
  await pool.query('DELETE FROM fridge_users WHERE email = $1', [EMAIL]);
  await pool.end();
})().catch(async (e) => { console.error(e); try { await pool.query('DELETE FROM fridge_users WHERE email=$1', [EMAIL]); } catch {} process.exit(1); });
