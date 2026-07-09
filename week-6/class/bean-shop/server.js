// ─────────────────────────────────────────────────────────────
// Bean Shop — Email/Password Auth API (JWT)
// 3-file architecture: server.js (this) + index.html + client.js
// DB: Supabase Postgres via pgBouncer transaction pooler (port 6543)
//   - unnamed parameterized queries only (no `name:` on queries)
//   - DDL runs as plain SQL string literals (no params)
//   - ssl.rejectUnauthorized=false, connection string .trim()'d
// Runs both locally (`node server.js`) and on Vercel (serverless export).
// ─────────────────────────────────────────────────────────────

require('dotenv').config();

const path = require('path');
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// ── Config ───────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET =
  (process.env.JWT_SECRET || '').trim() || 'bean-shop-dev-fallback-secret-change-me';
const JWT_EXPIRES_IN = '7d';
const SALT_ROUNDS = 10;
const TABLE = 'bean_shop_users'; // prefixed to avoid collisions on shared Supabase
const ORDERS_TABLE = 'bean_shop_orders';
const ITEMS_TABLE = 'bean_shop_order_items';

// ── TossPayments 결제위젯 키 ─────────────────────────────────
// CLIENT KEY: 프론트에 내려줘도 되는 공개 키(gck). SECRET KEY: 서버 전용(gsk) — 절대 노출 금지.
const TOSS_CLIENT_KEY = (process.env.TOSS_CLIENT_KEY || '').trim();
const TOSS_SECRET_KEY = (process.env.TOSS_SECRET_KEY || '').trim();
const TOSS_CONFIRM_URL = 'https://api.tosspayments.com/v1/payments/confirm';

// ── ImageKit (프로필 이미지 업로드) ──────────────────────────
// PUBLIC KEY·URL ENDPOINT: 프론트에 내려줘도 되는 공개 값. PRIVATE KEY: 서버 전용 — 절대 노출 금지.
const IMAGEKIT_PUBLIC_KEY = (process.env.IMAGEKIT_PUBLIC_KEY || '').trim();
const IMAGEKIT_PRIVATE_KEY = (process.env.IMAGEKIT_PRIVATE_KEY || '').trim();
const IMAGEKIT_URL_ENDPOINT = (process.env.IMAGEKIT_URL_ENDPOINT || '').trim().replace(/\/+$/, '');

// ── DB Pool ──────────────────────────────────────────────────
// Pool connects lazily on first query — safe for serverless cold starts.
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
});

// ── Lazy DB init (create table once per process) ─────────────
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  // Pure SQL literal — no params (pgBouncer transaction pooler rejects DDL params).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${ORDERS_TABLE} (
      id               SERIAL PRIMARY KEY,
      order_no         TEXT UNIQUE NOT NULL,
      user_id          INTEGER,
      customer_name    TEXT,
      customer_phone   TEXT,
      customer_email   TEXT,
      customer_address TEXT,
      zipcode          TEXT,
      memo             TEXT,
      subtotal         INTEGER NOT NULL,
      shipping_fee     INTEGER NOT NULL,
      total            INTEGER NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${ITEMS_TABLE} (
      id           SERIAL PRIMARY KEY,
      order_id     INTEGER NOT NULL REFERENCES ${ORDERS_TABLE}(id) ON DELETE CASCADE,
      product_id   TEXT NOT NULL,
      product_name TEXT NOT NULL,
      grind        TEXT NOT NULL,
      weight       TEXT NOT NULL,
      unit_price   INTEGER NOT NULL,
      qty          INTEGER NOT NULL,
      line_total   INTEGER NOT NULL
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_bean_shop_orders_user_id ON ${ORDERS_TABLE}(user_id)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_bean_shop_order_items_order_id ON ${ITEMS_TABLE}(order_id)`
  );
  // Payment columns — added via ALTER (CREATE TABLE IF NOT EXISTS above is a no-op
  // on the shared Supabase where the table already exists, so it would skip new columns).
  await pool.query(`ALTER TABLE ${ORDERS_TABLE} ADD COLUMN IF NOT EXISTS payment_key    TEXT`);
  await pool.query(`ALTER TABLE ${ORDERS_TABLE} ADD COLUMN IF NOT EXISTS payment_method TEXT`);
  await pool.query(`ALTER TABLE ${ORDERS_TABLE} ADD COLUMN IF NOT EXISTS paid_at        TIMESTAMPTZ`);
  // 프로필 이미지 컬럼(users) — 공유 Supabase 에선 CREATE TABLE IF NOT EXISTS 가 no-op 이라 ALTER 로 추가.
  await pool.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS profile_image TEXT`);
  dbInitialized = true;
}

