// ============================================================================
// 마음 게시판 — 백엔드 서버 (server.js)
//   - 의존성: pg 만 사용. 정적 서빙/라우팅은 Node 내장 http 모듈로 직접 처리.
//   - DB: Supabase Postgres (트랜잭션 풀러 :6543, SSL 필수).
//   - 접속 URL(DB_URL)은 오직 .env 에서만 읽으며 절대 로그/응답에 노출하지 않음.
//   - 글/댓글은 DB에 저장되고, 좋아요는 DB에서 likes = likes + 1 로 누적 갱신된다.
// ============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// 1) 환경변수 로드 (node v20.6+/v24: process.loadEnvFile)
//    __dirname 기준으로 .env 를 찾으므로 실행 cwd 와 무관하게 동작한다.
//    이 앱은 DB_URL 만 사용한다. (.env 의 다른 키는 읽지 않음)
// ---------------------------------------------------------------------------
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (_) {
  // .env 가 이미 환경에 주입돼 있거나(예: 배포 플랫폼) 파일이 없을 수 있음 → 무시
}

const PORT = process.env.PORT || 3000;
const DB_URL = (process.env.DB_URL || '').trim(); // trailing newline 방지

if (!DB_URL) {
  // URL 값 자체는 출력하지 않고, "없음" 사실만 알림
  console.error('[FATAL] .env 의 DB_URL 이 설정되지 않았습니다. 서버를 시작할 수 없습니다.');
  process.exit(1);
}

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
// 3) 스키마 + 시드 (lazy init: 최초 1회만 실행, cold start 대응)
// ---------------------------------------------------------------------------
let dbReady = null; // Promise 캐시 — 동시 요청에도 init 1회만

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS posts (
        id         BIGSERIAL PRIMARY KEY,
        category   TEXT NOT NULL,            -- '고민' | '칭찬' | '응원'
        title      TEXT,
        body       TEXT NOT NULL,
        likes      INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS comments (
        id         BIGSERIAL PRIMARY KEY,
        post_id    BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        text       TEXT NOT NULL,
        likes      INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id)'
    );

    // --- 시드: posts 가 비어 있을 때만 1회 (index.html 의 getSeedPosts() 와 동일한 3글) ---
    //   created_at 은 now() - interval 로 시드의 상대시간을 재현(42분 전 / 3시간 전 / 26시간 전 등).
    //   글/댓글의 likes 초기값도 시드 값과 동일하게 맞춘다.
    const { rows } = await client.query('SELECT COUNT(*)::int AS c FROM posts');
    if (rows[0].c === 0) {
      const seedPosts = [
        {
          category: '고민',
          title: '요즘 진로 때문에 너무 막막해요',
          body: '남들은 다 길을 찾은 것 같은데 저만 제자리인 느낌이에요. 이런 시기 다들 어떻게 버티셨나요? 🥲',
          likes: 5,
          ageInterval: '42 minutes',
          comments: [
            {
              text: '저도 딱 그 시기 지나봤어요. 제자리처럼 느껴져도 사실 쉬어가는 중인 거예요. 너무 자책 말아요 🙂',
              likes: 4,
              ageInterval: '35 minutes',
            },
            {
              text: '조급해하지 않아도 괜찮아요. 응원할게요!',
              likes: 2,
              ageInterval: '20 minutes',
            },
          ],
        },
        {
          category: '칭찬',
          title: '오늘 작은 일을 해낸 나에게',
          body: '미루던 일을 드디어 끝냈어요. 별거 아닌 것 같아도 스스로 칭찬해주고 싶어서 남겨봅니다. 잘했어 나 자신! 🌸',
          likes: 12,
          ageInterval: '3 hours',
          comments: [
            {
              text: '작은 일을 해낸 게 제일 멋진 거예요. 정말 잘하셨어요 👏',
              likes: 6,
              ageInterval: '2 hours',
            },
          ],
        },
        {
          category: '응원',
          title: '',
          body: '지금 힘든 시간 보내고 계신 모든 분들, 오늘 하루도 버텨낸 것만으로 충분해요. 우리 같이 힘내요! 🌻',
          likes: 9,
          ageInterval: '26 hours',
          comments: [
            {
              text: '이 글 보고 위로받고 가요. 고마워요 🌻',
              likes: 5,
              ageInterval: '20 hours',
            },
            {
              text: '우리 같이 힘내요!! 오늘도 수고했어요.',
              likes: 3,
              ageInterval: '12 hours',
            },
          ],
        },
      ];

      for (const p of seedPosts) {
        // created_at 을 now() - interval 로 직접 지정해 시드 상대시간을 재현
        const inserted = await client.query(
          `INSERT INTO posts (category, title, body, likes, created_at)
           VALUES ($1, $2, $3, $4, now() - ($5)::interval)
           RETURNING id`,
          [p.category, p.title, p.body, p.likes, p.ageInterval]
        );
        const postId = inserted.rows[0].id;
        for (const c of p.comments) {
          await client.query(
            `INSERT INTO comments (post_id, text, likes, created_at)
             VALUES ($1, $2, $3, now() - ($4)::interval)`,
            [postId, c.text, c.likes, c.ageInterval]
          );
        }
      }
      console.log(`[seed] posts ${seedPosts.length}건 + 댓글 주입 완료`);
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
// 4.5) 행 → API 객체 매핑 (데이터 계약 함정 방지)
//   ⚠️ createdAt 은 반드시 JS 숫자(epoch milliseconds)로 반환한다.
//      클라이언트가 new Date(createdAt) 와 (b.createdAt - a.createdAt) 숫자 뺄셈을 하므로,
//      ISO 문자열/bigint-문자열을 주면 "Invalid Date" 로 깨진다.
//      pg 는 timestamptz 를 JS Date 객체로 주므로 .getTime() 으로 epoch ms 로 변환한다.
//   id(BIGSERIAL)는 pg 가 문자열로 줘도 OK — 클라이언트는 id 를 불투명하게 다룬다.
//   (단 같은 id 가 왕복되게만 하면 됨. 서버 라우팅에서 :id 는 Number()로 검증)
// ---------------------------------------------------------------------------
function mapComment(row) {
  return {
    id: row.id,
    text: row.text,
    likes: row.likes,
    createdAt: row.created_at.getTime(), // TIMESTAMPTZ(Date) → epoch ms
  };
}

function mapPost(row, comments) {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    body: row.body,
    likes: row.likes,
    createdAt: row.created_at.getTime(), // TIMESTAMPTZ(Date) → epoch ms
    comments, // [{ id, text, likes, createdAt }]
  };
}

