// ============================================================================
// MERIDIAN 커피빈몰 — 인증 + 주문 백엔드 (server.js)
//   - 역할: 같은 폴더의 index.html(단일 파일 CDN React 쇼핑몰) 정적 서빙 +
//           이메일/비밀번호 기반 회원가입·로그인 JWT 인증 API +
//           로그인 유저의 주문 생성/조회 API(모두 Bearer 보호).
//   - 의존성: pg(DB) + bcryptjs(비밀번호 해시) + jsonwebtoken(JWT).
//     정적 서빙/라우팅은 Node 내장 http 모듈로 직접 처리한다(Express 미사용).
//   - DB: Supabase Postgres (트랜잭션 풀러 :6543, SSL 필수).
//   - DB_URL / JWT_SECRET 은 오직 .env 에서만 읽으며 절대 로그/응답에 노출하지 않는다.
//   - 공유 DB 대비: 이 앱 전용 테이블 접두사 cbmall_ 를 사용한다(범용 users 충돌 방지).
// ============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ---------------------------------------------------------------------------
// 1) 환경변수 로드 (Node 20.6+/24: process.loadEnvFile)
//    __dirname 기준으로 .env 를 찾으므로 실행 cwd 와 무관하게 동작한다.
// ---------------------------------------------------------------------------
const ENV_PATH = path.join(__dirname, '.env');
try {
  process.loadEnvFile(ENV_PATH);
} catch (_) {
  // .env 가 이미 환경에 주입돼 있거나(배포 플랫폼) 파일이 없을 수 있음 → 무시
}

const PORT = Number(process.env.PORT) || 3000;
const DB_URL = (process.env.DB_URL || '').trim(); // trailing newline/space 방지

