// ============================================================================
// 남성의류 쇼핑몰 앱 — 백엔드 서버 (server.js)
//   - 의존성: pg(DB) + jsonwebtoken(JWT) + bcryptjs(비밀번호 해시).
//     정적 서빙/라우팅은 Node 내장 http 모듈로 직접 처리한다(Express 안 씀).
//   - DB: Supabase Postgres (트랜잭션 풀러 :6543, SSL 필수).
//   - 접속 URL(DB_URL)·JWT_SECRET 은 오직 .env 에서만 읽으며 절대 로그/응답에 노출하지 않음.
//   - 인증: JWT Bearer 토큰. 상품 목록은 공개(인증 불필요), 장바구니는 전부 Bearer 보호.
//     장바구니는 WHERE id=$1 AND user_id=$2 로 본인 항목만 매칭 → 남의 항목은 404(존재 누출 없음).
//   - 결제: TossPayments v2 결제위젯 prepare→confirm 플로우.
//       · POST /api/payments/prepare  : 서버가 장바구니 합계로 주문(pending)을 확정(orderId/amount 고정).
//       · POST /api/payments/confirm  : successUrl 리다이렉트로 받은 paymentKey/orderId/amount 검증 후
//                                       Toss 승인 API 호출 → 성공 시 주문 paid + 장바구니 비우기.
//     TOSS_SECRET_KEY 는 오직 .env 에서만 읽으며(서버 전용) 절대 로그/응답/커밋 파일에 노출하지 않음.
//     successUrl/failUrl 은 해시가 아닌 실제 경로(/success·/fail)로 오므로 SPA 폴백으로 index.html 서빙.
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
// 1.7) TossPayments 시크릿 키 (서버 전용) — 오직 .env 에서만 읽는다.
//    ⚠️ 절대 로그/응답/커밋되는 파일(server.js 포함)에 값을 넣지 않는다.
//    없어도 부팅은 막지 않는다(상품/장바구니는 이 키 없이 동작). 결제 승인(confirm) 시에만 필수.
//    프론트에 노출되는 "클라이언트키"는 공개값이라 index.html 에 직접 둔다(여기 시크릿키와 다름).
// ---------------------------------------------------------------------------
const TOSS_SECRET_KEY = (process.env.TOSS_SECRET_KEY || '').trim();
const TOSS_CONFIRM_URL = 'https://api.tosspayments.com/v1/payments/confirm';

// ---------------------------------------------------------------------------
// 1.8) ImageKit (이미지 저장소) — .env 의 URL_ENDPOINT / PUBLIC_KEY / PRIVATE_KEY.
//    · URL_ENDPOINT, PUBLIC_KEY 는 공개값(브라우저에 내려도 안전).
//    · PRIVATE_KEY 는 서버 전용. 절대 응답/로그에 넣지 않는다.
//      업로드 서명(HMAC-SHA1)을 만들 때만 쓰이고, 서명 자체는 token+expire 로만 계산되므로
//      PRIVATE_KEY 는 브라우저로 나가지 않는다.
//    · 업로드는 "브라우저 → ImageKit 직접"이다(서버를 파일이 통과하지 않음).
//      서버는 /api/imagekit/auth 로 1회용 서명만 발급한다 → 큰 파일도 서버 메모리를 안 먹는다.
//    · 저장 허용 URL: 반드시 우리 URL_ENDPOINT 로 시작해야 한다(임의 외부 URL 주입 차단).
// ---------------------------------------------------------------------------
const IK_URL_ENDPOINT = (process.env.URL_ENDPOINT || '').trim().replace(/\/+$/, '');
const IK_PUBLIC_KEY = (process.env.PUBLIC_KEY || '').trim();
const IK_PRIVATE_KEY = (process.env.PRIVATE_KEY || '').trim();
const IK_AUTH_TTL_SEC = 30 * 60; // 서명 유효시간(ImageKit 최대 1시간)

// 이미지 URL 검증 — 우리 ImageKit 엔드포인트에서 온 https URL 만 DB 에 저장한다.
//   (엔드포인트가 미설정이면 검증 불가 → 저장 거부. 조용히 통과시키지 않는다.)
function isAllowedImageUrl(url) {
  if (typeof url !== 'string' || !IK_URL_ENDPOINT) return false;
  return url.startsWith(`${IK_URL_ENDPOINT}/`);
}

// ---------------------------------------------------------------------------
// 1.9) 관리자 — .env 의 ADMIN_EMAILS(쉼표 구분)에 있는 이메일은 가입/로그인 시 자동 승격.
//    권한의 최종 판단은 항상 DB(shop_users.is_admin) 또는 이 목록으로 하며,
//    JWT 안의 값은 신뢰하지 않는다(토큰을 위조·재사용해도 권한이 따라오지 않게).
// ---------------------------------------------------------------------------
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

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
const T_ORDERS = 'shop_orders';

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
// 2.5) 시드 데이터 — 정확히 10개.
//   price 는 정수(원 단위). INTEGER 컬럼이라 node-pg 가 JS number 로 돌려준다.
//   image_url 은 전부 우리 ImageKit(URL_ENDPOINT) 에 올려둔 파일이다.
//     → 원본은 Unsplash 였고 migrate-images.js 로 1회 이관했다. 이제 외부 호스트에 의존하지 않는다.
//     → 새 DB 에 시드될 때도 곧바로 ImageKit URL 이 들어간다.
//   stock/status 는 컬럼 기본값(50, 'active')을 그대로 쓴다.
// ---------------------------------------------------------------------------
const IK_SEED_BASE = 'https://ik.imagekit.io/uruefe4p3/shop/products';

