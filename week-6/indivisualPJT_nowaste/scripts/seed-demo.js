// 데모 영상용 시드. 직접 pg로 넣어 D-day·리포트 추세·레시피 캐시를 정확히 통제한다.
// 실행: node scripts/seed-demo.js  → 데모 계정 초기화 후 토큰을 stdout(JSON)으로 출력.
// 끝나면 cleanup-demo.js 로 지운다. (도메인 @nowaste.app → cleanup-test-users 도 잡음)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const EMAIL = 'demo@nowaste.app';
const PW = 'demo1234';
const TOKEN_OUT = process.argv[2] || path.join(__dirname, '.demo-token.json');

// KST 오늘 기준 N일 뒤 날짜 컬럼식
const DP = (n) => `((now() AT TIME ZONE 'Asia/Seoul')::date + ${n})`;

// 열려있는 재고 한 건
async function addItem(uid, it) {
  await pool.query(
    `INSERT INTO fridge_items
       (user_id, name, ingredient, capacity, remaining, unit, price,
        expiry_date, expiry_source, storage, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7, ${DP(it.d)}, $8, $9, 'confirmed')`,
    [uid, it.name, it.ing, it.cap, it.rem ?? it.cap, it.unit, it.price ?? null,
     it.src || 'preset', it.storage || 'fridge']
  );
}

// 과거에 버린 기록 (리포트 막대용) — k개월 전 10일, 통째로 폐기
async function addDiscard(uid, monthsAgo, ing, won) {
  await pool.query(
    `INSERT INTO fridge_items
       (user_id, name, ingredient, capacity, remaining, unit, price,
        purchased_on, expiry_date, expiry_source, storage, status,
        closed_on, outcome, discarded_amount)
     VALUES ($1,$2,$3, 1, 0, '개', $4,
        ${DP(-monthsAgo * 30 - 5)}, ${DP(-monthsAgo * 30)}, 'manual', 'fridge', 'confirmed',
        date_trunc('month', (now() AT TIME ZONE 'Asia/Seoul')::date)
          - make_interval(months => $5::int) + interval '10 days',
        'discarded', 1)`,
    [uid, ing, ing, won, monthsAgo]
  );
}

// 다 먹은 기록 (다 먹은 재료 카운트)
async function addEaten(uid, ing) {
  await pool.query(
    `INSERT INTO fridge_items
       (user_id, name, ingredient, capacity, remaining, unit, price,
        expiry_date, expiry_source, storage, status, closed_on, outcome)
     VALUES ($1,$2,$3, 1, 0, '개', 3000, ${DP(-3)}, 'manual', 'fridge', 'confirmed',
        ${DP(-2)}, 'eaten')`,
    [uid, ing, ing]
  );
}

const RECIPES = [
  { title: '김치두부찌개', tag: '어른', mins: 20, emoji: '🍲',
    uses: [{ ing: '김치', amt: 200, unit: 'g' }, { ing: '두부', amt: 300, unit: 'g' },
           { ing: '대파', amt: 50, unit: 'g' }, { ing: '돼지고기', amt: 150, unit: 'g' }],
    seasonings: ['고춧가루', '다진마늘', '국간장'],
    steps: ['냄비에 돼지고기를 볶다가 김치를 넣고 함께 볶아요.',
            '물 2컵을 붓고 고춧가루·다진마늘을 넣어 끓여요.',
            '두부를 큼직하게 썰어 넣고 5분 더 끓여요.',
            '마지막에 대파를 넣고 국간장으로 간을 맞춰요.'] },
  { title: '돼지고기 제육볶음', tag: '어른', mins: 15, emoji: '🍳',
    uses: [{ ing: '돼지고기', amt: 300, unit: 'g' }, { ing: '양파', amt: 1, unit: '개' },
           { ing: '대파', amt: 40, unit: 'g' }],
    seasonings: ['고추장', '고춧가루', '간장', '설탕', '다진마늘'],
    steps: ['고추장·고춧가루·간장·설탕·다진마늘로 양념장을 만들어요.',
            '돼지고기에 양념장을 버무려 10분 재워요.',
            '센 불에 양파와 함께 볶아요.',
            '대파를 넣고 한 번 더 볶아 완성해요.'] },
  { title: '대파달걀말이', tag: '아이', mins: 10, emoji: '🍳',
    uses: [{ ing: '계란', amt: 3, unit: '개' }, { ing: '대파', amt: 30, unit: 'g' }],
    seasonings: ['소금', '식용유'],
    steps: ['계란을 풀고 잘게 썬 대파와 소금을 넣어요.',
            '약한 불 팬에 기름을 두르고 계란물을 부어요.',
            '가장자리가 익으면 돌돌 말아요.',
            '한 김 식혀 먹기 좋게 썰어요.'] },
  { title: '프렌치토스트', tag: '아이', mins: 10, emoji: '🍞',
    uses: [{ ing: '계란', amt: 2, unit: '개' }, { ing: '우유', amt: 100, unit: 'ml' }],
    seasonings: ['설탕', '식용유'],
    steps: ['계란·우유·설탕을 잘 섞어요.',
            '식빵을 계란물에 충분히 적셔요.',
            '약한 불 팬에 노릇하게 앞뒤로 구워요.'] },
];

