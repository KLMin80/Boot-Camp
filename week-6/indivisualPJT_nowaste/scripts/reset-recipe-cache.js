// 레시피 캐시 리셋 + 워밍. 기존 캐시를 비우고, 흔한 가정식을 '새 형식'(양념 양·초보 설명)으로 미리 채운다.
// nowaste 전용 캐시(fridge_recipe_cache)라 안전. 실행: node scripts/reset-recipe-cache.js
require('dotenv').config();
const { pool } = require('../db');
const recipes = require('../recipes');

// 태그 골고루 — 아이(순하게)/건강(저염·담백)/어른(일반)
const DISHES = [
  ['김치찌개', '어른'], ['된장찌개', '건강'], ['제육볶음', '어른'], ['김치볶음밥', '어른'],
  ['부대찌개', '어른'], ['순두부찌개', '어른'], ['닭볶음탕', '어른'], ['불고기', '아이'],
  ['계란말이', '아이'], ['달걀찜', '아이'], ['소시지야채볶음', '아이'], ['감자조림', '아이'],
  ['어묵볶음', '아이'], ['멸치볶음', '아이'], ['카레라이스', '아이'], ['오므라이스', '아이'],
  ['시금치나물', '건강'], ['콩나물무침', '건강'], ['두부조림', '건강'], ['미역국', '건강'],
  ['애호박볶음', '건강'], ['오이무침', '건강'], ['가지볶음', '건강'], ['북엇국', '건강'],
  ['김치전', '어른'], ['참치김치찌개', '어른'], ['잡채', '어른'], ['된장국', '건강'],
];

(async () => {
  // 1) 리셋
  const del = await pool.query('DELETE FROM fridge_recipe_cache');
  console.log(`🗑  기존 캐시 ${del.rowCount}개 삭제`);

  // 2) 어휘(사전) — 프리셋 ∪ 흔한 재료
  const pr = await pool.query('SELECT DISTINCT ingredient FROM fridge_shelf_life');
  const COMMON = ['김치', '밥', '라면', '국수', '소면', '우동', '당면', '떡', '만두', '유부', '어묵', '햄',
    '소시지', '스팸', '참치', '김', '미역', '멸치', '순두부', '콩나물', '숙주', '양배추', '깻잎', '청양고추',
    '고추', '카레', '치킨', '전', '잡채', '나물', '옥수수', '완두콩', '빵', '식빵', '밀가루', '설탕', '북어'];
  const vocab = [...new Set([...pr.rows.map((x) => x.ingredient), ...COMMON])];

  // 3) 워밍 — 새 형식으로 생성(양념 양·초보 steps는 recipes.js 프롬프트가 처리)
  let ok = 0, fail = 0;
  for (const [dish, tag] of DISHES) {
    try {
      const out = await recipes.byName({ dish, inventory: [], vocab, tag });
      if (out.recipe) { ok++; console.log(`  ✓ ${dish} (${tag})`); }
      else { fail++; console.log(`  ✗ ${dish} — ${out.error || '생성 실패'}`); }
    } catch (e) { fail++; console.log(`  ! ${dish} — ${e.status || ''} ${e.message}`); }
  }

  const total = await pool.query('SELECT count(*)::int c FROM fridge_recipe_cache');
  console.log(`\n워밍 ${ok}개 성공 / ${fail}개 실패 · 현재 캐시 ${total.rows[0].c}개`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