// ── Middleware ───────────────────────────────────────────────
app.use(express.json());

// ── Static serving (HARDENED) ────────────────────────────────
// NEVER serve the project root: express.static(__dirname) would expose
// GET /.env (DB password, JWT & Toss secret keys), /server.js, /package.json,
// /node_modules/*, etc. Instead serve ONLY index.html and the images/ folder.
const INDEX_HTML = path.join(__dirname, 'index.html');
const sendIndex = (_req, res) => res.sendFile(INDEX_HTML);

// Product images (safe sub-directory only; dotfiles blocked).
app.use(
  '/images',
  express.static(path.join(__dirname, 'images'), { index: false, dotfiles: 'deny' })
);

// DB-free health check (defined BEFORE the /api DB gate so it works even if DB is down).
app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    data: {
      status: 'ok',
      tossConfigured: Boolean(TOSS_CLIENT_KEY && TOSS_SECRET_KEY),
      imagekitConfigured: Boolean(IMAGEKIT_PUBLIC_KEY && IMAGEKIT_PRIVATE_KEY && IMAGEKIT_URL_ENDPOINT),
    },
  });
});

// SPA shell — root + the TossPayments redirect landing paths (hash router can't
// receive the ?paymentKey=&orderId=&amount= query, so these are REAL paths that
// serve index.html; the client reads the query and calls /api/payments/confirm).
app.get('/', sendIndex);
app.get('/payment/success', sendIndex);
app.get('/payment/fail', sendIndex);

// Gate every /api route behind a successful DB init (cold-start safe).
app.use('/api', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('DB init failed:', err);
    res.status(500).json({ success: false, message: 'Database initialization failed' });
  }
});

// Bearer-token auth guard → attaches req.user = { sub, email }
function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ success: false, message: '인증이 필요합니다.' });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (_err) {
    return res.status(401).json({ success: false, message: '유효하지 않거나 만료된 토큰입니다.' });
  }
}

// ── Helpers ──────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isValidEmail = (email) =>
  typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);

const signToken = (user) =>
  jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

// Static hash to equalize response timing when an email is not found,
// so login can't be used to enumerate registered accounts via timing.
const DUMMY_HASH = bcrypt.hashSync('unused-timing-equalizer-password', SALT_ROUNDS);

// ─────────────────────────────────────────────────────────────
// Shop catalog & pricing — copied VERBATIM from index.html so the
// server is the source of truth for prices. Client math MUST match.
// (index.html lines 108-118, 132-205, 213-214, 972-975)
// ─────────────────────────────────────────────────────────────
const WEIGHTS = ['200g', '500g', '1kg'];
const WEIGHT_MULT = { '200g': 1, '500g': 2.3, '1kg': 4.2 };

const GRINDS = [
  { id: '홀빈', label: '홀빈', hint: '분쇄하지 않은 원두 그대로' },
  { id: '드립', label: '드립', hint: 'V60·칼리타 등 핸드드립용' },
  { id: '에스프레소', label: '에스프레소', hint: '에스프레소 머신용 고운 분쇄' },
];

const ORIGINS = ['에티오피아', '콜롬비아', '케냐', '과테말라', '브라질', '인도네시아', '코스타리카', '파나마'];
const ROASTS = ['라이트', '미디엄', '다크'];