async function addRecipe(r) {
  const core = [...new Set(r.uses.map((u) => u.ing))].sort();
  await pool.query(
    `INSERT INTO fridge_recipe_cache
       (title, tag, mins, emoji, uses, servings, core_ings, seasonings, steps, source)
     VALUES ($1,$2,$3,$4,$5,2,$6,$7,$8,'seed')
     ON CONFLICT (title) DO UPDATE SET
       tag=excluded.tag, mins=excluded.mins, emoji=excluded.emoji, uses=excluded.uses,
       core_ings=excluded.core_ings, seasonings=excluded.seasonings, steps=excluded.steps`,
    [r.title, r.tag, r.mins, r.emoji, JSON.stringify(r.uses), core,
     r.seasonings || [], JSON.stringify(r.steps || [])]
  );
}

(async () => {
  // 1) 계정 초기화
  await pool.query('DELETE FROM fridge_users WHERE email = $1', [EMAIL]); // CASCADE로 재고 삭제
  const hash = await bcrypt.hash(PW, 10);
  const u = await pool.query(
    'INSERT INTO fridge_users (email, password_hash) VALUES ($1,$2) RETURNING id',
    [EMAIL, hash]
  );
  const uid = u.rows[0].id;

  // 2) 열려있는 재고 — D-day가 색으로 보이도록
  const items = [
    { name: '대파',          ing: '대파',     cap: 200,  unit: 'g',  price: 2980, d: 0,  storage: 'fridge' }, // D-DAY
    { name: '풀무원 두부',    ing: '두부',     cap: 300,  unit: 'g',  price: 2200, d: 1,  storage: 'fridge' }, // D-1
    { name: '한돈 앞다리살',  ing: '돼지고기', cap: 600,  unit: 'g',  price: 9800, d: 2,  storage: 'fridge' }, // D-2
    { name: '서울우유 1A',    ing: '우유',     cap: 1000, rem: 400, unit: 'ml', price: 3150, d: 3, storage: 'fridge' }, // D-3
    { name: '초란 10구',      ing: '계란',     cap: 10,   unit: '개', price: 6490, d: 12, storage: 'fridge' },
    { name: '종가집 포기김치', ing: '김치',     cap: 500,  unit: 'g',  price: 0,    d: 20, storage: 'fridge' }, // 남은 음식(무료)
    { name: '양파',          ing: '양파',     cap: 3,    unit: '개', price: 3900, d: 51, storage: 'room_shade' },
    // 냉동으로 살린 것 (freezer/preset) — '냉동으로 살린 것' 카운트 + 냉동 탭
    { name: '대파(냉동)',     ing: '대파',     cap: 150,  unit: 'g',  price: 0,    d: 85, storage: 'freezer' },
    { name: '양파(냉동)',     ing: '양파',     cap: 200,  unit: 'g',  price: 0,    d: 88, storage: 'freezer' },
  ];
  for (const it of items) await addItem(uid, it);

  // 3) 리포트 — 6개월 폐기 추세(내림세) + 다 먹은 기록
  const trend = [ [5, '상추', 6200], [4, '애호박', 5100], [3, '콩나물', 4300],
                  [2, '두부', 3200], [1, '우유', 2100], [0, '대파', 1400] ];
  for (const [m, ing, won] of trend) await addDiscard(uid, m, ing, won);
  for (const ing of ['계란', '양파', '닭고기', '두부', '당근']) await addEaten(uid, ing);

  // 4) 레시피 캐시 — 보유 재료를 전부 커버해 생성(LLM) 호출 없이 즉시 뜨게
  for (const r of RECIPES) await addRecipe(r);

  // 5) 토큰 발급 (server.js와 동일한 payload/secret)
  const token = jwt.sign({ uid }, process.env.JWT_SECRET, { expiresIn: '30d' });
  fs.writeFileSync(TOKEN_OUT, JSON.stringify({ email: EMAIL, token, uid }, null, 2));
  console.log(JSON.stringify({ ok: true, email: EMAIL, uid, items: items.length, token_file: TOKEN_OUT }));
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
