// 레시피 하이브리드 엔진
//
// 이 앱의 레시피는 "맛있는 걸 찾아줘"가 아니라 "이 재료를 남김없이 쓰게 해줘"다.
// 그래서 랭킹 기준이 다르다:
//   1) 급한 재료(D-1 이하)를 쓰는가   ← 최우선
//   2) 많이 소진하는가 (300g를 다 쓰는 > 50g만 쓰는)
//   3) 부족한 재료가 적은가
//
// 흐름: 캐시(전역 카탈로그)에서 먼저 찾고 → 모자라면 LLM으로 생성 → 캐시에 저장.
// 쓸수록 캐시가 두꺼워져 LLM 호출이 0에 수렴한다.

const OpenAI = require('openai');
const { pool } = require('./db');

const MODEL = 'gpt-4o-mini'; // 레시피 생성엔 충분하고 저렴 (호출당 ~0.01원)
const apiKey = process.env.OPEN_AI_API || process.env.OPENAI_API_KEY;
const client = apiKey ? new OpenAI({ apiKey }) : null;

// 집에 있다고 가정하는 양념 — 재고로 관리하지 않고, 부족해도 주문 목록에 넣지 않는다.
// (이게 없으면 모든 레시피가 "간장 없음"으로 떠서 쿠팡 링크가 양념으로 도배된다)
const PANTRY = ['간장', '소금', '설탕', '고춧가루', '참기름', '식용유', '후추',
  '다진마늘', '고추장', '된장', '굴소스', '식초', '맛술', '물엿', '케첩', '마요네즈', '깨'];

const RECIPE_COLS = 'title, tag, mins, emoji, uses, servings, seasonings, steps, source';

/* ── 캐시 조회 ── core_ings가 focus 재료와 하나라도 겹치는 레시피 */
async function fromCache(focus, tag) {
  if (!focus.length) return [];
  const params = [focus];
  let sql = `SELECT ${RECIPE_COLS} FROM fridge_recipe_cache WHERE core_ings && $1`;
  if (tag && tag !== '전체') { params.push(tag); sql += ` AND tag = $2`; }
  sql += ' LIMIT 60';
  const r = await pool.query(sql, params);
  return r.rows;
}

/* 레시피 한 건에 보유/부족 정보를 붙인다 (필터·정렬 없이) */
function annotate(r, have) {
  const owned = r.uses.filter((u) => have[u.ing]);
  const missing = r.uses.filter((u) => !have[u.ing]).map((u) => u.ing);
  const urgentUses = owned.filter((u) => have[u.ing].days_left <= 1).length;
  const soonest = owned.length ? Math.min(...owned.map((u) => have[u.ing].days_left)) : 99;
  const consumed = owned.reduce((s, u) => s + Math.min(u.amt || 0, have[u.ing].remaining), 0);
  return {
    ...r,
    uses: r.uses.map((u) => ({
      ...u, have: have[u.ing]?.remaining ?? 0, days_left: have[u.ing]?.days_left ?? null,
    })),
    missing, urgentUses, soonest, consumed,
  };
}

const haveMap = (inventory) => Object.fromEntries(inventory.map((i) => [i.ing, i]));

/* ── 랭킹 ── 앱의 정체성이 여기 있다 */
function rank(recipes, inventory) {
  const have = haveMap(inventory);
  return recipes
    .map((r) => annotate(r, have))
    .filter((r) => r.missing.length <= 2)          // 3개 이상 없으면 "만들 수 있다"고 보기 어렵다
    .sort((a, b) =>
      b.urgentUses - a.urgentUses ||               // 급한 재료를 더 많이 쓰는 것
      a.missing.length - b.missing.length ||        // 부족한 게 적은 것
      b.consumed - a.consumed ||                    // 더 많이 비우는 것
      a.soonest - b.soonest                         // 그다음 급한 순
    );
}

