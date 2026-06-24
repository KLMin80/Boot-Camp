// ============================================================================
// 가계부(Household Budget) — 백엔드 서버 (server.js)
//   - 의존성: pg 만 사용. 정적 서빙/라우팅은 Node 내장 http 모듈로 직접 처리(Express 안 씀).
//   - DB: Supabase Postgres (트랜잭션 풀러 :6543, SSL 필수).
//   - 접속 URL(DB_URL)은 오직 .env 에서만 읽으며 절대 로그/응답에 노출하지 않음.
//   - 인증 없음(익명 단일 데이터셋). .env 의 JWT_SECRET 은 이 앱에서 사용하지 않는다.
//   - 핵심: 거래(transactions)를 행으로 쌓고, 카테고리별 합계/요약을 전부 SQL 집계(GROUP BY)로
//           계산해서 돌려준다. SUM 은 ::float8, COUNT 는 ::int 로 캐스팅(미캐스팅 시 문자열 → 클라 NaN).
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
const DB_URL = (process.env.DB_URL || '').trim(); // trailing newline/CR 방지

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
// 3) 도메인 상수 — 카테고리 화이트리스트.
//    프론트(index.html)의 카테고리 id 와 100% 동일해야 한다(검증에 사용).
//    ⚠️ 클라이언트의 라벨/아이콘/색은 서버가 몰라도 됨 — 서버는 id 만 안다.
//    amount 단위는 원(KRW) 양의 정수.
// ---------------------------------------------------------------------------
const EXPENSE_CATEGORIES = [
  'food',
  'transport',
  'housing',
  'subscribe',
  'event',
  'shopping',
  'medical',
  'culture',
  'etc',
];
const INCOME_CATEGORIES = ['salary', 'bonus', 'side', 'invest', 'etc'];

const EXPENSE_SET = new Set(EXPENSE_CATEGORIES);
const INCOME_SET = new Set(INCOME_CATEGORIES);

// type 별 허용 카테고리 집합을 돌려준다.
function categorySetFor(type) {
  return type === 'income' ? INCOME_SET : EXPENSE_SET;
}

// amount 안전 상한(원). 천문학적 입력/오타로 BIGINT 를 넘는 값을 컷.
const MAX_AMOUNT = 1_000_000_000_000; // 1조 원

// ---------------------------------------------------------------------------
// 4) 스키마 (lazy init: 최초 1회만 실행, cold start 대응)
//    transactions: 익명 거래 1건 = 1행. budgets: expense 카테고리별 예산 1행.
// ---------------------------------------------------------------------------
let dbReady = null; // Promise 캐시 — 동시 요청에도 init 1회만

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id          BIGSERIAL PRIMARY KEY,
        type        TEXT NOT NULL CHECK (type IN ('income','expense')),
        txn_date    DATE NOT NULL,
        amount      BIGINT NOT NULL CHECK (amount > 0),
        category    TEXT NOT NULL,
        memo        TEXT NOT NULL DEFAULT '',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS budgets (
        category    TEXT PRIMARY KEY,
        amount      BIGINT NOT NULL CHECK (amount >= 0),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(txn_date)'
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type)'
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
// 5) HTTP 유틸
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
// 6) 행 → API 객체 매핑 (데이터 계약 함정 방지)
//   ⚠️ date 는 SQL 에서 to_char(txn_date,'YYYY-MM-DD') 로 이미 문자열로 받아온다.
//      (JS Date 로 받으면 타임존 때문에 하루 밀림 → 반드시 SELECT 에서 문자열로.)
//   ⚠️ amount 는 BIGINT → pg 가 문자열로 주므로 Number(...) 로 숫자 변환.
//   ⚠️ createdAt 은 TIMESTAMPTZ(Date) → .getTime() 으로 epoch ms(숫자) 변환.
//      ISO 문자열/bigint-문자열을 주면 클라에서 "Invalid Date" 로 깨진다.
//   id(BIGSERIAL)는 pg 가 문자열로 줘도 OK — 클라이언트는 id 를 불투명하게 다룬다(왕복만).
//   ※ 이 매퍼를 쓰는 모든 SELECT 는 date 컬럼을 'YYYY-MM-DD' 문자열 alias 로 내려보내야 한다.
// ---------------------------------------------------------------------------
function mapTransaction(row) {
  return {
    id: row.id,
    type: row.type,
    date: row.date, // SELECT 에서 to_char(...) 로 'YYYY-MM-DD' 문자열
    amount: Number(row.amount), // BIGINT(문자열) → 숫자
    category: row.category,
    memo: row.memo,
    createdAt: row.created_at.getTime(), // TIMESTAMPTZ(Date) → epoch ms
  };
}