const SEED_PRODUCTS = [
  ['베이직 크루넥 반팔 티셔츠', 19900, `${IK_SEED_BASE}/product-1-product.jpg`, '매일 입기 좋은 코마 면 100% 베이직 반팔 티셔츠. 군더더기 없는 데일리 핏.'],
  ['프리미엄 옥스포드 셔츠', 39900, `${IK_SEED_BASE}/product-2-product.jpg`, '포멀과 캐주얼을 넘나드는 옥스포드 코튼 셔츠. 다양하게 매치하기 좋은 데일리 셔츠.'],
  ['테일러드 캐주얼 블레이저', 89000, `${IK_SEED_BASE}/product-3-product.jpg`, '격식과 멋을 더하는 베이지 캐주얼 블레이저. 셔츠 위에 걸치면 완성되는 룩.'],
  ['슬림핏 워싱 데님 진', 49900, `${IK_SEED_BASE}/product-4-product.jpg`, '신축성 좋은 슬림핏 데님 팬츠. 자연스러운 워싱으로 어디에나 잘 어울려요.'],
  ['레더 라이더 자켓', 129000, `${IK_SEED_BASE}/product-5-product.jpg`, '시그니처 블랙 라이더 자켓. 어떤 룩에도 시크한 무드를 더해주는 한 벌.'],
  ['워싱 데님 트러커 자켓', 69000, `${IK_SEED_BASE}/product-6-product.jpg`, '라이트 워싱 데님 트러커 자켓. 사계절 레이어드 필수 아이템.'],
  ['슬림핏 드레스 셔츠 (스카이블루)', 34900, `${IK_SEED_BASE}/product-7-product.jpg`, '비즈니스 룩을 완성하는 스카이블루 드레스 셔츠. 구김 적은 소재.'],
  ['그래픽 오버핏 반팔 티셔츠', 24900, `${IK_SEED_BASE}/product-8-product.jpg`, '오트밀 컬러에 포인트 그래픽을 더한 오버핏 티셔츠. 캐주얼 코디에 딱.'],
  ['체크 플란넬 오버셔츠', 44900, `${IK_SEED_BASE}/product-9-product.jpg`, '머스타드 체크 플란넬 오버셔츠. 티셔츠 위에 걸쳐 가을 레이어드룩.'],
  ['베이직 스웨트셔츠 (화이트)', 39900, `${IK_SEED_BASE}/product-10-product.jpg`, '깔끔한 화이트 스웨트셔츠. 사계절 부담 없이 입기 좋은 베이직 맨투맨.'],
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
    // 주문(결제) 테이블 — TossPayments prepare→confirm 의 단일 진실 소스.
    //   order_id 는 앱이 부여하는 고유값(UNIQUE), amount 는 prepare 시 서버가 확정(정수 원).
    //   status: 'pending'(준비) → 'paid'(승인 완료) | 'failed'(승인 실패/금액 불일치).
    //   items_snapshot 은 결제 시점 장바구니 스냅샷(JSONB). payment_key 는 승인 성공 후 저장.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${T_ORDERS} (
        id             BIGSERIAL PRIMARY KEY,
        order_id       TEXT NOT NULL UNIQUE,
        user_id        BIGINT NOT NULL REFERENCES ${T_USERS}(id) ON DELETE CASCADE,
        order_name     TEXT NOT NULL,
        amount         INTEGER NOT NULL CHECK (amount >= 0),
        status         TEXT NOT NULL DEFAULT 'pending',
        item_count     INTEGER NOT NULL DEFAULT 0,
        items_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
        payment_key    TEXT,
        method         TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        paid_at        TIMESTAMPTZ
      );
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_shop_orders_user_id ON ${T_ORDERS}(user_id)`
    );

    // --- 마이그레이션 (기존 DB 에도 안전하게 컬럼 추가) ---
    //   CREATE TABLE IF NOT EXISTS 는 테이블이 이미 있으면 통째로 스킵된다.
    //   → 나중에 추가된 컬럼은 반드시 ALTER ... ADD COLUMN IF NOT EXISTS 로 따로 보장해야 한다.
    //   (이걸 빼면 로컬 빈 DB 에선 되고, 기존 데이터가 있는 DB 에선 'column does not exist' 로 깨진다.)
    await client.query(`
      ALTER TABLE ${T_USERS}
        ADD COLUMN IF NOT EXISTS profile_image TEXT,
        ADD COLUMN IF NOT EXISTS is_admin      BOOLEAN NOT NULL DEFAULT false;
    `);
    // stock: 재고 수량(0 이면 품절).  status: 'active'(판매중) | 'discontinued'(판매중단).
    //   "품절"은 상태값이 아니라 stock = 0 에서 파생된다 → 두 곳에 같은 사실을 저장하지 않는다.
    await client.query(`
      ALTER TABLE ${T_PRODUCTS}
        ADD COLUMN IF NOT EXISTS stock  INTEGER NOT NULL DEFAULT 50,
        ADD COLUMN IF NOT EXISTS status TEXT    NOT NULL DEFAULT 'active';
    `);
    // 음수 재고/오타 상태값을 DB 레벨에서 차단. 이미 있으면 무시(42710/42P07 등).
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE ${T_PRODUCTS} ADD CONSTRAINT shop_products_stock_nonneg CHECK (stock >= 0);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE ${T_PRODUCTS} ADD CONSTRAINT shop_products_status_valid
          CHECK (status IN ('active', 'discontinued'));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

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
  const stock = row.stock != null ? row.stock : 0;
  const status = row.status || 'active';
  return {
    id: row.id,
    name: row.name,
    price: row.price, // INTEGER → number
    imageUrl: row.image_url,
    description: row.description,
    stock,   // INTEGER → number
    status,  // 'active' | 'discontinued'
    // 살 수 있는가 — 판매중이면서 재고가 남아 있을 때만. 프론트는 이 값 하나만 보면 된다
    // (품절/판매중단 판정 규칙이 서버 한 곳에만 있도록).
    purchasable: status === 'active' && stock > 0,
    createdAt: row.created_at.getTime(), // TIMESTAMPTZ(Date) → epoch ms
  };
}

// 이메일이 ADMIN_EMAILS 에 있거나 DB 의 is_admin 이 true 면 관리자.
function rowIsAdmin(row) {
  if (!row) return false;
  if (row.is_admin === true) return true;
  return ADMIN_EMAILS.has(String(row.email || '').toLowerCase());
}

function publicUser(row) {
  // 응답에 내보낼 수 있는 user 형태. password_hash 절대 포함 금지.
  return {
    id: row.id,
    email: row.email,
    profileImage: row.profile_image || null,
    isAdmin: rowIsAdmin(row),
  };
}

// ADMIN_EMAILS 에 있는 계정인데 DB 플래그가 아직 false 면 승격시킨다(가입/로그인 시 1회).
//   반환: 승격 결과가 반영된 row (호출부가 그대로 publicUser 에 넘길 수 있게).
async function syncAdminFlag(row) {
  if (!row || row.is_admin === true) return row;
  if (!ADMIN_EMAILS.has(String(row.email || '').toLowerCase())) return row;
  await pool.query(`UPDATE ${T_USERS} SET is_admin = true WHERE id = $1`, [row.id]);
  return { ...row, is_admin: true };
}

// 장바구니 한 줄(shop_cart_items JOIN shop_products) → camelCase 항목.
//   id 는 cart row id(PATCH/DELETE 에 사용), productId 는 상품 id.
function mapCartItem(row) {
  const price = row.price; // INTEGER
  const quantity = row.quantity; // INTEGER
  const stock = row.stock != null ? row.stock : 0;
  const status = row.status || 'active';
  return {
    id: row.id, // cart row id (변경/삭제 키)
    productId: row.product_id,
    name: row.name,
    price, // 정수
    imageUrl: row.image_url,
    description: row.description,
    quantity, // 정수
    lineTotal: price * quantity,
    stock,
    status,
    // 담긴 뒤에 품절/판매중단이 됐을 수 있다 → 결제 가능 여부를 항목마다 알려준다.
    purchasable: status === 'active' && stock >= quantity,
  };
}

// 전체 장바구니 객체로 조립 — 모든 변경 요청이 이 형태를 반환한다.
function buildCart(rows) {
  const items = rows.map(mapCartItem);
  const totalQuantity = items.reduce((s, it) => s + it.quantity, 0);
  const totalPrice = items.reduce((s, it) => s + it.lineTotal, 0);
  return { items, totalQuantity, totalPrice };
}

// 주문명 — "첫 상품명" 또는 "첫 상품명 외 N건". Toss orderName 100자 제한 방어 truncation.
function buildOrderName(items) {
  const first = String((items[0] && items[0].name) || '주문 상품');
  const base = items.length > 1 ? `${first} 외 ${items.length - 1}건` : first;
  return base.length > 90 ? `${base.slice(0, 90)}…` : base;
}

// shop_orders 행 → API 객체(camelCase). 결제 요약만 반환(payment_key 등 민감치 않은 값 위주).
//   createdAt/paidAt 은 다른 매핑과 동일하게 epoch ms 숫자 계약을 지킨다.
//   items 는 결제 시점 스냅샷(JSONB) — node-pg 가 이미 JS 배열로 파싱해 준다(JSON.parse 금지).
//   해당 컬럼을 SELECT 하지 않은 호출부에서는 빈 배열이 된다.
function mapOrder(row) {
  return {
    orderId: row.order_id,
    orderName: row.order_name,
    amount: row.amount,                 // INTEGER → number
    status: row.status,
    method: row.method || null,
    itemCount: row.item_count != null ? row.item_count : undefined,
    items: Array.isArray(row.items_snapshot) ? row.items_snapshot : [],
    createdAt: row.created_at ? row.created_at.getTime() : undefined,
    paidAt: row.paid_at ? row.paid_at.getTime() : undefined,
  };
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

// SPA 폴백 경로: TossPayments 는 successUrl/failUrl 로 "실제 경로"(해시 아님)로 리다이렉트한다
//   (예: /success?paymentKey=...&orderId=...&amount=...). 이 경로들도 index.html 을 서빙해야
//   프론트가 결과 화면을 띄우고 confirm 을 호출할 수 있다. 쿼리스트링은 서버가 pathname 만
//   보므로 브라우저 URL 에 그대로 보존된다. 읽는 파일은 항상 INDEX_HTML_PATH 하나뿐(안전 유지).
const SPA_FALLBACK_PATHS = new Set(['/success', '/fail']);

// ⚠️ Vercel(@vercel/nft) 파일 트레이싱 대비: index.html 경로를 "리터럴"로 고정한다.
//    런타임에 변수 경로로만 읽으면 nft 가 정적 분석을 못 해 함수 번들에서 index.html 이
//    빠지고 배포 환경에서 GET / 가 404 가 된다. allowlist 가 index.html 단일이므로
//    통과 시 읽을 파일은 항상 이 경로다.
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');

function serveStatic(pathname, res) {
  // '/' 와 SPA 폴백 경로(/success·/fail) → index.html. 그 외엔 basename 만 추출(트래버설 방지).
  const requested =
    (pathname === '/' || SPA_FALLBACK_PATHS.has(pathname))
      ? 'index.html'
      : path.basename(decodeURIComponent(pathname));

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
       RETURNING id, email, profile_image, is_admin`,
      [email, passwordHash]
    );
  } catch (err) {
    if (err && err.code === '23505') {
      // 동시 가입 레이스로 UNIQUE 충돌 → 409
      return sendJSON(res, 409, { error: '이미 가입된 이메일입니다.' });
    }
    throw err;
  }

  const user = await syncAdminFlag(inserted.rows[0]);
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
    `SELECT id, email, password_hash, profile_image, is_admin FROM ${T_USERS} WHERE email = $1`,
    [email]
  );
  if (result.rows.length === 0) {
    return sendJSON(res, 401, { error: INVALID });
  }

  const found = result.rows[0];
  const ok = await bcrypt.compare(password, found.password_hash);
  if (!ok) {
    return sendJSON(res, 401, { error: INVALID });
  }

  const row = await syncAdminFlag(found);
  const token = signToken(row);
  sendJSON(res, 200, { token, user: publicUser(row) });
}