if (!DB_URL) {
  console.error('[FATAL] .env 의 DB_URL 이 설정되지 않았습니다. 서버를 시작할 수 없습니다.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1.5) DB_URL 견고 파서
//    이 프로젝트의 비밀번호는 인코딩되지 않은 특수문자('@', '!' 등)를 포함한다
//    (형태: postgresql://USER:P@SSW0RD!!@HOST:6543/postgres — 비번 자체가 '@' 를
//     품고 있다). 인코딩 안 된 '@' 는 표준 URL 파서(new URL / pg 의
//    connectionString)가 host 구분자로 오인해 연결이 깨진다.
//    → connectionString 을 쓰지 않고 URL 을 직접 분해해 { host, port, user,
//      password, database } 개별 필드로 pg 에 넘긴다. 개별 필드는 pg 가 그대로
//      사용하므로 특수문자 파싱 문제가 원천 차단된다.
//    분해 규칙(순서가 중요):
//      · userinfo↔host  : authority 의 '마지막' '@' 에서 분리(비번의 '@' 보존)
//      · user↔password  : userinfo 의 '처음' ':' 에서 분리(그 뒤 전부가 비번)
//      · host↔port      : hostport 의 '마지막' ':' 에서 분리
// ---------------------------------------------------------------------------
function maybeDecode(s) {
  // 값이 percent-encoding 된 경우에만 디코드. 원문에 '%' 가 없으면(현재 비번처럼
  // 특수문자가 raw 로 들어있는 경우) 그대로 둔다 → 잘못된 디코드로 값이 바뀌지 않음.
  if (typeof s !== 'string' || s.indexOf('%') === -1) return s;
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return s;
  }
}

function parsePgUrl(raw) {
  const m = raw.match(/^(postgres(?:ql)?):\/\/(.*)$/is);
  if (!m) {
    throw new Error('DB_URL 형식 오류: postgres:// 또는 postgresql:// 스킴이 필요합니다.');
  }
  let rest = m[2];

  // 쿼리스트링(?sslmode=... 등) 제거
  const qIdx = rest.indexOf('?');
  if (qIdx !== -1) rest = rest.slice(0, qIdx);

  // authority(userinfo@host:port) 와 database(첫 '/' 뒤) 분리
  let authority;
  let database;
  const slashIdx = rest.indexOf('/');
  if (slashIdx === -1) {
    authority = rest;
    database = 'postgres';
  } else {
    authority = rest.slice(0, slashIdx);
    database = maybeDecode(rest.slice(slashIdx + 1)) || 'postgres';
  }

  // userinfo ↔ host:port  — '마지막' '@' 기준 (비밀번호에 포함된 '@' 를 보존)
  const atIdx = authority.lastIndexOf('@');
  if (atIdx === -1) {
    throw new Error('DB_URL 형식 오류: 사용자 정보(user:password@)가 없습니다.');
  }
  const userinfo = authority.slice(0, atIdx);
  const hostport = authority.slice(atIdx + 1);

  // user ↔ password — '처음' ':' 기준 (그 뒤 전부가 비밀번호: '@',':','!' 등 포함 가능)
  let user;
  let password;
  const colonIdx = userinfo.indexOf(':');
  if (colonIdx === -1) {
    user = userinfo;
    password = '';
  } else {
    user = userinfo.slice(0, colonIdx);
    password = userinfo.slice(colonIdx + 1);
  }

  // host ↔ port — '마지막' ':' 기준
  let host;
  let port;
  const hpColon = hostport.lastIndexOf(':');
  if (hpColon === -1) {
    host = hostport;
    port = 5432;
  } else {
    host = hostport.slice(0, hpColon);
    port = parseInt(hostport.slice(hpColon + 1), 10) || 5432;
  }

  return {
    host: maybeDecode(host),
    port,
    user: maybeDecode(user),
    password: maybeDecode(password),
    database,
  };
}

let DB_CFG;
try {
  DB_CFG = parsePgUrl(DB_URL);
} catch (err) {
  console.error('[FATAL] DB_URL 파싱 실패:', err.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1.6) JWT_SECRET 확보
//    .env 에 JWT_SECRET 이 있으면 그대로 사용(절대 덮어쓰지 않음 — 기존 토큰 보존).
//    없으면 강한 랜덤 시크릿을 생성해 .env 에 한 줄 append 한 뒤 사용한다.
//    → 서버를 재시작해도 같은 시크릿을 읽으므로 발급된 토큰이 유지된다.
//    값 자체는 어떤 로그/응답에도 노출하지 않는다. DB_URL 라인은 건드리지 않는다.
// ---------------------------------------------------------------------------
function ensureJwtSecret() {
  const existing = (process.env.JWT_SECRET || '').trim();
  if (existing) return existing;

  const generated = crypto.randomBytes(48).toString('hex');
  try {
    // 파일 끝이 개행으로 안 끝나면 개행을 먼저 붙여 새 키가 기존 줄에 붙지 않게 한다
    // (예: DB_URL=...JWT_SECRET=... 처럼 한 줄로 뭉치는 것을 방지).
    let prefix = '';
    try {
      const cur = fs.readFileSync(ENV_PATH);
      if (cur.length > 0 && cur[cur.length - 1] !== 0x0a) prefix = '\n';
    } catch (_) {
      // .env 가 없으면 새로 만든다(이 앱은 DB_URL 필수라 위에서 이미 걸러짐).
    }
    fs.appendFileSync(ENV_PATH, `${prefix}JWT_SECRET=${generated}\n`);
    console.log('[jwt] JWT_SECRET 이 없어 새로 생성해 .env 에 저장했습니다(값 비노출).');
  } catch (_) {
    // 기록 실패(읽기전용 FS 등)해도 이번 프로세스 동안은 메모리 값으로 동작.
    console.warn('[jwt] .env 저장 실패 — 이번 실행 동안만 임시 시크릿을 사용합니다.');
  }
  process.env.JWT_SECRET = generated;
  return generated;
}

const JWT_SECRET = ensureJwtSecret();
const JWT_EXPIRES_IN = '7d';

// ---------------------------------------------------------------------------
// 1.7) TossPayments 결제 키 확보
//    · TOSS_CLIENT_KEY : 공개용(클라이언트 노출 OK) — /api/payments/config 로만 전달.
//    · TOSS_SECRET_KEY : 서버 전용 — 승인 API Basic 인증에만 사용, 절대 응답/로그/클라 노출 금지.
//    .env 에 값이 있으면 그대로 사용. 없으면 토스가 공개한 "문서용 테스트 상점" 키를
//    .env 에 append(기존 라인 보존). 실제 운영 키는 .env 에서 교체하면 된다.
//    (문서용 테스트 키는 토스가 공식 문서에 공개한 키라 소스 기본값으로 둬도 안전하다.)
// ---------------------------------------------------------------------------
const TOSS_DOCS_CLIENT_KEY = 'test_gck_docs_Ovk5rk1EwkEbP0W43n07xlzm';
const TOSS_DOCS_SECRET_KEY = 'test_gsk_docs_OaPz8L5KdmQXkzRz3y47BMw6';
const TOSS_CONFIRM_URL = 'https://api.tosspayments.com/v1/payments/confirm';

function appendEnvLines(lines) {
  try {
    let prefix = '';
    try {
      const cur = fs.readFileSync(ENV_PATH);
      if (cur.length > 0 && cur[cur.length - 1] !== 0x0a) prefix = '\n';
    } catch (_) {
      // .env 없음 → 새로 만든다(이 앱은 DB_URL 필수라 위에서 이미 걸러짐).
    }
    fs.appendFileSync(ENV_PATH, prefix + lines.join('\n') + '\n');
    return true;
  } catch (_) {
    return false;
  }
}

function ensureTossKeys() {
  const toAppend = [];
  let clientKey = (process.env.TOSS_CLIENT_KEY || '').trim();
  let secretKey = (process.env.TOSS_SECRET_KEY || '').trim();
  if (!clientKey) { clientKey = TOSS_DOCS_CLIENT_KEY; toAppend.push(`TOSS_CLIENT_KEY=${clientKey}`); }
  if (!secretKey) { secretKey = TOSS_DOCS_SECRET_KEY; toAppend.push(`TOSS_SECRET_KEY=${secretKey}`); }
  if (toAppend.length) {
    if (appendEnvLines(toAppend)) console.log('[toss] TOSS 키가 없어 문서용 테스트 키를 .env 에 저장했습니다(값 비노출).');
    else console.warn('[toss] .env 저장 실패 — 이번 실행 동안만 임시 테스트 키를 사용합니다.');
    process.env.TOSS_CLIENT_KEY = clientKey;
    process.env.TOSS_SECRET_KEY = secretKey;
  }
  return { clientKey, secretKey };
}

const { clientKey: TOSS_CLIENT_KEY, secretKey: TOSS_SECRET_KEY } = ensureTossKeys();

// ---------------------------------------------------------------------------
// 1.8) ImageKit 이미지 업로드 키 확보
//    · IMAGEKIT_URL_ENDPOINT : 공개용(클라 노출 OK). 예 https://ik.imagekit.io/<id>. 끝 슬래시 strip.
//    · IMAGEKIT_PUBLIC_KEY   : 공개용(클라 노출 OK) — /api/imagekit/auth 로만 내려감.
//    · IMAGEKIT_PRIVATE_KEY  : 서버 전용 — 업로드 서명(HMAC-SHA1)·파일삭제 Basic 인증에만 사용.
//      절대 응답/로그/클라/정적파일로 노출 금지(정적 서빙 allowlist 가 .env 차단).
//    세 값 모두 .env 에서만 읽는다. 소스에 기본값을 두면 커밋 시 키가 그대로 공개된다.
//    값은 ImageKit 대시보드 > Developer options > Standard Keys 에서 발급.
// ---------------------------------------------------------------------------
const IMAGEKIT_UPLOAD_URL = 'https://upload.imagekit.io/api/v1/files/upload';

function ensureImageKitKeys() {
  const publicKey = (process.env.IMAGEKIT_PUBLIC_KEY || '').trim();
  const privateKey = (process.env.IMAGEKIT_PRIVATE_KEY || '').trim();
  // 끝 슬래시는 사용 전에 정규화 — allowlist 검증(endpoint + '/')이 일관되게 동작하도록.
  const urlEndpoint = (process.env.IMAGEKIT_URL_ENDPOINT || '').trim().replace(/\/+$/, '');
  const missing = [];
  if (!publicKey) missing.push('IMAGEKIT_PUBLIC_KEY');
  if (!privateKey) missing.push('IMAGEKIT_PRIVATE_KEY');
  if (!urlEndpoint) missing.push('IMAGEKIT_URL_ENDPOINT');
  if (missing.length) {
    console.error(`[FATAL] .env 에 ${missing.join(', ')} 이(가) 없습니다. .env.example 을 참고해 채워주세요.`);
    process.exit(1);
  }
  return { publicKey, privateKey, urlEndpoint };
}

const {
  publicKey: IMAGEKIT_PUBLIC_KEY,
  privateKey: IMAGEKIT_PRIVATE_KEY,
  urlEndpoint: IMAGEKIT_URL_ENDPOINT,
} = ensureImageKitKeys();

// ---------------------------------------------------------------------------
// 2) PG 풀 — Supabase 풀러는 SSL 필수. connectionString 대신 개별 필드 사용.
// ---------------------------------------------------------------------------
const pool = new Pool({
  host: DB_CFG.host,
  port: DB_CFG.port,
  user: DB_CFG.user,
  password: DB_CFG.password,
  database: DB_CFG.database,
  ssl: { rejectUnauthorized: false },
  max: 5, // 풀러 환경 배려: 작게 유지
});

pool.on('error', (err) => {
  // 유휴 클라이언트 오류로 프로세스가 죽지 않도록 흡수 (URL/비번 비노출)
  console.error('[pg pool] idle client error:', err.message);
});

// ---------------------------------------------------------------------------
// 3) 스키마 (lazy init: 최초 1회만, cold start 대응)
//    ⚠️ 공유 Supabase DB 이므로 범용 이름 users 금지 → cbmall_users 로 네임스페이스.
//       (같은 DB 에 다른 퀘스트/앱의 users 가 다른 스키마로 존재할 수 있어,
//        CREATE TABLE IF NOT EXISTS users 는 조용히 스킵되고 컬럼 불일치 500 을 유발.)
// ---------------------------------------------------------------------------
const T_USERS = 'cbmall_users';
const T_ORDERS = 'cbmall_orders';

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

    // 프로필 사진(ImageKit URL) 컬럼 — 공유 DB 안전: ADD COLUMN IF NOT EXISTS 로 추가.
    //   ⚠️ cbmall_users 는 이미 존재하므로 위 CREATE IF NOT EXISTS 는 no-op → 새 컬럼이
    //      안 생긴다. 반드시 ALTER 로 추가해야 profile_image 가 실제로 붙는다.
    //   값은 우리 ImageKit 엔드포인트 하위 URL 만 저장(저장 시 allowlist 검증). nullable.
    await client.query(`ALTER TABLE ${T_USERS} ADD COLUMN IF NOT EXISTS profile_image TEXT;`);

    // 주문 테이블. user_id 는 cbmall_users.id 참조(유저 삭제 시 주문도 함께 삭제).
    // items 는 주문 시점의 상품 스냅샷 배열(JSONB). 금액은 전부 정수(원).
    // ⚠️ 공유 DB 이므로 반드시 cbmall_ 접두사 — 범용 orders 는 타 앱과 충돌 위험.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${T_ORDERS} (
        id             BIGSERIAL PRIMARY KEY,
        user_id        BIGINT NOT NULL REFERENCES ${T_USERS}(id) ON DELETE CASCADE,
        items          JSONB NOT NULL,
        subtotal       INTEGER NOT NULL,
        shipping_fee   INTEGER NOT NULL DEFAULT 0,
        total          INTEGER NOT NULL,
        recipient_name TEXT NOT NULL,
        phone          TEXT NOT NULL,
        postal_code    TEXT,
        address        TEXT NOT NULL,
        address_detail TEXT,
        memo           TEXT,
        status         TEXT NOT NULL DEFAULT '주문완료',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // 내 주문 최신순 조회를 위한 인덱스(user_id 기준).
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_${T_ORDERS}_user_id ON ${T_ORDERS} (user_id);
    `);

    // 결제(TossPayments) 연동 컬럼 — 공유 DB 안전: ADD COLUMN IF NOT EXISTS 로 추가.
    //   order_no       : 토스에 넘기는 고유 주문번호(MRD-<row id>-<rand>). 승인 조회 키.
    //   payment_key    : 승인 성공 시 토스가 발급한 paymentKey.
    //   payment_method : 승인된 결제수단(카드/간편결제 등).
    //   paid_at        : 승인 완료 시각.
    // (status 는 결제대기 → 주문완료 로 전이. 기존 주문 기본값 '주문완료' 는 그대로 유지.)
    await client.query(`ALTER TABLE ${T_ORDERS} ADD COLUMN IF NOT EXISTS order_no TEXT;`);
    await client.query(`ALTER TABLE ${T_ORDERS} ADD COLUMN IF NOT EXISTS payment_key TEXT;`);
    await client.query(`ALTER TABLE ${T_ORDERS} ADD COLUMN IF NOT EXISTS payment_method TEXT;`);
    await client.query(`ALTER TABLE ${T_ORDERS} ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;`);
    // order_no 는 유일해야 하되 기존 행(NULL)은 제외 → 부분 유니크 인덱스.
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_${T_ORDERS}_order_no ON ${T_ORDERS} (order_no) WHERE order_no IS NOT NULL;`
    );
  } finally {
    client.release();
  }
}