// transactions 한 행을 매퍼가 기대하는 컬럼(특히 date 문자열)으로 SELECT 하는 공통 컬럼식.
const TXN_SELECT_COLS = `
  id,
  type,
  to_char(txn_date, 'YYYY-MM-DD') AS date,
  amount,
  category,
  memo,
  created_at
`;

// ---------------------------------------------------------------------------
// 7) 입력 검증 헬퍼
// ---------------------------------------------------------------------------
const MONTH_RE = /^\d{4}-\d{2}$/; // YYYY-MM
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/; // YYYY-MM-DD

// month 쿼리 검증: 없거나(null) 유효한 YYYY-MM. 잘못된 형식이면 에러.
//   반환: { ok:true, value:string|null } | { ok:false, error }
function validateMonth(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: true, value: null };
  }
  if (typeof raw !== 'string' || !MONTH_RE.test(raw)) {
    return { ok: false, error: 'month 는 YYYY-MM 형식이어야 합니다.' };
  }
  const m = Number(raw.slice(5, 7));
  if (m < 1 || m > 12) {
    return { ok: false, error: 'month 의 월(月)이 올바르지 않습니다.' };
  }
  return { ok: true, value: raw };
}

// date 검증: 'YYYY-MM-DD' 이면서 실제 존재하는 날짜인지 파싱으로 확인(예: 2월 30일 거부).
//   반환: 정규화된 'YYYY-MM-DD' 문자열 | null
function normalizeDate(raw) {
  if (typeof raw !== 'string' || !DATE_RE.test(raw)) return null;
  const [y, mo, d] = raw.split('-').map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // 실제 달력상 유효성 확인 (UTC 기준 구성 — 타임존 영향 없음)
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return raw;
}

// amount 검증: 양의 정수(원). 0/음수/NaN/문자/과대값 거부.
//   반환: 정수 | null
function normalizeAmount(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n <= 0 || n > MAX_AMOUNT) return null;
  return n;
}

// ---------------------------------------------------------------------------
// 8) API 핸들러 — transactions
// ---------------------------------------------------------------------------

// GET /api/transactions?month=YYYY-MM (month 선택; 없으면 전체)
//   → { transactions:[ { id, type, date, amount, category, memo, createdAt } ] }
//   정렬: txn_date DESC, id DESC.
async function listTransactions(query, res) {
  const mv = validateMonth(query.get('month'));
  if (!mv.ok) return sendJSON(res, 400, { error: mv.error });

  // WHERE: month 가 null 이면 전체, 아니면 to_char 로 해당 월만.
  const { rows } = await pool.query(
    `SELECT ${TXN_SELECT_COLS}
       FROM transactions
      WHERE ($1::text IS NULL OR to_char(txn_date, 'YYYY-MM') = $1)
      ORDER BY txn_date DESC, id DESC`,
    [mv.value]
  );
  sendJSON(res, 200, { transactions: rows.map(mapTransaction) });
}