const BEANS = [
  {
    id: 'ethiopia-yirgacheffe', name: '에티오피아 예가체프 코체레', nameEn: 'Ethiopia Yirgacheffe Kochere',
    origin: '에티오피아', region: '예가체프, 게데오존', farm: '코체레 워싱 스테이션',
    process: '워시드', altitude: '1,900–2,100m', roast: '라이트', roastLabel: '라이트',
    notes: ['자스민', '베르가못', '레몬', '홍차'], acidity: 5, body: 2, sweetness: 3,
    price: 22000, featured: true, tag: '이번 주 추천',
    desc: '화사한 꽃향과 산뜻한 시트러스가 어우러진 클래식 예가체프. 홍차처럼 깔끔하게 떨어지는 여운이 매력입니다.',
  },
  {
    id: 'colombia-huila', name: '콜롬비아 우일라 수프리모', nameEn: 'Colombia Huila Supremo',
    origin: '콜롬비아', region: '우일라, 피탈리토', farm: '엘 파라이소 농장',
    process: '워시드', altitude: '1,700–1,900m', roast: '미디엄', roastLabel: '미디엄',
    notes: ['카라멜', '밀크초콜릿', '오렌지', '아몬드'], acidity: 3, body: 3, sweetness: 4,
    price: 19000, featured: true, tag: '베스트셀러',
    desc: '균형 잡힌 바디와 부드러운 단맛. 데일리로 즐기기 좋은, 누구에게나 잘 맞는 안정적인 한 잔입니다.',
  },
  {
    id: 'kenya-nyeri-aa', name: '케냐 니에리 AA', nameEn: 'Kenya Nyeri AA',
    origin: '케냐', region: '니에리, 무랑가', farm: '카리아이니 팩토리',
    process: '워시드 (더블 발효)', altitude: '1,750–1,900m', roast: '미디엄', roastLabel: '미디엄 라이트',
    notes: ['블랙커런트', '자몽', '토마토', '레드와인'], acidity: 5, body: 3, sweetness: 3,
    price: 24000, featured: false, tag: null,
    desc: '강렬한 산미와 쥬시한 베리, 와인 같은 복합미. 케냐 특유의 화려하고 선명한 캐릭터를 담았습니다.',
  },
  {
    id: 'guatemala-antigua', name: '과테말라 안티구아', nameEn: 'Guatemala Antigua',
    origin: '과테말라', region: '안티구아', farm: '산타 카타리나 농장',
    process: '워시드', altitude: '1,500–1,700m', roast: '다크', roastLabel: '미디엄 다크',
    notes: ['다크초콜릿', '캐러멜', '오렌지필', '스모키'], acidity: 2, body: 4, sweetness: 3,
    price: 20000, featured: false, tag: null,
    desc: '묵직한 바디와 은은한 스모키함. 다크 초콜릿의 진한 단맛이 길게 이어지는 클래식한 커피입니다.',
  },
  {
    id: 'brazil-cerrado', name: '브라질 세라도 내추럴', nameEn: 'Brazil Cerrado Natural',
    origin: '브라질', region: '세라도, 미나스제라이스', farm: '파젠다 산타 이네스',
    process: '내추럴', altitude: '1,100–1,300m', roast: '다크', roastLabel: '다크',
    notes: ['헤이즐넛', '다크초콜릿', '브라운슈가', '땅콩'], acidity: 1, body: 4, sweetness: 4,
    price: 16000, featured: false, tag: '데일리',
    desc: '고소한 견과류와 진한 초콜릿의 무게감. 에스프레소·밀크 베이스 음료에 특히 잘 어울리는 베이스 원두입니다.',
  },
  {
    id: 'sumatra-mandheling', name: '인도네시아 만델링', nameEn: 'Sumatra Mandheling',
    origin: '인도네시아', region: '수마트라, 링통', farm: '링통 소농 조합',
    process: '웻헐 (길링 바사)', altitude: '1,200–1,500m', roast: '다크', roastLabel: '다크',
    notes: ['흙내음', '허브', '다크초콜릿', '시더우드'], acidity: 1, body: 5, sweetness: 2,
    price: 18000, featured: false, tag: null,
    desc: '깊은 바디와 흙내음, 허브의 무게감. 진하고 묵직한 커피를 좋아하는 분께 자신 있게 권합니다.',
  },
  {
    id: 'ethiopia-guji', name: '에티오피아 구지 우라가 내추럴', nameEn: 'Ethiopia Guji Uraga Natural',
    origin: '에티오피아', region: '구지, 우라가', farm: '우라가 스테이션',
    process: '내추럴', altitude: '1,950–2,150m', roast: '라이트', roastLabel: '라이트',
    notes: ['블루베리', '딸기', '레드와인', '다크초콜릿'], acidity: 4, body: 3, sweetness: 5,
    price: 25000, featured: false, tag: '신상',
    desc: '잘 익은 베리가 폭발하는 내추럴 특유의 단맛. 와인 같은 여운이 인상적인, 화사하고 달콤한 커피입니다.',
  },
  {
    id: 'costa-rica-tarrazu', name: '코스타리카 따라주 허니', nameEn: 'Costa Rica Tarrazú Honey',
    origin: '코스타리카', region: '따라주, 산호세', farm: '라 미니타 농장',
    process: '허니 (옐로우)', altitude: '1,600–1,800m', roast: '미디엄', roastLabel: '미디엄',
    notes: ['꿀', '살구', '브라운슈가', '아몬드'], acidity: 3, body: 3, sweetness: 5,
    price: 23000, featured: true, tag: '한정',
    desc: '허니 프로세스 특유의 매끄러운 단맛과 살구 같은 과일향. 부드럽고 우아하게 마무리되는 한 잔입니다.',
  },
  {
    id: 'panama-geisha', name: '파나마 게이샤', nameEn: 'Panama Geisha',
    origin: '파나마', region: '보케테, 치리키', farm: '하시엔다 라 에스메랄다',
    process: '워시드', altitude: '1,600–1,800m', roast: '라이트', roastLabel: '라이트',
    notes: ['자스민', '복숭아', '베르가못', '열대과일'], acidity: 4, body: 2, sweetness: 4,
    price: 45000, featured: false, tag: '프리미엄',
    desc: '전 세계가 사랑하는 게이샤. 압도적인 꽃향과 복숭아, 열대과일의 화려한 향미를 온전히 만나보세요.',
  },
];