function ensureDB() {
  // 최초 호출 시에만 initDB 실행. 실패하면 캐시를 비워 다음 요청에서 재시도.
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
// 4.5) 행 → API 객체 매핑
//   password_hash 는 절대 매핑/노출하지 않는다.
//   createdAt 은 epoch milliseconds(숫자)로 반환한다. pg 는 TIMESTAMPTZ 를 JS Date
//   로 주므로 .getTime() 으로 변환 — ISO 문자열을 주면 클라의 new Date() 가 깨질 수 있음.
// ---------------------------------------------------------------------------
function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    // ImageKit 프로필 사진 URL(없으면 null). 프론트가 아바타 표시·세션복구에 사용.
    // 이 값을 채우려면 SELECT/RETURNING 에 profile_image 컬럼이 포함돼야 한다.
    profileImage: row.profile_image != null ? row.profile_image : null,
    createdAt: row.created_at ? row.created_at.getTime() : null,
  };
}

// 주문 행 → API 객체(camelCase 정규화). DB snake_case 컬럼을 프론트가 쓰기 편한
// 형태로 변환한다. items(JSONB)는 pg 가 이미 JS 배열로 파싱해 주므로 그대로 노출.
// INTEGER(subtotal/shipping_fee/total)는 pg 가 숫자로, BIGSERIAL(id)은 문자열로 준다.
// createdAt 은 epoch milliseconds(숫자) — 기존 user.createdAt 과 일관(프론트 new Date() 안전).
function publicOrder(row) {
  return {
    id: row.id,
    items: row.items,
    subtotal: row.subtotal,
    shippingFee: row.shipping_fee,
    total: row.total,
    recipient: {
      name: row.recipient_name,
      phone: row.phone,
      postalCode: row.postal_code,
      address: row.address,
      addressDetail: row.address_detail,
      memo: row.memo,
    },
    status: row.status,
    orderNo: row.order_no || null,
    paidAt: row.paid_at ? row.paid_at.getTime() : null,
    createdAt: row.created_at ? row.created_at.getTime() : null,
  };
}

