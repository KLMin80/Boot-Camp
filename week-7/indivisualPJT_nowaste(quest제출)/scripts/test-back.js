// 폰 뒤로가기(히스토리 연동) 동작 테스트 — 설치된 Chrome을 playwright-core로 몰아본다.
const { chromium } = require('playwright-core');
const BASE = process.env.BASE || 'http://localhost:3300';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

let pass = 0, fail = 0;
const ok = (c, l, x = '') => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${c ? '' : ' → ' + x}`); };

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(BASE, { waitUntil: 'networkidle' });

  // 가입 (새 계정)
  const email = `back${Date.now()}@t.com`;
  await page.click("button:has-text('처음이신가요')");
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', 'pw123456');
  await page.click("button[type=submit]");
  await page.waitForSelector("text=냉장고", { timeout: 15000 });
  ok(true, '가입 후 홈 진입');
  ok(errors.length === 0, '콘솔 에러 없음', errors.join(' | '));

  const curView = () => page.evaluate(() => {
    // 화면 판별: 헤더 h1 텍스트
    return document.querySelector('h1')?.textContent || '';
  });

  // 1) 홈 → 요리 탭 → 뒤로가기 → 홈
  await page.click("nav button:nth-child(4)"); // 요리
  await page.waitForTimeout(500);
  ok((await curView()).includes('오늘 뭐 먹지'), '요리 화면 진입');
  await page.goBack();
  await page.waitForTimeout(500);
  ok((await curView()).includes('냉장고'), '뒤로 → 홈으로 (앱 안 종료)', await curView());
  ok(page.url().startsWith(BASE), '아직 앱 URL', page.url());

  // 2) 담기 → 재료로 담기 → 뒤로 → 담기 메뉴 → 뒤로 → 홈
  await page.click("nav button:nth-child(2)"); // 담기
  await page.waitForTimeout(400);
  await page.click("button:has-text('재료로 담기')");
  await page.waitForTimeout(400);
  ok((await curView()).includes('재료로 담기'), '재료로 담기 진입');
  await page.goBack();
  await page.waitForTimeout(500);
  ok((await curView()).includes('담기') && !(await curView()).includes('재료로'), '뒤로 → 담기 메뉴', await curView());
  await page.goBack();
  await page.waitForTimeout(500);
  ok((await curView()).includes('냉장고'), '뒤로 → 홈', await curView());

  // 3) 냉장고 재료 탭 → 시트 열기 → 뒤로 → 시트 닫힘 (홈 유지)
  // 재료 하나 추가해서 시트 테스트
  await page.evaluate(async () => {
    const t = localStorage.getItem('nowaste.token');
    await fetch('/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: JSON.stringify({ name: '양파', ingredient: '양파', capacity: 3, unit: '개', storage: 'room_shade' }) });
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector("text=양파", { timeout: 8000 });
  await page.click(".divide-y button:has-text('양파')"); // 아이템 시트
  await page.waitForTimeout(400);
  const sheetOpen = await page.evaluate(() => !!document.querySelector('.slideup'));
  ok(sheetOpen, '아이템 시트 열림');
  await page.goBack();
  await page.waitForTimeout(500);
  const sheetClosed = await page.evaluate(() => !document.querySelector('.slideup'));
  ok(sheetClosed, '뒤로 → 시트 닫힘');
  ok((await curView()).includes('냉장고'), '홈 유지(시트만 닫힘)', await curView());

  console.log(`\n${'─'.repeat(38)}`);
  console.log(fail === 0 ? `✅ 뒤로가기 전부 통과 (${pass})` : `❌ ${fail} 실패 / ${pass} 통과`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('실패:', e.message); process.exit(1); });