// GET /api/auth/me  (Bearer) → 200 { user:{ id, email } }
//   토큰의 sub 로 DB 에서 실제 사용자를 다시 확인(삭제된 사용자/유령 토큰 방지).
async function me(_req, res, authUser) {
  const result = await pool.query(
    `SELECT id, email, profile_image, is_admin FROM ${T_USERS} WHERE id = $1`,
    [authUser.id]
  );
  if (result.rows.length === 0) {
    return sendJSON(res, 401, { error: '유효하지 않은 토큰입니다.' });
  }
  const row = await syncAdminFlag(result.rows[0]);
  sendJSON(res, 200, { user: publicUser(row) });
}

// PATCH /api/auth/profile-image (Bearer) { imageUrl } → 200 { user }
//   imageUrl 이 null/'' 이면 프로필 사진 제거.
//   그 외에는 반드시 우리 ImageKit 엔드포인트 URL 이어야 한다(외부 URL 주입 차단).
async function updateProfileImage(req, res, authUser) {
  const body = await readJSONBody(req);
  const raw = body.imageUrl;

  let imageUrl = null;
  if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
    imageUrl = String(raw).trim();
    if (!isAllowedImageUrl(imageUrl)) {
      return sendJSON(res, 400, {
        error: '이미지 주소가 올바르지 않습니다. ImageKit 업로드를 통해 등록해 주세요.',
      });
    }
  }

  const { rows } = await pool.query(
    `UPDATE ${T_USERS} SET profile_image = $1
      WHERE id = $2
      RETURNING id, email, profile_image, is_admin`,
    [imageUrl, authUser.id]
  );
  if (rows.length === 0) {
    return sendJSON(res, 401, { error: '유효하지 않은 토큰입니다.' });
  }
  sendJSON(res, 200, { user: publicUser(rows[0]) });
}

