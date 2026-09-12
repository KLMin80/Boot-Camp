// 스토어 스크린샷 최신화 — 바뀐 UI(새 홈·장보기 모드·받기 시트)로 데모 데이터를 채워 4장 캡처.
// 저장: store-assets/screenshot-1-home.png … 4-add.png (1080x1920).
const { chromium } = require('playwright-core');
const { pool } = require('../db');
const bcrypt = require('bcryptjs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:3300';
const OUT = path.join(__dirname, '..', 'store-assets');
const EMAIL = 'demo@nowaste.app';
const api = async (m, u, { token, body } = {}) => {
  const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const kst = (off = 0) => new Date(Date.now() + 9 * 3600e3 + off * 86400e3).toISOString().slice(0, 10);

(async () => {
  // 데모 계정 준비(있으면 재사용) + 재고 초기화
  let token = (await api('POST', '/api/auth/login', { body: { email: EMAIL, password: 'demo1234' } })).data?.token;
  if (!token) token = (await api('POST', '/api/auth/signup', { body: { email: EMAIL, password: 'demo1234' } })).data.token;
  const uid = (await pool.query('SELECT id FROM fridge_users WHERE email=$1', [EMAIL])).rows[0].id;
  await pool.query('DELETE FROM fridge_items WHERE user_id=$1', [uid]);
  await pool.query('DELETE FROM fridge_shopping WHERE user_id=$1', [uid]);

  const ins = (o) => pool.query(
    `INSERT INTO fridge_items (user_id,name,ingredient,capacity,remaining,unit,price,purchased_on,expiry_date,expiry_source,storage,status,closed_on,outcome,discarded_amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10,$11,$12,$13,$14,$15)`,
    [uid, o.name, o.ing, o.cap, o.rem ?? o.cap, o.unit || 'g', o.price ?? null, o.purchased || kst(0), o.expiry, o.esrc || 'manual', o.storage || 'fridge', o.status || 'confirmed', o.closed || null, o.outcome || null, o.disc ?? null]);

  // ── 냉장고(홈·요리용) 확정 재고 — 유통기한 스펙트럼
  await ins({ name: '풀무원 부침두부', ing: '두부', cap: 300, unit: 'g', price: 2480, expiry: kst(1) });   // 곧 상해요
  await ins({ name: '대파 한단', ing: '대파', cap: 200, unit: 'g', price: 1980, expiry: kst(0) });          // 곧 상해요
  await ins({ name: '냉장 삼겹살', ing: '돼지고기', cap: 500, unit: 'g', price: 9900, expiry: kst(3) });     // 이번 주
  await ins({ name: '서울우유 1L', ing: '우유', cap: 1000, unit: 'ml', price: 2850, expiry: kst(6) });
  await ins({ name: '무항생제 계란 15구', ing: '계란', cap: 15, unit: '개', price: 6490, expiry: kst(22) }); // 여유
  await ins({ name: '종가집 포기김치 900g', ing: '김치', cap: 900, unit: 'g', price: 12900, expiry: kst(40) });
  // ── 확인 필요(pending) — 유통기한 추정(날짜확인)
  await ins({ name: '스팸 클래식 200g', ing: '스팸', cap: 200, unit: 'g', price: 3980, expiry: kst(300), esrc: 'preset', storage: 'room', status: 'pending' });
  await ins({ name: '해찬들 고추장 500g', ing: '고추장', cap: 500, unit: 'g', price: 8900, expiry: kst(365), esrc: 'preset', storage: 'fridge', status: 'pending' });
  // ── 곧 도착(ordered)
  await ins({ name: '제주 삼다수 2L x6', ing: '생수', cap: 1, unit: '개', expiry: kst(400), status: 'ordered' });
  // ── 리포트: 이번 달 (먹음=식비, 폐기=버린돈)
  await ins({ name: '애호박', ing: '애호박', cap: 1, unit: '개', price: 1500, purchased: kst(-3), expiry: kst(-1), closed: kst(0), outcome: 'eaten' });
  await ins({ name: '두부(소진)', ing: '두부', cap: 300, unit: 'g', price: 2480, purchased: kst(-5), expiry: kst(-1), closed: kst(0), outcome: 'eaten' });
  await ins({ name: '상추', ing: '상추', cap: 1, unit: '개', price: 2200, purchased: kst(-6), expiry: kst(-2), closed: kst(-1), outcome: 'discarded', disc: 1 });      // 2200원 버림
  await ins({ name: '우유(상함)', ing: '우유', cap: 1000, unit: 'ml', price: 2850, purchased: kst(-8), expiry: kst(-2), closed: kst(-1), outcome: 'discarded', disc: 600 }); // 1710원 버림
  // ── 리포트: 지난 달 (추세용, 더 많이 버림 → 이번 달 '덜 버렸어요')
  await ins({ name: '시금치', ing: '시금치', cap: 1, unit: '개', price: 3000, purchased: kst(-38), expiry: kst(-33), closed: kst(-33), outcome: 'discarded', disc: 1 });
  await ins({ name: '당근', ing: '당근', cap: 3, unit: '개', price: 3600, purchased: kst(-40), expiry: kst(-34), closed: kst(-34), outcome: 'discarded', disc: 3 });
  await ins({ name: '사과', ing: '사과', cap: 5, unit: '개', price: 9000, purchased: kst(-41), expiry: kst(-35), closed: kst(-35), outcome: 'discarded', disc: 3 });

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 3 });
  await ctx.addInitScript((t) => localStorage.setItem('nowaste.token', t), token);
  const page = await ctx.newPage();

  const shot = async (file) => { await page.waitForTimeout(700); await page.screenshot({ path: path.join(OUT, file) }); console.log('saved', file); };

  // 1) 홈(냉장고)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=오늘 추천요리', { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('screenshot-1-home.png');

  // 2) 요리
  await page.locator('nav button:has-text("요리")').click();
  await page.waitForSelector('article', { timeout: 60000 });
  await page.waitForFunction(() => !document.body.innerText.includes('레시피 더 찾는 중'), { timeout: 25000 }).catch(() => {});
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('screenshot-2-cook.png');

  // 3) 리포트
  await page.locator('nav button:has-text("리포트")').click();
  await page.waitForSelector('text=이번 달 식비', { timeout: 15000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('screenshot-3-report.png');

  // 4) 담기 (홈의 재료 담기 버튼)
  await page.locator('nav button:has-text("냉장고")').click();
  await page.waitForSelector('text=재료 담기', { timeout: 8000 });
  await page.getByRole('button', { name: /재료 담기/ }).click();
  await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('screenshot-4-add.png');

  await browser.close();
  await pool.end();
  console.log('\n완료 — store-assets/ 에 4장 저장');
})().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