// ---------------------------------------------------------------------------
// 4.6) JWT 발급/검증
// ---------------------------------------------------------------------------
function signToken(user) {
  return jwt.sign({ sub: String(user.id), email: user.email }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: JWT_EXPIRES_IN,
  });
}

// Authorization: Bearer <token> 파싱 + 검증.
//   성공: { id, email } 반환.  실패(없음/만료/서명불량/형식오류): null.
function authenticate(req) {
  const header = req.headers['authorization'] || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  try {
    const payload = jwt.verify(match[1].trim(), JWT_SECRET, { algorithms: ['HS256'] });
    if (!payload || !payload.sub) return null;
    return { id: payload.sub, email: payload.email };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 5) 정적 서빙 — allowlist 방식 (.env / server.js / package.json 등 유출 차단)
//    · '/' 및 '/index.html' → index.html
//    · 공개 확장자(.js .css .png ...) 파일만 서빙하되, dotfile(.env 등)과
//      명시적 차단 파일(server.js, package.json ...)은 제외.
//    · path.basename 으로 디렉터리 성분을 제거하므로 '/../' 트래버설도 무력화.
//    · 그 외 알 수 없는 경로 → index.html 로 폴백(SPA 친화 + 파일 존재 여부 비노출).
// ---------------------------------------------------------------------------
const PUBLIC_EXT = new Set([
  '.html', '.js', '.css', '.svg', '.png', '.jpg', '.jpeg',
  '.gif', '.ico', '.webp', '.woff', '.woff2', '.map', '.json',
]);
const BLOCKED_BASENAMES = new Set([
  'server.js', 'package.json', 'package-lock.json', '.env',
]);

function contentTypeFor(ext) {
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.ico': return 'image/x-icon';
    case '.webp': return 'image/webp';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    default: return 'application/octet-stream';
  }
}