// ---------------------------------------------------------------------------
// 6.2) API 핸들러 — ImageKit 업로드 서명 (Bearer)
//    브라우저가 ImageKit 에 파일을 직접 올리려면 (token, expire, signature) 3종이 필요하다.
//    signature = HMAC-SHA1(token + expire, PRIVATE_KEY)  ← PRIVATE_KEY 는 여기서만 쓰이고 나가지 않는다.
//    expire 는 unix seconds(최대 1시간 뒤). token 은 매 요청 새 UUID(재사용 금지).
//    로그인한 사용자에게만 발급한다 → 아무나 우리 계정 스토리지에 업로드하지 못하게.
// ---------------------------------------------------------------------------
function imagekitAuth(_req, res) {
  if (!IK_PRIVATE_KEY || !IK_PUBLIC_KEY || !IK_URL_ENDPOINT) {
    console.error('[imagekit] .env 의 URL_ENDPOINT / PUBLIC_KEY / PRIVATE_KEY 중 일부가 없습니다.');
    return sendJSON(res, 500, { error: '서버에 이미지 업로드 설정이 없습니다.' });
  }

  const token = crypto.randomUUID();
  const expire = Math.floor(Date.now() / 1000) + IK_AUTH_TTL_SEC;
  const signature = crypto
    .createHmac('sha1', IK_PRIVATE_KEY)
    .update(token + expire)
    .digest('hex');

  // publicKey/urlEndpoint 는 공개값 — 프론트가 업로드 폼을 만들 때 필요하다.
  sendJSON(res, 200, {
    token,
    expire,
    signature,
    publicKey: IK_PUBLIC_KEY,
    urlEndpoint: IK_URL_ENDPOINT,
  });
}

// ---------------------------------------------------------------------------
// 6.5) API 핸들러 — 상품 (공개, 인증 불필요)
// ---------------------------------------------------------------------------
const PRODUCT_COLS = 'id, name, price, image_url, description, stock, status, created_at';

// GET /api/products → 200 [{ id, name, price, imageUrl, description, stock, status, purchasable, createdAt }]
//   판매중단 상품도 내려준다 — 목록에서 "판매중단" 배지로 보여주기 위해서다(담기는 서버가 막는다).
async function listProducts(_req, res) {
  const { rows } = await pool.query(
    `SELECT ${PRODUCT_COLS} FROM ${T_PRODUCTS} ORDER BY id ASC`
  );
  sendJSON(res, 200, rows.map(mapProduct));
}