const BEAN_MAP = Object.fromEntries(BEANS.map((b) => [b.id, b]));
const GRIND_IDS = GRINDS.map((g) => g.id);

// Pricing / shipping rules — identical to index.html.
const round500 = (n) => Math.round(n / 500) * 500;
const priceFor = (bean, weight) => round500(bean.price * WEIGHT_MULT[weight]);
const FREE_SHIPPING_THRESHOLD = 30000;
const SHIPPING_FEE = 3000;
const shippingFor = (subtotal) =>
  subtotal === 0 || subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE;

// Attach per-weight computed prices to a bean for API responses.
const pricesFor = (bean) =>
  WEIGHTS.reduce((acc, w) => ((acc[w] = priceFor(bean, w)), acc), {});
const serializeBean = (bean) => ({ ...bean, prices: pricesFor(bean) });

// Order number: BS-YYYYMMDD-XXXX (KST date; Date/Math.random are fine in a real server).
function genOrderNo() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const p = (t) => parts.find((x) => x.type === t).value;
  const rand = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  return `BS-${p('year')}${p('month')}${p('day')}-${rand}`;
}

// Optional Bearer auth: valid token → req.user; no header → guest (req.user = null);
// header present but invalid → 401 (don't silently downgrade a member to guest).
function authOptional(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header) {
    req.user = null;
    return next();
  }
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    req.user = null;
    return next();
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (_err) {
    return res.status(401).json({ success: false, message: '유효하지 않거나 만료된 토큰입니다.' });
  }
}

// Shape an order (+ its items) for API responses. Never leaks internals.
function serializeOrder(order, items) {
  return {
    id: order.id,
    order_no: order.order_no,
    user_id: order.user_id,
    customer: {
      name: order.customer_name,
      phone: order.customer_phone,
      email: order.customer_email,
      address: order.customer_address,
      zipcode: order.zipcode,
      memo: order.memo,
    },
    items: (items || []).map((it) => ({
      product_id: it.product_id,
      product_name: it.product_name,
      grind: it.grind,
      weight: it.weight,
      unit_price: it.unit_price,
      qty: it.qty,
      line_total: it.line_total,
    })),
    subtotal: order.subtotal,
    shipping_fee: order.shipping_fee,
    total: order.total,
    status: order.status,
    payment_method: order.payment_method || null,
    paid_at: order.paid_at || null,
    created_at: order.created_at,
  };
}

// ── Routes ───────────────────────────────────────────────────

// POST /api/auth/signup  { email, password } → 201 { user, token }
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: '유효한 이메일 형식이 아닙니다.' });
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 100) {
      return res
        .status(400)
        .json({ success: false, message: '비밀번호는 8자 이상 100자 이하여야 합니다.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    let result;
    try {
      result = await pool.query(
        `INSERT INTO ${TABLE} (email, password_hash)
         VALUES ($1, $2)
         RETURNING id, email, created_at, profile_image`,
        [normalizedEmail, passwordHash]
      );
    } catch (err) {
      if (err.code === '23505') {
        // unique_violation on email
        return res.status(409).json({ success: false, message: '이미 가입된 이메일입니다.' });
      }
      throw err;
    }

    const user = result.rows[0];
    const token = signToken(user);
    return res.status(201).json({ success: true, data: { user, token } });
  } catch (err) {
    console.error('signup error:', err);
    return res.status(500).json({ success: false, message: '회원가입 처리 중 오류가 발생했습니다.' });
  }
});

// POST /api/auth/login  { email, password } → 200 { user, token }
// Missing email and wrong password return the SAME 401 (no account-existence leak).
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (typeof email !== 'string' || typeof password !== 'string') {
      return res
        .status(400)
        .json({ success: false, message: '이메일과 비밀번호를 모두 입력해주세요.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const result = await pool.query(
      `SELECT id, email, password_hash, created_at, profile_image FROM ${TABLE} WHERE email = $1`,
      [normalizedEmail]
    );
    const row = result.rows[0];

    let ok;
    if (row) {
      ok = await bcrypt.compare(password, row.password_hash);
    } else {
      await bcrypt.compare(password, DUMMY_HASH); // burn equivalent time
      ok = false;
    }

    if (!ok) {
      return res
        .status(401)
        .json({ success: false, message: '이메일 또는 비밀번호가 올바르지 않습니다.' });
    }

    const user = { id: row.id, email: row.email, created_at: row.created_at, profile_image: row.profile_image };
    const token = signToken(user);
    return res.json({ success: true, data: { user, token } });
  } catch (err) {
    console.error('login error:', err);
    return res.status(500).json({ success: false, message: '로그인 처리 중 오류가 발생했습니다.' });
  }
});