function serveIndex(res) {
  fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
    if (err) return sendJSON(res, 404, { error: 'Not Found' });
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

function serveStatic(pathname, res) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (_) {
    return serveIndex(res); // 잘못된 인코딩 → 인덱스 폴백(정보 비노출)
  }

  if (decoded === '/' || decoded === '/index.html') {
    return serveIndex(res);
  }

  const base = path.basename(decoded); // 디렉터리 성분 제거 → 트래버설 차단
  const ext = path.extname(base).toLowerCase();

  // dotfile / 차단 파일 / 공개 확장자 아님 → 전부 인덱스 폴백(실제 파일 비노출)
  if (base.startsWith('.') || BLOCKED_BASENAMES.has(base) || !PUBLIC_EXT.has(ext)) {
    return serveIndex(res);
  }

  const filePath = path.join(__dirname, base);
  // 방어적 이중 확인: 해석된 경로가 __dirname 밖이면 폴백
  if (filePath !== path.join(__dirname, base) || !filePath.startsWith(__dirname)) {
    return serveIndex(res);
  }

  fs.readFile(filePath, (err, data) => {
    if (err) return serveIndex(res); // 존재하지 않으면 인덱스 폴백
    res.writeHead(200, {
      'Content-Type': contentTypeFor(ext),
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// 6) 입력 검증 규칙
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 8;

// ---------------------------------------------------------------------------
// 6.1) POST /api/signup  { email, password }
//   → 201 { token, user: { id, email, createdAt } }
//   → 400(형식), 409(중복 이메일)
// ---------------------------------------------------------------------------
async function signup(req, res) {
  const body = await readJSONBody(req);

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  // 검증(400)은 DB 접근 전에 수행 → DB 상태와 무관하게 즉시 응답
  if (!EMAIL_RE.test(email)) {
    return sendJSON(res, 400, { error: '올바른 이메일 형식이 아닙니다.' });
  }
  if (password.length < MIN_PASSWORD_LEN) {
    return sendJSON(res, 400, { error: `비밀번호는 최소 ${MIN_PASSWORD_LEN}자 이상이어야 합니다.` });
  }

  await ensureDB();

  // 중복 이메일 → 409
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
       RETURNING id, email, profile_image, created_at`,
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

// ---------------------------------------------------------------------------
// 6.2) POST /api/login  { email, password }
//   → 200 { token, user: { id, email, createdAt } }
//   → 401(이메일/비번 불일치 — 어느 쪽이 틀렸는지 구분 노출하지 않음)
// ---------------------------------------------------------------------------
async function login(req, res) {
  const body = await readJSONBody(req);

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  const INVALID = '이메일 또는 비밀번호가 올바르지 않습니다.';
  if (!email || !password) {
    return sendJSON(res, 401, { error: INVALID });
  }

  await ensureDB();

  const result = await pool.query(
    `SELECT id, email, password_hash, profile_image, created_at FROM ${T_USERS} WHERE email = $1`,
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

// ---------------------------------------------------------------------------
// 6.3) GET /api/me  (Authorization: Bearer <token>)
//   → 200 { user: { id, email, createdAt } }
//   → 401(토큰 없음/무효/만료, 또는 삭제된 사용자)
// ---------------------------------------------------------------------------
async function me(req, res, authUser) {
  await ensureDB();
  const result = await pool.query(
    `SELECT id, email, profile_image, created_at FROM ${T_USERS} WHERE id = $1`,
    [authUser.id]
  );
  if (result.rows.length === 0) {
    return sendJSON(res, 401, { error: '유효하지 않은 토큰입니다.' });
  }
  sendJSON(res, 200, { user: publicUser(result.rows[0]) });
}

// ---------------------------------------------------------------------------
// 6.3.5) ImageKit 프로필 사진 — 서명 기반 "클라이언트 직접 업로드" 방식
//   흐름:
//     ① 클라가 GET /api/imagekit/auth(Bearer)로 업로드용 서명(token/expire/signature)을 받는다.
//     ② 클라가 그 서명 + 파일을 ImageKit 업로드 API 로 "직접" 보낸다(이미지 바이트는 우리 서버를 안 거침).
//     ③ 업로드 성공 후 반환된 url 을 POST /api/profile/photo(Bearer)로 저장한다.
//   보안: PRIVATE 키는 서명 생성에만 쓰고 절대 응답/클라로 내보내지 않는다. 서명 발급은
//         로그인 필수(무단 업로드 서명 방지). 저장 시 url 이 우리 엔드포인트 하위인지 allowlist 검증.
// ---------------------------------------------------------------------------

// GET /api/imagekit/auth (Bearer) → { token, expire, signature, publicKey, urlEndpoint }
//   ImageKit 클라 업로드에 필요한 인증 파라미터. DB 불필요(로그인 게이트만).
//     · token     : 매 요청 고유값(UUID).
//     · expire    : unix seconds, 현재+40분(반드시 1시간 이내 — ImageKit 규칙).
//     · signature : HMAC-SHA1(key=PRIVATE_KEY, data=token+expire) 의 hex digest.
//   ⚠️ PRIVATE 키 자체는 응답에 절대 넣지 않는다(signature 만).
function imagekitAuth(req, res, _authUser) {
  const token = crypto.randomUUID();
  const expire = Math.floor(Date.now() / 1000) + 40 * 60; // 현재+40분 (< 1h)
  const signature = crypto
    .createHmac('sha1', IMAGEKIT_PRIVATE_KEY)
    .update(token + expire)
    .digest('hex');
  sendJSON(res, 200, {
    token,
    expire,
    signature,
    publicKey: IMAGEKIT_PUBLIC_KEY,
    urlEndpoint: IMAGEKIT_URL_ENDPOINT,
  });
}

// POST /api/profile/photo (Bearer)  body: { url, fileId? }
//   → 200 { user }  |  400(엔드포인트 밖 URL/누락)  |  401(삭제된 사용자)
//   url 이 반드시 IMAGEKIT_URL_ENDPOINT + '/' 로 시작해야 저장(임의 URL 저장 차단).
//   fileId 는 선택 — 현재 스키마엔 저장하지 않지만(profile_image 만), 받아도 무시하고 통과.
async function updateProfilePhoto(req, res, authUser) {
  const body = await readJSONBody(req);
  const url = trimStr(body.url);
  if (!url) {
    return sendJSON(res, 400, { error: '이미지 URL(url)이 필요합니다.' });
  }
  // allowlist: 우리 ImageKit 엔드포인트 하위 URL 만 허용(뒤에 '/' 를 붙여 프리픽스 위조 차단).
  const allowedPrefix = IMAGEKIT_URL_ENDPOINT + '/';
  if (!url.startsWith(allowedPrefix)) {
    return sendJSON(res, 400, { error: '허용되지 않은 이미지 URL 입니다. ImageKit 엔드포인트 주소만 저장할 수 있습니다.' });
  }

  await ensureDB();
  const updated = await pool.query(
    `UPDATE ${T_USERS} SET profile_image = $1
     WHERE id = $2
     RETURNING id, email, profile_image, created_at`,
    [url, authUser.id]
  );
  if (updated.rows.length === 0) {
    // 토큰은 유효하나 해당 유저가 삭제된 경우
    return sendJSON(res, 401, { error: '유효하지 않은 토큰입니다.' });
  }
  sendJSON(res, 200, { user: publicUser(updated.rows[0]) });
}

// ---------------------------------------------------------------------------
// 6.4) 주문(order) API — 모두 유효 JWT(Bearer) 필수. user_id 는 토큰에서만 취한다.
// ---------------------------------------------------------------------------
function isNonNegInt(n) {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}
function isPosInt(n) {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}
function trimStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// 배송비 정책 — 프론트(index.html의 shippingFor)와 동일한 단일 소스.
// 결제 준비 시 서버가 금액을 "권위 있게" 재계산하는 데 사용한다(클라 값 불신).
const FREE_SHIP_MIN = 30000;
const SHIP_FEE = 3000;
const shippingFor = (subtotal) => (subtotal === 0 || subtotal >= FREE_SHIP_MIN ? 0 : SHIP_FEE);

// 주문 생성 페이로드 검증 + 정규화.
//   성공: { value: { items, recipient, amounts } }
//   실패: { error: '<사유>' }  (호출부에서 400 으로 응답)
function validateOrderPayload(body) {
  // --- items: 비어있지 않은 배열, 각 항목 필수필드 + qty>0 ---
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return { error: '주문 상품(items)은 비어있지 않은 배열이어야 합니다.' };
  }
  const items = [];
  for (let i = 0; i < body.items.length; i++) {
    const it = body.items[i] || {};
    const productId = it.productId;
    const name = trimStr(it.name);
    const unitPrice = it.unitPrice;
    const qty = it.qty;

    if (productId === undefined || productId === null || String(productId).trim() === '') {
      return { error: `items[${i}].productId 는 필수입니다.` };
    }
    if (!name) {
      return { error: `items[${i}].name 은 필수입니다.` };
    }
    if (!isNonNegInt(unitPrice)) {
      return { error: `items[${i}].unitPrice 는 0 이상 정수여야 합니다.` };
    }
    if (!isPosInt(qty)) {
      return { error: `items[${i}].qty 는 1 이상 정수여야 합니다.` };
    }

    // lineTotal 은 제공되면 검증해 사용, 없으면 unitPrice*qty 로 서버가 계산(스냅샷 일관성).
    const lineTotal = isNonNegInt(it.lineTotal) ? it.lineTotal : unitPrice * qty;
    items.push({
      productId,
      name,
      origin: trimStr(it.origin),
      weight: trimStr(it.weight),
      unitPrice,
      qty,
      lineTotal,
    });
  }

  // --- recipient: name/phone/address 필수 ---
  const r = body.recipient || {};
  const name = trimStr(r.name);
  const phone = trimStr(r.phone);
  const address = trimStr(r.address);
  if (!name) return { error: '받는 분 이름(recipient.name)은 필수입니다.' };
  if (!phone) return { error: '연락처(recipient.phone)는 필수입니다.' };
  if (!address) return { error: '주소(recipient.address)는 필수입니다.' };

  const recipient = {
    name,
    phone,
    address,
    postalCode: trimStr(r.postalCode) || null,
    addressDetail: trimStr(r.addressDetail) || null,
    memo: trimStr(r.memo) || null,
  };

  // --- amounts: subtotal/shippingFee/total 모두 0 이상 정수 ---
  const a = body.amounts || {};
  if (!isNonNegInt(a.subtotal)) return { error: 'amounts.subtotal 은 0 이상 정수여야 합니다.' };
  if (!isNonNegInt(a.shippingFee)) return { error: 'amounts.shippingFee 는 0 이상 정수여야 합니다.' };
  if (!isNonNegInt(a.total)) return { error: 'amounts.total 은 0 이상 정수여야 합니다.' };

  return {
    value: {
      items,
      recipient,
      amounts: { subtotal: a.subtotal, shippingFee: a.shippingFee, total: a.total },
    },
  };
}

// POST /api/orders  → 201 { order }
//   user_id 는 토큰(authUser.id)에서만 취함 — 클라가 보낸 어떤 user 값도 신뢰하지 않는다.
async function createOrder(req, res, authUser) {
  const body = await readJSONBody(req);
  const parsed = validateOrderPayload(body);
  if (parsed.error) {
    return sendJSON(res, 400, { error: parsed.error });
  }
  const { items, recipient, amounts } = parsed.value;

  await ensureDB();

  // items 는 JSONB — pg 는 JS 배열을 Postgres 배열로 오해하므로 반드시 문자열화 + ::jsonb 캐스팅.
  const inserted = await pool.query(
    `INSERT INTO ${T_ORDERS}
       (user_id, items, subtotal, shipping_fee, total,
        recipient_name, phone, postal_code, address, address_detail, memo)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, user_id, items, subtotal, shipping_fee, total,
               recipient_name, phone, postal_code, address, address_detail, memo, status, created_at`,
    [
      authUser.id,
      JSON.stringify(items),
      amounts.subtotal,
      amounts.shippingFee,
      amounts.total,
      recipient.name,
      recipient.phone,
      recipient.postalCode,
      recipient.address,
      recipient.addressDetail,
      recipient.memo,
    ]
  );

  sendJSON(res, 201, { order: publicOrder(inserted.rows[0]) });
}

// GET /api/orders  → 200 { orders: [...] }
//   현재 로그인 유저(user_id)의 주문만 최신순. WHERE 로 격리 — 남의 주문 절대 노출 안 됨.
async function listOrders(req, res, authUser) {
  await ensureDB();
  const result = await pool.query(
    `SELECT id, user_id, items, subtotal, shipping_fee, total,
            recipient_name, phone, postal_code, address, address_detail, memo, status, created_at
     FROM ${T_ORDERS}
     WHERE user_id = $1
     ORDER BY created_at DESC, id DESC`,
    [authUser.id]
  );
  sendJSON(res, 200, { orders: result.rows.map(publicOrder) });
}

// GET /api/orders/:id  → 200 { order }  |  404(남의 것이거나 없음)
//   WHERE 에 user_id 를 함께 걸어 존재 여부 자체를 노출하지 않는다(격리 = 404, not 403).
async function getOrder(req, res, authUser, rawId) {
  // id 는 정수 문자열이어야 한다. 아니면 int8 캐스팅 오류(500) 대신 404 로 정리.
  if (!/^\d+$/.test(rawId)) {
    return sendJSON(res, 404, { error: '주문을 찾을 수 없습니다.' });
  }

  await ensureDB();
  const result = await pool.query(
    `SELECT id, user_id, items, subtotal, shipping_fee, total,
            recipient_name, phone, postal_code, address, address_detail, memo, status, created_at
     FROM ${T_ORDERS}
     WHERE id = $1 AND user_id = $2`,
    [rawId, authUser.id]
  );
  if (result.rows.length === 0) {
    return sendJSON(res, 404, { error: '주문을 찾을 수 없습니다.' });
  }
  sendJSON(res, 200, { order: publicOrder(result.rows[0]) });
}

// ---------------------------------------------------------------------------
// 6.5) TossPayments 결제 — 준비(prepare) / 승인(confirm) / 설정(config)
//   흐름:
//     ① 클라가 장바구니 items + 배송지 recipient 로 /prepare 호출
//        → 서버가 금액(subtotal/shipping/total)을 "권위 있게" 계산하고
//          결제대기(status '결제대기') 주문을 만들며 orderId(order_no)+amount 발급.
//     ② 결제창 승인 후 successUrl 복귀 → 클라가 /confirm { paymentKey, orderId, amount } 호출.
//        → 서버는 저장한 기대 금액과 요청 amount 가 "정확히 일치"할 때만 토스 승인 API 호출.
//          성공 시 주문을 '주문완료'로 확정하고 payment_key 저장.
//   보안: secret 키는 서버에서만 사용 / 금액 위변조 차단 / 남의 주문 조작 차단(소유확인) / 멱등.
// ---------------------------------------------------------------------------

// items(주문상품) + recipient(배송지) 검증 후, 금액을 서버가 계산해서 함께 반환한다.
// amounts 는 클라가 보내더라도 신뢰하지 않고 서버 계산값을 사용한다.
function validateCartAndRecipient(body) {
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return { error: '주문 상품(items)은 비어있지 않은 배열이어야 합니다.' };
  }
  const items = [];
  for (let i = 0; i < body.items.length; i++) {
    const it = body.items[i] || {};
    const name = trimStr(it.name);
    const unitPrice = it.unitPrice;
    const qty = it.qty;
    if (it.productId === undefined || it.productId === null || String(it.productId).trim() === '') {
      return { error: `items[${i}].productId 는 필수입니다.` };
    }
    if (!name) return { error: `items[${i}].name 은 필수입니다.` };
    if (!isNonNegInt(unitPrice)) return { error: `items[${i}].unitPrice 는 0 이상 정수여야 합니다.` };
    if (!isPosInt(qty)) return { error: `items[${i}].qty 는 1 이상 정수여야 합니다.` };
    items.push({
      productId: it.productId,
      name,
      origin: trimStr(it.origin),
      weight: trimStr(it.weight),
      unitPrice,
      qty,
      lineTotal: unitPrice * qty,
    });
  }

  const r = body.recipient || {};
  const name = trimStr(r.name);
  const phone = trimStr(r.phone);
  const address = trimStr(r.address);
  if (!name) return { error: '받는 분 이름(recipient.name)은 필수입니다.' };
  if (!phone) return { error: '연락처(recipient.phone)는 필수입니다.' };
  if (!address) return { error: '주소(recipient.address)는 필수입니다.' };

  const recipient = {
    name, phone, address,
    postalCode: trimStr(r.postalCode) || null,
    addressDetail: trimStr(r.addressDetail) || null,
    memo: trimStr(r.memo) || null,
  };

  // 서버 권위 금액: 클라가 보낸 amounts 는 무시하고 items 로부터 다시 계산한다.
  const subtotal = items.reduce((s, it) => s + it.unitPrice * it.qty, 0);
  const shippingFee = shippingFor(subtotal);
  const total = subtotal + shippingFee;

  return { value: { items, recipient, amounts: { subtotal, shippingFee, total } } };
}

// 주문명: "예가체프 코체레 외 2건"
function buildOrderName(items) {
  const first = (items[0] && items[0].name) ? items[0].name : '커피 원두';
  return items.length > 1 ? `${first} 외 ${items.length - 1}건` : first;
}

// GET /api/payments/config → { clientKey }
//   공개 클라이언트 키만 전달한다. secret 키는 어떤 경우에도 응답에 포함하지 않는다.
function paymentsConfig(req, res) {
  sendJSON(res, 200, { clientKey: TOSS_CLIENT_KEY });
}

// POST /api/payments/prepare (Bearer)
//   → 201 { orderId, amount, orderName, customerKey, customerEmail, order }
async function preparePayment(req, res, authUser) {
  const body = await readJSONBody(req);
  const parsed = validateCartAndRecipient(body);
  if (parsed.error) return sendJSON(res, 400, { error: parsed.error });
  const { items, recipient, amounts } = parsed.value;

  await ensureDB();

  // 결제대기 주문 생성 → id 확보 후 order_no(=토스 orderId) 발급.
  const inserted = await pool.query(
    `INSERT INTO ${T_ORDERS}
       (user_id, items, subtotal, shipping_fee, total,
        recipient_name, phone, postal_code, address, address_detail, memo, status)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10, $11, '결제대기')
     RETURNING id`,
    [
      authUser.id, JSON.stringify(items), amounts.subtotal, amounts.shippingFee, amounts.total,
      recipient.name, recipient.phone, recipient.postalCode, recipient.address, recipient.addressDetail, recipient.memo,
    ]
  );
  const orderRowId = inserted.rows[0].id;
  const orderNo = `MRD-${orderRowId}-${crypto.randomBytes(4).toString('hex')}`; // 예: MRD-12-a1b2c3d4 (토스 orderId 규격 6~64자)

  const updated = await pool.query(
    `UPDATE ${T_ORDERS} SET order_no = $1
     WHERE id = $2 AND user_id = $3
     RETURNING id, user_id, items, subtotal, shipping_fee, total,
               recipient_name, phone, postal_code, address, address_detail, memo,
               status, order_no, payment_key, payment_method, paid_at, created_at`,
    [orderNo, orderRowId, authUser.id]
  );

  const order = updated.rows[0];
  sendJSON(res, 201, {
    orderId: orderNo,
    amount: amounts.total,
    orderName: buildOrderName(items),
    customerKey: `cbmall_member_${authUser.id}`, // 로그인 유저별 고정 customerKey
    customerEmail: authUser.email || undefined,
    order: publicOrder(order),
  });
}

// POST /api/payments/confirm (Bearer) → 200 { order }
async function confirmPayment(req, res, authUser) {
  const body = await readJSONBody(req);
  const paymentKey = trimStr(body.paymentKey);
  const orderId = trimStr(body.orderId);
  const amount = body.amount;

  if (!paymentKey || !orderId) {
    return sendJSON(res, 400, { error: '결제 정보(paymentKey, orderId)가 올바르지 않습니다.' });
  }
  if (!isPosInt(amount)) {
    return sendJSON(res, 400, { error: '결제 금액(amount)이 올바르지 않습니다.' });
  }

  await ensureDB();

  // 소유 확인: 내 주문(order_no ↔ user_id)만 조회. 없으면 404(존재 자체 비노출 = 남의 것 조작 차단).
  const found = await pool.query(
    `SELECT id, user_id, items, subtotal, shipping_fee, total,
            recipient_name, phone, postal_code, address, address_detail, memo,
            status, order_no, payment_key, payment_method, paid_at, created_at
     FROM ${T_ORDERS}
     WHERE order_no = $1 AND user_id = $2`,
    [orderId, authUser.id]
  );
  if (found.rows.length === 0) {
    return sendJSON(res, 404, { error: '주문을 찾을 수 없습니다.' });
  }
  const order = found.rows[0];

  // 멱등성: 이미 승인 완료된 주문이면 재승인하지 않고 그대로 반환(새로고침/중복 confirm 안전).
  if (order.status === '주문완료' || order.status === '결제완료') {
    return sendJSON(res, 200, { order: publicOrder(order), alreadyConfirmed: true });
  }

  // 위변조 차단: 서버가 저장한 기대 금액과 요청 amount 가 다르면 승인 거부(토스 호출 전).
  if (Number(order.total) !== Number(amount)) {
    return sendJSON(res, 400, { error: '결제 금액이 주문 금액과 일치하지 않습니다.', code: 'AMOUNT_MISMATCH' });
  }

  // 토스 결제 승인 — secret 키 Basic 인증(서버 전용). base64(secretKey + ':').
  const encoded = Buffer.from(`${TOSS_SECRET_KEY}:`).toString('base64');
  let tossRes, tossData;
  try {
    tossRes = await fetch(TOSS_CONFIRM_URL, {
      method: 'POST',
      headers: { Authorization: `Basic ${encoded}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentKey, orderId, amount: Number(amount) }),
    });
    tossData = await tossRes.json();
  } catch (e) {
    return sendJSON(res, 502, { error: '결제 승인 서버와 통신하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
  }

  if (!tossRes.ok) {
    // 토스가 준 code/message 를 그대로 전달(민감정보 아님). 주문은 '결제대기'로 유지 → 재시도 가능.
    return sendJSON(res, 400, {
      error: (tossData && tossData.message) || '결제 승인에 실패했습니다.',
      code: (tossData && tossData.code) || 'CONFIRM_FAILED',
    });
  }

  // 승인 성공 → 주문 확정('결제대기'였던 것만 갱신 = 이중 확정 방지).
  const method = (tossData && tossData.method) ? String(tossData.method) : null;
  const confirmed = await pool.query(
    `UPDATE ${T_ORDERS}
     SET status = '주문완료', payment_key = $1, payment_method = $2, paid_at = now()
     WHERE order_no = $3 AND user_id = $4 AND status = '결제대기'
     RETURNING id, user_id, items, subtotal, shipping_fee, total,
               recipient_name, phone, postal_code, address, address_detail, memo,
               status, order_no, payment_key, payment_method, paid_at, created_at`,
    [paymentKey, method, orderId, authUser.id]
  );
  const finalOrder = confirmed.rows[0] || order; // 경합으로 이미 갱신됐다면 방금 읽은 행 사용
  sendJSON(res, 200, { order: publicOrder(finalOrder) });
}

// ---------------------------------------------------------------------------
// 7) API 라우터
//    라우팅/인증 게이트를 먼저 처리하고, DB 가 필요한 핸들러 내부에서만 ensureDB()
//    를 호출한다. 덕분에 DB 가 down 이어도 health/404/405/401(토큰없음) 은 정상 응답.
// ---------------------------------------------------------------------------
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

  // --- 헬스체크 (인증·DB 불필요: 프론트가 API 존재 감지용) ---
  if (pathname === '/api/health') {
    if (method !== 'GET') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    return sendJSON(res, 200, { ok: true, service: 'coffee-bean-mall-auth' });
  }

  // --- 회원가입 ---
  if (pathname === '/api/signup') {
    if (method !== 'POST') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    return signup(req, res);
  }

  // --- 로그인 ---
  if (pathname === '/api/login') {
    if (method !== 'POST') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    return login(req, res);
  }

  // --- 현재 사용자 (Bearer) ---
  if (pathname === '/api/me') {
    if (method !== 'GET') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    const authUser = requireAuth(req, res);
    if (!authUser) return; // 401 이미 응답됨
    return me(req, res, authUser);
  }

  // --- ImageKit 클라 업로드 서명 (Bearer 필수) ---
  //   로그인 유저만 업로드 서명을 받을 수 있다(무단 업로드 서명 발급 차단).
  if (pathname === '/api/imagekit/auth') {
    if (method !== 'GET') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    const authUser = requireAuth(req, res);
    if (!authUser) return; // 401 이미 응답됨
    return imagekitAuth(req, res, authUser);
  }

  // --- 프로필 사진 저장 (Bearer 필수) ---
  //   업로드 완료된 ImageKit url 을 내 계정 profile_image 에 저장.
  if (pathname === '/api/profile/photo') {
    if (method !== 'POST') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    const authUser = requireAuth(req, res);
    if (!authUser) return; // 401 이미 응답됨
    return updateProfilePhoto(req, res, authUser);
  }

  // --- 주문 목록/생성 (Bearer 필수) ---
  //   유효 메서드(GET/POST)면 인증 게이트로 진행 → 토큰 없으면 401.
  //   그 외 메서드는 인증 이전에 405(기존 하우스 스타일과 일관).
  if (pathname === '/api/orders') {
    if (method !== 'GET' && method !== 'POST') {
      return sendJSON(res, 405, { error: 'Method Not Allowed' });
    }
    const authUser = requireAuth(req, res);
    if (!authUser) return; // 401 이미 응답됨
    return method === 'POST'
      ? createOrder(req, res, authUser)
      : listOrders(req, res, authUser);
  }

  // --- 주문 상세 (Bearer 필수) — /api/orders/:id ---
  if (pathname.startsWith('/api/orders/')) {
    if (method !== 'GET') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    const authUser = requireAuth(req, res);
    if (!authUser) return; // 401 이미 응답됨
    const rawId = pathname.slice('/api/orders/'.length);
    return getOrder(req, res, authUser, rawId);
  }

  // --- 결제 설정: 공개 클라이언트 키 (인증 불필요) ---
  if (pathname === '/api/payments/config') {
    if (method !== 'GET') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    return paymentsConfig(req, res);
  }

  // --- 결제 준비 (Bearer 필수) ---
  if (pathname === '/api/payments/prepare') {
    if (method !== 'POST') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    const authUser = requireAuth(req, res);
    if (!authUser) return; // 401 이미 응답됨
    return preparePayment(req, res, authUser);
  }

  // --- 결제 승인 (Bearer 필수) ---
  if (pathname === '/api/payments/confirm') {
    if (method !== 'POST') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    const authUser = requireAuth(req, res);
    if (!authUser) return; // 401 이미 응답됨
    return confirmPayment(req, res, authUser);
  }

  return sendJSON(res, 404, { error: 'API Not Found' });
}

