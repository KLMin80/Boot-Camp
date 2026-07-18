// slides.html의 각 .slide를 정확히 1920x1080 PNG로 저장한다.
const { chromium } = require('playwright-core');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FILE = 'file:///' + path.resolve(__dirname, '..', 'slides.html').replace(/\\/g, '/');
const OUT = path.resolve(__dirname, '..');

const NAMES = { s2: '슬라이드2_문제', s3: '슬라이드3_솔루션', s4: '슬라이드4_핵심기능',
  s5: '슬라이드5_배운것', s6: '슬라이드6_차별점', s7: '슬라이드7_비용', s8: '슬라이드8_마무리' };

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(FILE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200); // 폰트 로드
  for (const [id, name] of Object.entries(NAMES)) {
    const el = page.locator('#' + id);
    await el.screenshot({ path: path.join(OUT, name + '.png') });
    console.log('✓', name + '.png');
  }
  await browser.close();
  console.log('\n보조 슬라이드 7장 완료');
})().catch((e) => { console.error(e.message); process.exit(1); });