// ---------------------------------------------------------------------------
// 6.55) API 핸들러 — 관리자 상품 관리 (전부 관리자 전용)
//    등록/수정/삭제. 이미지는 반드시 우리 ImageKit URL 이어야 한다.
//    삭제는 shop_cart_items 가 ON DELETE CASCADE 라 남의 장바구니에서도 함께 사라진다.
//    (주문 내역은 items_snapshot(JSONB)에 값으로 복사돼 있어 상품이 지워져도 보존된다.)
// ---------------------------------------------------------------------------
const PRODUCT_STATUSES = new Set(['active', 'discontinued']);
const MAX_PRICE = 100_000_000; // 1억원 — 오타(0 하나 더) 방어
const MAX_STOCK = 1_000_000;

// 상품 입력 검증. mode='create' 면 필수값 누락을 막고, 'patch' 면 들어온 필드만 검사한다.
//   반환: { error } 또는 { fields: {컬럼명: 값} }
function validateProductInput(body, mode) {
  const fields = {};
  const has = (k) => body[k] !== undefined && body[k] !== null;

  if (mode === 'create' || has('name')) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return { error: '상품명을 입력해 주세요.' };
    if (name.length > 120) return { error: '상품명은 120자 이하로 입력해 주세요.' };
    fields.name = name;
  }

  if (mode === 'create' || has('price')) {
    const price = Number(body.price);
    if (!Number.isInteger(price) || price < 0 || price > MAX_PRICE) {
      return { error: '가격은 0 이상의 정수(원)여야 합니다.' };
    }
    fields.price = price;
  }

  if (mode === 'create' || has('imageUrl')) {
    const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
    if (!isAllowedImageUrl(imageUrl)) {
      return { error: '상품 이미지는 ImageKit 업로드를 통해 등록해 주세요.' };
    }
    fields.image_url = imageUrl;
  }

  if (mode === 'create' || has('description')) {
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (description.length > 500) return { error: '설명은 500자 이하로 입력해 주세요.' };
    fields.description = description;
  }

  if (mode === 'create' || has('stock')) {
    const stock = body.stock === undefined || body.stock === null ? 0 : Number(body.stock);
    if (!Number.isInteger(stock) || stock < 0 || stock > MAX_STOCK) {
      return { error: '재고는 0 이상의 정수여야 합니다.' };
    }
    fields.stock = stock;
  }

  if (mode === 'create' || has('status')) {
    const status = body.status === undefined || body.status === null ? 'active' : String(body.status);
    if (!PRODUCT_STATUSES.has(status)) {
      return { error: "상태는 'active'(판매중) 또는 'discontinued'(판매중단) 여야 합니다." };
    }
    fields.status = status;
  }

  return { fields };
}

// GET /api/admin/products (Admin) → 200 [product]  — 최신 등록순
async function adminListProducts(_req, res) {
  const { rows } = await pool.query(
    `SELECT ${PRODUCT_COLS} FROM ${T_PRODUCTS} ORDER BY id DESC`
  );
  sendJSON(res, 200, rows.map(mapProduct));
}

// POST /api/admin/products (Admin) { name, price, imageUrl, description?, stock?, status? } → 201 product
async function adminCreateProduct(req, res) {
  const body = await readJSONBody(req);
  const { error, fields } = validateProductInput(body, 'create');
  if (error) return sendJSON(res, 400, { error });

  const cols = Object.keys(fields);
  const placeholders = cols.map((_c, i) => `$${i + 1}`).join(', ');
  const { rows } = await pool.query(
    `INSERT INTO ${T_PRODUCTS} (${cols.join(', ')})
     VALUES (${placeholders})
     RETURNING ${PRODUCT_COLS}`,
    cols.map((c) => fields[c])
  );
  sendJSON(res, 201, mapProduct(rows[0]));
}

// PATCH /api/admin/products/:id (Admin) — 보낸 필드만 갱신 → 200 product
async function adminUpdateProduct(req, res, productId) {
  const body = await readJSONBody(req);
  const { error, fields } = validateProductInput(body, 'patch');
  if (error) return sendJSON(res, 400, { error });

  const cols = Object.keys(fields);
  if (cols.length === 0) {
    return sendJSON(res, 400, { error: '변경할 항목이 없습니다.' });
  }

  // SET name = $1, price = $2 ...  / WHERE id = $N
  const setSql = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
  const params = cols.map((c) => fields[c]);
  params.push(productId);

  const { rows } = await pool.query(
    `UPDATE ${T_PRODUCTS} SET ${setSql}
      WHERE id = $${params.length}
      RETURNING ${PRODUCT_COLS}`,
    params
  );
  if (rows.length === 0) {
    return sendJSON(res, 404, { error: '해당 상품을 찾을 수 없습니다.' });
  }
  sendJSON(res, 200, mapProduct(rows[0]));
}

