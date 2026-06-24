// ============================================================================
// 맛집/요리 커뮤니티 앱 — 백엔드 서버 (server.js)
//   - 의존성: pg(DB) + jsonwebtoken(JWT) + bcryptjs(비밀번호 해시).
//     정적 서빙/라우팅은 Node 내장 http 모듈로 직접 처리한다(Express 안 씀).
//   - DB: Supabase Postgres (트랜잭션 풀러 :6543, SSL 필수).
//   - 접속 URL(DB_URL)·JWT_SECRET 은 오직 .env 에서만 읽으며 절대 로그/응답에 노출하지 않음.
//   - 인증: JWT Bearer 토큰. 게시글은 조회조차 로그인 필요(전부 Bearer 보호).
//     수정/삭제는 WHERE id=$1 AND user_id=$2 로 본인 글만 매칭 → 남의 글은 404(존재 누출 없음).
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
//    이 앱은 DB_URL 과 JWT_SECRET 을 사용한다. (.env 의 다른 키는 읽지 않음)
// ---------------------------------------------------------------------------
const ENV_PATH = path.join(__dirname, '.env');
try {
  process.loadEnvFile(ENV_PATH);
} catch (_) {
  // .env 가 이미 환경에 주입돼 있거나(예: 배포 플랫폼) 파일이 없을 수 있음 → 무시
}

const PORT = Number(process.env.PORT) || 4000;
const DB_URL = (process.env.DB_URL || '').trim(); // trailing newline 방지

