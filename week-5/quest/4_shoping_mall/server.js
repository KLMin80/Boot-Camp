// ============================================================================
// 남성의류 쇼핑몰 앱 — 백엔드 서버 (server.js)
//   - 의존성: pg(DB) + jsonwebtoken(JWT) + bcryptjs(비밀번호 해시).
//     정적 서빙/라우팅은 Node 내장 http 모듈로 직접 처리한다(Express 안 씀).
//   - DB: Supabase Postgres (트랜잭션 풀러 :6543, SSL 필수).
//   - 접속 URL(DB_URL)·JWT_SECRET 은 오직 .env 에서만 읽으며 절대 로그/응답에 노출하지 않음.
//   - 인증: JWT Bearer 토큰. 상품 목록은 공개(인증 불필요), 장바구니는 전부 Bearer 보호.
//     장바구니는 WHERE id=$1 AND user_id=$2 로 본인 항목만 매칭 → 남의 항목은 404(존재 누출 없음).
//   - 결제/주문 엔드포인트는 없음(프론트가 alert 만 띄움).
// ============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ---------------------------------------------------------------------------
// 1) 환경변수 로드 (node v20.6+/v24: process.loadEnvFile)
//    __dirname 기준으로 .env 를 찾으므로 실행 cwd 와 무관하게 동작한다.
//    이 앱은 SUPABASE_DB_URL 과 JWT_SECRET 을 사용한다.
//    ⚠️ .env 의 키 이름은 DB_URL 이 아니라 SUPABASE_DB_URL 이다.
// ---------------------------------------------------------------------------
const ENV_PATH = path.join(__dirname, '.env');
try {
  process.loadEnvFile(ENV_PATH);
} catch (_) {
  // .env 가 이미 환경에 주입돼 있거나(예: 배포 플랫폼) 파일이 없을 수 있음 → 무시
}

const PORT = Number(process.env.PORT) || 4000;
// ⚠️ 키 이름 함정: .env 는 SUPABASE_DB_URL 을 쓴다. (DB_URL 은 폴백으로만 허용)
const DB_URL = (process.env.SUPABASE_DB_URL || process.env.DB_URL || '').trim(); // trailing newline 방지

if (!DB_URL) {
  // URL 값 자체는 출력하지 않고, "없음" 사실만 알림
  console.error('[FATAL] .env 의 SUPABASE_DB_URL 이 설정되지 않았습니다. 서버를 시작할 수 없습니다.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1.5) JWT_SECRET 확보
//    .env 에 JWT_SECRET 이 있으면 그대로 사용(절대 건드리지 않음).
//    없으면 강한 시크릿을 생성해 .env 에 한 줄(JWT_SECRET=...) append 한 뒤 사용한다.
//    → 서버를 재시작해도 같은 시크릿을 읽으므로 발급된 토큰이 유지된다.
//    값 자체는 어떤 로그/응답에도 노출하지 않는다.
// ---------------------------------------------------------------------------
function ensureJwtSecret() {
  const existing = (process.env.JWT_SECRET || '').trim();
  if (existing) return existing;

  const generated = crypto.randomBytes(48).toString('hex');
  try {
    // 파일 끝이 개행으로 안 끝나면 개행을 먼저 붙여 새 키가 같은 줄에 붙지 않게 한다.
    let prefix = '';
    try {
      const cur = fs.readFileSync(ENV_PATH);
      if (cur.length > 0 && cur[cur.length - 1] !== 0x0a) prefix = '\n';
    } catch (_) {
      // .env 가 없으면 새로 만든다(이 앱은 SUPABASE_DB_URL 이 필수라 위에서 이미 걸러짐).
    }
    fs.appendFileSync(ENV_PATH, `${prefix}JWT_SECRET=${generated}\n`);
    console.log('[jwt] JWT_SECRET 이 없어 새로 생성해 .env 에 저장했습니다(값 비노출).');
  } catch (err) {
    // 파일 기록에 실패해도(읽기전용 FS 등) 이번 프로세스 동안은 메모리 값으로 동작시킨다.
    console.warn('[jwt] .env 에 JWT_SECRET 저장 실패 — 이번 실행 동안만 임시 시크릿을 사용합니다.');
  }
  process.env.JWT_SECRET = generated;
  return generated;
}

const JWT_SECRET = ensureJwtSecret();
const JWT_EXPIRES_IN = '7d';

// ---------------------------------------------------------------------------
// 1.6) 테이블 네임스페이스 (공유 Supabase DB 충돌 방지)
//   이 Supabase 프로젝트는 부트캠프 퀘스트들이 공유하는 단일 postgres DB 다.
//   범용 이름(products/users/carts)은 다른 퀘스트와 충돌한다 — CREATE TABLE IF NOT EXISTS
//   는 기존 테이블이 있으면 스킵되므로, 우리가 가정한 컬럼이 없어 'column does not exist'
//   로 깨진다. 이 버그는 로컬(빈 DB)에선 안 보이고 공유-DB E2E 에서만 터진다.
//   → 이 앱 전용 테이블은 shop_ prefix 로 격리한다.
//   ⚠️ 단일 출처: 모든 쿼리는 아래 상수를 템플릿 리터럴로 참조한다(이름 누락 방지).
//   ⚠️ 기존 타 퀘스트 테이블은 절대 건드리지 않는다(DROP/ALTER 금지, 데이터 보존).
// ---------------------------------------------------------------------------
const T_USERS = 'shop_users';
const T_PRODUCTS = 'shop_products';
const T_CART = 'shop_cart_items';

// ---------------------------------------------------------------------------
// 2) PG 풀 — Supabase 풀러는 SSL 필수
// ---------------------------------------------------------------------------
const pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false },
  max: 5, // 서버리스/풀러 환경 배려: 작게 유지
});

