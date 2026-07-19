// thumbnail.html → 발표썸네일.png (1920×1080)
const { chromium } = require('playwright-core');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FILE = 'file:///' + path.resolve(__dirname, '..', 'thumbnail.html').replace(/\\/g, '/');
const OUT = path.resolve(__dirname, '..', '발표썸네일.png');
(async () => {
  const b = await chromium.launch({ executablePath: CHROME, headless: true });
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await p.goto(FILE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1000);
  await p.locator('.slide').screenshot({ path: OUT });
  await b.close();
  console.log('✓ 발표썸네일.png');
})().catch((e) => { console.error(e.message); process.exit(1); });