// GET /api/auth/me  (Authorization: Bearer <token>) → 200 { user }
app.get('/api/auth/me', authRequired, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, created_at, profile_image FROM ${TABLE} WHERE id = $1`,
      [req.user.sub]
    );
    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ success: false, message: '사용자를 찾을 수 없습니다.' });
    }
    return res.json({ success: true, data: { user } });
  } catch (err) {
    console.error('me error:', err);
    return res
      .status(500)
      .json({ success: false, message: '사용자 정보 조회 중 오류가 발생했습니다.' });
  }
});

// ── Product routes (read-only, served from in-code catalog) ──

// GET /api/products?origin=a,b&roast=x,y&sort=추천|낮은가격|높은가격
// Mirrors ShopPage filter/sort exactly; each product includes computed `prices`.
app.get('/api/products', (req, res) => {
  try {
    const parseMulti = (v) =>
      typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const selOrigins = parseMulti(req.query.origin);
    const selRoasts = parseMulti(req.query.roast);
    const sort = typeof req.query.sort === 'string' ? req.query.sort : '추천';

    let list = BEANS.filter(
      (b) =>
        (selOrigins.length === 0 || selOrigins.includes(b.origin)) &&
        (selRoasts.length === 0 || selRoasts.includes(b.roast))
    );
    if (sort === '낮은가격') list = [...list].sort((a, b) => a.price - b.price);
    else if (sort === '높은가격') list = [...list].sort((a, b) => b.price - a.price);

    return res.json({ success: true, data: { products: list.map(serializeBean) } });
  } catch (err) {
    console.error('products error:', err);
    return res.status(500).json({ success: false, message: '상품 목록 조회 중 오류가 발생했습니다.' });
  }
});

// GET /api/products/:id  → single bean by slug (404 if unknown)
app.get('/api/products/:id', (req, res) => {
  const bean = BEAN_MAP[req.params.id];
  if (!bean) {
    return res.status(404).json({ success: false, message: '상품을 찾을 수 없습니다.' });
  }
  return res.json({ success: true, data: { product: serializeBean(bean) } });
});

// GET /api/meta  → constants so the client can reproduce pricing/shipping locally
app.get('/api/meta', (_req, res) => {
  return res.json({
    success: true,
    data: {
      weights: WEIGHTS,
      weightMultipliers: WEIGHT_MULT,
      grinds: GRINDS,
      origins: ORIGINS,
      roasts: ROASTS,
      freeShippingThreshold: FREE_SHIPPING_THRESHOLD,
      shippingFee: SHIPPING_FEE,
    },
  });
});

// ── Order routes ─────────────────────────────────────────────

// POST /api/orders  { items:[{beanId,grind,weight,qty}], customer:{...} }
// Guest checkout by default; a valid Bearer token links the order to that user.
// ALL amounts are recomputed server-side — client-sent prices are never trusted.
app.post('/api/orders', authOptional, async (req, res) => {
  try {
    const body = req.body || {};
    const rawItems = Array.isArray(body.items) ? body.items : null;
    const customer = body.customer && typeof body.customer === 'object' ? body.customer : {};

    if (!rawItems || rawItems.length === 0) {
      return res.status(400).json({ success: false, message: '주문 상품(items)이 비어 있습니다.' });
    }

    // Validate each line and rebuild it from the server catalog (price snapshot).
    const computed = [];
    for (let idx = 0; idx < rawItems.length; idx++) {
      const it = rawItems[idx] || {};
      const bean = BEAN_MAP[it.beanId];
      if (!bean) {
        return res
          .status(400)
          .json({ success: false, message: `유효하지 않은 상품입니다 (items[${idx}].beanId).` });
      }
      if (!GRIND_IDS.includes(it.grind)) {
        return res
          .status(400)
          .json({ success: false, message: `유효하지 않은 분쇄 옵션입니다 (items[${idx}].grind).` });
      }
      if (!WEIGHTS.includes(it.weight)) {
        return res
          .status(400)
          .json({ success: false, message: `유효하지 않은 중량 옵션입니다 (items[${idx}].weight).` });
      }
      const qty = Number(it.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 999) {
        return res
          .status(400)
          .json({ success: false, message: `수량은 1 이상 999 이하의 정수여야 합니다 (items[${idx}].qty).` });
      }
      const unitPrice = priceFor(bean, it.weight);
      computed.push({
        product_id: bean.id,
        product_name: bean.name,
        grind: it.grind,
        weight: it.weight,
        unit_price: unitPrice,
        qty,
        line_total: unitPrice * qty,
      });
    }

    const subtotal = computed.reduce((s, l) => s + l.line_total, 0);
    const shipping_fee = shippingFor(subtotal);
    const total = subtotal + shipping_fee;

    // Recipient / contact info (member email falls back to the account email).
    const userId = req.user ? req.user.sub : null;
    const name = typeof customer.name === 'string' ? customer.name.trim() : '';
    const phone = typeof customer.phone === 'string' ? customer.phone.trim() : '';
    const address = typeof customer.address === 'string' ? customer.address.trim() : '';
    let email = typeof customer.email === 'string' ? customer.email.trim().toLowerCase() : '';
    const zipcode = typeof customer.zipcode === 'string' ? customer.zipcode.trim() : null;
    const memo = typeof customer.memo === 'string' ? customer.memo.trim() : null;

    if (!name || !phone || !address) {
      return res
        .status(400)
        .json({ success: false, message: '수령인 정보(name, phone, address)가 필요합니다.' });
    }
    if (!email && req.user) email = (req.user.email || '').trim().toLowerCase();
    if (!email) {
      return res
        .status(400)
        .json({ success: false, message: '연락받을 이메일(customer.email)이 필요합니다.' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: '유효한 이메일 형식이 아닙니다.' });
    }

    // orders(1) + order_items(N) in ONE transaction (pgBouncer-compatible).
    const client = await pool.connect();
    try {
      let orderRow;
      for (let attempt = 0; attempt < 5; attempt++) {
        const orderNo = genOrderNo();
        try {
          await client.query('BEGIN');
          const r = await client.query(
            `INSERT INTO ${ORDERS_TABLE}
               (order_no, user_id, customer_name, customer_phone, customer_email,
                customer_address, zipcode, memo, subtotal, shipping_fee, total, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending')
             RETURNING *`,
            [orderNo, userId, name, phone, email, address, zipcode, memo, subtotal, shipping_fee, total]
          );
          orderRow = r.rows[0];
          for (const it of computed) {
            await client.query(
              `INSERT INTO ${ITEMS_TABLE}
                 (order_id, product_id, product_name, grind, weight, unit_price, qty, line_total)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [orderRow.id, it.product_id, it.product_name, it.grind, it.weight, it.unit_price, it.qty, it.line_total]
            );
          }
          await client.query('COMMIT');
          break;
        } catch (err) {
          await client.query('ROLLBACK');
          if (err.code === '23505' && attempt < 4) continue; // order_no collision → retry
          throw err;
        }
      }
      return res.status(201).json({ success: true, data: { order: serializeOrder(orderRow, computed) } });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('create order error:', err);
    return res.status(500).json({ success: false, message: '주문 처리 중 오류가 발생했습니다.' });
  }
});

