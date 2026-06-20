// ============================================================================
// 밸런스 게임(양자택일 투표) — 백엔드 서버 (server.js)
//   - 의존성: pg 만 사용. 정적 서빙/라우팅은 Node 내장 http 모듈로 직접 처리.
//   - DB: Supabase Postgres (트랜잭션 풀러 :6543, SSL 필수).
//   - 접속 URL(DB_URL)은 오직 .env 에서만 읽으며 절대 로그/응답에 노출하지 않음.
//   - 핵심: 투표(votes)는 행으로 쌓고, 비율은 SQL COUNT 로 집계해서 돌려준다.
//           (퍼센트 나눗셈 percentA = a/(a+b) 는 클라이언트가 한다. 서버는 COUNT 까지.)
// ============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// 1) 환경변수 로드 (node v20.6+/v24: process.loadEnvFile)
//    __dirname 기준으로 .env 를 찾으므로 실행 cwd 와 무관하게 동작한다.
//    이 앱은 DB_URL 만 사용한다. (.env 의 다른 키는 읽지 않으며, .env 는 절대 덮어쓰지 않음)
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
//    questions(질문) + votes(개별 투표 1행 = 1표). 비율은 votes 를 COUNT 해서 낸다.
// ---------------------------------------------------------------------------
let dbReady = null; // Promise 캐시 — 동시 요청에도 init 1회만

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS questions (
        id         BIGSERIAL PRIMARY KEY,
        option_a   TEXT NOT NULL,
        option_b   TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS votes (
        id          BIGSERIAL PRIMARY KEY,
        question_id BIGINT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
        choice      TEXT NOT NULL CHECK (choice IN ('A','B')),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_votes_question_id ON votes(question_id)'
    );

    // --- 시드: questions 가 비어 있을 때만 1회 (첫 화면에서 막대가 바로 보이도록) ---
    //   created_at 은 now() - interval 로 상대시간(5시간 전/2시간 전/30분 전)을 재현.
    //   각 질문의 A/B 표는 generate_series 로 votes 에 실제 행을 만들어 넣는다.
    //   (즉 시드도 "투표 행"으로 들어가므로, 목록 조회 시의 COUNT 집계 경로와 100% 동일하다.)
    const { rows } = await client.query('SELECT COUNT(*)::int AS c FROM questions');
    if (rows[0].c === 0) {
      const seed = [
        {
          optionA: '월급 500만원 + 주 7일 출근',
          optionB: '월급 300만원 + 주 4일 출근',
          aCount: 12,
          bCount: 30,
          ageInterval: '5 hours',
        },
        {
          optionA: '평생 치킨만 먹기',
          optionB: '평생 피자만 먹기',
          aCount: 21,
          bCount: 14,
          ageInterval: '2 hours',
        },
        {
          optionA: '10억 받고 무인도에서 1년 살기',
          optionB: '그냥 지금처럼 살기',
          aCount: 18,
          bCount: 9,
          ageInterval: '30 minutes',
        },
      ];

      for (const q of seed) {
        // 질문 1건 삽입 (created_at 을 now() - interval 로 직접 지정해 상대시간 재현)
        const inserted = await client.query(
          `INSERT INTO questions (option_a, option_b, created_at)
           VALUES ($1, $2, now() - ($3)::interval)
           RETURNING id`,
          [q.optionA, q.optionB, q.ageInterval]
        );
        const questionId = inserted.rows[0].id;

        // A 표 / B 표를 generate_series 로 votes 에 실제 행으로 주입 (0표면 건너뜀)
        if (q.aCount > 0) {
          await client.query(
            `INSERT INTO votes (question_id, choice)
             SELECT $1, 'A' FROM generate_series(1, $2)`,
            [questionId, q.aCount]
          );
        }
        if (q.bCount > 0) {
          await client.query(
            `INSERT INTO votes (question_id, choice)
             SELECT $1, 'B' FROM generate_series(1, $2)`,
            [questionId, q.bCount]
          );
        }
      }
      console.log(`[seed] questions ${seed.length}건 + 투표 표 주입 완료`);
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
//      클라이언트가 new Date(createdAt) 로 상대시간을 그리므로,
//      ISO 문자열/bigint-문자열을 주면 "Invalid Date" 로 깨진다.
//      pg 는 timestamptz 를 JS Date 객체로 주므로 .getTime() 으로 epoch ms 로 변환.
//   ⚠️ aCount/bCount 는 SQL 에서 ::int 로 캐스팅해 받으므로 JS 숫자다.
//      (pg 는 캐스팅 안 된 COUNT(bigint)를 문자열로 주기 때문에 SQL 쪽에서 ::int 필수)
//   id(BIGSERIAL)는 pg 가 문자열로 줘도 OK — 클라이언트는 id 를 불투명하게 다룬다.
//      (단 같은 id 가 왕복되게만 하면 됨. 서버 라우팅에서 :id 는 Number()로 검증)
//   응답 필드는 전부 camelCase: optionA/optionB/aCount/bCount/createdAt.
// ---------------------------------------------------------------------------
function mapQuestion(row) {
  return {
    id: row.id,
    optionA: row.option_a,
    optionB: row.option_b,
    aCount: row.a_count, // SQL 에서 ::int 캐스팅된 숫자
    bCount: row.b_count, // SQL 에서 ::int 캐스팅된 숫자
    createdAt: row.created_at.getTime(), // TIMESTAMPTZ(Date) → epoch ms
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

// GET /api/questions → 질문 배열(최신순). 각 질문에 A/B 표(COUNT 집계) 포함.
//   LEFT JOIN + GROUP BY + COUNT FILTER 로 한 번에 A/B 표를 센다.
//   COUNT 결과는 ::int 로 캐스팅해 JS 숫자로 받는다.
async function listQuestions(_req, res) {
  const { rows } = await pool.query(`
    SELECT q.id, q.option_a, q.option_b, q.created_at,
           COUNT(v.id) FILTER (WHERE v.choice = 'A')::int AS a_count,
           COUNT(v.id) FILTER (WHERE v.choice = 'B')::int AS b_count
    FROM questions q
    LEFT JOIN votes v ON v.question_id = q.id
    GROUP BY q.id
    ORDER BY q.created_at DESC, q.id DESC
  `);
  sendJSON(res, 200, rows.map(mapQuestion));
}

// POST /api/questions  { optionA, optionB } → 생성된 질문 객체(aCount 0, bCount 0)
//   검증: optionA/optionB 둘 다 string, trim 후 1~100자.
async function createQuestion(req, res) {
  const body = await readJSONBody(req);

  const optionA = typeof body.optionA === 'string' ? body.optionA.trim() : '';
  const optionB = typeof body.optionB === 'string' ? body.optionB.trim() : '';

  if (optionA.length < 1 || optionA.length > 100) {
    return sendJSON(res, 400, { error: 'optionA 는 1~100자의 문자열이어야 합니다.' });
  }
  if (optionB.length < 1 || optionB.length > 100) {
    return sendJSON(res, 400, { error: 'optionB 는 1~100자의 문자열이어야 합니다.' });
  }

  const { rows } = await pool.query(
    `INSERT INTO questions (option_a, option_b)
     VALUES ($1, $2)
     RETURNING id, option_a, option_b, created_at`,
    [optionA, optionB]
  );
  // 새 질문은 아직 투표가 없으므로 a_count/b_count 를 0 으로 채워 매핑한다.
  const row = { ...rows[0], a_count: 0, b_count: 0 };
  sendJSON(res, 201, mapQuestion(row));
}

// POST /api/questions/:id/vote  { choice: "A"|"B" } → 반영 후 최신 { aCount, bCount }
//   순서: ① 질문 존재 확인(없으면 404) → ② votes 1행 INSERT → ③ 해당 질문 표를 다시 COUNT.
async function vote(req, res, questionId) {
  const body = await readJSONBody(req);
  const choice = typeof body.choice === 'string' ? body.choice : '';
  if (choice !== 'A' && choice !== 'B') {
    return sendJSON(res, 400, { error: "choice 는 'A' 또는 'B' 여야 합니다." });
  }

  // ① 질문 존재 확인 → 없으면 404 (FK 위반을 일반 500 으로 흘리지 않도록 명시적으로 처리)
  const exists = await pool.query('SELECT 1 FROM questions WHERE id = $1', [questionId]);
  if (exists.rows.length === 0) {
    return sendJSON(res, 404, { error: '해당 질문을 찾을 수 없습니다.' });
  }

  // ② 투표 1행 INSERT (1행 = 1표)
  await pool.query(
    'INSERT INTO votes (question_id, choice) VALUES ($1, $2)',
    [questionId, choice]
  );

  // ③ 해당 질문의 최신 A/B 표를 다시 COUNT 해서 반환 (::int 로 숫자 캐스팅)
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE choice = 'A')::int AS a_count,
            COUNT(*) FILTER (WHERE choice = 'B')::int AS b_count
     FROM votes WHERE question_id = $1`,
    [questionId]
  );
  sendJSON(res, 200, { aCount: rows[0].a_count, bCount: rows[0].b_count });
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

  // 컬렉션 라우트: /api/questions
  if (pathname === '/api/questions') {
    if (method === 'GET') return ensureDB().then(() => listQuestions(req, res));
    if (method === 'POST') return ensureDB().then(() => createQuestion(req, res));
    return sendJSON(res, 405, { error: 'Method Not Allowed' });
  }

  // POST /api/questions/:id/vote
  const m = pathname.match(/^\/api\/questions\/([^/]+)\/vote$/);
  if (m) {
    if (method !== 'POST') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    const id = parseId(m[1]); // :id 는 Number()로 검증(양의 정수 아니면 400)
    if (id === null) return sendJSON(res, 400, { error: '유효하지 않은 질문 id 입니다.' });
    return ensureDB().then(() => vote(req, res, id));
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
    console.log(`[server] 밸런스 게임 백엔드 실행 → http://localhost:${PORT}`);
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
