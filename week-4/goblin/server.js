// ============================================================
// 메모장 앱 백엔드 서버
//   - Node.js 내장 http 모듈 (외부 의존성은 pg 하나뿐)
//   - Supabase PostgreSQL(transaction pooler, 6543) 연결
//   - REST API + index.html 정적 서빙(allowlist 방식)
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// ------------------------------------------------------------
// 0) .env 로드 (의존성 추가 없이 직접 파싱)
//    __dirname 기준으로 읽으므로 실행 위치(cwd)와 무관하다.
// ------------------------------------------------------------
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // 양끝 따옴표 제거
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

const PORT = process.env.PORT || 3000;

// trailing newline 등으로 인한 접속 문자열 오염 방지
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL이 설정되지 않았습니다. .env 파일을 확인하세요.');
  process.exit(1);
}

// ------------------------------------------------------------
// 1) DB 연결 (Supabase pooler는 SSL 필수)
// ------------------------------------------------------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  // 유휴 클라이언트에서 발생한 예기치 못한 오류로 프로세스가 죽지 않도록
  console.error('⚠️  예기치 못한 DB 풀 오류:', err.message);
});

// 서버 시작 시 notes 테이블 보장 (lazy init: 중복 실행 방지)
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      id         BIGSERIAL PRIMARY KEY,
      title      TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  dbInitialized = true;
}

// DB 행 → 프론트엔드 호환 형태로 변환
//   createdAt/updatedAt 을 epoch milliseconds(숫자)로 반환해
//   기존 index.html의 숫자 정렬/ new Date() 로직을 그대로 유지한다.
function rowToNote(row) {
  return {
    id: String(row.id), // 프론트는 id를 문자열로 사용해 왔으므로 문자열로 통일
    title: row.title,
    content: row.content,
    createdAt: Number(row.created_ms),
    updatedAt: Number(row.updated_ms),
  };
}

// SELECT 시 epoch ms 컬럼을 함께 뽑기 위한 공통 컬럼 목록
const SELECT_COLS = `
  id,
  title,
  content,
  (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS created_ms,
  (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS updated_ms
`;

// ------------------------------------------------------------
// 2) 응답 헬퍼 (일관된 JSON 구조)
// ------------------------------------------------------------
function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendOk(res, data, status = 200) {
  sendJSON(res, status, { success: true, data });
}

function sendErr(res, status, message) {
  sendJSON(res, status, { success: false, message });
}

