// Play 스토어용 스크린샷 4장 (1080×1920, 9:16). 커서·자막 없이 깔끔하게.
const { chromium } = require('playwright-core');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:3300';
const OUT = path.resolve(__dirname, '..', 'store-assets');
const { token } = require('./.demo-token.json');

(async () => {
  require('fs').mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await b.newContext({ viewport: { width: 432, height: 768 }, deviceScaleFactor: 2.5 });
  await ctx.addInitScript((t) => localStorage.setItem('nowaste.token', t), token);
  const p = await ctx.newPage();
  await p.goto(BASE, { waitUntil: 'networkidle', timeout: 20000 });
  await p.waitForSelector('text=오늘 안 쓰면 버려요', { timeout: 12000 });
  await p.waitForTimeout(700);

  const shot = (name) => p.screenshot({ path: path.join(OUT, name) });

  await shot('screenshot-1-home.png');                        // 냉장고: 급함 + 곧 떨어져요

  await p.locator('nav button:has-text("요리")').click();
  await p.waitForSelector('article', { timeout: 12000 });
  await p.waitForTimeout(900);
  await shot('screenshot-2-cook.png');                        // 요리: 레시피 + 골라서

  await p.locator('nav button:has-text("리포트")').click();
  await p.waitForSelector('text=버린 돈이', { timeout: 8000 });
  await p.waitForTimeout(900);
  await shot('screenshot-3-report.png');                      // 리포트: 아낀 돈

  await p.locator('nav button:has-text("담기")').click();
  await p.waitForSelector('text=영수증으로 한 번에', { timeout: 6000 });
  await p.waitForTimeout(700);
  await shot('screenshot-4-add.png');                         // 담기: 영수증

  await b.close();
  console.log('✓ 스토어 스크린샷 4장:', OUT);
})().catch((e) => { console.error(e.message); process.exit(1); });