// DELETE /api/admin/products/:id (Admin) → 200 { ok, deletedId }
async function adminDeleteProduct(_req, res, productId) {
  const { rows } = await pool.query(
    `DELETE FROM ${T_PRODUCTS} WHERE id = $1 RETURNING id`,
    [productId]
  );
  if (rows.length === 0) {
    return sendJSON(res, 404, { error: '해당 상품을 찾을 수 없습니다.' });
  }
  sendJSON(res, 200, { ok: true, deletedId: rows[0].id });
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
            p.name, p.price, p.image_url, p.description, p.stock, p.status
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

  // 상품 존재 확인 → 없으면 404. 판매 가능 여부(재고/판매중단)는 서버가 최종 판단한다.
  //   프론트 버튼을 비활성화해 두더라도, 요청은 직접 만들 수 있으므로 여기서 반드시 다시 막는다.
  const prod = await pool.query(
    `SELECT id, stock, status FROM ${T_PRODUCTS} WHERE id = $1`,
    [productId]
  );
  if (prod.rows.length === 0) {
    return sendJSON(res, 404, { error: '해당 상품을 찾을 수 없습니다.' });
  }
  const { stock, status } = prod.rows[0];
  if (status !== 'active') {
    return sendJSON(res, 409, { error: '판매가 중단된 상품입니다.' });
  }
  if (stock <= 0) {
    return sendJSON(res, 409, { error: '품절된 상품입니다.' });
  }

  // 담기는 "누적"이므로 이미 담긴 수량까지 합쳐 재고를 넘지 않는지 본다.
  const existing = await pool.query(
    `SELECT quantity FROM ${T_CART} WHERE user_id = $1 AND product_id = $2`,
    [authUser.id, productId]
  );
  const already = existing.rows.length ? existing.rows[0].quantity : 0;
  if (already + quantity > stock) {
    return sendJSON(res, 409, {
      error: `재고가 ${stock}개 남아 있어요.${already ? ` (장바구니에 이미 ${already}개)` : ''}`,
    });
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

  // 대상 항목의 상품 재고/상태를 함께 읽는다.
  //   user_id 를 함께 걸어 남의 항목은 매칭 자체가 안 되게 한다(404, 존재 누출 없음).
  const target = await pool.query(
    `SELECT c.id, p.stock, p.status
       FROM ${T_CART} c
       JOIN ${T_PRODUCTS} p ON p.id = c.product_id
      WHERE c.id = $1 AND c.user_id = $2`,
    [cartItemId, authUser.id]
  );
  if (target.rows.length === 0) {
    return sendJSON(res, 404, { error: '해당 장바구니 항목을 찾을 수 없습니다.' });
  }
  const { stock, status } = target.rows[0];
  if (status !== 'active') {
    return sendJSON(res, 409, { error: '판매가 중단된 상품입니다. 장바구니에서 빼주세요.' });
  }
  if (quantity > stock) {
    return sendJSON(res, 409, { error: `재고가 ${stock}개 남아 있어요.` });
  }

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
// 6.7) API 핸들러 — 결제 (TossPayments 결제위젯: prepare → confirm)
//   [prepare] 서버가 "장바구니 합계"로 주문 금액을 확정하고 pending 주문을 만든다.
//             → 이후 confirm 은 클라가 보낸 amount 를 신뢰하지 않고 이 저장 금액과 대조한다.
//   [confirm] successUrl 리다이렉트로 받은 paymentKey/orderId/amount 를 검증한 뒤
//             Toss 승인 API 를 호출한다. 승인 성공 시에만 결제가 실제로 완료된다.
//   ⚠️ orderId 는 전역 공용 테스트키(_docs_) 충돌을 피하려 매번 crypto.randomUUID() 로 고유하게.
// ---------------------------------------------------------------------------

// POST /api/payments/prepare (Bearer) → 201 { orderId, amount, orderName }
async function preparePayment(_req, res, authUser) {
  const cart = await fetchCart(authUser.id);
  if (cart.items.length === 0) {
    return sendJSON(res, 400, { error: '장바구니가 비어 있어 결제를 진행할 수 없습니다.' });
  }

  // 담아둔 사이에 품절/판매중단이 됐을 수 있다 → 결제창을 띄우기 전에 막는다.
  const blocked = cart.items.filter((it) => !it.purchasable);
  if (blocked.length > 0) {
    const first = blocked[0];
    const reason = first.status !== 'active' ? '판매중단' : `재고 부족(남은 수량 ${first.stock}개)`;
    return sendJSON(res, 409, {
      error: `'${first.name}' 상품은 ${reason} 상태예요. 장바구니를 확인해 주세요.`,
      blockedProductIds: blocked.map((it) => it.productId),
    });
  }

  const amount = cart.totalPrice;                 // 서버가 확정하는 결제 금액(정수 원)
  const orderName = buildOrderName(cart.items);
  const itemCount = cart.totalQuantity;
  const orderId = `shop_${crypto.randomUUID()}`;  // 고유 orderId (공용 테스트키 충돌 방지)
  const snapshot = cart.items.map((it) => ({
    productId: it.productId, name: it.name, price: it.price,
    quantity: it.quantity, lineTotal: it.lineTotal,
  }));

  // items_snapshot 은 JSONB — node-pg 는 JS 배열을 PG 배열로 오해하므로 반드시 JSON.stringify + ::jsonb.
  await pool.query(
    `INSERT INTO ${T_ORDERS} (order_id, user_id, order_name, amount, status, item_count, items_snapshot)
     VALUES ($1, $2, $3, $4, 'pending', $5, $6::jsonb)`,
    [orderId, authUser.id, orderName, amount, itemCount, JSON.stringify(snapshot)]
  );

  sendJSON(res, 201, { orderId, amount, orderName });
}

// POST /api/payments/confirm (Bearer) { paymentKey, orderId, amount } → 200 { status, order }
async function confirmPayment(req, res, authUser) {
  const body = await readJSONBody(req);
  const paymentKey = typeof body.paymentKey === 'string' ? body.paymentKey.trim() : '';
  const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';
  const amount = parsePositiveInt(body.amount);

  if (!paymentKey || !orderId || amount === null) {
    return sendJSON(res, 400, { error: '결제 정보(paymentKey/orderId/amount)가 올바르지 않습니다.' });
  }

  // 주문은 order_id + user_id 로만 조회 → 남의 주문은 매칭 자체가 안 돼 confirm 불가(404).
  const found = await pool.query(
    `SELECT * FROM ${T_ORDERS} WHERE order_id = $1 AND user_id = $2`,
    [orderId, authUser.id]
  );
  if (found.rows.length === 0) {
    return sendJSON(res, 404, { error: '주문을 찾을 수 없습니다.' });
  }
  const order = found.rows[0];

  // 이미 승인 완료된 주문의 재confirm(새로고침/중복요청) → 멱등 응답(중복 승인·중복 청구 방지).
  if (order.status === 'paid') {
    return sendJSON(res, 200, { status: 'paid', alreadyProcessed: true, order: mapOrder(order) });
  }

  // ⚠️ 금액 위변조 방지 — 클라가 보낸 amount 를 신뢰하지 않고 서버 저장 금액과 대조. 불일치면 거부.
  if (Number(amount) !== Number(order.amount)) {
    await pool.query(`UPDATE ${T_ORDERS} SET status = 'failed' WHERE id = $1`, [order.id]);
    return sendJSON(res, 400, { error: '결제 금액이 주문 금액과 일치하지 않습니다.' });
  }

  if (!TOSS_SECRET_KEY) {
    console.error('[toss] TOSS_SECRET_KEY 미설정 — .env(로컬) 또는 배포 환경변수에 등록 필요');
    return sendJSON(res, 500, { error: '서버에 결제 시크릿 키가 설정되지 않았습니다.' });
  }

  // Toss 승인 API 호출 — 금액은 반드시 "서버 저장액(order.amount)"으로 보낸다(클라값 아님).
  //   인증: Basic base64(secretKey + ':')  (Node 20.6+ 전역 fetch 사용)
  const encoded = Buffer.from(`${TOSS_SECRET_KEY}:`).toString('base64');
  let tossRes, tossData;
  try {
    tossRes = await fetch(TOSS_CONFIRM_URL, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${encoded}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentKey, orderId, amount: order.amount }),
    });
    tossData = await tossRes.json().catch(() => ({}));
  } catch (err) {
    console.error('[toss confirm] 네트워크 오류:', err.message);
    return sendJSON(res, 502, { error: '결제 승인 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
  }

  if (!tossRes.ok) {
    // Toss 승인 실패(카드사 거절/이미 처리됨 등) → 주문 failed 표시 후 원인 메시지 반환.
    await pool.query(`UPDATE ${T_ORDERS} SET status = 'failed' WHERE id = $1`, [order.id]);
    const msg = (tossData && tossData.message) || '결제 승인에 실패했습니다.';
    return sendJSON(res, 400, { error: msg, code: tossData && tossData.code });
  }

  // 승인 성공 → paid 표시 + paymentKey/method 저장 + 해당 사용자 장바구니 비우기.
  const method = (tossData && tossData.method) || null;
  const updated = await pool.query(
    `UPDATE ${T_ORDERS}
        SET status = 'paid', payment_key = $1, method = $2, paid_at = now()
      WHERE id = $3
      RETURNING *`,
    [paymentKey, method, order.id]
  );
  await pool.query(`DELETE FROM ${T_CART} WHERE user_id = $1`, [authUser.id]);

  // 재고 차감 — 결제 스냅샷 기준으로 한 번에. GREATEST(...,0) 로 음수 방지.
  //   ⚠️ 이 시점엔 Toss 승인이 이미 끝났다. 여기서 실패해도 결제는 유효하므로
  //      500 으로 뒤집지 않고 로그만 남긴다(재고는 관리자 화면에서 교정 가능).
  const snapshot = Array.isArray(order.items_snapshot) ? order.items_snapshot : [];
  if (snapshot.length > 0) {
    try {
      await pool.query(
        `UPDATE ${T_PRODUCTS} p
            SET stock = GREATEST(p.stock - s.qty, 0)
           FROM (SELECT UNNEST($1::bigint[]) AS pid, UNNEST($2::int[]) AS qty) s
          WHERE p.id = s.pid`,
        [snapshot.map((it) => Number(it.productId)), snapshot.map((it) => Number(it.quantity))]
      );
    } catch (err) {
      console.error('[stock] 결제 후 재고 차감 실패 (결제는 정상 승인됨):', err.message);
    }
  }

  sendJSON(res, 200, { status: 'paid', order: mapOrder(updated.rows[0]) });
}

// ---------------------------------------------------------------------------
// 6.8) API 핸들러 — 주문 내역 (마이페이지, Bearer 보호)
//   WHERE user_id = $1 로 본인 주문만 조회한다(남의 주문은 결과에 아예 안 들어옴).
//   ⚠️ 'pending' 은 제외한다: /payments/prepare 는 결제창에 들어갈 때마다 pending 행을 만들어서,
//      결제를 중단하면 그대로 남는다. 마이페이지는 "실제 결제 시도"(paid/failed)만 보여준다.
//   summary 는 paid 주문만 집계한다(실패 주문이 총 결제액에 섞이면 안 됨).
//   payment_key 는 절대 SELECT/응답하지 않는다(결제 식별자 = 민감값).
// ---------------------------------------------------------------------------
async function listOrders(_req, res, authUser) {
  const { rows } = await pool.query(
    `SELECT order_id, order_name, amount, status, method, item_count,
            items_snapshot, created_at, paid_at
       FROM ${T_ORDERS}
      WHERE user_id = $1 AND status <> 'pending'
      ORDER BY created_at DESC, id DESC`,
    [authUser.id]
  );

  const orders = rows.map(mapOrder);
  const paid = orders.filter((o) => o.status === 'paid');

  const summary = {
    paidCount: paid.length,
    totalPaid: paid.reduce((sum, o) => sum + o.amount, 0),
    totalItems: paid.reduce((sum, o) => sum + (o.itemCount || 0), 0),
    lastPaidAt: paid.length > 0 ? (paid[0].paidAt || paid[0].createdAt) : null,
  };

  sendJSON(res, 200, { orders, summary });
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

// 관리자 전용 게이트 — 401(미인증) / 403(권한없음) 을 구분해 응답한다.
//   ⚠️ 권한은 토큰 payload 가 아니라 매 요청 DB(+ADMIN_EMAILS)에서 다시 확인한다.
//      토큰은 7일 유효하므로, 권한을 회수해도 남은 토큰이 관리자로 통하면 안 된다.
async function requireAdmin(req, res) {
  const authUser = requireAuth(req, res);
  if (!authUser) return null; // 401 이미 응답됨

  await ensureDB();
  const { rows } = await pool.query(
    `SELECT id, email, is_admin FROM ${T_USERS} WHERE id = $1`,
    [authUser.id]
  );
  if (rows.length === 0) {
    sendJSON(res, 401, { error: '유효하지 않은 토큰입니다.' });
    return null;
  }
  if (!rowIsAdmin(rows[0])) {
    sendJSON(res, 403, { error: '관리자만 사용할 수 있는 기능입니다.' });
    return null;
  }
  return authUser;
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

  // --- 프로필 사진: /api/auth/profile-image (Bearer) ---
  if (pathname === '/api/auth/profile-image') {
    if (method !== 'PATCH') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    const authUser = requireAuth(req, res);
    if (!authUser) return; // 401 이미 응답됨
    return ensureDB().then(() => updateProfileImage(req, res, authUser));
  }

  // --- ImageKit 업로드 서명 (Bearer, DB 불필요) ---
  if (pathname === '/api/imagekit/auth') {
    if (method !== 'GET') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    const authUser = requireAuth(req, res);
    if (!authUser) return; // 401 이미 응답됨
    return imagekitAuth(req, res);
  }

  // --- 관리자: /api/admin/products — GET(전체) / POST(등록) ---
  if (pathname === '/api/admin/products') {
    if (method !== 'GET' && method !== 'POST') {
      return sendJSON(res, 405, { error: 'Method Not Allowed' });
    }
    const admin = await requireAdmin(req, res);
    if (!admin) return; // 401/403 이미 응답됨
    if (method === 'GET') return adminListProducts(req, res);
    return adminCreateProduct(req, res);
  }

  // --- 관리자: /api/admin/products/:id — PATCH(수정) / DELETE(삭제) ---
  const adminProductMatch = pathname.match(/^\/api\/admin\/products\/([^/]+)$/);
  if (adminProductMatch) {
    if (method !== 'PATCH' && method !== 'DELETE') {
      return sendJSON(res, 405, { error: 'Method Not Allowed' });
    }
    const admin = await requireAdmin(req, res);
    if (!admin) return; // 401/403 이미 응답됨
    const id = parseId(adminProductMatch[1]);
    if (id === null) return sendJSON(res, 400, { error: '유효하지 않은 상품 id 입니다.' });
    if (method === 'PATCH') return adminUpdateProduct(req, res, id);
    return adminDeleteProduct(req, res, id);
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

  // --- 결제: /api/payments/prepare (Bearer) — 주문 확정(pending) ---
  if (pathname === '/api/payments/prepare') {
    if (method !== 'POST') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    const authUser = requireAuth(req, res);
    if (!authUser) return; // 401 이미 응답됨
    return ensureDB().then(() => preparePayment(req, res, authUser));
  }

  // --- 결제: /api/payments/confirm (Bearer) — Toss 승인 + paid 처리 ---
  if (pathname === '/api/payments/confirm') {
    if (method !== 'POST') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    const authUser = requireAuth(req, res);
    if (!authUser) return; // 401 이미 응답됨
    return ensureDB().then(() => confirmPayment(req, res, authUser));
  }

  // --- 마이페이지: /api/orders (Bearer) — 내 주문/결제 내역 ---
  if (pathname === '/api/orders') {
    if (method !== 'GET') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    const authUser = requireAuth(req, res);
    if (!authUser) return; // 401 이미 응답됨
    return ensureDB().then(() => listOrders(req, res, authUser));
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
      // ⚠️ listen(port, cb) 는 cb 를 'listening' 의 once 리스너로 단다.
      //    이번 시도는 'listening' 없이 실패했으므로 그 cb 가 살아남는다 → 정리하지 않으면
      //    다음 포트로 성공했을 때 이전 시도의 cb 까지 함께 실행돼 "4000 에서 실행" 처럼
      //    실제와 다른 주소를 안내한다(포트 충돌 때만 나타나는 버그).
      server.removeAllListeners('listening');
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
    if (!TOSS_SECRET_KEY) {
      console.warn('[toss] 경고: TOSS_SECRET_KEY 가 없어 결제 승인(confirm)이 실패합니다. ' +
        '.env(로컬) 또는 배포 플랫폼 환경변수에 등록하세요.');
    }
    if (!IK_URL_ENDPOINT || !IK_PUBLIC_KEY || !IK_PRIVATE_KEY) {
      console.warn('[imagekit] 경고: URL_ENDPOINT / PUBLIC_KEY / PRIVATE_KEY 중 일부가 없어 ' +
        '이미지 업로드가 동작하지 않습니다.');
    }
    if (ADMIN_EMAILS.size === 0) {
      console.warn('[admin] 경고: ADMIN_EMAILS 가 비어 있어 관리자 페이지에 접근할 수 없습니다. ' +
        '.env 에 ADMIN_EMAILS=your@email.com 형태로 등록하세요.');
    } else {
      console.log(`[admin] 관리자 이메일 ${ADMIN_EMAILS.size}개 등록됨 — 해당 계정으로 로그인 시 관리자 메뉴가 열립니다.`);
    }
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