pool.on('error', (err) => {
  // 유휴 클라이언트 오류로 프로세스가 죽지 않도록 흡수 (URL 비노출)
  console.error('[pg pool] idle client error:', err.message);
});

// ---------------------------------------------------------------------------
// 2.5) 시드 데이터 — 정확히 10개 (image_url 은 HEAD 200 검증된 URL).
//   price 는 정수(원 단위). INTEGER 컬럼이라 node-pg 가 JS number 로 돌려준다.
// ---------------------------------------------------------------------------
const SEED_PRODUCTS = [
  ['베이직 크루넥 반팔 티셔츠', 19900, 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=600&q=80', '매일 입기 좋은 코마 면 100% 베이직 반팔 티셔츠. 군더더기 없는 데일리 핏.'],
  ['프리미엄 옥스포드 셔츠', 39900, 'https://images.unsplash.com/photo-1602810318383-e386cc2a3ccf?w=600&q=80', '포멀과 캐주얼을 넘나드는 옥스포드 코튼 셔츠. 다양하게 매치하기 좋은 데일리 셔츠.'],
  ['테일러드 캐주얼 블레이저', 89000, 'https://images.unsplash.com/photo-1593030761757-71fae45fa0e7?w=600&q=80', '격식과 멋을 더하는 베이지 캐주얼 블레이저. 셔츠 위에 걸치면 완성되는 룩.'],
  ['슬림핏 워싱 데님 진', 49900, 'https://images.unsplash.com/photo-1542272604-787c3835535d?w=600&q=80', '신축성 좋은 슬림핏 데님 팬츠. 자연스러운 워싱으로 어디에나 잘 어울려요.'],
  ['레더 라이더 자켓', 129000, 'https://images.unsplash.com/photo-1551028719-00167b16eac5?w=600&q=80', '시그니처 블랙 라이더 자켓. 어떤 룩에도 시크한 무드를 더해주는 한 벌.'],
  ['워싱 데님 트러커 자켓', 69000, 'https://images.unsplash.com/photo-1516257984-b1b4d707412e?w=600&q=80', '라이트 워싱 데님 트러커 자켓. 사계절 레이어드 필수 아이템.'],
  ['슬림핏 드레스 셔츠 (스카이블루)', 34900, 'https://images.unsplash.com/photo-1620012253295-c15cc3e65df4?w=600&q=80', '비즈니스 룩을 완성하는 스카이블루 드레스 셔츠. 구김 적은 소재.'],
  ['그래픽 오버핏 반팔 티셔츠', 24900, 'https://images.unsplash.com/photo-1576566588028-4147f3842f27?w=600&q=80', '오트밀 컬러에 포인트 그래픽을 더한 오버핏 티셔츠. 캐주얼 코디에 딱.'],
  ['체크 플란넬 오버셔츠', 44900, 'https://images.unsplash.com/photo-1607345366928-199ea26cfe3e?w=600&q=80', '머스타드 체크 플란넬 오버셔츠. 티셔츠 위에 걸쳐 가을 레이어드룩.'],
  ['베이직 스웨트셔츠 (화이트)', 39900, 'https://images.unsplash.com/photo-1620799140408-edc6dcb6d633?w=600&q=80', '깔끔한 화이트 스웨트셔츠. 사계절 부담 없이 입기 좋은 베이직 맨투맨.'],
];

// ---------------------------------------------------------------------------
// 3) 스키마 (lazy init: 최초 1회만 실행, cold start 대응)
//    상품은 비어 있을 때만 시드(idempotent). 사용자/장바구니는 빈 상태로 시작.
// ---------------------------------------------------------------------------
let dbReady = null; // Promise 캐시 — 동시 요청에도 init 1회만

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${T_USERS} (
        id            BIGSERIAL PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${T_PRODUCTS} (
        id          BIGSERIAL PRIMARY KEY,
        name        TEXT NOT NULL,
        price       INTEGER NOT NULL,
        image_url   TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${T_CART} (
        id          BIGSERIAL PRIMARY KEY,
        user_id     BIGINT NOT NULL REFERENCES ${T_USERS}(id) ON DELETE CASCADE,
        product_id  BIGINT NOT NULL REFERENCES ${T_PRODUCTS}(id) ON DELETE CASCADE,
        quantity    INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, product_id)
      );
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_shop_cart_items_user_id ON ${T_CART}(user_id)`
    );

    // --- 상품 시드 (테이블이 비어 있을 때만) ---
    const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM ${T_PRODUCTS}`);
    if (rows[0].n === 0) {
      // 단일 INSERT 로 10개를 한 번에 — $1..$N 파라미터 바인딩.
      const valuesSql = SEED_PRODUCTS.map(
        (_p, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`
      ).join(', ');
      const params = SEED_PRODUCTS.flat();
      await client.query(
        `INSERT INTO ${T_PRODUCTS} (name, price, image_url, description) VALUES ${valuesSql}`,
        params
      );
      console.log(`[db] 상품 시드 완료 — ${SEED_PRODUCTS.length}개 등록.`);
    }
  } finally {
    client.release();
  }
}

function ensureDB() {
  // 최초 호출 시에만 initDB 실행. 실패하면 캐시를 비워 다음 요청에서 재시도 가능.
  if (!dbReady) {
    dbReady = initDB().catch((err) => {
      dbReady = null;
      throw err;
    });
  }
  return dbReady;
}

// ---------------------------------------------------------------------------
// 4) HTTP 유틸
// ---------------------------------------------------------------------------
function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJSONBody(req, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        reject(new Error('INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// 4.5) 행 → API 객체 매핑 (데이터 계약 함정 방지) — 전부 camelCase
//   ⚠️ createdAt 은 반드시 JS 숫자(epoch milliseconds)로 반환한다.
//      pg 는 TIMESTAMPTZ 를 JS Date 로 주므로 .getTime() 으로 변환. ISO 문자열 금지(클라 깨짐).
//   ⚠️ price/quantity 는 INTEGER 컬럼이라 pg 가 JS number 로 준다(numeric 였다면 문자열).
//   password_hash 는 절대 매핑/노출하지 않는다.
// ---------------------------------------------------------------------------
function mapProduct(row) {
  return {
    id: row.id,
    name: row.name,
    price: row.price, // INTEGER → number
    imageUrl: row.image_url,
    description: row.description,
    createdAt: row.created_at.getTime(), // TIMESTAMPTZ(Date) → epoch ms
  };
}

function publicUser(row) {
  // 응답에 내보낼 수 있는 user 형태 — email 과 id 만. password_hash 절대 포함 금지.
  return { id: row.id, email: row.email };
}

// 장바구니 한 줄(shop_cart_items JOIN shop_products) → camelCase 항목.
//   id 는 cart row id(PATCH/DELETE 에 사용), productId 는 상품 id.
function mapCartItem(row) {
  const price = row.price; // INTEGER
  const quantity = row.quantity; // INTEGER
  return {
    id: row.id, // cart row id (변경/삭제 키)
    productId: row.product_id,
    name: row.name,
    price, // 정수
    imageUrl: row.image_url,
    description: row.description,
    quantity, // 정수
    lineTotal: price * quantity,
  };
}

// 전체 장바구니 객체로 조립 — 모든 변경 요청이 이 형태를 반환한다.
function buildCart(rows) {
  const items = rows.map(mapCartItem);
  const totalQuantity = items.reduce((s, it) => s + it.quantity, 0);
  const totalPrice = items.reduce((s, it) => s + it.lineTotal, 0);
  return { items, totalQuantity, totalPrice };
}

// ---------------------------------------------------------------------------
// 4.6) JWT 발급/검증
// ---------------------------------------------------------------------------
function signToken(user) {
  // payload: sub = user.id(문자열), email. HS256, 7일 만료.
  return jwt.sign({ sub: String(user.id), email: user.email }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: JWT_EXPIRES_IN,
  });
}

// Authorization: Bearer <token> 파싱 + 검증.
//   성공: { id, email } 반환.  실패: null 반환(라우트에서 401 처리).
function authenticate(req) {
  const header = req.headers['authorization'] || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  try {
    const payload = jwt.verify(match[1].trim(), JWT_SECRET, { algorithms: ['HS256'] });
    if (!payload || !payload.sub) return null;
    return { id: payload.sub, email: payload.email };
  } catch (_) {
    // 만료/서명불량/형식오류 등 모두 인증 실패로 처리
    return null;
  }
}

// ---------------------------------------------------------------------------
// 5) 정적 서빙 — allowlist 방식
//    오직 index.html 만 서빙. 그 외 모든 경로(.env, package.json, server.js, dotfile ...)
//    는 404. path.basename 으로 디렉터리 성분을 제거하므로 /../ 트래버설도 무력화된다.
// ---------------------------------------------------------------------------
const STATIC_ALLOWLIST = new Set(['index.html']);

// ⚠️ Vercel(@vercel/nft) 파일 트레이싱 대비: index.html 경로를 "리터럴"로 고정한다.
//    런타임에 변수 경로로만 읽으면 nft 가 정적 분석을 못 해 함수 번들에서 index.html 이
//    빠지고 배포 환경에서 GET / 가 404 가 된다. allowlist 가 index.html 단일이므로
//    통과 시 읽을 파일은 항상 이 경로다.
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');

function serveStatic(pathname, res) {
  // '/' → index.html 로 매핑, 그 외엔 basename 만 추출(트래버설 방지)
  const requested = pathname === '/' ? 'index.html' : path.basename(decodeURIComponent(pathname));

  if (!STATIC_ALLOWLIST.has(requested)) {
    return sendJSON(res, 404, { error: 'Not Found' });
  }

  fs.readFile(INDEX_HTML_PATH, (err, data) => {
    if (err) return sendJSON(res, 404, { error: 'Not Found' });
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// 6) API 핸들러 — 인증
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 6;

// POST /api/auth/signup  { email, password } → 201 { token, user:{ id, email } }
async function signup(req, res) {
  const body = await readJSONBody(req);

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!EMAIL_RE.test(email)) {
    return sendJSON(res, 400, { error: '올바른 이메일 형식이 아닙니다.' });
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
    return sendJSON(res, 400, { error: `비밀번호는 최소 ${MIN_PASSWORD_LEN}자 이상이어야 합니다.` });
  }

  // 중복 이메일 → 409. UNIQUE 제약 위반(23505)도 함께 방어한다.
  const dup = await pool.query(`SELECT 1 FROM ${T_USERS} WHERE email = $1`, [email]);
  if (dup.rows.length > 0) {
    return sendJSON(res, 409, { error: '이미 가입된 이메일입니다.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  let inserted;
  try {
    inserted = await pool.query(
      `INSERT INTO ${T_USERS} (email, password_hash)
       VALUES ($1, $2)
       RETURNING id, email`,
      [email, passwordHash]
    );
  } catch (err) {
    if (err && err.code === '23505') {
      // 동시 가입 레이스로 UNIQUE 충돌 → 409
      return sendJSON(res, 409, { error: '이미 가입된 이메일입니다.' });
    }
    throw err;
  }

  const user = inserted.rows[0];
  const token = signToken(user);
  sendJSON(res, 201, { token, user: publicUser(user) });
}

// POST /api/auth/login  { email, password } → 200 { token, user:{ id, email } }
async function login(req, res) {
  const body = await readJSONBody(req);

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  // 어느 쪽이 틀렸는지 구분 노출 금지 — 통일된 401 메시지.
  const INVALID = '이메일 또는 비밀번호가 올바르지 않습니다.';

  if (!email || !password) {
    return sendJSON(res, 401, { error: INVALID });
  }

  const result = await pool.query(
    `SELECT id, email, password_hash FROM ${T_USERS} WHERE email = $1`,
    [email]
  );
  if (result.rows.length === 0) {
    return sendJSON(res, 401, { error: INVALID });
  }

  const row = result.rows[0];
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) {
    return sendJSON(res, 401, { error: INVALID });
  }

  const token = signToken(row);
  sendJSON(res, 200, { token, user: publicUser(row) });
}

// GET /api/auth/me  (Bearer) → 200 { user:{ id, email } }
//   토큰의 sub 로 DB 에서 실제 사용자를 다시 확인(삭제된 사용자/유령 토큰 방지).
async function me(_req, res, authUser) {
  const result = await pool.query(`SELECT id, email FROM ${T_USERS} WHERE id = $1`, [authUser.id]);
  if (result.rows.length === 0) {
    return sendJSON(res, 401, { error: '유효하지 않은 토큰입니다.' });
  }
  sendJSON(res, 200, { user: publicUser(result.rows[0]) });
}

// ---------------------------------------------------------------------------
// 6.5) API 핸들러 — 상품 (공개, 인증 불필요)
// ---------------------------------------------------------------------------

// GET /api/products → 200 [{ id, name, price, imageUrl, description, createdAt }]  (등록순)
async function listProducts(_req, res) {
  const { rows } = await pool.query(
    `SELECT id, name, price, image_url, description, created_at
       FROM ${T_PRODUCTS}
      ORDER BY id ASC`
  );
  sendJSON(res, 200, rows.map(mapProduct));
}

// ---------------------------------------------------------------------------
// 6.6) API 핸들러 — 장바구니 (전부 Bearer 보호, user_id 로 스코프)
//   모든 변경 요청(POST/PATCH/DELETE)은 "갱신된 전체 장바구니 객체"를 반환한다.
//   소유권은 SQL(WHERE id=$1 AND user_id=$2)로 강제 → 남의 항목은 매칭 자체가 안 돼 404.
// ---------------------------------------------------------------------------

// 현재 사용자의 전체 장바구니를 JOIN 으로 읽어 CART 객체로 조립.
async function fetchCart(userId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.product_id, c.quantity, c.created_at,
            p.name, p.price, p.image_url, p.description
       FROM ${T_CART} c
       JOIN ${T_PRODUCTS} p ON p.id = c.product_id
      WHERE c.user_id = $1
      ORDER BY c.created_at ASC, c.id ASC`,
    [userId]
  );
  return buildCart(rows);
}

// 양의 정수 검증 헬퍼 — 정수이고 1 이상이면 그 값, 아니면 null.
function parsePositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// GET /api/cart → 200 CART
async function getCart(_req, res, authUser) {
  const cart = await fetchCart(authUser.id);
  sendJSON(res, 200, cart);
}

// POST /api/cart  { productId, quantity? } → 201 CART
//   quantity 기본 1, 양의 정수 검증(아니면 400). 상품 없으면 404.
//   이미 담긴 상품이면 수량 누적(ON CONFLICT DO UPDATE).
async function addToCart(req, res, authUser) {
  const body = await readJSONBody(req);

  const productId = parsePositiveInt(body.productId);
  if (productId === null) {
    return sendJSON(res, 400, { error: '유효하지 않은 상품 id 입니다.' });
  }

  // quantity 미지정이면 1. 지정되면 양의 정수여야 한다.
  let quantity = 1;
  if (body.quantity !== undefined && body.quantity !== null) {
    quantity = parsePositiveInt(body.quantity);
    if (quantity === null) {
      return sendJSON(res, 400, { error: '수량(quantity)은 1 이상의 정수여야 합니다.' });
    }
  }

  // 상품 존재 확인 → 없으면 404.
  const prod = await pool.query(`SELECT 1 FROM ${T_PRODUCTS} WHERE id = $1`, [productId]);
  if (prod.rows.length === 0) {
    return sendJSON(res, 404, { error: '해당 상품을 찾을 수 없습니다.' });
  }

  // 이미 담긴 상품이면 수량 누적, 아니면 새로 추가.
  await pool.query(
    `INSERT INTO ${T_CART} (user_id, product_id, quantity)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, product_id)
     DO UPDATE SET quantity = ${T_CART}.quantity + EXCLUDED.quantity`,
    [authUser.id, productId, quantity]
  );

  const cart = await fetchCart(authUser.id);
  sendJSON(res, 201, cart);
}

// PATCH /api/cart/:id  { quantity } → 200 CART
//   quantity 는 정수 ≥1, 아니면 400. WHERE id=$1 AND user_id=$2, 없으면 404.
async function updateCartItem(req, res, authUser, cartItemId) {
  const body = await readJSONBody(req);

  const quantity = parsePositiveInt(body.quantity);
  if (quantity === null) {
    return sendJSON(res, 400, { error: '수량(quantity)은 1 이상의 정수여야 합니다.' });
  }

  // user_id 를 함께 걸어 남의 항목은 매칭 자체가 안 되게 한다(404, 존재 누출 없음).
  const updated = await pool.query(
    `UPDATE ${T_CART} SET quantity = $1
      WHERE id = $2 AND user_id = $3
      RETURNING id`,
    [quantity, cartItemId, authUser.id]
  );
  if (updated.rows.length === 0) {
    return sendJSON(res, 404, { error: '해당 장바구니 항목을 찾을 수 없습니다.' });
  }

  const cart = await fetchCart(authUser.id);
  sendJSON(res, 200, cart);
}

// DELETE /api/cart/:id → 200 CART  (WHERE id=$1 AND user_id=$2, 없으면 404)
async function deleteCartItem(_req, res, authUser, cartItemId) {
  const { rows } = await pool.query(
    `DELETE FROM ${T_CART} WHERE id = $1 AND user_id = $2 RETURNING id`,
    [cartItemId, authUser.id]
  );
  if (rows.length === 0) {
    return sendJSON(res, 404, { error: '해당 장바구니 항목을 찾을 수 없습니다.' });
  }

  const cart = await fetchCart(authUser.id);
  sendJSON(res, 200, cart);
}

// ---------------------------------------------------------------------------
// 7) API 라우터 — /api/* 매칭 후 위 핸들러로 분기
//    라우팅/입력 검증을 먼저 수행해 DB 와 무관한 응답(404/405/400/401)은
//    DB 연결 상태와 관계없이 즉시 반환한다. DB 가 실제로 필요한 핸들러를
//    고른 뒤에만 ensureDB() 로 스키마를 보장한다.
//    (이렇게 하면 DB 가 down 이어도 라우터가 옳다는 걸 404/405/400/401 로 증명 가능)
// ---------------------------------------------------------------------------
function parseId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// 보호 라우트 진입 게이트: 토큰 검증 실패 시 401 응답하고 null 반환.
function requireAuth(req, res) {
  const user = authenticate(req);
  if (!user) {
    sendJSON(res, 401, { error: '인증이 필요합니다. 로그인 후 다시 시도해 주세요.' });
    return null;
  }
  return user;
}

async function handleApi(req, res, pathname) {
  const method = req.method;

  // --- 헬스체크 (인증 불필요, DB 불필요) ---
  if (pathname === '/api/health') {
    if (method !== 'GET') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    return sendJSON(res, 200, { ok: true });
  }

  // --- 상품 목록 (공개, 인증 불필요) ---
  if (pathname === '/api/products') {
    if (method !== 'GET') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    return ensureDB().then(() => listProducts(req, res));
  }

  // --- 인증: /api/auth/signup ---
  if (pathname === '/api/auth/signup') {
    if (method !== 'POST') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    return ensureDB().then(() => signup(req, res));
  }

  // --- 인증: /api/auth/login ---
  if (pathname === '/api/auth/login') {
    if (method !== 'POST') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    return ensureDB().then(() => login(req, res));
  }

  // --- 인증: /api/auth/me (Bearer) ---
  if (pathname === '/api/auth/me') {
    if (method !== 'GET') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    const authUser = requireAuth(req, res);
    if (!authUser) return; // 401 이미 응답됨
    return ensureDB().then(() => me(req, res, authUser));
  }

  // --- 장바구니 컬렉션: /api/cart (Bearer) — GET(조회) / POST(담기) ---
  if (pathname === '/api/cart') {
    const authUser = requireAuth(req, res);
    if (!authUser) return; // 401 이미 응답됨
    if (method === 'GET') return ensureDB().then(() => getCart(req, res, authUser));
    if (method === 'POST') return ensureDB().then(() => addToCart(req, res, authUser));
    return sendJSON(res, 405, { error: 'Method Not Allowed' });
  }

  // --- 장바구니 단건: /api/cart/:id (Bearer) — PATCH(수량) / DELETE(제거) ---
  const m = pathname.match(/^\/api\/cart\/([^/]+)$/);
  if (m) {
    if (method !== 'PATCH' && method !== 'DELETE') {
      return sendJSON(res, 405, { error: 'Method Not Allowed' });
    }
    const authUser = requireAuth(req, res);
    if (!authUser) return; // 401 이미 응답됨
    const id = parseId(m[1]);
    if (id === null) return sendJSON(res, 400, { error: '유효하지 않은 장바구니 항목 id 입니다.' });
    if (method === 'PATCH') return ensureDB().then(() => updateCartItem(req, res, authUser, id));
    return ensureDB().then(() => deleteCartItem(req, res, authUser, id));
  }

  return sendJSON(res, 404, { error: 'API Not Found' });
}

// ---------------------------------------------------------------------------
// 8) 서버 — /api 와 정적 경로를 명확히 분기
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  let pathname = '/';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch (_) {
    return sendJSON(res, 400, { error: 'Bad Request' });
  }

  // --- API 분기 ---
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    try {
      // 라우팅/검증은 즉시, DB 가 필요한 핸들러만 내부에서 ensureDB() 호출
      await handleApi(req, res, pathname);
    } catch (err) {
      if (err.message === 'INVALID_JSON' || err.message === 'PAYLOAD_TOO_LARGE') {
        return sendJSON(res, 400, { error: '요청 본문이 올바르지 않습니다.' });
      }
      // DB/서버 오류 → 500 (내부 메시지/URL 비노출)
      console.error('[API ERROR]', req.method, pathname, '-', err.message);
      if (!res.headersSent) {
        sendJSON(res, 500, { error: '서버 오류가 발생했습니다.' });
      }
    }
    return;
  }

  // --- 정적 분기 (GET/HEAD 만) ---
  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(pathname, res);
  }
  return sendJSON(res, 405, { error: 'Method Not Allowed' });
});