/* ── LLM 생성 ── 재료를 우리 어휘 안에서만 고르게 강제한다 */
async function generate({ focus, invNames, vocab, tag, need, avoid }) {
  if (!client) return [];
  const tagLine = tag && tag !== '전체'
    ? `- 대상은 "${tag}"용이다 (아이=순하고 부드럽게 / 어른=일반 / 건강=저염·기름 적게).`
    : '- 대상은 아이·어른·건강 중 재료에 맞게 정한다.';

  const sys = [
    '너는 한국 가정식 요리사다. 냉장고에서 곧 상할 재료를 남김없이 소진시키는 것이 목적이다.',
    '규칙:',
    `- uses의 재료는 반드시 주어진 "재료 사전" 안의 이름만 쓴다. 사전에 없는 재료는 절대 uses에 넣지 않는다.`,
    '- 급한 재료를 최대한 많이, 최대한 많은 양으로 쓰는 요리를 우선한다.',
    '- **servings는 2로 고정(2인분 기준). uses의 amt는 정확히 2인분 기준의 현실적인 양이다** (예: 대파 100g, 두부 300g, 달걀 3개).',
    '- 소금·간장·참기름 같은 양념은 uses가 아니라 seasonings에 넣는다 (집에 있다고 가정).',
    '- uses에는 사전 재료 중 없는 것을 최대 1개까지만 포함할 수 있다 (부족분 유도). 대부분은 보유 재료로 채운다.',
    tagLine,
    '- **steps는 4~6단계, 각 단계에 재료 양·불세기·시간을 구체적으로** (예: "중불에서 5분간 볶는다"). 실제로 따라 할 수 있게.',
    '- 서로 다른, 겹치지 않는 요리를 만든다.',
  ].join('\n');

  const usr = [
    `재료 사전(이 안에서만 고를 것): ${vocab.join(', ')}`,
    `지금 보유한 재료: ${invNames.join(', ') || '없음'}`,
    `특히 급한(먼저 써야 할) 재료: ${focus.join(', ')}`,
    avoid.length ? `이미 추천한 것(피할 것): ${avoid.join(', ')}` : '',
    `${need}개의 서로 다른 요리를 제안하라.`,
  ].filter(Boolean).join('\n');

  const unit = { type: 'string', enum: ['g', 'ml', '개'] };
  const resp = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
    max_tokens: 1500,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'recipes', strict: true,
        schema: {
          type: 'object', additionalProperties: false, required: ['recipes'],
          properties: {
            recipes: {
              type: 'array',
              items: {
                type: 'object', additionalProperties: false,
                required: ['title', 'tag', 'mins', 'emoji', 'servings', 'uses', 'seasonings', 'steps'],
                properties: {
                  title: { type: 'string' },
                  tag: { type: 'string', enum: ['아이', '어른', '건강'] },
                  mins: { type: 'integer' },
                  emoji: { type: 'string' },
                  servings: { type: 'integer' },
                  uses: {
                    type: 'array',
                    items: {
                      type: 'object', additionalProperties: false,
                      required: ['ing', 'amt', 'unit'],
                      properties: { ing: { type: 'string', enum: vocab }, amt: { type: 'number' }, unit },
                    },
                  },
                  seasonings: { type: 'array', items: { type: 'string' } },
                  steps: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  });

  const parsed = JSON.parse(resp.choices[0].message.content);
  return (parsed.recipes || []).filter((r) => r.uses?.length);
}

/* ── 캐시에 저장 ── 같은 제목은 무시 (전역 공유) */
async function store(recipes, source = 'llm') {
  for (const r of recipes) {
    const core = [...new Set(r.uses.map((u) => u.ing))].sort();
    await pool.query(
      `INSERT INTO fridge_recipe_cache (title, tag, mins, emoji, uses, servings, core_ings, seasonings, steps, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (title) DO NOTHING`,
      [r.title, r.tag || '어른', r.mins || 20, r.emoji || '🍽️',
       JSON.stringify(r.uses), r.servings > 0 ? r.servings : 2,
       core, r.seasonings || [], JSON.stringify(r.steps || []), source]
    );
  }
}

/* ── 진입점 ── */
async function suggest({ inventory, vocab, tag, want = 6 }) {
  const invNames = [...new Set(inventory.map((i) => i.ing))];
  const urgent = inventory.filter((i) => i.days_left <= 4).map((i) => i.ing);
  const focus = urgent.length ? [...new Set(urgent)] : invNames;

  let ranked = rank(await fromCache(focus, tag), inventory);

  // 캐시가 이 정도만 있어도 LLM을 부르지 않는다 (첫 방문 외엔 항상 즉시 응답).
  // want(6개)를 다 못 채워도, 최소치(3)만 넘으면 캐시 것만 준다.
  const MIN_FRESH = 3;
  let generatedNow = false;
  if (ranked.length < MIN_FRESH && invNames.length && client) {
    try {
      const made = await generate({
        focus, invNames, vocab, tag,
        need: want - ranked.length,
        avoid: ranked.map((r) => r.title),
      });
      if (made.length) {
        await store(made);
        ranked = rank(await fromCache(focus, tag), inventory);
        generatedNow = true;
      }
    } catch (e) {
      // LLM이 막혀도 앱은 죽지 않는다 — 캐시에 있던 것만 돌려준다
      console.error('[recipes] LLM 생성 실패:', e.status || '', e.message);
    }
  }

  return { recipes: ranked.slice(0, want), generated: generatedNow, hasLLM: Boolean(client) };
}

/* ── 음식명으로 레시피 만들기 ── 추천에 없는 요리를 직접 입력했을 때.
   캐시에 있으면 그걸 쓰고, 없으면 그 요리 하나를 생성해 캐시에 저장한다. */
async function byName({ dish, inventory, vocab, tag }) {
  const name = String(dish || '').trim().slice(0, 40);
  if (!name) return { recipe: null, error: '음식 이름을 입력해 주세요.' };

  // 캐시에 같은 이름(부분 일치)이 있으면 재사용
  const hit = await pool.query(
    `SELECT ${RECIPE_COLS} FROM fridge_recipe_cache WHERE title ILIKE $1 ORDER BY (title = $2) DESC LIMIT 1`,
    [`%${name}%`, name]
  );
  if (hit.rowCount) return { recipe: annotate(hit.rows[0], haveMap(inventory)), generated: false };

  if (!client) return { recipe: null, error: 'AI 레시피 생성이 설정되지 않았어요.' };

  const invNames = [...new Set(inventory.map((i) => i.ing))];
  const sys = [
    '너는 한국 가정식 요리사다. 사용자가 지정한 요리의 레시피를 만든다.',
    `- uses의 재료는 반드시 주어진 "재료 사전" 안의 이름만 쓴다.`,
    '- servings는 2(2인분), uses의 amt는 2인분 기준 현실적인 양.',
    '- 양념(소금·간장 등)은 seasonings에, 사전에 있는 주재료만 uses에.',
    '- steps는 4~6단계, 재료 양·불세기·시간 구체적으로.',
    tag && tag !== '전체' ? `- 가능하면 "${tag}" 취향에 맞게.` : '',
  ].filter(Boolean).join('\n');
  const usr = [
    `재료 사전(uses는 이 안에서만): ${vocab.join(', ')}`,
    `사용자 보유 재료: ${invNames.join(', ') || '없음'}`,
    `만들 요리: "${name}"`,
    '이 요리의 레시피 1개를 만들어라. 보유 재료를 최대한 활용하되, 이 요리에 꼭 필요한 재료는 없어도 uses에 넣어라(앱이 부족분을 표시한다).',
  ].join('\n');

  const unit = { type: 'string', enum: ['g', 'ml', '개'] };
  const resp = await client.chat.completions.create({
    model: MODEL, max_tokens: 700,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'recipe', strict: true,
        schema: {
          type: 'object', additionalProperties: false,
          required: ['title', 'tag', 'mins', 'emoji', 'servings', 'uses', 'seasonings', 'steps'],
          properties: {
            title: { type: 'string' }, tag: { type: 'string', enum: ['아이', '어른', '건강'] },
            mins: { type: 'integer' }, emoji: { type: 'string' }, servings: { type: 'integer' },
            uses: { type: 'array', items: { type: 'object', additionalProperties: false,
              required: ['ing', 'amt', 'unit'],
              properties: { ing: { type: 'string', enum: vocab }, amt: { type: 'number' }, unit } } },
            seasonings: { type: 'array', items: { type: 'string' } },
            steps: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  });
  const made = JSON.parse(resp.choices[0].message.content);
  if (!made.uses?.length) return { recipe: null, error: '그 요리 레시피를 못 만들었어요. 다른 이름으로 해보세요.' };
  await store([made], 'byname');

  // 저장된 것을 다시 읽어 소유권(have/missing) 붙여 반환
  const saved = await pool.query(`SELECT ${RECIPE_COLS} FROM fridge_recipe_cache WHERE title = $1 LIMIT 1`, [made.title]);
  return { recipe: annotate(saved.rows[0] || made, haveMap(inventory)), generated: true };
}

module.exports = { suggest, byName, PANTRY };
