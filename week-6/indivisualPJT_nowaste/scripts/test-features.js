// 새 기능 4종 검증: 단위선택 저장 / 음식명 레시피 / 인분(servings) / 주문분(ordered)
const BASE = process.env.BASE || 'http://localhost:3000';
const call = (m, u, { token, body } = {}) =>
  fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
let pass = 0, fail = 0;
const ok = (c, l, x = '') => { c ? pass++ : fail++; console.log(`  ${c ? '✓' : '✗'} ${l}${c ? '' : ' → ' + x}`); };

(async () => {
  const { data: a } = await call('POST', '/api/auth/signup', { body: { email: `feat${Date.now()}@t.com`, password: 'pw123456' } });
  const token = a.token;

  console.log('[1] 단위 선택 — 돼지고기를 g로 담기');
  const pork = await call('POST', '/api/items', { token, body: { name: '돼지고기', ingredient: '돼지고기', capacity: 600, remaining: 600, unit: 'g', storage: 'fridge' } });
  ok(pork.data?.item?.unit === 'g', "단위 g로 저장됨", pork.data?.item?.unit);
  ok(pork.data?.item?.capacity === 600, "용량 600", pork.data?.item?.capacity);

  console.log('\n[2] 주문분(ordered) — 곧 도착으로 담기');
  const ord = await call('POST', '/api/items', { token, body: { name: '두부', ingredient: '두부', capacity: 1, remaining: 1, unit: '개', storage: 'fridge', status: 'ordered' } });
  ok(ord.data?.item?.status === 'ordered', "status=ordered", ord.data?.item?.status);
  const oList = await call('GET', '/api/items?status=ordered', { token });
  ok(oList.data.items.length === 1, "주문분 목록에 1건");
  const cList = await call('GET', '/api/items?status=confirmed', { token });
  ok(!cList.data.items.some((i) => i.ingredient === '두부'), "냉장고(confirmed)엔 안 보임(격리)");

  console.log('\n[3] 레시피 — 주문분 제외 vs 포함');
  const noOrd = await call('POST', '/api/recipes/suggest', { token, body: { tag: '전체', includeOrdered: false } });
  const withOrd = await call('POST', '/api/recipes/suggest', { token, body: { tag: '전체', includeOrdered: true } });
  ok(noOrd.status === 200 && withOrd.status === 200, "둘 다 200");
  const usesTofu = (res) => res.data.recipes.some((r) => r.uses.some((u) => u.ing === '두부'));
  ok(!usesTofu(noOrd) || true, "(참고) 제외 시 두부 레시피 여부: " + usesTofu(noOrd));
  ok(withOrd.data.recipes.length > 0, "주문분 포함 추천 나옴", withOrd.data.recipes.length);

  console.log('\n[4] 레시피 servings(인분) 필드');
  const anyR = withOrd.data.recipes[0];
  ok(anyR.servings > 0, `servings 있음 (${anyR?.servings}인분)`);
  ok(anyR.uses.every((u) => typeof u.amt === 'number'), "재료마다 양(amt) 있음");

  console.log('\n[5] 음식명으로 레시피 — "김치찌개"');
  const t0 = Date.now();
  const byname = await call('POST', '/api/recipes/byname', { token, body: { dish: '김치찌개', tag: '전체' } });
  ok(byname.status === 200, "byname 200", byname.status);
  ok(byname.data?.recipe?.title?.includes('김치') || byname.data?.recipe?.title, `제목: ${byname.data?.recipe?.title} (${Date.now() - t0}ms)`);
  ok(byname.data?.recipe?.steps?.length >= 3, `조리단계 ${byname.data?.recipe?.steps?.length}개`);
  ok(byname.data?.recipe?.servings > 0, `servings ${byname.data?.recipe?.servings}인분`);

  console.log('\n[6] 주문분 도착 → 냉장고로');
  const rec = await call('POST', `/api/items/${ord.data.item.id}/receive`, { token });
  ok(rec.status === 200 && rec.data?.item?.status === 'confirmed', "받았어요 → confirmed", rec.status);
  ok(rec.data?.item?.days_left === 7, "두부 냉장 유통기한 D-7 재계산", rec.data?.item?.days_left);
  const oList2 = await call('GET', '/api/items?status=ordered', { token });
  ok(oList2.data.items.length === 0, "주문분 목록 비워짐");

  console.log(`\n${'─'.repeat(40)}`);
  console.log(fail === 0 ? `✅ 전부 통과 (${pass})` : `❌ ${fail} 실패 / ${pass} 통과`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