// POST /api/transactions  { type, date, amount, category, memo? }
//   → 201 { transaction:{...} }
async function createTransaction(req, res) {
  const body = await readJSONBody(req);

  // type
  const type = typeof body.type === 'string' ? body.type : '';
  if (type !== 'income' && type !== 'expense') {
    return sendJSON(res, 400, { error: 'type 은 income 또는 expense 여야 합니다.' });
  }

  // date (유효한 달력 날짜)
  const date = normalizeDate(body.date);
  if (!date) {
    return sendJSON(res, 400, { error: 'date 는 유효한 YYYY-MM-DD 날짜여야 합니다.' });
  }

  // amount (양의 정수)
  const amount = normalizeAmount(body.amount);
  if (amount === null) {
    return sendJSON(res, 400, { error: 'amount 는 0보다 큰 정수(원)여야 합니다.' });
  }

  // category (해당 type 의 화이트리스트)
  const category = typeof body.category === 'string' ? body.category : '';
  if (!categorySetFor(type).has(category)) {
    return sendJSON(res, 400, { error: '해당 type 에 유효하지 않은 category 입니다.' });
  }

  // memo (선택 — 문자열, 없으면 '')
  const memo = typeof body.memo === 'string' ? body.memo : '';

  const { rows } = await pool.query(
    `INSERT INTO transactions (type, txn_date, amount, category, memo)
     VALUES ($1, $2::date, $3, $4, $5)
     RETURNING ${TXN_SELECT_COLS}`,
    [type, date, amount, category, memo]
  );
  sendJSON(res, 201, { transaction: mapTransaction(rows[0]) });
}

// PATCH /api/transactions/:id  부분수정(type/date/amount/category/memo 중 일부)
//   → 200 { transaction:{...} } / 없으면 404.
//   type 이 바뀌면 category 가 (새 type 또는 명시되지 않으면 기존 type)의 화이트리스트에 맞는지 검증.
async function updateTransaction(req, res, id) {
  const body = await readJSONBody(req);

  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  // 검증된 변경 값을 모은다. (category-type 교차검증을 위해 먼저 type/category 결정)
  const updates = {};

  if (has('type')) {
    const type = typeof body.type === 'string' ? body.type : '';
    if (type !== 'income' && type !== 'expense') {
      return sendJSON(res, 400, { error: 'type 은 income 또는 expense 여야 합니다.' });
    }
    updates.type = type;
  }
  if (has('date')) {
    const date = normalizeDate(body.date);
    if (!date) {
      return sendJSON(res, 400, { error: 'date 는 유효한 YYYY-MM-DD 날짜여야 합니다.' });
    }
    updates.date = date;
  }
  if (has('amount')) {
    const amount = normalizeAmount(body.amount);
    if (amount === null) {
      return sendJSON(res, 400, { error: 'amount 는 0보다 큰 정수(원)여야 합니다.' });
    }
    updates.amount = amount;
  }
  if (has('category')) {
    if (typeof body.category !== 'string') {
      return sendJSON(res, 400, { error: 'category 형식이 올바르지 않습니다.' });
    }
    updates.category = body.category;
  }
  if (has('memo')) {
    if (typeof body.memo !== 'string') {
      return sendJSON(res, 400, { error: 'memo 는 문자열이어야 합니다.' });
    }
    updates.memo = body.memo;
  }

  // 변경할 필드가 없으면 존재만 확인하고 현재 행 반환(없으면 404).
  if (Object.keys(updates).length === 0) {
    const cur = await pool.query(
      `SELECT ${TXN_SELECT_COLS} FROM transactions WHERE id = $1`,
      [id]
    );
    if (cur.rows.length === 0) {
      return sendJSON(res, 404, { error: '해당 거래를 찾을 수 없습니다.' });
    }
    return sendJSON(res, 200, { transaction: mapTransaction(cur.rows[0]) });
  }

  // category-type 교차검증:
  //   - type 이나 category 중 하나라도 바뀌면, "변경 후" type 의 화이트리스트로 category 를 검증해야 한다.
  //   - 둘 중 일부만 들어온 경우 기존 행의 값이 필요하므로 현재 행을 먼저 읽는다.
  let existing = null;
  if (has('type') || has('category')) {
    const cur = await pool.query(
      'SELECT type, category FROM transactions WHERE id = $1',
      [id]
    );
    if (cur.rows.length === 0) {
      return sendJSON(res, 404, { error: '해당 거래를 찾을 수 없습니다.' });
    }
    existing = cur.rows[0];

    const effType = has('type') ? updates.type : existing.type;
    const effCategory = has('category') ? updates.category : existing.category;
    if (!categorySetFor(effType).has(effCategory)) {
      return sendJSON(res, 400, {
        error: '변경된 type 에 유효하지 않은 category 입니다.',
      });
    }
  }

  // 동적 SET 절 구성 (date 는 ::date 캐스팅)
  const sets = [];
  const params = [];
  let n = 1;
  if (has('type')) {
    sets.push(`type = $${n++}`);
    params.push(updates.type);
  }
  if (has('date')) {
    sets.push(`txn_date = $${n++}::date`);
    params.push(updates.date);
  }
  if (has('amount')) {
    sets.push(`amount = $${n++}`);
    params.push(updates.amount);
  }
  if (has('category')) {
    sets.push(`category = $${n++}`);
    params.push(updates.category);
  }
  if (has('memo')) {
    sets.push(`memo = $${n++}`);
    params.push(updates.memo);
  }

  params.push(id);
  const { rows } = await pool.query(
    `UPDATE transactions SET ${sets.join(', ')}
      WHERE id = $${n}
      RETURNING ${TXN_SELECT_COLS}`,
    params
  );
  if (rows.length === 0) {
    return sendJSON(res, 404, { error: '해당 거래를 찾을 수 없습니다.' });
  }
  sendJSON(res, 200, { transaction: mapTransaction(rows[0]) });
}