// GET /api/orders  → the logged-in user's orders (newest first), items included
app.get('/api/orders', authRequired, async (req, res) => {
  try {
    const ordersResult = await pool.query(
      `SELECT * FROM ${ORDERS_TABLE} WHERE user_id = $1 ORDER BY created_at DESC, id DESC`,
      [req.user.sub]
    );
    const orders = ordersResult.rows;

    const itemsByOrder = {};
    if (orders.length > 0) {
      const ids = orders.map((o) => o.id);
      const itemsResult = await pool.query(
        `SELECT * FROM ${ITEMS_TABLE} WHERE order_id = ANY($1::int[]) ORDER BY id ASC`,
        [ids]
      );
      for (const it of itemsResult.rows) {
        (itemsByOrder[it.order_id] = itemsByOrder[it.order_id] || []).push(it);
      }
    }

    const data = orders.map((o) => serializeOrder(o, itemsByOrder[o.id] || []));
    return res.json({ success: true, data: { orders: data } });
  } catch (err) {
    console.error('list orders error:', err);
    return res.status(500).json({ success: false, message: '주문 목록 조회 중 오류가 발생했습니다.' });
  }
});

// GET /api/orders/:orderNo  → member sees own; guest must pass matching ?email=
app.get('/api/orders/:orderNo', authOptional, async (req, res) => {
  try {
    const notFound = () =>
      res.status(404).json({ success: false, message: '주문을 찾을 수 없습니다.' });

    const result = await pool.query(
      `SELECT * FROM ${ORDERS_TABLE} WHERE order_no = $1`,
      [req.params.orderNo]
    );
    const order = result.rows[0];
    if (!order) return notFound();

    if (req.user) {
      // Member: only their own orders (404 to avoid leaking existence).
      if (order.user_id !== req.user.sub) return notFound();
    } else {
      // Guest: require ?email= matching the order's contact email.
      const email = (typeof req.query.email === 'string' ? req.query.email : '').trim().toLowerCase();
      if (!email || email !== (order.customer_email || '').toLowerCase()) return notFound();
    }

    const itemsResult = await pool.query(
      `SELECT * FROM ${ITEMS_TABLE} WHERE order_id = $1 ORDER BY id ASC`,
      [order.id]
    );
    return res.json({ success: true, data: { order: serializeOrder(order, itemsResult.rows) } });
  } catch (err) {
    console.error('get order error:', err);
    return res.status(500).json({ success: false, message: '주문 조회 중 오류가 발생했습니다.' });
  }
});