// ---------------------------------------------------------------------------
// 9) 기동: EADDRINUSE 면 다음 포트로 자동 폴백(수강생 포트 충돌 대응).
//    실제로 떠 있는 주소를 콘솔에 출력하고, Live Server 가 아닌 그 주소로 접속하도록 안내한다.
//    기동 직후 DB 연결을 한 번 확인(성공/실패만 알림, URL 비노출).
// ---------------------------------------------------------------------------
const MAX_PORT_TRIES = 20; // PORT 부터 +20 까지 순차 시도

function start(startPort = PORT, triesLeft = MAX_PORT_TRIES) {
  const onError = (err) => {
    if (err && err.code === 'EADDRINUSE' && triesLeft > 0) {
      const next = startPort + 1;
      console.warn(`[server] 포트 ${startPort} 사용 중 — ${next} 로 자동 전환합니다.`);
      server.removeListener('error', onError);
      // 잠깐 대기 없이 바로 다음 포트로 재시도
      start(next, triesLeft - 1);
      return;
    }
    console.error('[server] 기동 실패:', err.message);
    process.exit(1);
  };

  server.once('error', onError);
  server.listen(startPort, () => {
    server.removeListener('error', onError);
    const url = `http://localhost:${startPort}`;
    console.log(`[server] 남성의류 쇼핑몰 백엔드 실행 → ${url}`);
    console.log(`[안내] Live Server 로 열지 말고 위 주소(${url})로 접속하세요.`);
    // 기동 직후 DB 연결 확인 (실패해도 서버는 떠 있고, 요청 시 재시도)
    ensureDB()
      .then(() => console.log('[db] Supabase Postgres 연결 및 스키마 준비 완료'))
      .catch((err) =>
        console.error('[db] 연결 실패 — 첫 API 요청 시 재시도합니다. 원인:', err.message)
      );
  });
}

// 로컬 실행 / 서버리스 export 듀얼 모드
if (require.main === module) {
  start();
}
module.exports = server;