// DELETE /api/transactions/:id → 200 { ok:true } / 404.
async function deleteTransaction(_req, res, id) {
  const { rows } = await pool.query(
    'DELETE FROM transactions WHERE id = $1 RETURNING id',
    [id]
  );
  if (rows.length === 0) {
    return sendJSON(res, 404, { error: '해당 거래를 찾을 수 없습니다.' });
  }
  sendJSON(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// 9) API 핸들러 — summary (카테고리별 합계는 SQL GROUP BY 로 계산)
//   GET /api/summary?month=YYYY-MM (month 선택)
//   → { month, income:{ total, byCategory:[{category,total,count}] },
//             expense:{ total, byCategory:[...] }, net }
//   ⚠️ SUM → ::float8, COUNT → ::int 캐스팅 필수(미캐스팅 numeric/문자열 → 클라 NaN)
//   합계 내림차순(ORDER BY total DESC). amount>0 만 저장되므로 0원 카테고리는 자연히 빠진다.
// ---------------------------------------------------------------------------

// 한 type(income/expense)의 카테고리별 합계 묶음을 GROUP BY 로 계산.
//   반환: { total:number, byCategory:[ {category, total, count} ] }
async function summarizeType(type, month) {
  const { rows } = await pool.query(
    `SELECT category,
            SUM(amount)::float8 AS total,
            COUNT(*)::int       AS count
       FROM transactions
      WHERE type = $1
        AND ($2::text IS NULL OR to_char(txn_date, 'YYYY-MM') = $2)
      GROUP BY category
      ORDER BY total DESC`,
    [type, month]
  );
  const byCategory = rows.map((r) => ({
    category: r.category,
    total: Number(r.total), // ::float8 → JS number (방어적 재변환)
    count: r.count,
  }));
  const total = byCategory.reduce((sum, r) => sum + r.total, 0);
  return { total, byCategory };
}

async function getSummary(query, res) {
  const mv = validateMonth(query.get('month'));
  if (!mv.ok) return sendJSON(res, 400, { error: mv.error });
  const month = mv.value;

  // income / expense 각각 1번씩 GROUP BY (독립 커넥션이므로 Promise.all 안전)
  const [income, expense] = await Promise.all([
    summarizeType('income', month),
    summarizeType('expense', month),
  ]);

  const net = income.total - expense.total;
  sendJSON(res, 200, { month, income, expense, net });
}

// ---------------------------------------------------------------------------
// 10) API 핸들러 — budgets (expense 카테고리별 예산)
//   GET /api/budgets → { budgets:[ {category, amount} ] }  (amount 는 Number)
//   PUT /api/budgets { budgets:[ {category, amount} ] } → 200 { budgets:[...] }
//     각 항목 upsert(ON CONFLICT). category 는 EXPENSE 화이트리스트, amount 0 이상 정수.
// ---------------------------------------------------------------------------
async function listBudgets(_req, res) {
  const { rows } = await pool.query(
    `SELECT category, amount
       FROM budgets
      WHERE category = ANY($1)
      ORDER BY category`,
    [EXPENSE_CATEGORIES]
  );
  const budgets = rows.map((r) => ({
    category: r.category,
    amount: Number(r.amount), // BIGINT(문자열) → 숫자
  }));
  sendJSON(res, 200, { budgets });
}

async function putBudgets(req, res) {
  const body = await readJSONBody(req);

  if (!Array.isArray(body.budgets)) {
    return sendJSON(res, 400, { error: 'budgets 는 배열이어야 합니다.' });
  }

  // 모든 항목을 먼저 검증(부분 적용 방지). category 는 EXPENSE 화이트리스트, amount 0 이상 정수.
  const items = [];
  for (const item of body.budgets) {
    if (!item || typeof item !== 'object') {
      return sendJSON(res, 400, { error: '각 budget 항목은 객체여야 합니다.' });
    }
    const category = typeof item.category === 'string' ? item.category : '';
    if (!EXPENSE_SET.has(category)) {
      return sendJSON(res, 400, {
        error: 'budget 의 category 는 지출(expense) 카테고리여야 합니다.',
      });
    }
    const amt = Number(item.amount);
    if (!Number.isFinite(amt) || !Number.isInteger(amt) || amt < 0 || amt > MAX_AMOUNT) {
      return sendJSON(res, 400, { error: 'budget 의 amount 는 0 이상 정수여야 합니다.' });
    }
    items.push({ category, amount: amt });
  }

  // upsert: 같은 category 가 중복으로 와도 마지막 값이 반영되도록 순차 실행.
  //   하나의 커넥션에서 처리(순차 — pg 동일 client 직렬화 안전).
  const client = await pool.connect();
  try {
    for (const it of items) {
      await client.query(
        `INSERT INTO budgets (category, amount)
         VALUES ($1, $2)
         ON CONFLICT (category)
         DO UPDATE SET amount = EXCLUDED.amount, updated_at = now()`,
        [it.category, it.amount]
      );
    }
    // 처리 후 전체 budgets(expense 카테고리) 반환
    const { rows } = await client.query(
      `SELECT category, amount
         FROM budgets
        WHERE category = ANY($1)
        ORDER BY category`,
      [EXPENSE_CATEGORIES]
    );
    const budgets = rows.map((r) => ({ category: r.category, amount: Number(r.amount) }));
    sendJSON(res, 200, { budgets });
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// 11) API 라우터 — /api/* 매칭 후 위 핸들러로 분기
//    라우팅/입력 검증을 먼저 수행해 DB 와 무관한 응답(404/405)은 즉시 반환한다.
//    DB 가 실제로 필요한 핸들러를 고른 뒤에만 ensureDB() 로 스키마를 보장한다.
//    (이렇게 하면 DB 가 down 이어도 라우터가 옳다는 걸 404/405 로 증명 가능)
// ---------------------------------------------------------------------------
function parseId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function handleApi(req, res, pathname, query) {
  const method = req.method;

  // --- 헬스체크 (DB 불필요 → 즉시 200) ---
  //   클라이언트가 로드 시 백엔드(server.js) 연결 여부를 확인하는 용도.
  //   정적 서버(Live Server·npx serve)로 열면 이 경로가 404 가 되어, 클라가 "백엔드 없음"을 감지한다.
  if (pathname === '/api/health') {
    if (method === 'GET') return sendJSON(res, 200, { ok: true });
    return sendJSON(res, 405, { error: 'Method Not Allowed' });
  }

  // --- 거래 컬렉션: /api/transactions (GET 목록 / POST 생성) ---
  if (pathname === '/api/transactions') {
    if (method === 'GET') return ensureDB().then(() => listTransactions(query, res));
    if (method === 'POST') return ensureDB().then(() => createTransaction(req, res));
    return sendJSON(res, 405, { error: 'Method Not Allowed' });
  }

  // --- 거래 단건: /api/transactions/:id (PATCH 수정 / DELETE 삭제) ---
  const txnMatch = pathname.match(/^\/api\/transactions\/([^/]+)$/);
  if (txnMatch) {
    if (method !== 'PATCH' && method !== 'DELETE') {
      return sendJSON(res, 405, { error: 'Method Not Allowed' });
    }
    const id = parseId(txnMatch[1]);
    if (id === null) return sendJSON(res, 400, { error: '유효하지 않은 거래 id 입니다.' });
    if (method === 'PATCH') return ensureDB().then(() => updateTransaction(req, res, id));
    return ensureDB().then(() => deleteTransaction(req, res, id));
  }

  // --- 요약: /api/summary (GET) ---
  if (pathname === '/api/summary') {
    if (method === 'GET') return ensureDB().then(() => getSummary(query, res));
    return sendJSON(res, 405, { error: 'Method Not Allowed' });
  }

  // --- 예산: /api/budgets (GET 조회 / PUT 일괄 upsert) ---
  if (pathname === '/api/budgets') {
    if (method === 'GET') return ensureDB().then(() => listBudgets(req, res));
    if (method === 'PUT') return ensureDB().then(() => putBudgets(req, res));
    return sendJSON(res, 405, { error: 'Method Not Allowed' });
  }

  return sendJSON(res, 404, { error: 'API Not Found' });
}

// ---------------------------------------------------------------------------
// 12) 정적 서빙 — allowlist 방식
//    오직 index.html 만 서빙. 그 외 모든 경로(.env, package.json, server.js, *.png, .git ...)
//    는 404. path.basename 으로 디렉터리 성분을 제거하므로 /../ 트래버설도 무력화.
//    (이 프로젝트는 과거 server.js 가 .env 를 정적 서빙해 GET /.env 로 키가 샌 사고가 있었음
//     → 반드시 allowlist 로 막는다.)
// ---------------------------------------------------------------------------
const STATIC_ALLOWLIST = new Set(['index.html']);

function serveStatic(pathname, res) {
  // '/' → index.html 로 매핑, 그 외엔 basename 만 추출(트래버설 방지)
  const requested =
    pathname === '/' ? 'index.html' : path.basename(decodeURIComponent(pathname));

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
// 13) 서버 — /api 와 정적 경로를 명확히 분기
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (_) {
    return sendJSON(res, 400, { error: 'Bad Request' });
  }
  const pathname = url.pathname;

  // --- API 분기 ---
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    try {
      // 라우팅/검증은 즉시, DB 가 필요한 핸들러만 내부에서 ensureDB() 호출
      await handleApi(req, res, pathname, url.searchParams);
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
// 14) 기동: 포트 자동 폴백 + DB 연결 확인(성공/실패만 알림, URL 비노출) 후 listen
// ---------------------------------------------------------------------------
let currentPort = Number(PORT) || 3000;

// 포트가 이미 사용 중이면(예: 3000 을 다른 앱이 점유) 다음 포트로 자동 이동해서
// npm start 가 EADDRINUSE 로 죽지 않게 한다(최대 +10 포트까지 시도).
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && currentPort < (Number(PORT) || 3000) + 10) {
    console.warn(`[server] 포트 ${currentPort} 사용 중 → ${currentPort + 1} 로 재시도합니다.`);
    currentPort += 1;
    setTimeout(() => server.listen(currentPort), 150);
  } else {
    console.error('[server] 리스닝 실패:', err.message);
    process.exit(1);
  }
});

server.on('listening', () => {
  console.log(`\n[server] 가계부 백엔드 실행 → http://localhost:${currentPort}`);
  console.log('[중요] 반드시 위 주소로 접속하세요. VS Code Live Server·npx serve 로 열면');
  console.log('       /api 백엔드가 없어 거래 저장이 "API를 찾을 수 없음" 으로 실패합니다.\n');
  ensureDB()
    .then(() => console.log('[db] Supabase Postgres 연결 및 스키마 준비 완료'))
    .catch((err) =>
      console.error('[db] 연결 실패 — 첫 API 요청 시 재시도합니다. 원인:', err.message)
    );
});

function start() {
  server.listen(currentPort);
}

// 로컬 실행 / 서버리스 export 듀얼 모드
if (require.main === module) {
  start();
}
module.exports = server;
