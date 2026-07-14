// 실제로 뜬 서버에 대고 API를 돌려본다. 목(mock) 없이 진짜 DB에 붙는다.
const BASE = process.env.BASE || 'http://localhost:3000';

const call = async (method, url, { token, body } = {}) => {
  const r = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await r.json(); } catch { /* 204 등 */ }
  return { status: r.status, data };
};

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
};

(async () => {
  const stamp = Date.now();
  const A = { email: `a${stamp}@test.com`, password: 'pw123456' };
  const B = { email: `b${stamp}@test.com`, password: 'pw123456' };

  console.log('\n[1] 헬스체크');
  const h = await call('GET', '/api/health');
  ok(h.status === 200, 'GET /api/health → 200', h.status);

  console.log('\n[2] 🔒 .env가 웹으로 새는가 (함정 3)');
  for (const p of ['/.env', '/db.js', '/schema.sql', '/package.json']) {
    const r = await fetch(BASE + p);
    const body = await r.text();
    const leaked = body.includes('SUPABASE_DB_URL') || body.includes('JWT_SECRET') || body.includes('postgresql://');
    ok(r.status === 404 && !leaked, `GET ${p} → 404, 내용 안 샘`, `status=${r.status}`);
  }

  console.log('\n[3] 가입 · 로그인');
  const sa = await call('POST', '/api/auth/signup', { body: A });
  ok(sa.status === 201 && sa.data.token, '가입 → 토큰 발급', sa.status);
  const dup = await call('POST', '/api/auth/signup', { body: A });
  ok(dup.status === 409, '같은 이메일 재가입 → 409', dup.status);
  const bad = await call('POST', '/api/auth/login', { body: { ...A, password: 'wrong' } });
  ok(bad.status === 401, '틀린 비밀번호 → 401', bad.status);
  const tokenA = sa.data.token;

  const sb = await call('POST', '/api/auth/signup', { body: B });
  const tokenB = sb.data.token;

  console.log('\n[4] 토큰 없이 접근');
  const noauth = await call('GET', '/api/items');
  ok(noauth.status === 401, '토큰 없이 GET /api/items → 401', noauth.status);
  const forged = await call('GET', '/api/items', { token: 'not.a.real.token' });
  ok(forged.status === 401, '위조 토큰 → 401', forged.status);

  console.log('\n[5] 라벨 없는 신선식품 — 재료+보관방법만으로 유통기한 자동');
  const onion = await call('POST', '/api/items', {
    token: tokenA,
    body: { name: '양파', ingredient: '양파', capacity: 3, unit: '개', price: 3900, storage: 'room_shade' },
  });
  ok(onion.status === 201, '양파 담기 → 201', onion.status);
  ok(onion.data?.item?.expiry_source === 'preset', "유통기한 출처 = 'preset'");
  ok(onion.data?.item?.days_left === 60, '양파+실온그늘 → D-60', `days_left=${onion.data?.item?.days_left}`);

  const tofu = await call('POST', '/api/items', {
    token: tokenA,
    body: { name: '풀무원 두부', ingredient: '두부', capacity: 300, unit: 'g', price: 2200, storage: 'fridge' },
  });
  ok(tofu.data?.item?.days_left === 7, '두부+냉장 → D-7', `days_left=${tofu.data?.item?.days_left}`);

  const leek = await call('POST', '/api/items', {
    token: tokenA,
    body: { name: '대파', ingredient: '대파', capacity: 200, unit: 'g', price: 2980, storage: 'fridge' },
  });

  console.log('\n[6] ❄️ 냉동 전환 — 얼리면 안 되는 재료를 막는가');
  const freezeTofu = await call('POST', `/api/items/${tofu.data.item.id}/freeze`, { token: tokenA });
  ok(freezeTofu.status === 409, '두부 냉동 시도 → 409 거절', freezeTofu.status);
  ok(/얼리면 못 써요/.test(freezeTofu.data?.error || ''), '거절 사유를 사람 말로 알려줌');

  const freezeLeek = await call('POST', `/api/items/${leek.data.item.id}/freeze`, { token: tokenA });
  ok(freezeLeek.status === 200, '대파 냉동 → 200', freezeLeek.status);
  ok(freezeLeek.data?.item?.storage === 'freezer', '보관위치 = freezer');
  ok(freezeLeek.data?.item?.days_left === 90, '기한 재계산 → D-90', `days_left=${freezeLeek.data?.item?.days_left}`);

  console.log('\n[7] 🔒 남의 냉장고에 손댈 수 있는가 (RLS가 없는 자리 — 급소)');
  const targetId = onion.data.item.id;
  const peek = await call('GET', '/api/items', { token: tokenB });
  ok((peek.data?.items || []).length === 0, 'B의 목록에 A의 재고가 안 보임', `${peek.data?.items?.length}건`);

  const steal = await call('PATCH', `/api/items/${targetId}`, { token: tokenB, body: { name: '해킹됨' } });
  ok(steal.status === 404, 'B가 A의 재고 수정 시도 → 404 차단', steal.status);

  const kill = await call('DELETE', `/api/items/${targetId}`, { token: tokenB });
  ok(kill.status === 404, 'B가 A의 재고 삭제 시도 → 404 차단', kill.status);

  const frz = await call('POST', `/api/items/${targetId}/freeze`, { token: tokenB });
  ok(frz.status === 404, 'B가 A의 재고 냉동 시도 → 404 차단', frz.status);

  const cls = await call('POST', `/api/items/${targetId}/close`, { token: tokenB, body: { outcome: 'eaten' } });
  ok(cls.status === 404, 'B가 A의 재고 소진처리 시도 → 404 차단', cls.status);

  const still = await call('GET', '/api/items', { token: tokenA });
  ok(still.data.items.find((i) => i.id === targetId)?.name === '양파', 'A의 양파는 그대로 무사함');

  console.log('\n[8] 소진 · 폐기 기록 (절감 측정의 근거)');
  const discard = await call('POST', `/api/items/${tofu.data.item.id}/close`, {
    token: tokenA, body: { outcome: 'discarded' },
  });
  ok(discard.status === 200, '두부 버림 처리 → 200', discard.status);
  ok(discard.data?.item?.outcome === 'discarded', "outcome = 'discarded'");
  ok(discard.data?.item?.closed_on != null, 'closed_on 기록됨');

  const after = await call('GET', '/api/items', { token: tokenA });
  ok(!after.data.items.some((i) => i.id === tofu.data.item.id), '버린 건 냉장고 목록에서 빠짐');

  console.log('\n[9] 리포트 집계 (숫자가 문자열로 오면 NaN — 함정 11)');
  const stats = await call('GET', '/api/stats/waste?months=6', { token: tokenA });
  ok(stats.status === 200, 'GET /api/stats/waste → 200', stats.status);
  const w = stats.data?.monthly?.[0]?.wasted;
  ok(typeof w === 'number' && !Number.isNaN(w), '폐기 금액이 number 타입', `typeof=${typeof w} value=${w}`);
  ok(w === 2200, '두부 2,200원어치를 통째로 버린 것으로 집계', `wasted=${w}`);

  console.log('\n[10] 레시피 — 급한 재료를 쓰는 것부터');
  const rec = await call('POST', '/api/recipes/suggest', { token: tokenA, body: { tag: '전체' } });
  ok(rec.status === 200 && Array.isArray(rec.data.recipes), '레시피 추천 → 200');

  console.log('\n[11] 날짜가 하루 밀리지 않는가 (KST/UTC — 함정 6)');
  const kstToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  const fresh = await call('POST', '/api/items', {
    token: tokenA, body: { name: '상추', ingredient: '상추', capacity: 100, unit: 'g', storage: 'fridge' },
  });
  const expect = new Date(Date.parse(kstToday + 'T00:00:00Z') + 5 * 86400000).toISOString().slice(0, 10);
  ok(fresh.data.item.expiry_date === expect, `상추+냉장 → ${expect} (5일)`, `got=${fresh.data.item.expiry_date}`);
  ok(fresh.data.item.days_left === 5, 'days_left = 5', `got=${fresh.data.item.days_left}`);

  console.log(`\n${'─'.repeat(46)}`);
  console.log(fail === 0 ? `✅ 전부 통과 (${pass})` : `❌ ${fail}건 실패 / ${pass}건 통과`);
  process.exit(fail ? 1 : 0);
})();
