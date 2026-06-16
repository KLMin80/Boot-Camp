// ============================================================
// 오늘 할 일 · Todo  —  의존성 0 http 서버 + pg (Supabase PostgreSQL)
// ------------------------------------------------------------
// - 서버는 Node 내장 http 모듈만 사용 (Express 미사용)
// - 유일한 외부 의존성: pg
// - DB 자격증명은 .env 에서만 로드 (node --env-file=.env)
// - 정적 서빙은 화이트리스트 방식 → .env / server.js 등 비노출
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// ------------------------------------------------------------
// 1) 설정 / 환경변수
//    Node 20.6+/24 의 --env-file 로 .env 가 process.env 에 주입됨.
//    혹시 --env-file 없이 실행됐다면 loadEnvFile 로 보강 (의존성 0).
// ------------------------------------------------------------
if (!process.env.PGHOST && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(path.join(__dirname, '.env'));
  } catch (_) {
    /* .env 없으면 그냥 진행 (아래에서 검증) */
  }
}

const PORT = (process.env.PORT || '3000').trim();

// trailing newline / 공백 방지를 위해 모든 값에 .trim()
const env = (k) => (process.env[k] || '').trim();

// ------------------------------------------------------------
// 2) PostgreSQL 풀
//    ★ URL 문자열을 그대로 넘기지 않고 개별 필드로 분리.
//      비밀번호에 '@' / '!!' 가 있어 URL 파서가 깨지기 때문.
//    ★ 포트 6543 = 트랜잭션 풀러(Supavisor) → SSL 필수.
// ------------------------------------------------------------
const pool = new Pool({
  host: env('PGHOST'),
  port: Number(env('PGPORT')) || 6543,
  user: env('PGUSER'),
  password: env('PGPASSWORD'),
  database: env('PGDATABASE') || 'postgres',
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[pg] 유휴 클라이언트 오류:', err.message);
});

// ------------------------------------------------------------
// 3) 테이블 lazy 초기화 (1회만 실행)
// ------------------------------------------------------------
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS todos (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      text TEXT NOT NULL,
      done BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  dbInitialized = true;
  console.log('[db] todos 테이블 준비 완료');
}

// ------------------------------------------------------------
// 4) 응답 헬퍼
// ------------------------------------------------------------
function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function ok(res, data, status = 200) {
  sendJSON(res, status, { success: true, data });
}

function fail(res, status, message) {
  sendJSON(res, status, { success: false, message });
}

// 요청 본문(JSON) 파싱 — 최대 64KB
function readJSONBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) {
        tooLarge = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge) return reject(new Error('PAYLOAD_TOO_LARGE'));
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

// DB row → 프론트가 기대하는 todo 형태로 정규화
// { id, text, done, createdAt }  (id는 문자열로, createdAt은 epoch ms)
function toTodo(row) {
  return {
    id: String(row.id),
    text: row.text,
    done: row.done,
    createdAt: new Date(row.created_at).getTime(),
  };
}

// ------------------------------------------------------------
// 5) 정적 파일 서빙 (화이트리스트)
//    - '/' → index.html
//    - 허용 확장자 + 비-dotfile + 비-차단목록만 서빙
//    - 그 외/미존재 → index.html (SPA fallback, 파일 존재여부도 비노출)
//    → GET /.env, /server.js, /package.json 등은 절대 원본을 안 줌
// ------------------------------------------------------------
const PUBLIC_EXT = new Set(['.html', '.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.ico', '.json', '.map']);
const BLOCKED_BASENAMES = new Set(['server.js', 'package.json', 'package-lock.json', '.env']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function serveIndex(res) {
  const file = path.join(__dirname, 'index.html');
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('index.html 을 찾을 수 없습니다.');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buf);
  });
}