if (!DB_URL) {
  // URL 값 자체는 출력하지 않고, "없음" 사실만 알림
  console.error('[FATAL] .env 의 DB_URL 이 설정되지 않았습니다. 서버를 시작할 수 없습니다.');
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
      // .env 가 없으면 새로 만든다(이 앱은 DB_URL 이 필수라 위에서 이미 걸러짐).
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
//   범용 이름(posts/users)은 다른 퀘스트와 충돌한다 — 예: week-4 마음게시판이 만든
//   posts 는 스키마가 전혀 다르다(category/body/likes, user_id·content 없음, 실데이터 보유).
//   CREATE TABLE IF NOT EXISTS 는 기존 테이블이 있으면 스킵되므로, 우리가 가정한
//   컬럼(user_id/content)이 없어 인덱스·INSERT 가 'column does not exist' 로 깨진다.
//   → 이 앱 전용 테이블은 community_ prefix 로 격리한다.
//   ⚠️ 단일 출처: 모든 쿼리는 아래 상수를 템플릿 리터럴로 참조한다(이름 누락 방지).
//   ⚠️ 기존 타 퀘스트 테이블은 절대 건드리지 않는다(DROP/ALTER 금지, 데이터 보존).
// ---------------------------------------------------------------------------
const T_USERS = 'community_users';
const T_POSTS = 'community_posts';

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
// 3) 스키마 (lazy init: 최초 1회만 실행, cold start 대응) — 시드 없음(빈 상태로 시작)
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
      CREATE TABLE IF NOT EXISTS ${T_POSTS} (
        id          BIGSERIAL PRIMARY KEY,
        user_id     BIGINT NOT NULL REFERENCES ${T_USERS}(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        content     TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_community_posts_user_id ON ${T_POSTS}(user_id)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_community_posts_created_at ON ${T_POSTS}(created_at DESC, id DESC)`
    );
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
// 4.5) 행 → API 객체 매핑 (데이터 계약 함정 방지)
//   ⚠️ createdAt 은 반드시 JS 숫자(epoch milliseconds)로 반환한다.
//      클라이언트가 new Date(createdAt) / 숫자 정렬을 하므로, ISO 문자열·bigint-문자열을
//      주면 "Invalid Date" 로 깨진다. pg 는 TIMESTAMPTZ 를 JS Date 로 주므로 .getTime() 으로 변환.
//   ⚠️ authorName 은 작성자 이메일의 아이디(@ 앞부분)만 노출한다.
//      다른 사용자의 전체 이메일은 절대 응답에 넣지 않는다(authorName + authorId 만).
//      authorId 는 클라이언트가 "내 글" 여부를 판별하는 데 쓴다.
//   id/authorId(BIGSERIAL)는 pg 가 문자열로 줘도 OK — 클라이언트는 불투명하게 왕복만 한다.
//   password_hash 는 절대 매핑/노출하지 않는다.
// ---------------------------------------------------------------------------
function authorNameFromEmail(email) {
  // 이메일 아이디(로컬파트)만. 비정상 값이어도 안전하게 처리.
  return typeof email === 'string' ? email.split('@')[0] : '';
}

function mapPost(row) {
  // row 는 posts JOIN users 결과: id, title, content, user_id, author_email, created_at
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    authorId: row.user_id,
    authorName: authorNameFromEmail(row.author_email),
    createdAt: row.created_at.getTime(), // TIMESTAMPTZ(Date) → epoch ms
  };
}

function publicUser(row) {
  // 응답에 내보낼 수 있는 user 형태 — email 과 id 만. password_hash 절대 포함 금지.
  return { id: row.id, email: row.email };
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
//    오직 index.html 만 서빙. 그 외 모든 경로(.env, package.json, server.js, *.png, .git ...)
//    는 404. path.basename 으로 디렉터리 성분을 제거하므로 /../ 트래버설도 무력화된다.
// ---------------------------------------------------------------------------
const STATIC_ALLOWLIST = new Set(['index.html']);

// ⚠️ Vercel(@vercel/nft) 파일 트레이싱 대비: index.html 경로를 "리터럴"로 고정한다.
//    런타임에 변수 경로(path.join(__dirname, 변수))로만 읽으면 nft 가 정적 분석을 못 해
//    함수 번들에서 index.html 이 빠지고, 배포 환경에서 GET / 가 404 가 된다.
//    allowlist 가 index.html 단일이므로 통과 시 읽을 파일은 항상 이 경로다.
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
// 6.5) API 핸들러 — 게시글 (전부 Bearer 보호, 조회조차 로그인 필요)
//   posts 를 users 와 JOIN 해 author_email 을 얻고 authorName(아이디)만 노출한다.
//   소유권은 SQL(WHERE id=$1 AND user_id=$2)로 강제 → 남의 글은 매칭 자체가 안 돼 404.
// ---------------------------------------------------------------------------

// 단건 조회 공통 쿼리: 작성자 이메일 JOIN 포함. id 로 1건.
async function fetchPostById(id) {
  const { rows } = await pool.query(
    `SELECT p.id, p.title, p.content, p.user_id, u.email AS author_email, p.created_at
       FROM ${T_POSTS} p
       JOIN ${T_USERS} u ON u.id = p.user_id
      WHERE p.id = $1`,
    [id]
  );
  return rows[0] || null;
}

// GET /api/posts → 200 [{ id, title, content, authorId, authorName, createdAt }]  (최신순)
async function listPosts(_req, res) {
  const { rows } = await pool.query(
    `SELECT p.id, p.title, p.content, p.user_id, u.email AS author_email, p.created_at
       FROM ${T_POSTS} p
       JOIN ${T_USERS} u ON u.id = p.user_id
      ORDER BY p.created_at DESC, p.id DESC`
  );
  sendJSON(res, 200, rows.map(mapPost));
}

// GET /api/posts/:id → 200 { ...post } | 404
async function getPost(_req, res, id) {
  const row = await fetchPostById(id);
  if (!row) {
    return sendJSON(res, 404, { error: '해당 게시글을 찾을 수 없습니다.' });
  }
  sendJSON(res, 200, mapPost(row));
}

// POST /api/posts  { title, content } → 201 { ...post }  (title/content 공백이면 400)
async function createPost(req, res, authUser) {
  const body = await readJSONBody(req);
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';

  if (!title) {
    return sendJSON(res, 400, { error: '제목(title)은 필수입니다.' });
  }
  if (!content) {
    return sendJSON(res, 400, { error: '내용(content)은 필수입니다.' });
  }

  const inserted = await pool.query(
    `INSERT INTO ${T_POSTS} (user_id, title, content)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [authUser.id, title, content]
  );
  // 작성자 이메일(아이디)을 포함해 동일 형태로 돌려주기 위해 JOIN 조회로 다시 읽는다.
  const row = await fetchPostById(inserted.rows[0].id);
  sendJSON(res, 201, mapPost(row));
}

// PATCH /api/posts/:id  { title?, content? } → 200 { ...post }
//   본인 글만(WHERE id=$1 AND user_id=$2). 없거나 남의 글이면 404. 빈 값이면 400.
async function updatePost(req, res, authUser, id) {
  const body = await readJSONBody(req);

  const sets = [];
  const params = [];
  let n = 1;

  if (Object.prototype.hasOwnProperty.call(body, 'title')) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      return sendJSON(res, 400, { error: '제목(title)은 비어 있을 수 없습니다.' });
    }
    sets.push(`title = $${n++}`);
    params.push(title);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'content')) {
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content) {
      return sendJSON(res, 400, { error: '내용(content)은 비어 있을 수 없습니다.' });
    }
    sets.push(`content = $${n++}`);
    params.push(content);
  }

  // 변경할 필드가 없으면 400 (게시글 PATCH 는 최소 한 필드 필요).
  if (sets.length === 0) {
    return sendJSON(res, 400, { error: '수정할 내용(title 또는 content)이 필요합니다.' });
  }

  // WHERE 에 user_id 를 함께 걸어 남의 글은 매칭 자체가 안 되게 한다(404, 존재 누출 없음).
  params.push(id, authUser.id);
  const updated = await pool.query(
    `UPDATE ${T_POSTS} SET ${sets.join(', ')}
      WHERE id = $${n++} AND user_id = $${n++}
      RETURNING id`,
    params
  );
  if (updated.rows.length === 0) {
    return sendJSON(res, 404, { error: '해당 게시글을 찾을 수 없습니다.' });
  }
  // 동일 형태(작성자 포함)로 응답하기 위해 JOIN 조회로 다시 읽는다.
  const row = await fetchPostById(updated.rows[0].id);
  sendJSON(res, 200, mapPost(row));
}

