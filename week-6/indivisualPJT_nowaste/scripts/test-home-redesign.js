// 홈 개편 검증: 하단탭 3개 · 재료담기 버튼 · 확인 필요(확인/편집) · 오늘 추천요리 · 기존기능 유지.
const { chromium } = require('playwright-core');
const { pool } = require('../db');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:3300';
const EMAIL = `home_${Date.now()}@t.com`;
const api = async (m, u, { token, body } = {}) => {
  const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
let pass = 0, fail = 0;
const ok = (c, l, e = '') => { c ? (pass++, console.log('  ✓', l)) : (fail++, console.log('  ✗', l, e)); };
const pendCount = async (token) => (await api('GET', '/api/items?status=pending', { token })).data.items.length;
const confCount = async (token) => (await api('GET', '/api/items?status=confirmed', { token })).data.items.length;

(async () => {
  const token = (await api('POST', '/api/auth/signup', { body: { email: EMAIL, password: 'pw123456' } })).data.token;
  // 확정 재고(레시피·재고목록용)
  for (const ig of ['두부', '대파', '김치']) await api('POST', '/api/items', { token, body: { name: ig, ingredient: ig, capacity: 300, remaining: 300, unit: 'g', price: 3000, storage: 'fridge' } });
  // 확인 대기(pending) 2건 — 하나는 유통기한 미상(추정)
  await api('POST', '/api/items', { token, body: { name: '서울우유 1L', ingredient: '우유', capacity: 1000, remaining: 1000, unit: 'ml', price: 2800, storage: 'fridge', status: 'pending' } });
  await api('POST', '/api/items', { token, body: { name: '대란 15구', ingredient: '계란', capacity: 15, remaining: 15, unit: '개', price: 6000, storage: 'fridge', status: 'pending', expiry_date: '2026-09-01' } });

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 440, height: 1000 } });
  await ctx.addInitScript((t) => localStorage.setItem('nowaste.token', t), token);
  const page = await ctx.newPage();
  const errs = []; page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=확인 필요', { timeout: 30000 });

  // ① 하단 탭 3개
  const nav = page.locator('nav').last();
  ok(await nav.getByText('냉장고').isVisible() && await nav.getByText('요리').isVisible() && await nav.getByText('리포트').isVisible(), '하단탭 냉장고·요리·리포트');
  ok(await nav.getByText('담기').count() === 0 && await nav.getByText('확인', { exact: true }).count() === 0, "하단탭에 담기·확인 없음");

  // ② 재료 담기 버튼 → 담기 화면
  ok(await page.getByRole('button', { name: /재료 담기/ }).isVisible(), '냉장고에 재료 담기 버튼');
  await page.getByRole('button', { name: /재료 담기/ }).click();
  await page.waitForTimeout(500);
  ok(!(await page.getByText('값 맞는지 보고 확인').isVisible().catch(() => false)), '재료 담기 → 담기 화면으로 이동(홈 이탈)');
  await nav.getByText('냉장고').click(); // 홈 복귀
  await page.waitForSelector('text=확인 필요', { timeout: 8000 });

  // ③ 확인 필요 — 항목·확인버튼·편집시트
  ok(await page.getByText('서울우유 1L').isVisible() && await page.getByText('대란 15구').isVisible(), '확인 필요에 pending 항목 표시');
  await page.getByText('서울우유 1L').click();
  await page.waitForSelector('text=이 값 맞나요?', { timeout: 8000 });
  ok(await page.getByText('이 값 맞나요?').isVisible(), '항목 탭 → 확인 시트(편집) 열림');
  await page.getByRole('button', { name: /고칠게요/ }).click();
  ok(await page.getByRole('button', { name: /고쳐서 냉장고에 넣기/ }).isVisible(), '고치기 모드 진입');
  await page.mouse.click(220, 25); // 시트 닫기(백드롭)
  await page.waitForSelector('text=이 값 맞나요?', { state: 'hidden', timeout: 4000 }).catch(() => {});

  // 확인 버튼 → pending→confirmed
  const p0 = await pendCount(token), c0 = await confCount(token);
  await page.getByRole('button', { name: '확인', exact: true }).first().click();
  await page.waitForTimeout(1000);
  const p1 = await pendCount(token), c1 = await confCount(token);
  ok(p1 === p0 - 1 && c1 === c0 + 1, `확인 → 냉장고로 이동 (pending ${p0}→${p1}, confirmed ${c0}→${c1})`);

  // ④ 오늘 추천요리 → 상세
  await page.waitForSelector('text=오늘 추천요리', { timeout: 30000 });
  ok(await page.getByText('오늘 추천요리').isVisible(), '오늘 추천요리 섹션');
  await page.locator('section:has-text("오늘 추천요리") button').nth(1).click(); // 첫 레시피 카드(0=더보기)
  await page.waitForSelector('text=몇 인분?', { timeout: 10000 });
  ok(await page.getByText('몇 인분?').isVisible(), '추천요리 탭 → 레시피 상세 열림');
  await page.mouse.click(220, 25);
  await page.waitForTimeout(300);

  ok(errs.length === 0, '콘솔 에러 없음', errs.join(' | '));

  await browser.close();
  await pool.query('DELETE FROM fridge_users WHERE email = $1', [EMAIL]);
  await pool.end();
  console.log(`\n${fail === 0 ? '✅ 통과' : '❌ 실패'} (${pass}/${pass + fail})`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await pool.query('DELETE FROM fridge_users WHERE email=$1', [EMAIL]); } catch {} process.exit(1); });