function serveStatic(req, res, pathname) {
  if (pathname === '/' || pathname === '/index.html') {
    return serveIndex(res);
  }

  const basename = path.basename(pathname);
  const ext = path.extname(pathname).toLowerCase();

  // dotfile / 차단목록 / 비허용 확장자 → 원본 노출 금지, index.html 로 폴백
  if (basename.startsWith('.') || BLOCKED_BASENAMES.has(basename) || !PUBLIC_EXT.has(ext)) {
    return serveIndex(res);
  }

  // 경로 탈출 방지: 해석된 절대경로가 __dirname 내부여야 함
  const resolved = path.join(__dirname, decodeURIComponent(pathname));
  if (resolved !== __dirname && !resolved.startsWith(__dirname + path.sep)) {
    return serveIndex(res);
  }

  fs.readFile(resolved, (err, buf) => {
    if (err) return serveIndex(res); // 미존재여도 존재여부 노출 없이 index 로
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ------------------------------------------------------------
// 6) API 핸들러
//    ★ 트랜잭션 풀러(6543)에서는 named prepared statement 회피.
//      일반 파라미터라이즈드 쿼리($1,$2)만 사용.
// ------------------------------------------------------------

// GET /api/todos  → 전체 목록, 최신순(created_at DESC, id DESC tiebreak)
async function listTodos(_req, res) {
  const { rows } = await pool.query(
    'SELECT id, text, done, created_at FROM todos ORDER BY created_at DESC, id DESC'
  );
  ok(res, rows.map(toTodo));
}

// POST /api/todos  body {text} → INSERT 후 생성된 row 반환
async function createTodo(req, res) {
  let body;
  try {
    body = await readJSONBody(req);
  } catch (e) {
    return fail(res, 400, e.message === 'PAYLOAD_TOO_LARGE' ? '요청이 너무 큽니다.' : '잘못된 JSON 형식입니다.');
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return fail(res, 400, '할 일 내용(text)이 비어 있습니다.');
  if (text.length > 500) return fail(res, 400, '할 일 내용이 너무 깁니다(최대 500자).');

  const { rows } = await pool.query(
    'INSERT INTO todos (text) VALUES ($1) RETURNING id, text, done, created_at',
    [text]
  );
  ok(res, toTodo(rows[0]), 201);
}

// PATCH /api/todos/:id  body {done} → done 갱신 후 갱신된 row 반환
async function updateTodo(req, res, id) {
  let body;
  try {
    body = await readJSONBody(req);
  } catch (e) {
    return fail(res, 400, e.message === 'PAYLOAD_TOO_LARGE' ? '요청이 너무 큽니다.' : '잘못된 JSON 형식입니다.');
  }
  if (typeof body.done !== 'boolean') {
    return fail(res, 400, 'done(boolean) 값이 필요합니다.');
  }
  const { rows } = await pool.query(
    'UPDATE todos SET done = $1 WHERE id = $2 RETURNING id, text, done, created_at',
    [body.done, id]
  );
  if (rows.length === 0) return fail(res, 404, '해당 할 일을 찾을 수 없습니다.');
  ok(res, toTodo(rows[0]));
}

// DELETE /api/todos/:id → 1건 삭제
async function deleteTodo(_req, res, id) {
  const { rows } = await pool.query(
    'DELETE FROM todos WHERE id = $1 RETURNING id',
    [id]
  );
  if (rows.length === 0) return fail(res, 404, '해당 할 일을 찾을 수 없습니다.');
  ok(res, { id: String(rows[0].id) });
}

// 완료 항목 일괄 삭제 (done=true 전부)
async function clearCompleted(_req, res) {
  const { rows } = await pool.query('DELETE FROM todos WHERE done = true RETURNING id');
  ok(res, { deleted: rows.length });
}

// ------------------------------------------------------------
// 7) 라우팅
// ------------------------------------------------------------
async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method;

  // /api/todos
  if (pathname === '/api/todos') {
    if (method === 'GET') return listTodos(req, res);
    if (method === 'POST') return createTodo(req, res);
    // DELETE /api/todos?completed=true → 완료 일괄삭제
    if (method === 'DELETE' && searchParams.get('completed') === 'true') {
      return clearCompleted(req, res);
    }
    return fail(res, 405, `허용되지 않은 메서드입니다: ${method}`);
  }

  // POST /api/todos/clear-completed (대체 경로)
  if (pathname === '/api/todos/clear-completed') {
    if (method === 'POST') return clearCompleted(req, res);
    return fail(res, 405, `허용되지 않은 메서드입니다: ${method}`);
  }

  // /api/todos/:id
  const m = pathname.match(/^\/api\/todos\/(\d+)$/);
  if (m) {
    const id = m[1]; // 문자열 그대로 $1 바인딩 → BIGINT 캐스팅은 pg가 처리
    if (method === 'PATCH' || method === 'PUT') return updateTodo(req, res, id);
    if (method === 'DELETE') return deleteTodo(req, res, id);
    return fail(res, 405, `허용되지 않은 메서드입니다: ${method}`);
  }

  return fail(res, 404, '존재하지 않는 API 경로입니다.');
}

// ------------------------------------------------------------
// 8) 서버
// ------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (_) {
    return fail(res, 400, '잘못된 요청 URL 입니다.');
  }

  // API 라우트
  if (url.pathname.startsWith('/api/')) {
    try {
      await initDB(); // lazy init (cold start 대응)
      await handleApi(req, res, url);
    } catch (err) {
      console.error('[api] 처리 중 오류:', err);
      if (!res.headersSent) fail(res, 500, '서버 내부 오류가 발생했습니다.');
    }
    return;
  }

  // 그 외 → 정적(화이트리스트)
  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res, url.pathname);
  }

  fail(res, 404, 'Not Found');
});

function start() {
  server.listen(PORT, () => {
    console.log(`Todo 서버 실행 중 → http://localhost:${PORT}`);
    // 시작 시 DB 연결/테이블을 미리 확인 (실패해도 서버는 떠 있음)
    initDB()
      .then(() => console.log('[db] Supabase 연결 및 초기화 성공'))
      .catch((err) => console.error('[db] 초기화 실패(요청 시 재시도):', err.message));
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`포트 ${PORT} 가 이미 사용 중입니다. PORT 환경변수로 다른 포트를 지정하세요.`);
      process.exit(1);
    }
    throw err;
  });
}

// 로컬: 서버 시작 / require 시: export
if (require.main === module) {
  start();
}
module.exports = server;
