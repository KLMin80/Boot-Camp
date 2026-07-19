// 앱 아이콘 마스터 1024×1024 (스토어·어댑티브 아이콘의 원본). 🧺 브랜드 마크.
const { chromium } = require('playwright-core');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = path.resolve(__dirname, '..', 'store-assets', 'app-icon-1024.png');
const HTML = `<!doctype html><meta charset=utf-8>
<div id="ic" style="width:1024px;height:1024px;display:grid;place-items:center;
  background:radial-gradient(circle at 38% 32%, #6f9182, #5B7A6B 62%, #4b6559);">
  <div style="font-size:560px;line-height:1;filter:drop-shadow(0 24px 40px rgba(0,0,0,.28))">🧺</div>
</div>`;
(async () => {
  require('fs').mkdirSync(path.dirname(OUT), { recursive: true });
  const b = await chromium.launch({ executablePath: CHROME, headless: true });
  const p = await b.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  await p.setContent(`<body style="margin:0">${HTML}</body>`);
  await p.waitForTimeout(500);
  await p.locator('#ic').screenshot({ path: OUT });
  await b.close();
  console.log('✓', OUT);
})().catch((e) => { console.error(e.message); process.exit(1); });
