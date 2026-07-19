// 남은 음식·김치가 레시피에 실제로 들어가는지 (1·3번 수정 검증)
const BASE = process.env.BASE || 'http://localhost:3300';
const call = (m, u, { token, body } = {}) =>
  fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
let pass = 0, fail = 0;
const ok = (c, l, x = '') => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${c ? '' : ' → ' + x}`); };

(async () => {
  const { data: a } = await call('POST', '/api/auth/signup', { body: { email: `lo${Date.now()}@t.com`, password: 'pw123456' } });
  const token = a.token;

  console.log('[1] 김치찌개 — 김치가 재료에 들어가나');
  const kim = await call('POST', '/api/recipes/byname', { token, body: { dish: '김치찌개', tag: '전체' } });
  ok(kim.status === 200, 'byname 200', kim.status);
  const kimIngs = (kim.data?.recipe?.uses || []).map((u) => u.ing);
  console.log('     재료:', kimIngs.join(', '));
  ok(kimIngs.some((i) => i.includes('김치')), '김치가 uses에 포함됨');

  console.log('\n[2] 남은 음식(잡채) 담고 → 그걸 쓰는 레시피 나오나');
  await call('POST', '/api/items', { token, body: { name: '남은 잡채', ingredient: '잡채', capacity: 1, unit: '개', storage: 'fridge', expiry_date: null } });
  await call('POST', '/api/items', { token, body: { name: '양파', ingredient: '양파', capacity: 2, unit: '개', storage: 'room_shade' } });
  const rec = await call('POST', '/api/recipes/suggest', { token, body: { tag: '전체' } });
  ok(rec.status === 200, '추천 200');
  const usesJapchae = rec.data.recipes.some((r) => r.uses.some((u) => u.ing.includes('잡채')));
  console.log('     추천 레시피:', rec.data.recipes.map((r) => r.title).join(' / '));
  ok(usesJapchae, '잡채 활용 레시피가 추천에 있음');

  console.log('\n[3] 부대찌개 — 핵심 재료(햄/소시지) 들어가나');
  const bud = await call('POST', '/api/recipes/byname', { token, body: { dish: '부대찌개', tag: '전체' } });
  const budIngs = (bud.data?.recipe?.uses || []).map((u) => u.ing);
  console.log('     재료:', budIngs.join(', '));
  ok(budIngs.some((i) => i.includes('햄') || i.includes('소시지') || i.includes('김치')), '부대찌개 핵심 재료 포함');

  console.log(`\n${'─'.repeat(38)}`);
  console.log(fail === 0 ? `✅ 남은음식·김치 전부 통과 (${pass})` : `❌ ${fail} 실패 / ${pass} 통과`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
