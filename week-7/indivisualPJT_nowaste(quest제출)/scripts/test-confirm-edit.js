// 확인(고쳐서 넣기) 화면에서 용량·단위 수정이 실제로 반영되는지 브라우저로 검증한다.
// 시나리오: OCR이 우유를 '1g'로 잘못 읽음 → 사용자가 1000ml로 고쳐서 담기 → DB에 반영.
const { chromium } = require('playwright-core');
const { pool } = require('../db');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:3300';
const EMAIL = `confirm_${Date.now()}@t.com`;

const api = async (m, u, { token, body } = {}) => {
  const r = await fetch(BASE + u, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, data: await r.json().catch(() => null) };
};

let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { c ? (pass++, console.log('  ✓', label)) : (fail++, console.log('  ✗', label, extra)); };

(async () => {
  // 1) 유저 + 잘못 읽힌 pending 재고 (우유 1g)
  const su = await api('POST', '/api/auth/signup', { body: { email: EMAIL, password: 'pw123456' } });
  const token = su.data.token;
  const uid = require('jsonwebtoken').verify(token, process.env.JWT_SECRET).uid;
  await pool.query(
    `INSERT INTO fridge_items (user_id, name, ingredient, capacity, remaining, unit, price,
       expiry_date, expiry_source, storage, status, ocr_text)
     VALUES ($1,'서울우유 1A','우유',1,1,'g',3150,
       (now() AT TIME ZONE 'Asia/Seoul')::date + 7,'ocr','fridge','pending','서울우유 1A 1g')`,
    [uid]
  );

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 402, height: 848 } });
  await ctx.addInitScript((t) => localStorage.setItem('nowaste.token', t), token);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  // 2) 확인 탭으로
  await page.locator('nav button:has-text("확인")').first().click();
  await page.waitForSelector('text=서울우유 1A', { timeout: 10000 });
  ok(await page.locator('text=1g').first().isVisible(), '잘못 읽힌 용량 "1g"이 보인다');

  // 3) 고칠게요 → 용량/단위 입력이 나타나는가 (이게 이번 버그의 핵심)
  await page.locator('button:has-text("고칠게요")').click();
  const capInput = page.locator('input[type="number"]').first();
  const unitSelect = page.locator('select').first();
  ok(await capInput.isVisible().catch(() => false), '용량 숫자 입력칸이 나타난다 (예전엔 안 나왔음)');
  ok(await unitSelect.isVisible().catch(() => false), '단위 선택칸이 나타난다');

  // 4) 1000 ml로 고치고 담기
  await capInput.fill('1000');
  await unitSelect.selectOption('ml');
  await page.locator('button:has-text("고쳐서 냉장고에 넣기")').click();

  // 5) DB에 반영됐는지 API로 확인
  let item = null;
  for (let k = 0; k < 20; k++) {
    const r = await api('GET', '/api/items?status=confirmed', { token });
    item = (r.data.items || []).find((x) => x.name === '서울우유 1A');
    if (item) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  ok(!!item, '냉장고(confirmed)로 넘어갔다');
  ok(item && item.capacity === 1000, `용량이 1000으로 반영`, `got=${item && item.capacity}`);
  ok(item && item.unit === 'ml', `단위가 ml로 반영`, `got=${item && item.unit}`);
  ok(item && item.remaining === 1000, `남은 양도 1000으로 맞춰짐`, `got=${item && item.remaining}`);

  await browser.close();
  await pool.query('DELETE FROM fridge_users WHERE email = $1', [EMAIL]); // 정리
  await pool.end();
  console.log(`\n${fail === 0 ? '✅ 통과' : '❌ 실패'} (${pass}/${pass + fail})`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await pool.query('DELETE FROM fridge_users WHERE email=$1', [EMAIL]); } catch {} process.exit(1); });
