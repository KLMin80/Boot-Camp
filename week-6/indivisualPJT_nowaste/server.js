// 남김없이 — API 서버
//
// 이 파일이 보안 경계다.
// Direct/pooler 연결은 postgres 역할로 붙어 RLS를 통과한다. DB가 지켜주지 않는다.
// 그래서 모든 재고 쿼리는 예외 없이 WHERE user_id = $1 을 포함해야 한다.

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');
const recipes = require('./recipes');
const ocr = require('./ocr');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('.env에 JWT_SECRET이 없습니다. `node scripts/gen-secret.js` 먼저 실행하세요.');
  process.exit(1);
}

app.use(express.json({ limit: '12mb' })); // 라벨 사진 base64가 크다 (클라에서 2048px로 줄여 보냄)

/* ───────────────── 날짜 ─────────────────
   date 컬럼을 그대로 JSON에 담으면 toISOString()을 타면서
   KST 자정이 UTC 전날로 밀려 하루 어긋난다. 문자열로 뽑는다. */
const TODAY_KST = `(now() AT TIME ZONE 'Asia/Seoul')::date`;
const ITEM_COLS = `
  id, name, ingredient,
  capacity::float8      AS capacity,
  remaining::float8     AS remaining,
  unit, price,
  to_char(purchased_on, 'YYYY-MM-DD') AS purchased_on,
  to_char(expiry_date,  'YYYY-MM-DD') AS expiry_date,
  (expiry_date - ${TODAY_KST})::int    AS days_left,
  expiry_source, storage, status,
  to_char(closed_on, 'YYYY-MM-DD')     AS closed_on,
  outcome,
  discarded_amount::float8 AS discarded_amount,
  ocr_text
`;

/* ───────────────── 인증 ───────────────── */
const sign = (id) => jwt.sign({ uid: id }, JWT_SECRET, { expiresIn: '30d' });

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: '로그인이 필요합니다.' });
  try {
    req.userId = jwt.verify(token, JWT_SECRET).uid;
    next();
  } catch {
    return res.status(401).json({ error: '로그인이 만료됐습니다. 다시 로그인해 주세요.' });
  }
}

app.post('/api/auth/signup', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email.includes('@')) return res.status(400).json({ error: '이메일 형식을 확인해 주세요.' });
  if (password.length < 6) return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다.' });

  const hash = await bcrypt.hash(password, 10);
  try {
    const r = await pool.query(
      'INSERT INTO fridge_users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, hash]
    );
    res.status(201).json({ token: sign(r.rows[0].id), email: r.rows[0].email });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: '이미 가입된 이메일입니다.' });
    throw e;
  }
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const r = await pool.query('SELECT id, password_hash FROM fridge_users WHERE email = $1', [email]);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(password, u.password_hash))) {
    return res.status(401).json({ error: '이메일 또는 비밀번호가 맞지 않습니다.' });
  }
  res.json({ token: sign(u.id), email });
});

/* ───────────────── 보관기간 프리셋 ─────────────────
   행이 없다는 것 자체가 정보다. (두부, freezer) 행이 없으면 두부는 얼리면 못 쓴다. */
app.get('/api/shelf-life', async (req, res) => {
  const { ingredient } = req.query;
  const r = ingredient
    ? await pool.query(
        'SELECT ingredient, storage, days FROM fridge_shelf_life WHERE ingredient = $1 ORDER BY days DESC',
        [ingredient]
      )
    : await pool.query('SELECT ingredient, storage, days FROM fridge_shelf_life ORDER BY ingredient, days DESC');

  // { 양파: { room_shade: 60, fridge: 30, freezer: 90 }, ... }
  const byIngredient = {};
  for (const row of r.rows) {
    (byIngredient[row.ingredient] ||= {})[row.storage] = row.days;
  }
  res.json({ presets: byIngredient });
});

/* ───────────────── 재고 ───────────────── */
app.get('/api/items', auth, async (req, res) => {
  const status = req.query.status; // pending | confirmed | ordered | (없으면 열려있는 전부)
  const params = [req.userId];
  let where = 'user_id = $1 AND outcome IS NULL';
  if (['pending', 'confirmed', 'ordered'].includes(status)) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  const r = await pool.query(
    `SELECT ${ITEM_COLS} FROM fridge_items WHERE ${where} ORDER BY expiry_date ASC, created_at ASC`,
    params
  );
  res.json({ items: r.rows });
});