// ---------------------------------------------------------------------------
// 8) 서버 — /api 와 정적 경로 분기
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  let pathname = '/';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch (_) {
    return sendJSON(res, 400, { error: 'Bad Request' });
  }

  // --- API ---
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, pathname);
    } catch (err) {
      if (err.message === 'INVALID_JSON' || err.message === 'PAYLOAD_TOO_LARGE') {
        return sendJSON(res, 400, { error: '요청 본문이 올바르지 않습니다.' });
      }
      console.error('[API ERROR]', req.method, pathname, '-', err.message);
      if (!res.headersSent) {
        sendJSON(res, 500, { error: '서버 오류가 발생했습니다.' });
      }
    }
    return;
  }

  // --- 정적 (GET/HEAD 만) ---
  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(pathname, res);
  }
  return sendJSON(res, 405, { error: 'Method Not Allowed' });
});

// ---------------------------------------------------------------------------
// 9) 기동: 포트 점유 시 폴백(+1..+20). 리슨 성공 후 DB 연결 1회 확인(성공/실패만).
// ---------------------------------------------------------------------------
function start() {
  const basePort = PORT;
  const maxTries = 20;
  let current = basePort;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && current < basePort + maxTries) {
      current += 1;
      console.warn(`[server] 포트 ${current - 1} 사용 중 → ${current} 로 재시도`);
      server.listen(current);
    } else {
      console.error('[server] 서버 시작 실패:', err.message);
      process.exit(1);
    }
  });

  server.on('listening', () => {
    const actual = server.address().port;
    console.log(`[server] MERIDIAN 커피빈몰 인증 백엔드 실행 → http://localhost:${actual}`);
    console.log(`[toss] 결제 연동 활성화 — client key: ${TOSS_CLIENT_KEY.slice(0, 16)}… (secret 은 서버 전용, 비노출)`);
    console.log(`[imagekit] 프로필 사진 업로드 활성화 — endpoint: ${IMAGEKIT_URL_ENDPOINT} (private key 는 서버 전용, 비노출)`);
    console.log('[server] 팁: Live Server/npx serve 로 index.html 을 직접 열면 /api 가 없어 인증이 동작하지 않습니다. 반드시 이 서버로 접속하세요.');
    ensureDB()
      .then(() => console.log(`[db] Supabase Postgres 연결 및 스키마(${T_USERS}, ${T_ORDERS}) 준비 완료 (host: ${DB_CFG.host})`))
      .catch((err) =>
        console.error('[db] 연결 실패 — 첫 API 요청 시 재시도합니다. 원인:', err.message)
      );
  });

  server.listen(current);
}

// 로컬 실행 / 서버리스 export 듀얼 모드
if (require.main === module) {
  start();
}
module.exports = server;
