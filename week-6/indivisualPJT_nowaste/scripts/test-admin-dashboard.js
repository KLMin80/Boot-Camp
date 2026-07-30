// 운영·수익 관리 대시보드 검증: 관리자 게이트(403) + 집계(리텐션·자산·경제) + /admin 렌더.
// 서버는 ADMIN_EMAILS=admin@nowaste.test 로 띄운 상태여야 함.
const { chromium } = require('playwright-core');
const { pool } = require('../db');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:3300';
const ADMIN = 'admin@nowaste.test';
const STAMP = Date.now();
const api = async (m, u, { token, body } = {}) => {
  const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
let pass = 0, fail = 0;
const ok = (c, l, e = '') => { c ? (pass++, console.log('  ✓', l)) : (fail++, console.log('  ✗', l, e)); };
const signup = async (email) => (await api('POST', '/api/auth/signup', { body: { email, password: 'pw123456' } })).data?.token
  || (await api('POST', '/api/auth/login', { body: { email, password: 'pw123456' } })).data.token;
const addItem = async (token, ingredient, price) => (await api('POST', '/api/items', { token, body: { name: ingredient, ingredient, capacity: 300, remaining: 300, unit: 'g', price, storage: 'fridge' } })).data.item;
const close = (token, id, outcome, amt) => api('POST', `/api/items/${id}/close`, { token, body: { outcome, discarded_amount: amt ?? null } });

(async () => {
  const adminTok = await signup(ADMIN);
  const uEmail = `dashu_${STAMP}@t.com`;
  const uTok = await signup(uEmail);

  // 소비사이클/자산 시드: 두부 2건 먹음(예측가능 쌍), 두부 1건 폐기(폐기금액), 스캔 성격 데이터
  const t1 = await addItem(uTok, '두부', 3000); await close(uTok, t1.id, 'eaten');
  const t2 = await addItem(uTok, '두부', 3000); await close(uTok, t2.id, 'eaten');   // 같은 재료 2회 → 예측가능 쌍
  const t3 = await addItem(uTok, '두부', 3000); await close(uTok, t3.id, 'discarded', 150); // 150/300*3000 = ₩1500 폐기
  await addItem(uTok, '우유', 1200); // 살아있는 재고(가격 있음)
  await addItem(uTok, '계란', null); // 가격 없음 → 가격 커버리지 < 100 확인용

  // 리텐션용 백데이트 유저(40일 전 가입 + 재방문 활동)
  const bd = await pool.query("INSERT INTO fridge_users(email,password_hash,created_at) VALUES($1,'x', now()-interval '40 days') RETURNING id", [`bd_${STAMP}@t.com`]);
  const bid = bd.rows[0].id;
  await pool.query("INSERT INTO fridge_activity(user_id,day) VALUES ($1,(now()-interval '39 days')::date),($1,(now()-interval '35 days')::date) ON CONFLICT DO NOTHING", [bid]);

  // ── 관리자 게이트 ──
  const forbidden = await api('GET', '/api/admin/dashboard', { token: uTok });
  ok(forbidden.status === 403, '비관리자 → 403', JSON.stringify(forbidden.data));
  const noTok = await api('GET', '/api/admin/dashboard', {});
  ok(noTok.status === 401, '토큰 없음 → 401');

  // ── 집계 ──
  const res = await api('GET', '/api/admin/dashboard', { token: adminTok });
  ok(res.status === 200, '관리자 → 200');
  const d = res.data || {};
  ok(d.north && typeof d.north.mau === 'number' && d.north.totalUsers >= 2, `north 구조 (MAU=${d.north?.mau}, 유저=${d.north?.totalUsers})`);
  ok(Array.isArray(d.growth?.signups), '가입 추세 배열');
  ok(d.retention && d.retention.d30 !== null && d.retention.d30Den >= 1, `리텐션 D30 계산됨 (${d.retention?.d30}% n=${d.retention?.d30Den})`);
  ok(d.dataAsset?.closedCycles >= 3, `완결 사이클 ≥3 (${d.dataAsset?.closedCycles})`);
  ok(d.dataAsset?.predictablePairs >= 1, `재구매 예측가능 쌍 ≥1 (${d.dataAsset?.predictablePairs})`);
  ok(d.dataAsset?.wasteKrw >= 1500, `폐기 금액 ≥₩1500 (${d.dataAsset?.wasteKrw})`);
  ok(d.dataAsset?.priceCoverage > 0 && d.dataAsset?.priceCoverage < 100, `가격 커버리지 부분 (${d.dataAsset?.priceCoverage}%)`);
  ok(typeof d.sale?.transferClause === 'boolean', `영업양도 조항 체크(=${d.sale?.transferClause})`);
  ok(d.economics?.aiKrw >= 0 && typeof d.economics.note === 'string', 'AI 원가 + 제휴 미구현 노트');

  // ── /admin 렌더 ──
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 1400 }, deviceScaleFactor: 1.5 });
  await ctx.addInitScript((t) => localStorage.setItem('nowaste.token', t), adminTok);
  const page = await ctx.newPage();
  const errs = []; page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await page.goto(BASE + '/admin', { waitUntil: 'networkidle' });
  await page.waitForSelector('text=데이터 자산 (매각 대비)', { timeout: 15000 });
  ok(await page.getByText('남김없이 · 운영 대시보드').isVisible(), '헤더 렌더');
  ok(await page.getByText('한눈에').first().isVisible() && await page.getByText('성장 & 리텐션').isVisible(), '핵심 섹션 렌더');
  ok(await page.getByText('영업양도 조항', { exact: false }).isVisible(), '매각 준비 체크 렌더');
  ok(errs.length === 0, '콘솔 에러 없음', errs.join(' | '));
  await page.screenshot({ path: require('path').join(require('os').tmpdir(), 'nowaste-admin.png'), fullPage: true });

  // 비관리자 게이트 화면
  const ctx2 = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  await ctx2.addInitScript((t) => localStorage.setItem('nowaste.token', t), uTok);
  const p2 = await ctx2.newPage();
  await p2.goto(BASE + '/admin', { waitUntil: 'networkidle' });
  await p2.waitForTimeout(1000);
  ok(await p2.getByText('운영 대시보드').first().isVisible(), '비관리자 → 게이트 화면');

  await browser.close();
  // 정리
  await pool.query('DELETE FROM fridge_users WHERE email = ANY($1)', [[ADMIN, uEmail, `bd_${STAMP}@t.com`]]);
  await pool.end();
  console.log(`\n${fail === 0 ? '✅ 통과' : '❌ 실패'} (${pass}/${pass + fail})`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await pool.query('DELETE FROM fridge_users WHERE email = ANY($1)', [[ADMIN, `dashu_${STAMP}@t.com`, `bd_${STAMP}@t.com`]]); } catch {} process.exit(1); });