app.post('/api/items', auth, async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const ingredient = String(b.ingredient || '').trim() || name;
  if (!name) return res.status(400).json({ error: '이름이 필요합니다.' });

  const capacity = Number(b.capacity) > 0 ? Number(b.capacity) : 1;
  const remaining = b.remaining != null ? Number(b.remaining) : capacity;

  // 유통기한: 준 게 있으면 그걸 쓰고, 없으면 재료 × 보관방법 프리셋으로 계산한다.
  let expiry = b.expiry_date || null;
  let source = b.expiry_source || (expiry ? 'manual' : 'preset');
  const storage = b.storage || 'fridge';

  if (!expiry) {
    const p = await pool.query(
      'SELECT days FROM fridge_shelf_life WHERE ingredient = $1 AND storage = $2',
      [ingredient, storage]
    );
    const days = p.rows[0]?.days ?? 7; // 모르는 재료는 보수적으로 7일
    const d = await pool.query(`SELECT to_char(${TODAY_KST} + $1::int, 'YYYY-MM-DD') AS d`, [days]);
    expiry = d.rows[0].d;
    source = 'preset';
  }

  const r = await pool.query(
    `INSERT INTO fridge_items
       (user_id, name, ingredient, capacity, remaining, unit, price,
        expiry_date, expiry_source, storage, status, ocr_text)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING ${ITEM_COLS}`,
    [req.userId, name, ingredient, capacity, remaining, b.unit || 'g',
     b.price ?? null, expiry, source, storage, b.status || 'confirmed', b.ocr_text ?? null]
  );
  res.status(201).json({ item: r.rows[0] });
});

/* 라벨 사진 → OCR → 확인 대기(pending) 재고 생성.
   찍기만 하고 확인은 나중에. 그래서 status='pending'으로 넣고, 확인 화면에서 검증한다. */
app.post('/api/label/parse', auth, async (req, res) => {
  const image = req.body.image;
  if (!image) return res.status(400).json({ error: '이미지가 필요합니다.' });
  const storage = ['fridge', 'freezer', 'room', 'room_shade'].includes(req.body.storage)
    ? req.body.storage : 'fridge';

  let read;
  try {
    read = await ocr.readLabel(image);
  } catch (e) {
    console.error('[ocr]', e.message);
    return res.status(502).json({ error: '사진을 읽지 못했어요. 조금 더 가까이, 밝은 곳에서 다시 찍어주세요.' });
  }

  // 유통기한: OCR로 읽었으면 그 값 → 없으면 재료 프리셋 → 그래도 없으면 냉장 7일 기본(사용자가 확인 때 고침)
  let expiry = read.expiry;
  let source = expiry ? 'ocr' : null;
  if (!expiry && read.ingredient) {
    const p = await pool.query(
      'SELECT days FROM fridge_shelf_life WHERE ingredient = $1 AND storage = $2',
      [read.ingredient, storage]
    );
    if (p.rows[0]) { expiry = await addDaysKST(p.rows[0].days); source = 'preset'; }
  }
  if (!expiry) { expiry = await addDaysKST(7); source = 'preset'; }

  const r = await pool.query(
    `INSERT INTO fridge_items
       (user_id, name, ingredient, capacity, remaining, unit, price,
        expiry_date, expiry_source, storage, status, ocr_text)
     VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,'pending',$10)
     RETURNING ${ITEM_COLS}`,
    [req.userId,
     read.name || '이름 확인 필요',
     read.ingredient || read.name || '재료',
     read.capacity && read.capacity > 0 ? read.capacity : 1,
     read.unit || 'g', read.price, expiry, source, storage, read.ocr_text]
  );
  res.status(201).json({ item: r.rows[0], read: { ...read, expiry_source: source } });
});

async function addDaysKST(days) {
  const d = await pool.query(`SELECT to_char(${TODAY_KST} + $1::int, 'YYYY-MM-DD') AS d`, [days]);
  return d.rows[0].d;
}

const PATCHABLE = ['name', 'ingredient', 'capacity', 'remaining', 'unit', 'price',
                   'expiry_date', 'expiry_source', 'storage', 'status'];

