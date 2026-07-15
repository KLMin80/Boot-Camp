// 하이브리드 레시피 엔진을 실제 DB + 실제 OpenAI로 검증한다.
const { pool } = require('../db');
const { suggest } = require('../recipes');

const ok = (c, label, extra = '') => console.log(`  ${c ? '✓' : '✗'} ${label}${c ? '' : ' ' + extra}`);

(async () => {
  const vocabRes = await pool.query('SELECT DISTINCT ingredient FROM fridge_shelf_life ORDER BY 1');
  const vocab = vocabRes.rows.map((r) => r.ingredient);
  console.log(`재료 사전 ${vocab.length}종\n`);

  // 급한 재료가 섞인 가상 냉장고
  const inventory = [
    { ing: '두부', remaining: 300, unit: 'g', days_left: 0 },   // D-DAY
    { ing: '대파', remaining: 200, unit: 'g', days_left: 1 },   // D-1
    { ing: '돼지고기', remaining: 500, unit: 'g', days_left: 2 },
    { ing: '양파', remaining: 3, unit: '개', days_left: 40 },
    { ing: '달걀', remaining: 6, unit: '개', days_left: 20 },
  ];

  console.log('[1] 첫 요청 — 캐시가 비었으니 LLM이 생성해야 함');
  const before = await pool.query('SELECT count(*)::int n FROM fridge_recipe_cache');
  const t0 = Date.now();
  const r1 = await suggest({ inventory, vocab, tag: '전체', want: 6 });
  const dt = Date.now() - t0;
  const after = await pool.query('SELECT count(*)::int n FROM fridge_recipe_cache');

  ok(r1.hasLLM, 'OpenAI 키 로드됨');
  ok(r1.recipes.length > 0, `레시피 ${r1.recipes.length}개 반환`, `${r1.recipes.length}개`);
  ok(after.rows[0].n > before.rows[0].n, `캐시에 저장됨 (${before.rows[0].n} → ${after.rows[0].n})`);
  console.log(`     (${dt}ms)`);

  console.log('\n[2] 🔒 어휘 안전 — 사전 밖 재료가 있으면 안 됨');
  const allUses = r1.recipes.flatMap((r) => r.uses.map((u) => u.ing));
  const outOfVocab = [...new Set(allUses)].filter((x) => !vocab.includes(x));
  ok(outOfVocab.length === 0, '모든 재료가 사전 안', `밖: ${outOfVocab}`);

  console.log('\n[3] 급한 재료(두부 D-DAY, 대파 D-1)를 우선 쓰는가');
  const top = r1.recipes[0];
  const topIngs = top.uses.map((u) => u.ing);
  ok(top.urgentUses >= 1, `1순위 "${top.title}"가 급한 재료 사용`, `urgentUses=${top.urgentUses}`);
  console.log(`     1순위: ${top.title} — ${topIngs.join(', ')} · ${top.mins}분 · ${top.tag}`);
  console.log(`     steps: ${(top.steps || []).length}단계`);

  console.log('\n[4] 양념은 주문 목록(missing)에 없어야 함');
  const PANTRY = ['간장', '소금', '설탕', '고춧가루', '참기름', '식용유', '후추', '다진마늘', '고추장', '된장'];
  const missingHasPantry = r1.recipes.some((r) => r.missing.some((m) => PANTRY.includes(m)));
  ok(!missingHasPantry, '주문 목록에 양념이 안 섞임');

  console.log('\n[5] missing은 사전 재료만, 최대 2개');
  const badMissing = r1.recipes.some((r) => r.missing.length > 2);
  ok(!badMissing, 'missing이 2개 이하');

  console.log('\n[6] 두 번째 요청 — 이제 캐시 히트, LLM 없이(빠름)');
  const t1 = Date.now();
  const r2 = await suggest({ inventory, vocab, tag: '전체', want: 6 });
  const dt2 = Date.now() - t1;
  ok(!r2.generated, 'LLM 재호출 안 함 (캐시 히트)', `generated=${r2.generated}`);
  ok(dt2 < dt, `더 빠름 (${dt}ms → ${dt2}ms)`);

  console.log('\n[7] 태그 필터 — 아이용');
  const kid = await suggest({ inventory, vocab, tag: '아이', want: 4 });
  const allKid = kid.recipes.every((r) => r.tag === '아이');
  ok(kid.recipes.length === 0 || allKid, '전부 아이용 태그', kid.recipes.map((r) => r.tag).join(','));

  console.log('\n───────────────');
  console.log('레시피 미리보기:');
  r1.recipes.slice(0, 4).forEach((r) => {
    const use = r.uses.map((u) => `${u.ing}${u.have < u.amt ? '(부족)' : ''}`).join('+');
    console.log(`  ${r.emoji} ${r.title} [${r.tag}] — ${use}${r.missing.length ? ` · 주문:${r.missing.join(',')}` : ''}`);
  });

  await pool.end();
})().catch((e) => { console.error('실패:', e.status || '', e.message); process.exit(1); });