// ---------------------------------------------------------------------------
// 5) 정적 서빙 — allowlist 방식
//    오직 index.html 만 서빙. 그 외 모든 경로(.env, package.json, *.png, .git ...)
//    는 404. path.basename 으로 디렉터리 성분을 제거하므로 /../ 트래버설도 무력화.
// ---------------------------------------------------------------------------
const STATIC_ALLOWLIST = new Set(['index.html']);

function serveStatic(pathname, res) {
  // '/' → index.html 로 매핑, 그 외엔 basename 만 추출(트래버설 방지)
  const requested = pathname === '/' ? 'index.html' : path.basename(decodeURIComponent(pathname));

  if (!STATIC_ALLOWLIST.has(requested)) {
    return sendJSON(res, 404, { error: 'Not Found' });
  }

  const filePath = path.join(__dirname, requested);
  fs.readFile(filePath, (err, data) => {
    if (err) return sendJSON(res, 404, { error: 'Not Found' });
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// 6) API 핸들러
// ---------------------------------------------------------------------------
const CATEGORIES = new Set(['고민', '칭찬', '응원']);

// GET /api/posts → 글 배열(각 글에 댓글 배열 포함). 최신 글 먼저.
//   json_agg 를 쓰면 타임스탬프가 ISO 문자열로 나와 깨지므로, JS 에서 배열을 조립한다.
async function listPosts(_req, res) {
  const postsResult = await pool.query(
    'SELECT id, category, title, body, likes, created_at FROM posts ORDER BY created_at DESC, id DESC'
  );
  const commentsResult = await pool.query(
    'SELECT id, post_id, text, likes, created_at FROM comments ORDER BY created_at ASC, id ASC'
  );

  // post_id 별로 댓글을 그룹핑 (작성순). post_id 는 문자열일 수 있으므로 String 키로 통일.
  const commentsByPost = new Map();
  for (const c of commentsResult.rows) {
    const key = String(c.post_id);
    if (!commentsByPost.has(key)) commentsByPost.set(key, []);
    commentsByPost.get(key).push(mapComment(c));
  }

  const posts = postsResult.rows.map((p) =>
    mapPost(p, commentsByPost.get(String(p.id)) || [])
  );
  sendJSON(res, 200, posts);
}

// POST /api/posts  { category, title, body } → 생성된 글 객체(likes 0, comments [])
async function createPost(req, res) {
  const body = await readJSONBody(req);

  const category = typeof body.category === 'string' ? body.category.trim() : '';
  if (!CATEGORIES.has(category)) {
    return sendJSON(res, 400, { error: "category 는 '고민' | '칭찬' | '응원' 중 하나여야 합니다." });
  }

  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!text) {
    return sendJSON(res, 400, { error: '본문(body)은 필수입니다.' });
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';

  const { rows } = await pool.query(
    `INSERT INTO posts (category, title, body)
     VALUES ($1, $2, $3)
     RETURNING id, category, title, body, likes, created_at`,
    [category, title, text]
  );
  // 새 글은 댓글 없이 시작 (likes 는 DEFAULT 0)
  sendJSON(res, 201, mapPost(rows[0], []));
}

// PATCH /api/posts/:id/like → likes = likes + 1 후 { likes } 반환
async function likePost(_req, res, id) {
  const { rows } = await pool.query(
    'UPDATE posts SET likes = likes + 1 WHERE id = $1 RETURNING likes',
    [id]
  );
  if (rows.length === 0) {
    return sendJSON(res, 404, { error: '해당 글을 찾을 수 없습니다.' });
  }
  sendJSON(res, 200, { likes: rows[0].likes });
}

// POST /api/posts/:id/comments  { text } → 생성된 댓글 객체 { id, text, likes, createdAt }
async function createComment(req, res, postId) {
  const body = await readJSONBody(req);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return sendJSON(res, 400, { error: '댓글 본문(text)은 필수입니다.' });
  }

  // 글 존재 확인 → 없으면 404 (FK 위반을 일반 500 으로 흘리지 않도록 명시적으로 처리)
  const exists = await pool.query('SELECT 1 FROM posts WHERE id = $1', [postId]);
  if (exists.rows.length === 0) {
    return sendJSON(res, 404, { error: '해당 글을 찾을 수 없습니다.' });
  }

  const { rows } = await pool.query(
    `INSERT INTO comments (post_id, text)
     VALUES ($1, $2)
     RETURNING id, text, likes, created_at`,
    [postId, text]
  );
  sendJSON(res, 201, mapComment(rows[0]));
}

// PATCH /api/posts/:id/comments/:commentId/like → 해당 댓글 likes = likes + 1 후 { likes }
async function likeComment(_req, res, postId, commentId) {
  const { rows } = await pool.query(
    'UPDATE comments SET likes = likes + 1 WHERE id = $1 AND post_id = $2 RETURNING likes',
    [commentId, postId]
  );
  if (rows.length === 0) {
    return sendJSON(res, 404, { error: '해당 댓글을 찾을 수 없습니다.' });
  }
  sendJSON(res, 200, { likes: rows[0].likes });
}

// ---------------------------------------------------------------------------
// 7) API 라우터 — /api/* 매칭 후 위 핸들러로 분기
//    라우팅/입력 검증을 먼저 수행해 DB 와 무관한 응답(404/405/400)은
//    DB 연결 상태와 관계없이 즉시 반환한다. DB 가 실제로 필요한 핸들러를
//    고른 뒤에만 ensureDB() 로 스키마/시드를 보장한다.
//    (이렇게 하면 DB 가 down 이어도 라우터가 옳다는 걸 404/405/400 으로 증명 가능)
// ---------------------------------------------------------------------------
function parseId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function handleApi(req, res, pathname) {
  const method = req.method;

  // 컬렉션 라우트: /api/posts
  if (pathname === '/api/posts') {
    if (method === 'GET') return ensureDB().then(() => listPosts(req, res));
    if (method === 'POST') return ensureDB().then(() => createPost(req, res));
    return sendJSON(res, 405, { error: 'Method Not Allowed' });
  }

  // PATCH /api/posts/:id/like
  let m = pathname.match(/^\/api\/posts\/([^/]+)\/like$/);
  if (m) {
    if (method !== 'PATCH') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    const id = parseId(m[1]);
    if (id === null) return sendJSON(res, 400, { error: '유효하지 않은 글 id 입니다.' });
    return ensureDB().then(() => likePost(req, res, id));
  }

  // PATCH /api/posts/:id/comments/:commentId/like
  m = pathname.match(/^\/api\/posts\/([^/]+)\/comments\/([^/]+)\/like$/);
  if (m) {
    if (method !== 'PATCH') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    const postId = parseId(m[1]);
    const commentId = parseId(m[2]);
    if (postId === null || commentId === null) {
      return sendJSON(res, 400, { error: '유효하지 않은 id 입니다.' });
    }
    return ensureDB().then(() => likeComment(req, res, postId, commentId));
  }

  // POST /api/posts/:id/comments
  m = pathname.match(/^\/api\/posts\/([^/]+)\/comments$/);
  if (m) {
    if (method !== 'POST') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    const postId = parseId(m[1]);
    if (postId === null) return sendJSON(res, 400, { error: '유효하지 않은 글 id 입니다.' });
    return ensureDB().then(() => createComment(req, res, postId));
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
// 9) 기동: DB 연결을 한 번 확인(성공/실패만 알림, URL 비노출) 후 listen
// ---------------------------------------------------------------------------
function start() {
  server.listen(PORT, () => {
    console.log(`[server] 마음 게시판 백엔드 실행 → http://localhost:${PORT}`);
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