// DELETE /api/posts/:id → 200 { ok:true }  (없거나 남의 글이면 404)
async function deletePost(_req, res, authUser, id) {
  const { rows } = await pool.query(
    `DELETE FROM ${T_POSTS} WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, authUser.id]
  );
  if (rows.length === 0) {
    return sendJSON(res, 404, { error: '해당 게시글을 찾을 수 없습니다.' });
  }
  sendJSON(res, 200, { ok: true });
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

  // --- 게시글 컬렉션: /api/posts (Bearer) — GET(목록) / POST(작성) ---
  if (pathname === '/api/posts') {
    const authUser = requireAuth(req, res);
    if (!authUser) return; // 401 이미 응답됨
    if (method === 'GET') return ensureDB().then(() => listPosts(req, res));
    if (method === 'POST') return ensureDB().then(() => createPost(req, res, authUser));
    return sendJSON(res, 405, { error: 'Method Not Allowed' });
  }

  // --- 게시글 단건: /api/posts/:id (Bearer) — GET / PATCH(본인) / DELETE(본인) ---
  const m = pathname.match(/^\/api\/posts\/([^/]+)$/);
  if (m) {
    if (method !== 'GET' && method !== 'PATCH' && method !== 'DELETE') {
      return sendJSON(res, 405, { error: 'Method Not Allowed' });
    }
    const authUser = requireAuth(req, res);
    if (!authUser) return; // 401 이미 응답됨
    const id = parseId(m[1]);
    if (id === null) return sendJSON(res, 400, { error: '유효하지 않은 게시글 id 입니다.' });
    if (method === 'GET') return ensureDB().then(() => getPost(req, res, id));
    if (method === 'PATCH') return ensureDB().then(() => updatePost(req, res, authUser, id));
    return ensureDB().then(() => deletePost(req, res, authUser, id));
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
    console.log(`[server] 맛집/요리 커뮤니티 백엔드 실행 → ${url}`);
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