// ── Payment routes (TossPayments 결제위젯) ───────────────────

// GET /api/payments/config → 공개 클라이언트 키만 내려줌 (시크릿 키는 절대 노출 안 함).
app.get('/api/payments/config', (_req, res) => {
  res.json({ success: true, data: { clientKey: TOSS_CLIENT_KEY } });
});

// POST /api/payments/confirm  { paymentKey, orderId, amount }
// 서버 승인: (a) DB 주문 total 과 amount 일치 검증(위변조 방지·최우선),
//            (b) Toss 승인 API 호출(Basic 인증), (c) 성공 시 주문 status='paid' 로 갱신.
// 비회원/회원 모두 허용(주문번호 + 금액 일치가 승인 조건).
app.post('/api/payments/confirm', authOptional, async (req, res) => {
  try {
    const { paymentKey, orderId, amount } = req.body || {};

    if (
      !paymentKey || typeof paymentKey !== 'string' ||
      !orderId || typeof orderId !== 'string' ||
      amount === undefined || amount === null
    ) {
      return res
        .status(400)
        .json({ success: false, message: '결제 정보(paymentKey, orderId, amount)가 누락되었습니다.' });
    }
    const amountNum = Number(amount);
    if (!Number.isInteger(amountNum) || amountNum <= 0) {
      return res.status(400).json({ success: false, message: '유효하지 않은 결제 금액입니다.' });
    }
    if (!TOSS_SECRET_KEY) {
      return res
        .status(500)
        .json({ success: false, message: '서버에 TossPayments 시크릿 키가 설정되지 않았습니다.' });
    }

    // 1) 주문 조회 (Toss orderId = 우리 order_no)
    const found = await pool.query(`SELECT * FROM ${ORDERS_TABLE} WHERE order_no = $1`, [orderId]);
    const order = found.rows[0];
    if (!order) {
      return res.status(404).json({ success: false, message: '주문을 찾을 수 없습니다.' });
    }

    // 2) 🔒 금액 서버 검증 — 클라가 보낸 값이 아니라 DB 주문 total 과 대조 (위변조 방지)
    if (Number(order.total) !== amountNum) {
      return res
        .status(400)
        .json({ success: false, message: '결제 금액이 주문 금액과 일치하지 않습니다.' });
    }

    // 3) 멱등성 — 이미 결제 완료된 주문이면 재승인하지 않고 그대로 반환
    if (order.status === 'paid') {
      const itemsR = await pool.query(
        `SELECT * FROM ${ITEMS_TABLE} WHERE order_id = $1 ORDER BY id ASC`,
        [order.id]
      );
      return res.json({
        success: true,
        data: { order: serializeOrder(order, itemsR.rows), alreadyPaid: true },
      });
    }

    // 4) Toss 승인 API 호출 (Basic 인증 = base64(secretKey + ':'))
    const encodedKey = Buffer.from(TOSS_SECRET_KEY + ':').toString('base64');
    let tossRes;
    let toss;
    try {
      tossRes = await fetch(TOSS_CONFIRM_URL, {
        method: 'POST',
        headers: { Authorization: `Basic ${encodedKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentKey, orderId, amount: amountNum }),
      });
      toss = await tossRes.json();
    } catch (e) {
      console.error('toss confirm fetch error:', e);
      return res
        .status(502)
        .json({ success: false, message: '결제 승인 서버와 통신 중 오류가 발생했습니다.' });
    }

    if (!tossRes.ok) {
      // Toss 실패 응답 { code, message } — 코드/메시지만 전달(민감정보 없음)
      console.warn('toss confirm rejected:', toss && toss.code, toss && toss.message);
      return res.status(400).json({
        success: false,
        code: (toss && toss.code) || 'CONFIRM_FAILED',
        message: (toss && toss.message) || '결제 승인에 실패했습니다.',
      });
    }

    // 5) 승인 성공 → 주문 상태 paid 로 업데이트 (+ 결제수단/승인시각/결제키 저장)
    const method = (toss && toss.method) || null;
    const approvedAt = toss && toss.approvedAt ? new Date(toss.approvedAt) : new Date();
    const upd = await pool.query(
      `UPDATE ${ORDERS_TABLE}
          SET status = 'paid', payment_key = $2, payment_method = $3, paid_at = $4
        WHERE id = $1 AND status = 'pending'
        RETURNING *`,
      [order.id, paymentKey, method, approvedAt]
    );
    const updatedOrder =
      upd.rows[0] || { ...order, status: 'paid', payment_method: method, paid_at: approvedAt };
    const itemsR = await pool.query(
      `SELECT * FROM ${ITEMS_TABLE} WHERE order_id = $1 ORDER BY id ASC`,
      [order.id]
    );
    return res.json({ success: true, data: { order: serializeOrder(updatedOrder, itemsR.rows) } });
  } catch (err) {
    console.error('confirm payment error:', err);
    return res.status(500).json({ success: false, message: '결제 승인 처리 중 오류가 발생했습니다.' });
  }
});

// ── ImageKit routes (프로필 이미지) ──────────────────────────

// GET /api/imagekit/auth → 클라이언트 직접 업로드용 인증 파라미터.
// PRIVATE KEY 로 HMAC-SHA1 서명만 서버에서 발급(키 자체는 절대 노출 안 함).
// PUBLIC KEY·URL ENDPOINT 는 공개값이라 함께 반환(클라 업로드에 필요).
app.get('/api/imagekit/auth', authRequired, (_req, res) => {
  if (!IMAGEKIT_PRIVATE_KEY || !IMAGEKIT_PUBLIC_KEY || !IMAGEKIT_URL_ENDPOINT) {
    return res
      .status(500)
      .json({ success: false, message: '서버에 ImageKit 키가 설정되지 않았습니다.' });
  }
  const token = crypto.randomUUID();
  const expire = Math.floor(Date.now() / 1000) + 40 * 60; // 40분 후 만료(ImageKit 최대 1시간)
  const signature = crypto
    .createHmac('sha1', IMAGEKIT_PRIVATE_KEY)
    .update(token + expire)
    .digest('hex');
  res.json({
    success: true,
    data: { token, expire, signature, publicKey: IMAGEKIT_PUBLIC_KEY, urlEndpoint: IMAGEKIT_URL_ENDPOINT },
  });
});

// PATCH /api/auth/profile-image  { imageUrl } → 업로드 완료된 이미지 URL 을 유저에 저장.
// 🔒 URL 은 반드시 우리 ImageKit 엔드포인트 하위여야 함(임의 URL 저장 방지).
app.patch('/api/auth/profile-image', authRequired, async (req, res) => {
  try {
    const { imageUrl } = req.body || {};
    if (typeof imageUrl !== 'string' || !imageUrl.trim()) {
      return res.status(400).json({ success: false, message: '이미지 URL 이 필요합니다.' });
    }
    const url = imageUrl.trim();
    if (url.length > 500) {
      return res.status(400).json({ success: false, message: '이미지 URL 이 너무 깁니다.' });
    }
    if (!IMAGEKIT_URL_ENDPOINT || !url.startsWith(IMAGEKIT_URL_ENDPOINT + '/')) {
      return res.status(400).json({ success: false, message: '허용되지 않은 이미지 URL 입니다.' });
    }
    const upd = await pool.query(
      `UPDATE ${TABLE} SET profile_image = $2 WHERE id = $1
       RETURNING id, email, created_at, profile_image`,
      [req.user.sub, url]
    );
    const user = upd.rows[0];
    if (!user) {
      return res.status(401).json({ success: false, message: '사용자를 찾을 수 없습니다.' });
    }
    return res.json({ success: true, data: { user } });
  } catch (err) {
    console.error('update profile-image error:', err);
    return res.status(500).json({ success: false, message: '프로필 이미지 저장 중 오류가 발생했습니다.' });
  }
});

// JSON 404 for anything unmatched.
app.use((_req, res) => {
  res.status(404).json({ success: false, message: '요청한 리소스를 찾을 수 없습니다.' });
});

// Final error handler — never leak stack traces.
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, message: '서버 내부 오류가 발생했습니다.' });
});

// ── Startup / export (local + Vercel dual-mode) ──────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Bean Shop server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
