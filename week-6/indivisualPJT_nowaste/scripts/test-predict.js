// Phase D — 소비 예측. 부분 차감된 재료의 소비 속도로 '곧 떨어져요'를 계산하고,
// 홈 카드 + 미리 담기(멀티마켓)까지 실브라우저로 검증.
const { chromium } = require('playwright-core');
const { pool } = require('../db');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:3300';
const EMAIL = `predict_${Date.now()}@t.com`;

const api = async (m, u, { token, body } = {}) => {
  const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
let pass = 0, fail = 0;
const ok = (c, l, e = '') => { c ? (pass++, console.log('  ✓', l)) : (fail++, console.log('  ✗', l, e)); };

(async () => {
  const token = (await api('POST', '/api/auth/signup', { body: { email: EMAIL, password: 'pw123456' } })).data.token;
  const uid = require('jsonwebtoken').verify(token, process.env.JWT_SECRET).uid;
  const DP = (n) => `((now() AT TIME ZONE 'Asia/Seoul')::date + ${n})`;

  // 3일 전 산 우유 1000ml, 700 소비 → 300 남음 → 하루 ~233 → 약 1일 뒤 0 (유통기한은 넉넉히 +10)
  await pool.query(
    `INSERT INTO fridge_items (user_id, name, ingredient, capacity, remaining, unit, price, purchased_on, expiry_date, expiry_source, storage, status)
     VALUES ($1,'서울우유 1L','우유',1000,300,'ml',3000, ${DP(-3)}, ${DP(10)}, 'manual','fridge','confirmed')`, [uid]);
  // 갓 산 계란(소비 없음) → 예측에 뜨면 안 됨
  await pool.query(
    `INSERT INTO fridge_items (user_id, name, ingredient, capacity, remaining, unit, price, purchased_on, expiry_date, expiry_source, storage, status)
     VALUES ($1,'계란 30구','계란',30,30,'개',7000, ${DP(0)}, ${DP(20)}, 'manual','fridge','confirmed')`, [uid]);

  // ── API ──
  const p = await api('GET', '/api/stats/predict', { token });
  const items = p.data?.items || [];
  console.log('    예측:', items.map((i) => `${i.name}(~${i.days_to_empty}일)`).join(' | ') || '없음');
  ok(items.length === 1 && items[0].name === '서울우유 1L', '소비된 우유만 예측에 뜸(갓산 계란 제외)', `count=${items.length}`);
  ok(items[0] && items[0].days_to_empty <= 2, '약 1~2일 뒤 소진으로 계산', `dte=${items[0]?.days_to_empty}`);

  // ── UI: 홈 '곧 떨어져요' 카드 + 미리 담기 → 멀티마켓 시트 ──
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 402, height: 848 } });
  await ctx.addInitScript((t) => localStorage.setItem('nowaste.token', t), token);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=곧 떨어져요', { timeout: 10000 });
  ok(await page.locator('text=곧 떨어져요').first().isVisible(), "홈에 '곧 떨어져요' 카드가 뜬다");
  ok(await page.locator('text=다 써요').first().isVisible().catch(() => false), '소진 예상일이 표시된다');
  await page.locator('button:has-text("미리 담기")').first().click();
  ok(await page.locator('text=쿠팡프레시').first().isVisible({ timeout: 5000 }).catch(() => false), '미리 담기 → 멀티마켓 시트(쿠팡프레시 등)가 열린다');

  await browser.close();
  await pool.query('DELETE FROM fridge_users WHERE email = $1', [EMAIL]);
  await pool.end();
  console.log(`\n${fail === 0 ? '✅ 통과' : '❌ 실패'} (${pass}/${pass + fail})`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await pool.query('DELETE FROM fridge_users WHERE email=$1', [EMAIL]); } catch {} process.exit(1); });
