// 남김없이 — API 서버
//
// 이 파일이 보안 경계다.
// Direct/pooler 연결은 postgres 역할로 붙어 RLS를 통과한다. DB가 지켜주지 않는다.
// 그래서 모든 재고 쿼리는 예외 없이 WHERE user_id = $1 을 포함해야 한다.

require('dotenv').config();
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('.env에 JWT_SECRET이 없습니다. `node scripts/gen-secret.js` 먼저 실행하세요.');
  process.exit(1);
}

app.use(express.json({ limit: '1mb' }));

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
  const status = req.query.status; // pending | confirmed | (없으면 열려있는 전부)
  const params = [req.userId];
  let where = 'user_id = $1 AND outcome IS NULL';
  if (status === 'pending' || status === 'confirmed') {
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

/* ───────────────── 레시피 · 구매 링크 ─────────────────
   Phase 3에서 진짜 매칭으로 바꾼다. 지금은 보유 재고에 대고 고정 목록을 맞춘다. */
const RECIPES = [
  { id: 'r1', title: '두부 대파 된장찌개', mins: 15, tag: '어른', emoji: '🍲',
    uses: [{ ing: '두부', amt: 300, unit: 'g' }, { ing: '대파', amt: 100, unit: 'g' }], extra: [] },
  { id: 'r2', title: '대파 돼지고기 볶음', mins: 20, tag: '아이', emoji: '🥘',
    uses: [{ ing: '대파', amt: 100, unit: 'g' }, { ing: '돼지고기', amt: 300, unit: 'g' }], extra: ['간장'] },
  { id: 'r3', title: '시금치 달걀말이', mins: 12, tag: '아이', emoji: '🥚',
    uses: [{ ing: '시금치', amt: 100, unit: 'g' }, { ing: '달걀', amt: 3, unit: '개' }], extra: [] },
  { id: 'r4', title: '우유 감자 스프', mins: 25, tag: '건강', emoji: '🥣',
    uses: [{ ing: '우유', amt: 400, unit: 'ml' }, { ing: '감자', amt: 200, unit: 'g' }], extra: ['양송이'] },
  { id: 'r5', title: '양파 소고기 덮밥', mins: 18, tag: '어른', emoji: '🍛',
    uses: [{ ing: '양파', amt: 1, unit: '개' }, { ing: '소고기', amt: 200, unit: 'g' }], extra: ['밥'] },
];

app.post('/api/recipes/suggest', auth, async (req, res) => {
  const tag = req.body.tag && req.body.tag !== '전체' ? req.body.tag : null;
  const r = await pool.query(
    `SELECT ingredient, SUM(remaining)::float8 AS have,
            MIN(expiry_date - ${TODAY_KST})::int AS days_left
       FROM fridge_items
      WHERE user_id = $1 AND outcome IS NULL AND status = 'confirmed'
      GROUP BY 1`,
    [req.userId]
  );
  const stock = Object.fromEntries(r.rows.map((x) => [x.ingredient, x]));

  const out = RECIPES
    .filter((rc) => !tag || rc.tag === tag)
    .map((rc) => {
      const missing = [
        ...rc.uses.filter((u) => !stock[u.ing] || stock[u.ing].have < u.amt).map((u) => u.ing),
        ...rc.extra,
      ];
      const owned = rc.uses.filter((u) => stock[u.ing]);
      const soonest = owned.length ? Math.min(...owned.map((u) => stock[u.ing].days_left)) : 99;
      return { ...rc, missing, soonest, uses: rc.uses.map((u) => ({ ...u, have: stock[u.ing]?.have ?? 0, days_left: stock[u.ing]?.days_left ?? null })) };
    })
    .sort((a, b) => a.soonest - b.soonest); // 급한 재료를 쓰는 것부터

  res.json({ recipes: out });
});

/* v1은 쿠팡 검색 URL. 파트너스 승인 후 이 함수 안만 딥링크로 바꾸면 된다. */
function buyLink(name) {
  return `https://www.coupang.com/np/search?q=${encodeURIComponent(name)}`;
}
app.post('/api/coupang/link', auth, (req, res) => {
  const names = Array.isArray(req.body.items) ? req.body.items : [];
  res.json({ links: names.map((n) => ({ name: n, url: buyLink(n) })) });
});

/* ───────────────── 정적 서빙 ─────────────────
   ⚠️ express.static으로 프로젝트 폴더를 통째로 열면
   GET /.env 로 DB 비밀번호와 JWT 시크릿이 그대로 유출된다.
   그래서 파일을 하나씩 허용 목록으로만 내보낸다. */
const ALLOWED_FILES = { '/': 'index.html', '/index.html': 'index.html' };

app.get(['/', '/index.html'], (req, res) => {
  res.sendFile(path.join(__dirname, ALLOWED_FILES[req.path] || 'index.html'));
});

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