app.patch('/api/items/:id', auth, async (req, res) => {
  const sets = [];
  const params = [];
  for (const k of PATCHABLE) {
    if (req.body[k] !== undefined) {
      params.push(req.body[k]);
      sets.push(`${k} = $${params.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: '바꿀 값이 없습니다.' });

  params.push(req.params.id, req.userId); // ← user_id 조건. 이게 빠지면 남의 재고를 고칠 수 있다.
  const r = await pool.query(
    `UPDATE fridge_items SET ${sets.join(', ')}
     WHERE id = $${params.length - 1} AND user_id = $${params.length}
     RETURNING ${ITEM_COLS}`,
    params
  );
  if (!r.rowCount) return res.status(404).json({ error: '없는 항목입니다.' });
  res.json({ item: r.rows[0] });
});

/* 냉동실로 — 얼려도 되는 재료만. 기한은 프리셋으로 다시 계산한다.
   두부·감자·달걀처럼 freezer 프리셋이 없는 재료는 거절한다. */
app.post('/api/items/:id/freeze', auth, async (req, res) => {
  const cur = await pool.query(
    'SELECT ingredient FROM fridge_items WHERE id = $1 AND user_id = $2',
    [req.params.id, req.userId]
  );
  if (!cur.rowCount) return res.status(404).json({ error: '없는 항목입니다.' });

  const ingredient = cur.rows[0].ingredient;
  const p = await pool.query(
    "SELECT days FROM fridge_shelf_life WHERE ingredient = $1 AND storage = 'freezer'",
    [ingredient]
  );
  if (!p.rowCount) {
    return res.status(409).json({
      error: `${ingredient}은(는) 얼리면 못 써요. 오늘 요리로 쓰는 수밖에 없습니다.`,
      freezable: false,
    });
  }

  const r = await pool.query(
    `UPDATE fridge_items
        SET storage = 'freezer',
            expiry_date = ${TODAY_KST} + $1::int,
            expiry_source = 'preset'
      WHERE id = $2 AND user_id = $3
      RETURNING ${ITEM_COLS}`,
    [p.rows[0].days, req.params.id, req.userId]
  );
  res.json({ item: r.rows[0] });
});

/* 주문한 재료가 도착 → 냉장고로. 유통기한을 도착일(오늘) 기준으로 다시 계산한다. */
app.post('/api/items/:id/receive', auth, async (req, res) => {
  const cur = await pool.query(
    "SELECT ingredient, storage FROM fridge_items WHERE id = $1 AND user_id = $2 AND status = 'ordered'",
    [req.params.id, req.userId]
  );
  if (!cur.rowCount) return res.status(404).json({ error: '주문한 항목이 아니에요.' });

  const { ingredient, storage } = cur.rows[0];
  const p = await pool.query('SELECT days FROM fridge_shelf_life WHERE ingredient = $1 AND storage = $2', [ingredient, storage]);
  const days = p.rows[0]?.days ?? 7;
  const r = await pool.query(
    `UPDATE fridge_items
        SET status = 'confirmed',
            purchased_on = ${TODAY_KST},
            expiry_date = ${TODAY_KST} + $1::int,
            expiry_source = 'preset'
      WHERE id = $2 AND user_id = $3
      RETURNING ${ITEM_COLS}`,
    [days, req.params.id, req.userId]
  );
  res.json({ item: r.rows[0] });
});

/* 소진·폐기 — 이 기록이 없으면 "식비 절감"을 측정할 수 없다 (STRATEGY.md) */
app.post('/api/items/:id/close', auth, async (req, res) => {
  const outcome = req.body.outcome; // 'eaten' | 'discarded'
  if (!['eaten', 'discarded'].includes(outcome)) {
    return res.status(400).json({ error: "outcome은 'eaten' 또는 'discarded'여야 합니다." });
  }
  const r = await pool.query(
    `UPDATE fridge_items
        SET outcome = $1,
            closed_on = ${TODAY_KST},
            discarded_amount = CASE WHEN $1 = 'discarded'
                                    THEN COALESCE($2::numeric, remaining)
                                    ELSE 0 END,
            remaining = 0
      WHERE id = $3 AND user_id = $4 AND outcome IS NULL
      RETURNING ${ITEM_COLS}`,
    [outcome, req.body.discarded_amount ?? null, req.params.id, req.userId]
  );
  if (!r.rowCount) return res.status(404).json({ error: '없거나 이미 정리된 항목입니다.' });
  res.json({ item: r.rows[0] });
});

app.delete('/api/items/:id', auth, async (req, res) => {
  const r = await pool.query('DELETE FROM fridge_items WHERE id = $1 AND user_id = $2', [
    req.params.id, req.userId,
  ]);
  if (!r.rowCount) return res.status(404).json({ error: '없는 항목입니다.' });
  res.status(204).end();
});

/* ───────────────── 리포트 ─────────────────
   집계는 SQL에서 캐스팅하지 않으면 문자열로 와서 클라이언트에서 NaN이 된다. */
app.get('/api/stats/waste', auth, async (req, res) => {
  const months = Math.min(Math.max(Number(req.query.months) || 6, 1), 24);

  const monthly = await pool.query(
    `SELECT to_char(date_trunc('month', closed_on), 'YYYY-MM') AS month,
            COALESCE(SUM(price * discarded_amount / NULLIF(capacity,0)), 0)::float8 AS wasted,
            COUNT(*)::int AS n
       FROM fridge_items
      WHERE user_id = $1 AND outcome = 'discarded'
        AND closed_on >= date_trunc('month', ${TODAY_KST}) - make_interval(months => $2::int - 1)
      GROUP BY 1 ORDER BY 1`,
    [req.userId, months]
  );

  const top = await pool.query(
    `SELECT ingredient, COUNT(*)::int AS times,
            COALESCE(SUM(price * discarded_amount / NULLIF(capacity,0)), 0)::float8 AS wasted
       FROM fridge_items
      WHERE user_id = $1 AND outcome = 'discarded'
      GROUP BY 1 ORDER BY wasted DESC LIMIT 3`,
    [req.userId]
  );

  const saved = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE outcome = 'eaten')::int AS eaten,
            COUNT(*) FILTER (WHERE storage = 'freezer' AND expiry_source = 'preset')::int AS frozen
       FROM fridge_items WHERE user_id = $1`,
    [req.userId]
  );

  res.json({ monthly: monthly.rows, top: top.rows, ...saved.rows[0] });
});

/* 레시피용 재고 집계. includeOrdered면 '곧 도착'(ordered)도 포함(주말 미리 주문 대비). */
async function inventoryForRecipes(userId, includeOrdered) {
  const statuses = includeOrdered ? ['confirmed', 'ordered'] : ['confirmed'];
  const inv = await pool.query(
    `SELECT ingredient AS ing, SUM(remaining)::float8 AS remaining,
            MIN(unit) AS unit, MIN(expiry_date - ${TODAY_KST})::int AS days_left,
            bool_or(status = 'ordered') AS ordered
       FROM fridge_items
      WHERE user_id = $1 AND outcome IS NULL AND status = ANY($2)
      GROUP BY ingredient`,
    [userId, statuses]
  );
  return inv.rows;
}
// 프리셋(유통기한 사전)에 없지만 요리에 흔한 재료 + 남은 음식(직접 입력).
// 이게 없으면 김치찌개에 김치가, 남은 전/잡채/치킨 활용 레시피가 안 나온다.
const COMMON_INGREDIENTS = [
  '김치', '밥', '라면', '국수', '소면', '우동', '당면', '떡', '만두', '유부',
  '어묵', '햄', '소시지', '스팸', '참치', '김', '미역', '멸치', '순두부',
  '콩나물', '숙주', '양배추', '깻잎', '청양고추', '고추', '카레', '치킨',
  '피자', '전', '잡채', '나물', '옥수수', '완두콩', '아보카도', '빵', '식빵',
];

// 레시피 어휘 = 프리셋 ∪ 흔한 재료 ∪ 사용자 실제 재고(남은 음식 포함).
// 사용자가 담은 것은 뭐든 레시피에 활용될 수 있어야 한다.
async function recipeVocab(inventory = []) {
  const r = await pool.query('SELECT DISTINCT ingredient FROM fridge_shelf_life');
  const set = new Set([...r.rows.map((x) => x.ingredient), ...COMMON_INGREDIENTS]);
  for (const it of inventory) if (it.ing) set.add(it.ing);
  return [...set];
}

/* ───────────────── 레시피 (하이브리드: 캐시 + LLM) ───────────────── */
app.post('/api/recipes/suggest', auth, async (req, res) => {
  const tag = req.body.tag || '전체';
  const inventory = await inventoryForRecipes(req.userId, Boolean(req.body.includeOrdered));
  const vocab = await recipeVocab(inventory);
  const out = await recipes.suggest({ inventory, vocab, tag, want: 6 });
  res.json(out);
});

/* 음식명으로 레시피 만들기 — 추천에 없는 요리를 직접 입력 */
app.post('/api/recipes/byname', auth, async (req, res) => {
  const inventory = await inventoryForRecipes(req.userId, Boolean(req.body.includeOrdered));
  const vocab = await recipeVocab(inventory);
  const out = await recipes.byName({ dish: req.body.dish, inventory, vocab, tag: req.body.tag || '전체' });
  if (!out.recipe) return res.status(out.error ? 422 : 404).json({ error: out.error || '레시피를 못 만들었어요.' });
  res.json(out);
});

/* ───────────────── 멀티 마켓 구매 링크 ─────────────────
   쿠팡 하나가 아니라 여러 마켓으로 보내 "직접 비교"하게 한다.
   → 쿠팡이 구조적으로 못 하는 자리(중립 비교)를 차지하는 게 이 앱의 해자 (STRATEGY.md).

   ⚠️ 실시간 가격 나란히 비교는 담벼락 때문에 불가:
     - 쿠팡은 상품 가격 공개 API 없음 (파트너스는 딥링크만)
     - 네이버 쇼핑 생태계에 쿠팡·G마켓·11번가 배제됨
   → 그래서 각 마켓 '검색 딥링크' + (네이버 키 있으면) 네이버 참고 최저가.

   각 마켓 URL은 이 함수 한 곳에서만 만든다. 제휴 승인되면 여기만 딥링크로 교체. */
const MARKETS = [
  { key: 'coupang', label: '쿠팡프레시', icon: '🚀', affiliate: true,   // 파트너스 확정 (승인 후 딥링크로 교체)
    url: (q) => `https://www.coupang.com/np/search?q=${encodeURIComponent(q)}&channel=user` },
  { key: 'kurly',   label: '마켓컬리',   icon: '🥬', affiliate: false,  // 제휴 미확인 — 확인 후 true
    url: (q) => `https://www.kurly.com/search?sword=${encodeURIComponent(q)}` },
  { key: 'ssg',     label: '이마트몰',   icon: '🏪', affiliate: false,  // 제휴 미확인
    url: (q) => `https://emart.ssg.com/search.ssg?query=${encodeURIComponent(q)}` },
  { key: 'naver',   label: '네이버쇼핑', icon: '🔎', affiliate: true,   // 쇼핑커넥트 확정
    url: (q) => `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(q)}` },
];

/* 네이버 쇼핑 검색 API로 참고 최저가. 키가 있을 때만 동작(없으면 조용히 건너뜀). */
async function naverLowestPrice(query) {
  const id = process.env.NAVER_CLIENT_ID, secret = process.env.NAVER_CLIENT_SECRET;
  if (!id || !secret) return null;
  try {
    const r = await fetch(
      `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(query)}&display=1&sort=asc`,
      { headers: { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': secret },
        signal: AbortSignal.timeout(2500) }
    );
    if (!r.ok) return null;
    const j = await r.json();
    const p = j.items?.[0]?.lprice;
    return p ? Number(p) : null;
  } catch { return null; }
}

app.post('/api/buy-links', auth, async (req, res) => {
  const items = (Array.isArray(req.body.items) ? req.body.items : [])
    .map((s) => String(s).trim()).filter(Boolean).slice(0, 10);

  const links = {};
  for (const ing of items) {
    links[ing] = Object.fromEntries(MARKETS.map((m) => [m.key, m.url(ing)]));
  }

  // 네이버 참고가는 키가 있을 때만 (없으면 빈 객체)
  const priceHint = {};
  const priced = await Promise.all(items.map(async (ing) => [ing, await naverLowestPrice(ing)]));
  for (const [ing, p] of priced) if (p) priceHint[ing] = p;

  res.json({
    markets: MARKETS.map(({ key, label, icon, affiliate }) => ({ key, label, icon, affiliate })),
    links, priceHint,
  });
});

/* ───────────────── 정적 서빙 ─────────────────
   ⚠️ express.static으로 프로젝트 폴더를 통째로 열면
   GET /.env 로 DB 비밀번호와 JWT 시크릿이 그대로 유출된다.
   그래서 파일을 하나씩 허용 목록으로만 내보낸다. */
// index.html을 시작 시 한 번 읽어 메모리에서 서빙.
// (Vercel 번들러가 런타임 sendFile 경로를 추적 못 해 파일을 안 넣는 문제 회피 +
//  매 요청 디스크 stat 제거. 배포는 불변이라 시작 시 1회 읽으면 충분.)
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

app.get(['/', '/index.html'], (req, res) => res.type('html').send(INDEX_HTML));

app.get('/api/health', async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

// 그 외 전부 404. /.env, /db.js, /schema.sql, /.git/* 모두 여기로 떨어진다.
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: '서버에서 문제가 생겼습니다.' });
});

app.listen(PORT, () => {
  console.log(`남김없이 → http://localhost:${PORT}`);
  console.log('⚠️ Live Server 말고 이 주소로 접속하세요. 아니면 /api/* 가 전부 404입니다.');
});