// 요청 본문(JSON) 파싱 (크기 제한 포함)
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) {
        // 1MB 초과 시 중단
        tooBig = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return reject(new Error('PAYLOAD_TOO_LARGE'));
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

// title/content 검증 → 정제된 값 또는 에러 메시지 반환
function validateNoteInput(body) {
  if (!body || typeof body !== 'object') {
    return { error: '요청 본문이 올바르지 않습니다.' };
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!title) return { error: '제목을 입력해 주세요.' };
  if (!content) return { error: '내용을 입력해 주세요.' };
  if (title.length > 200) return { error: '제목은 200자 이내로 입력해 주세요.' };
  return { title, content };
}

// ------------------------------------------------------------
// 3) 정적 파일 서빙 (allowlist 방식)
//    - '/' 와 '/index.html' → index.html 만 허용
//    - 그 외 비-API 경로는 모두 index.html 로 폴백(SPA 친화 + 파일 존재 여부도 노출 안 함)
//    - .env / server.js / package.json 등은 절대 내려가지 않음
// ------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

// HTTP로 노출을 허용하는 정적 파일 화이트리스트 (basename 기준)
const PUBLIC_FILES = new Set(['index.html']);

function serveStatic(req, res, pathname) {
  // 기본 경로 → index.html
  let basename;
  if (pathname === '/' || pathname === '/index.html') {
    basename = 'index.html';
  } else {
    // 선행 슬래시 제거 후 basename만 추출 (디렉터리 구성요소 무시 → traversal 차단)
    basename = path.basename(pathname);
  }

  // 화이트리스트에 없으면 파일을 노출하지 않고 index.html 로 폴백
  if (!PUBLIC_FILES.has(basename)) {
    basename = 'index.html';
  }

  const filePath = path.join(__dirname, basename);

  // 경로 탈출 방지: 최종 경로가 반드시 __dirname 내부여야 함
  const resolved = path.resolve(filePath);
  if (resolved !== path.resolve(__dirname, basename)) {
    return sendErr(res, 403, '접근이 거부되었습니다.');
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      return sendErr(res, 404, '파일을 찾을 수 없습니다.');
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

// ------------------------------------------------------------
// 4) API 라우팅
// ------------------------------------------------------------
async function handleApi(req, res, pathname) {
  // 모든 API 요청 전에 테이블 보장 (cold start 대응)
  await initDB();

  const method = req.method;

  // /api/notes
  if (pathname === '/api/notes') {
    if (method === 'GET') {
      const result = await pool.query(
        `SELECT ${SELECT_COLS} FROM notes ORDER BY updated_at DESC, created_at DESC`
      );
      return sendOk(res, result.rows.map(rowToNote));
    }

    if (method === 'POST') {
      const body = await readBody(req);
      const v = validateNoteInput(body);
      if (v.error) return sendErr(res, 400, v.error);
      const result = await pool.query(
        `INSERT INTO notes (title, content) VALUES ($1, $2)
         RETURNING ${SELECT_COLS}`,
        [v.title, v.content]
      );
      return sendOk(res, rowToNote(result.rows[0]), 201);
    }

    return sendErr(res, 405, '허용되지 않은 메서드입니다.');
  }

  // /api/notes/:id
  const m = pathname.match(/^\/api\/notes\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    // id는 숫자(BIGSERIAL)여야 함
    if (!/^\d+$/.test(id)) {
      return sendErr(res, 400, '올바르지 않은 메모 ID입니다.');
    }

    if (method === 'PUT' || method === 'PATCH') {
      const body = await readBody(req);
      const v = validateNoteInput(body);
      if (v.error) return sendErr(res, 400, v.error);
      const result = await pool.query(
        `UPDATE notes
            SET title = $1, content = $2, updated_at = now()
          WHERE id = $3
        RETURNING ${SELECT_COLS}`,
        [v.title, v.content, id]
      );
      if (result.rowCount === 0) {
        return sendErr(res, 404, '메모를 찾을 수 없습니다.');
      }
      return sendOk(res, rowToNote(result.rows[0]));
    }

    if (method === 'DELETE') {
      const result = await pool.query(
        `DELETE FROM notes WHERE id = $1 RETURNING id`,
        [id]
      );
      if (result.rowCount === 0) {
        return sendErr(res, 404, '메모를 찾을 수 없습니다.');
      }
      return sendOk(res, { id });
    }

    return sendErr(res, 405, '허용되지 않은 메서드입니다.');
  }

  return sendErr(res, 404, 'API 경로를 찾을 수 없습니다.');
}

// ------------------------------------------------------------
// 5) 서버
// ------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURI(new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname);
  } catch (e) {
    return sendErr(res, 400, '잘못된 요청 경로입니다.');
  }

  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
    } else {
      serveStatic(req, res, pathname);
    }
  } catch (err) {
    // 본문 파싱 오류 등은 400, 그 외는 500
    if (err && err.message === 'INVALID_JSON') {
      return sendErr(res, 400, 'JSON 형식이 올바르지 않습니다.');
    }
    if (err && err.message === 'PAYLOAD_TOO_LARGE') {
      return sendErr(res, 413, '요청 본문이 너무 큽니다.');
    }
    console.error('💥 서버 오류:', err);
    if (!res.headersSent) {
      sendErr(res, 500, '서버 내부 오류가 발생했습니다.');
    }
  }
});

// 로컬 실행 시 서버 시작 / 서버리스 환경에서는 export
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`✅ 메모장 서버 실행 중 → http://localhost:${PORT}`);
  });
}

module.exports = server;
