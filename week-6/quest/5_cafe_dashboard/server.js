// ============================================================================
// ☕ 딥로스트 사장님 대시보드 — 백엔드 (server.js)
//   - Express 4 + pg + bcryptjs + jsonwebtoken (전부 로컬 node_modules 설치됨)
//   - DB: Supabase Postgres 트랜잭션 풀러(:6543, SSL 필수). 91일치 실데이터가 이미 있다.
//   - 인증: JWT Bearer. /api/health 외 모든 /api/* 는 토큰 필요.
//   - 외부: Open-Meteo(키 X), OpenAI(gpt-4.1 / gpt-4o-search-preview), Notion REST.
//   - ⚠️ 비밀값(DB URL / JWT_SECRET / OpenAI·Notion 토큰)은 로그/응답에 절대 노출하지 않는다.
//   - ⚠️ 정적 서빙은 index.html "단 한 파일"만. 폴더 통째 서빙 금지(.env 유출 방지).
//   - 계약서: API.md 가 유일한 기준.
// ============================================================================

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ---------------------------------------------------------------------------
// 1) .env 직접 파싱 (dotenv 미설치) — db.mjs 방식. 값은 .trim() 으로 개행 방지.
//    __dirname 기준이라 실행 cwd 와 무관하게 동작한다.
// ---------------------------------------------------------------------------
const ENV_PATH = path.join(__dirname, '.env');

function loadEnv() {
  const env = {};
  let raw = '';
  try {
    raw = fs.readFileSync(ENV_PATH, 'utf8');
  } catch (_) {
    return env; // .env 가 없어도(배포 환경 등) 계속 진행
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

const ENV = loadEnv();
const pick = (k) => (ENV[k] || process.env[k] || '').trim();

const PORT = Number(pick('PORT')) || 3000;
const DB_URL = pick('SUPABASE_DB_URL') || pick('DB_URL');
const OPENAI_API_KEY = pick('OPENAI_API_KEY');
const NOTION_TOKEN = pick('NOTION_TOKEN'); // 비어 있을 수 있음(미연결)
const NOTION_TODO_DB_ID = pick('NOTION_TODO_DB_ID');
const NOTION_ORDER_DB_ID = pick('NOTION_ORDER_DB_ID');
const NOTION_PARENT_PAGE_URL = pick('NOTION_PARENT_PAGE_URL');
const CAFE_LAT = pick('CAFE_LAT') || '37.3225';
const CAFE_LON = pick('CAFE_LON') || '127.0947';

// 사장님 전용 가입 화이트리스트 (쉼표 구분, 소문자)
const OWNER_EMAILS = new Set(
  pick('OWNER_EMAILS').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
);

if (!DB_URL) {
  console.error('[FATAL] .env 의 SUPABASE_DB_URL 이 없습니다. 서버를 시작할 수 없습니다.');
  process.exit(1);
}

// JWT_SECRET 확보 — 있으면 사용, 없으면 생성해 .env 에 append(재시작해도 토큰 유지). 값은 비노출.
function ensureJwtSecret() {
  const existing = pick('JWT_SECRET');
  if (existing) return existing;
  const generated = crypto.randomBytes(48).toString('hex');
  try {
    let prefix = '';
    try {
      const cur = fs.readFileSync(ENV_PATH);
      if (cur.length > 0 && cur[cur.length - 1] !== 0x0a) prefix = '\n';
    } catch (_) {}
    fs.appendFileSync(ENV_PATH, `${prefix}JWT_SECRET=${generated}\n`);
    console.log('[jwt] JWT_SECRET 이 없어 새로 생성해 .env 에 저장했습니다(값 비노출).');
  } catch (_) {
    console.warn('[jwt] .env 저장 실패 — 이번 실행 동안만 임시 시크릿을 사용합니다.');
  }
  return generated;
}
const JWT_SECRET = ensureJwtSecret();
const JWT_EXPIRES_IN = '12h';

// ---------------------------------------------------------------------------
// 2) PG 풀 — Supabase 풀러는 SSL 필수. 비밀번호가 순수 영숫자라 connectionString 직접 사용 가능.
// ---------------------------------------------------------------------------
const pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false },
  max: 4, // 풀러 환경 배려: 작게 유지
});
pool.on('error', (err) => {
  // 유휴 클라이언트 오류로 프로세스가 죽지 않도록 흡수(URL 비노출)
  console.error('[pg pool] idle client error:', err.message);
});

// ---------------------------------------------------------------------------
// 3) 공용 헬퍼 — 날짜/숫자. (pg 는 AVG/SUM/numeric 을 문자열로 주므로 SQL 캐스팅과 병행)
// ---------------------------------------------------------------------------
const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토']; // day_of_week: 0=일 ... 6=토

const num = (v) => (v === null || v === undefined ? null : Number(v));
const round1 = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
const round2 = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);
const fmtQty = (v) => String(Math.round(Number(v) * 10) / 10); // 3 → "3", 2.2 → "2.2"

// 'YYYY-MM-DD' 에 n일 더하기(UTC 기준이라 타임존 밀림 없음)
function addDays(dateStr, n) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
// 'YYYY-MM-DD' → 요일(0=일 ... 6=토)
function dowOf(dateStr) {
  return new Date(String(dateStr) + 'T00:00:00Z').getUTCDay();
}
// Asia/Seoul 기준 오늘 'YYYY-MM-DD' (데이터가 아니라 "실제 오늘/내일"이 필요한 날씨·예측용)
function seoulToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
// value/prev 증감률(%) 소수1자리. prev 가 0/누락이면 null.
function deltaPct(cur, prev) {
  if (!prev || prev === 0) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

// ---------------------------------------------------------------------------
// 4) 스키마 lazy init — 최초 1회만 cafe_owners 생성(cold start 대응). 기존 cafe_* 는 건드리지 않는다.
// ---------------------------------------------------------------------------
let dbReady = null; // Promise 캐시 — 동시 요청에도 init 1회만
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cafe_owners (
      id            SERIAL PRIMARY KEY,
      email         TEXT        NOT NULL UNIQUE,
      password_hash TEXT        NOT NULL,
      name          TEXT        NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at TIMESTAMPTZ
    );
  `);
  // 날씨 로그 — /api/predict/visitors 호출마다 예보+예측치를 upsert 해 둔다.
  // 지금은 날씨-방문객 상관 데이터가 없지만, 오늘부터 쌓으면 나중에 실제 회귀계수를 뽑을 수 있다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cafe_weather_log (
      log_date          DATE PRIMARY KEY,
      temp_max          NUMERIC(4,1),
      precip_sum        NUMERIC(5,1),
      weather_code      SMALLINT,
      baseline_expected NUMERIC(6,1),
      ai_expected       INTEGER,
      actual_visitors   INTEGER
    );
  `);
}
// 요일 타입 라벨 — 주말·공휴일은 가족 손님, 평일은 작업 손님. 사실상 다른 사업.
const dayTypeLabel = (isWeekend, isHoliday) => (isWeekend || isHoliday ? '주말' : '평일');
function ensureDB() {
  if (!dbReady) {
    dbReady = initDB().catch((err) => { dbReady = null; throw err; });
  }
  return dbReady;
}

// ---------------------------------------------------------------------------
// 5) Express 앱 + 공통 미들웨어/래퍼
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// 비동기 핸들러 오류를 500 으로 안전하게 흡수(내부 메시지 비노출).
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error('[API ERROR]', req.method, req.path, '-', err.message);
    if (!res.headersSent) res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  });
// DB 가 필요한 핸들러: ensureDB 먼저 보장 후 실행. (인증/라우팅 실패는 DB 없이도 먼저 판정됨)
const dbWrap = (fn) => wrap(async (req, res, next) => { await ensureDB(); return fn(req, res, next); });

// JWT 발급/검증 — payload { id, email, name }, HS256, 12h.
function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, {
    algorithm: 'HS256', expiresIn: JWT_EXPIRES_IN,
  });
}
// 보호 라우트 게이트(무상태) — 토큰 없거나 불량이면 401. DB 접근 없음.
function authRequired(req, res, next) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: '인증이 필요합니다. 로그인 후 다시 시도해 주세요.' });
  try {
    const p = jwt.verify(m[1].trim(), JWT_SECRET, { algorithms: ['HS256'] });
    req.user = { id: p.id, email: p.email, name: p.name };
    return next();
  } catch (_) {
    return res.status(401).json({ error: '세션이 만료되었습니다. 다시 로그인해 주세요.' });
  }
}
// 숫자 PK 가드 — 정수 아니면 null (bigint/serial 컬럼에 문자열 id 를 넣어 22P02→500 나는 것 방지)
function parseId(raw) {
  return /^\d+$/.test(String(raw)) ? Number(raw) : null;
}

// ---------------------------------------------------------------------------
// 6) 정적 서빙 — index.html "단일 파일"만. (폴더 통째 서빙 금지 → .env 유출 원천 차단)
//    프론트는 해시 라우팅(#/ #/data #/notion)이라 서버는 '/' 만 보면 된다.
//    index.html 이 아직 없어도(다른 에이전트가 작성 중) 서버는 정상 동작해야 한다.
// ---------------------------------------------------------------------------
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');
app.get('/', (_req, res) => {
  if (fs.existsSync(INDEX_HTML_PATH)) return res.sendFile(INDEX_HTML_PATH);
  res
    .status(200)
    .type('html')
    .send('<!doctype html><meta charset="utf-8"><title>딥로스트 대시보드</title>' +
      '<body style="font-family:sans-serif;padding:40px"><h1>☕ 딥로스트 대시보드 API</h1>' +
      '<p>서버는 실행 중입니다. index.html 준비 후 새로고침하세요.</p>' +
      '<p><code>GET /api/health</code> 로 상태를 확인할 수 있습니다.</p></body>');
});

// ---------------------------------------------------------------------------
// 7) 헬스체크 (인증 불필요) — 프론트가 부팅 시 가장 먼저 호출한다.
// ---------------------------------------------------------------------------
app.get('/api/health', wrap(async (_req, res) => {
  let db = false;
  let dataRange = null;
  try {
    await ensureDB();
    const { rows: [r] } = await pool.query(
      `SELECT to_char(MIN(sale_date),'YYYY-MM-DD') AS from_date,
              to_char(MAX(sale_date),'YYYY-MM-DD') AS to_date
         FROM cafe_daily_sales`
    );
    db = true;
    dataRange = { from: r.from_date, to: r.to_date };
  } catch (err) {
    console.error('[health] DB 확인 실패:', err.message);
  }
  res.json({
    ok: true,
    db,
    openai: !!OPENAI_API_KEY,
    notion: { configured: !!NOTION_TOKEN },
    dataRange,
  });
}));

// ---------------------------------------------------------------------------
// 8) 기동 — EADDRINUSE 면 다음 포트로 자동 폴백. 실제 포트를 로그로 출력. (비밀값 비노출)
//    라우트 등록(아래 청크들)은 이 파일의 동기 실행이 모두 끝난 뒤에야 요청을 받으므로,
//    start() 를 먼저 호출해도 이후에 정의되는 라우트가 정상 등록된다.
// ---------------------------------------------------------------------------
const MAX_PORT_TRIES = 20;
function start(startPort = PORT, triesLeft = MAX_PORT_TRIES) {
  const server = app.listen(startPort);
  server.once('listening', () => {
    const url = `http://localhost:${startPort}`;
    console.log(`[server] 딥로스트 사장님 대시보드 백엔드 실행 → ${url}`);
    console.log('[안내] Live Server 가 아니라 위 주소로 접속하세요.');
    console.log(`[cfg] openai: ${OPENAI_API_KEY ? '✓' : '✗(키 없음)'} / ` +
      `notion: ${NOTION_TOKEN ? '✓' : '✗(토큰 없음)'} / owner: ${OWNER_EMAILS.size}명`);
    ensureDB()
      .then(() => console.log('[db] Supabase 연결 및 cafe_owners 준비 완료'))
      .catch((err) => console.error('[db] 연결 실패 — 첫 요청 시 재시도. 원인:', err.message));
  });
  server.once('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && triesLeft > 0) {
      console.warn(`[server] 포트 ${startPort} 사용 중 — ${startPort + 1} 로 전환합니다.`);
      start(startPort + 1, triesLeft - 1);
      return;
    }
    console.error('[server] 기동 실패:', err.message);
    process.exit(1);
  });
}

if (require.main === module) start(PORT, MAX_PORT_TRIES);
module.exports = app;

// ---------------------------------------------------------------------------
// 9) 인증 라우트 — OWNER_EMAILS 화이트리스트만 가입 가능. 비번 bcrypt(rounds 10).
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PW = 6;

// POST /api/auth/register { email, password, name } → { token, user }
app.post('/api/auth/register', dbWrap(async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';

  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: '올바른 이메일 형식이 아닙니다.' });
  if (password.length < MIN_PW) return res.status(400).json({ error: `비밀번호는 최소 ${MIN_PW}자 이상이어야 합니다.` });
  if (!name) return res.status(400).json({ error: '이름을 입력해 주세요.' });

  // ⚠️ 사장님 전용: 화이트리스트 밖 이메일은 403.
  if (!OWNER_EMAILS.has(email)) {
    return res.status(403).json({ error: '사장님 계정만 가입할 수 있습니다.' });
  }

  const dup = await pool.query('SELECT 1 FROM cafe_owners WHERE email = $1', [email]);
  if (dup.rows.length > 0) return res.status(409).json({ error: '이미 가입된 이메일입니다.' });

  const passwordHash = await bcrypt.hash(password, 10);
  let inserted;
  try {
    inserted = await pool.query(
      `INSERT INTO cafe_owners (email, password_hash, name, last_login_at)
       VALUES ($1, $2, $3, now()) RETURNING id, email, name`,
      [email, passwordHash, name]
    );
  } catch (err) {
    if (err && err.code === '23505') return res.status(409).json({ error: '이미 가입된 이메일입니다.' });
    throw err;
  }
  const user = inserted.rows[0];
  res.status(201).json({ token: signToken(user), user });
}));

// POST /api/auth/login { email, password } → { token, user }
app.post('/api/auth/login', dbWrap(async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const INVALID = '이메일 또는 비밀번호가 올바르지 않습니다.';
  if (!email || !password) return res.status(401).json({ error: INVALID });

  const { rows } = await pool.query(
    'SELECT id, email, name, password_hash FROM cafe_owners WHERE email = $1', [email]
  );
  if (rows.length === 0) return res.status(401).json({ error: INVALID });
  const found = rows[0];
  const ok = await bcrypt.compare(password, found.password_hash);
  if (!ok) return res.status(401).json({ error: INVALID });

  await pool.query('UPDATE cafe_owners SET last_login_at = now() WHERE id = $1', [found.id]);
  const user = { id: found.id, email: found.email, name: found.name };
  res.json({ token: signToken(user), user });
}));

// GET /api/auth/me (Bearer) → { user } — 토큰 sub 로 DB 재확인(삭제된 계정 방지)
app.get('/api/auth/me', authRequired, dbWrap(async (req, res) => {
  const { rows } = await pool.query('SELECT id, email, name FROM cafe_owners WHERE id = $1', [req.user.id]);
  if (rows.length === 0) return res.status(401).json({ error: '유효하지 않은 토큰입니다.' });
  res.json({ user: rows[0] });
}));

// ---------------------------------------------------------------------------
// 10) 대시보드 데이터 — asOf 는 항상 DB 의 max(sale_date). (오늘 날짜로 조회하면 빈 값)
//     모든 수치는 숫자 타입. pg 집계는 SQL 에서 ::int / ::float8 캐스팅(안 하면 프론트 NaN).
// ---------------------------------------------------------------------------
async function getAsOf() {
  const { rows: [r] } = await pool.query(`SELECT to_char(MAX(sale_date),'YYYY-MM-DD') AS d FROM cafe_daily_sales`);
  if (!r || !r.d) throw new Error('매출 데이터가 없습니다.');
  return r.d;
}

// 재고 알림 — 하드코딩 금지, 실제 조건으로 계산. 재고 하회 + 미결 발주(발주완료/배송중) 조합으로 분류.
//   danger: 하회 AND 미결발주 없음 / warn: 하회 AND 발주 있으나 입고예정일 경과(지연) /
//   ok: 하회지만 발주 정상 진행(조치 불필요) / info: 재고 정상인데 입고예정일 경과.
//   + 한 플랜에 해지 100% 쏠림(≥3)이면 info. 별점급락/요일매출붕괴는 조건식만 두고 지금은 미발동이 정답.
async function buildAlerts(asOf, ratingCur, ratingPrev) {
  const alerts = [];
  const inv = await pool.query(
    `SELECT i.item_name, i.unit, i.current_stock::float8 AS cs, i.safety_stock::float8 AS ss,
            COALESCE(po.open_cnt, 0)::int AS open_cnt, to_char(po.max_exp, 'YYYY-MM-DD') AS max_exp
       FROM cafe_inventory i
       LEFT JOIN (
         SELECT item_name, COUNT(*) AS open_cnt, MAX(expected_date) AS max_exp
           FROM cafe_purchase_orders WHERE status IN ('발주완료','배송중') GROUP BY item_name
       ) po ON po.item_name = i.item_name
      ORDER BY (i.current_stock / NULLIF(i.safety_stock, 0)) ASC`
  );
  let unordered = 0, delayed = 0, ontrack = 0;
  for (const r of inv.rows) {
    const below = r.cs < r.ss;
    const hasOpen = r.open_cnt > 0;
    const late = hasOpen && r.max_exp && r.max_exp < asOf; // 'YYYY-MM-DD' 문자열 비교
    const pct = r.ss ? Math.round((r.cs / r.ss) * 100) : 0;
    const stock = `안전재고 ${fmtQty(r.ss)}${r.unit} 대비 ${fmtQty(r.cs)}${r.unit}`;
    if (below && !hasOpen) {
      unordered++;
      alerts.push({ level: 'danger', title: `${r.item_name} 재고 ${pct}%`, detail: `${stock}. 미발주 상태 — 지금 발주하세요.`, action: '발주' });
    } else if (below && hasOpen && late) {
      delayed++;
      alerts.push({ level: 'warn', title: `${r.item_name} 재고 ${pct}%`, detail: `${stock}. 발주했으나 입고예정일(${r.max_exp})이 지났는데 아직 미입고 — 공급처에 확인하세요.`, action: '입고확인' });
    } else if (below && hasOpen && !late) {
      ontrack++;
      alerts.push({ level: 'ok', title: `${r.item_name} 재고 ${pct}% — 조치 불필요`, detail: `${stock}. 발주가 정상 진행 중입니다(입고예정 ${r.max_exp}).`, action: null });
    } else if (!below && hasOpen && late) {
      alerts.push({ level: 'info', title: `${r.item_name} 입고 지연`, detail: `재고는 정상이나 발주 입고예정일(${r.max_exp})이 지났습니다.`, action: '입고확인' });
    }
  }

  // 멤버십: 해지가 한 플랜에 100% 쏠리고 3건 이상이면 info.
  const ch = await pool.query(`SELECT plan, COUNT(*) FILTER (WHERE status='cancelled')::int AS churns FROM cafe_memberships GROUP BY plan`);
  const totalChurn = ch.rows.reduce((s, r) => s + r.churns, 0);
  const topChurn = ch.rows.slice().sort((a, b) => b.churns - a.churns)[0];
  if (topChurn && totalChurn >= 3 && topChurn.churns === totalChurn) {
    alerts.push({ level: 'info', title: `${topChurn.plan} 플랜 해지 집중`, detail: `최근 해지 ${totalChurn}건이 전부 ${topChurn.plan} 플랜입니다. 해지 사유를 점검하세요.`, action: '점검' });
  }

  // 조건부(현재 데이터로는 미발동이 정답): 별점 급락 / 요일 매출 붕괴.
  if (ratingCur != null && ratingPrev != null && ratingCur < ratingPrev - 0.3) {
    alerts.push({ level: 'warn', title: `평점 급락 ${ratingPrev}→${ratingCur}`, detail: '최근 30일 평점이 직전 30일 대비 0.3점 넘게 하락했습니다. 리뷰 원문을 확인하세요.', action: '리뷰확인' });
  }
  const rev = await pool.query(
    `SELECT (SELECT total_revenue FROM cafe_daily_sales WHERE sale_date=$1) AS today,
            AVG(total_revenue)::float8 AS avg, COALESCE(STDDEV_SAMP(total_revenue),0)::float8 AS std
       FROM cafe_daily_sales
      WHERE day_of_week=(SELECT day_of_week FROM cafe_daily_sales WHERE sale_date=$1) AND NOT is_holiday`, [asOf]
  );
  const rv = rev.rows[0];
  if (rv && rv.today != null && rv.today < rv.avg - 2 * rv.std) {
    alerts.push({ level: 'warn', title: '요일 매출 급감', detail: `오늘 매출이 해당 요일 평균(${Math.round(rv.avg)}원)보다 2σ 이상 낮습니다.`, action: '점검' });
  }

  // 심각도 순으로 정렬한다. 사장님이 위에서 세 줄만 읽고 화면을 닫아도 조치할 것부터 보여야 한다.
  const SEVERITY = { danger: 0, warn: 1, info: 2, ok: 3 };
  alerts.sort((a, b) => (SEVERITY[a.level] ?? 9) - (SEVERITY[b.level] ?? 9));

  return { alerts, invCounts: { shortage: unordered + delayed + ontrack, unordered, delayed, ontrack } };
}

const kpiVs = (prev, value) => ({ prev, deltaPct: deltaPct(value, prev) });

// KPI 카드 + 알림. 평일/주말은 사실상 다른 사업 → 모든 KPI를 ① 전주 같은 요일 ② 요일/요일타입 baseline 두 가지로 비교.
async function buildSummary(asOf) {
  const dow = dowOf(asOf);
  const lastWeek = addDays(asOf, -7);
  const daysRes = await pool.query(
    `SELECT to_char(sale_date,'YYYY-MM-DD') AS d, day_name, is_weekend, is_holiday,
            visitors, orders, product_revenue, membership_revenue, total_revenue
       FROM cafe_daily_sales WHERE sale_date IN ($1, $2)`, [asOf, lastWeek]
  );
  const today = daysRes.rows.find((r) => r.d === asOf) || {};
  const lw = daysRes.rows.find((r) => r.d === lastWeek) || {};
  const isFamily = !!(today.is_weekend || today.is_holiday);
  const dtype = dayTypeLabel(today.is_weekend, today.is_holiday);

  const curMon = asOf.slice(0, 7);
  const [yy, mo] = asOf.split('-').map(Number);
  const prevMon = mo === 1 ? `${yy - 1}-12` : `${yy}-${String(mo - 1).padStart(2, '0')}`;

  const [dowAgg, tkt, mem, margin, ratings] = await Promise.all([
    pool.query(`SELECT AVG(total_revenue)::float8 AS rev, AVG(visitors)::float8 AS vis
                  FROM cafe_daily_sales WHERE day_of_week=$1 AND NOT is_holiday`, [dow]),
    // 객단가 요일타입 baseline: SUM(product_revenue)/SUM(orders) — 방문자 아님(주말 묶음주문 왜곡 방지).
    pool.query(`SELECT (SUM(product_revenue)::float8 / NULLIF(SUM(orders),0)) AS v
                  FROM cafe_daily_sales WHERE (is_weekend OR is_holiday)=$1`, [isFamily]),
    pool.query(`SELECT COUNT(*) FILTER (WHERE status='active')::int AS active, COUNT(*)::int AS total,
                       COALESCE(SUM(monthly_fee) FILTER (WHERE status='active'),0)::int AS mrr FROM cafe_memberships`),
    pool.query(`WITH pr AS (SELECT to_char(sale_date,'YYYY-MM') AS mon, SUM(product_revenue)::float8 AS prod FROM cafe_daily_sales GROUP BY 1),
                     cg AS (SELECT to_char(ms.sale_date,'YYYY-MM') AS mon, SUM(ms.qty*m.cost)::float8 AS cogs
                              FROM cafe_menu_sales ms JOIN cafe_menu m ON m.id=ms.menu_id GROUP BY 1)
                SELECT pr.mon AS month, ((pr.prod-cg.cogs)/pr.prod*100)::float8 AS rate FROM pr JOIN cg ON cg.mon=pr.mon`),
    pool.query(`SELECT AVG(rating) FILTER (WHERE review_date BETWEEN $2 AND $1)::float8 AS cur,
                       AVG(rating) FILTER (WHERE review_date BETWEEN $4 AND $3)::float8 AS prev
                  FROM cafe_reviews WHERE review_date BETWEEN $4 AND $1`,
                [asOf, addDays(asOf, -29), addDays(asOf, -30), addDays(asOf, -59)]),
  ]);

  const dowRev = num(dowAgg.rows[0].rev);
  const dowVis = num(dowAgg.rows[0].vis);
  const tktBase = num(tkt.rows[0].v);
  const m = mem.rows[0];
  const marginMap = Object.fromEntries(margin.rows.map((r) => [r.month, num(r.rate)]));
  const curRate = round1(marginMap[curMon]);
  const prevRate = round1(marginMap[prevMon]);
  const ratingCur = round1(ratings.rows[0].cur);
  const ratingPrev = round1(ratings.rows[0].prev);

  const { alerts, invCounts } = await buildAlerts(asOf, ratingCur, ratingPrev);

  const todayTkt = today.orders ? Math.round(today.product_revenue / today.orders) : 0;
  const lwTkt = lw.orders ? Math.round(lw.product_revenue / lw.orders) : 0;

  return {
    asOf,
    asOfDayName: today.day_name,
    dayType: dtype,
    kpis: {
      // ⚠️ "어제"라고 부르지 않는다. asOf 는 마지막으로 마감 입력된 영업일이지 반드시 어제인 것은 아니다.
      //    (지금 데이터는 6/30 에서 끊겨 있고 실제 오늘은 그보다 한참 뒤다)
      revenue: { label: '최근 마감 매출', value: today.total_revenue, unit: '원',
        vsLastWeek: kpiVs(lw.total_revenue, today.total_revenue), vsDowAvg: kpiVs(Math.round(dowRev), today.total_revenue) },
      visitors: { label: '최근 마감 방문자', value: today.visitors, unit: '명',
        vsLastWeek: kpiVs(lw.visitors, today.visitors), vsDowAvg: kpiVs(round1(dowVis), today.visitors) },
      avgTicket: { label: `객단가 (${dtype})`, value: todayTkt, unit: '원',
        vsLastWeek: kpiVs(lwTkt, todayTkt), vsDayTypeAvg: kpiVs(Math.round(tktBase), todayTkt) },
      membershipMrr: { label: '멤버십 MRR', value: m.mrr, unit: '원', sub: `활성 ${m.active}명 / 누적 ${m.total}명` },
      grossMargin: { label: '매출총이익률', value: curRate, unit: '%', vsPrevMonth: kpiVs(prevRate, curRate) },
      inventoryAlerts: { label: '재고 알림', value: invCounts.shortage, unit: '건',
        sub: `미발주 ${invCounts.unordered} · 지연 ${invCounts.delayed} · 정상진행 ${invCounts.ontrack}`, snapshot: true },
    },
    alerts,
  };
}

// GET /api/dashboard/summary
app.get('/api/dashboard/summary', authRequired, dbWrap(async (_req, res) => {
  const asOf = await getAsOf();
  res.json(await buildSummary(asOf));
}));

// 차트 — 일별매출/요일별/시간대별(평일·주말 분리)/월별추세/메뉴/리뷰/멤버십.
async function buildCharts(asOf) {
  const [daily, byDow, hourly, monthly, menu, revAgg, revByRating, revByMonth, revByChannel, revLow, mem, memByPlan, netAdd] =
    await Promise.all([
      pool.query(
        `SELECT to_char(sale_date,'YYYY-MM-DD') AS date, day_name,
                product_revenue, membership_revenue, total_revenue, visitors
           FROM cafe_daily_sales WHERE sale_date BETWEEN $2 AND $1 ORDER BY sale_date ASC`,
        [asOf, addDays(asOf, -29)]
      ),
      pool.query(
        `SELECT day_of_week, day_name, AVG(visitors)::float8 AS av,
                COALESCE(STDDEV_SAMP(visitors), 0)::float8 AS sv,
                AVG(total_revenue)::float8 AS ar, COUNT(*)::int AS n
           FROM cafe_daily_sales WHERE NOT is_holiday
          GROUP BY day_of_week, day_name ORDER BY day_of_week`
      ),
      // 시간대별 — 평일(작업 손님)과 주말·공휴일(가족)을 분리. 영업시간 밖은 null 로.
      pool.query(
        `SELECT h.hour, (d.is_weekend OR d.is_holiday) AS family, AVG(h.visitors)::float8 AS av
           FROM cafe_hourly_traffic h JOIN cafe_daily_sales d ON d.sale_date = h.sale_date
          WHERE h.hour BETWEEN 8 AND 20 GROUP BY h.hour, family ORDER BY h.hour`
      ),
      // 월별 추세 — 총매출은 그 달의 주말 일수에 휘둘린다 → 평일/주말 일평균을 분리해 함께 낸다.
      pool.query(
        `WITH t AS (
           SELECT to_char(sale_date,'YYYY-MM') AS mon, SUM(total_revenue)::int AS total, SUM(product_revenue)::float8 AS prod,
                  AVG(total_revenue) FILTER (WHERE NOT (is_weekend OR is_holiday))::float8 AS wd,
                  AVG(total_revenue) FILTER (WHERE (is_weekend OR is_holiday))::float8 AS we
             FROM cafe_daily_sales GROUP BY 1),
         c AS (SELECT to_char(ms.sale_date,'YYYY-MM') AS mon, SUM(ms.qty*m.cost)::float8 AS cogs
                 FROM cafe_menu_sales ms JOIN cafe_menu m ON m.id=ms.menu_id GROUP BY 1)
         SELECT t.mon AS month, t.total, t.wd, t.we, ((t.prod-c.cogs)/t.prod*100)::float8 AS margin
           FROM t JOIN c ON c.mon=t.mon ORDER BY t.mon`
      ),
      pool.query(
        `SELECT m.name, m.category, m.price, m.cost,
                COALESCE(SUM(ms.qty), 0)::int AS qty, COALESCE(SUM(ms.revenue), 0)::int AS revenue
           FROM cafe_menu m LEFT JOIN cafe_menu_sales ms ON ms.menu_id = m.id
          GROUP BY m.id, m.name, m.category, m.price, m.cost ORDER BY revenue DESC`
      ),
      pool.query(`SELECT AVG(rating)::float8 AS a, COUNT(*)::int AS n FROM cafe_reviews`),
      pool.query(`SELECT rating, COUNT(*)::int AS n FROM cafe_reviews GROUP BY rating ORDER BY rating DESC`),
      pool.query(`SELECT to_char(review_date,'YYYY-MM') AS month, AVG(rating)::float8 AS a, COUNT(*)::int AS n FROM cafe_reviews GROUP BY 1 ORDER BY 1`),
      pool.query(`SELECT channel, AVG(rating)::float8 AS a, COUNT(*)::int AS n FROM cafe_reviews GROUP BY channel ORDER BY n DESC`),
      // 저평점(≤2) 비율 — 주말(가족일) vs 평일. 좌석 충돌이 드러나는 핵심 지표.
      pool.query(
        `SELECT (d.is_weekend OR d.is_holiday) AS family, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE r.rating<=2)::int AS low
           FROM cafe_reviews r JOIN cafe_daily_sales d ON d.sale_date = r.review_date GROUP BY 1`
      ),
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE status='active')::int AS active,
                COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled,
                COALESCE(SUM(monthly_fee) FILTER (WHERE status='active'), 0)::int AS mrr FROM cafe_memberships`
      ),
      pool.query(
        `SELECT plan, COUNT(*) FILTER (WHERE status='active')::int AS n,
                (COUNT(*) FILTER (WHERE status='active') * monthly_fee)::int AS mrr
           FROM cafe_memberships GROUP BY plan, monthly_fee ORDER BY mrr DESC`
      ),
      pool.query(
        `WITH j AS (SELECT to_char(joined_date,'YYYY-MM') AS mon, COUNT(*)::int AS joins FROM cafe_memberships GROUP BY 1),
              c AS (SELECT to_char(cancelled_date,'YYYY-MM') AS mon, COUNT(*)::int AS churns FROM cafe_memberships WHERE cancelled_date IS NOT NULL GROUP BY 1)
         SELECT COALESCE(j.mon,c.mon) AS month, COALESCE(j.joins,0)::int AS joins, COALESCE(c.churns,0)::int AS churns
           FROM j FULL OUTER JOIN c ON j.mon=c.mon ORDER BY 1`
      ),
    ]);

  // 시간대: 8~20시 각 시간에 대해 평일값/주말값. 주말 미영업(8·9·20시)은 null(선을 끊어 '휴무' 표시).
  const hMap = new Map(); // hour → { weekday, weekend }
  for (let hr = 8; hr <= 20; hr++) hMap.set(hr, { hour: hr, weekday: null, weekend: null });
  for (const r of hourly.rows) {
    const slot = hMap.get(r.hour); if (!slot) continue;
    if (r.family) { if (r.hour >= 10 && r.hour <= 19) slot.weekend = round1(r.av); }
    else slot.weekday = round1(r.av);
  }

  const lowFamily = revLow.rows.find((r) => r.family === true);
  const lowWeekday = revLow.rows.find((r) => r.family === false);
  const share = (row) => (row && row.n ? round1((row.low / row.n) * 100) : null);

  return {
    dailyRevenue: daily.rows.map((r) => ({
      date: r.date, dayName: r.day_name,
      product: r.product_revenue, membership: r.membership_revenue, total: r.total_revenue, visitors: r.visitors,
    })),
    byDayOfWeek: byDow.rows.map((r) => ({
      dayName: r.day_name, avgVisitors: round1(r.av), stdVisitors: round1(r.sv), avgRevenue: Math.round(num(r.ar)), n: r.n,
    })),
    hourly: Array.from(hMap.values()),
    monthlyTrend: monthly.rows.map((r) => ({
      month: r.month, totalRevenue: r.total,
      weekdayAvgRevenue: Math.round(num(r.wd)), weekendAvgRevenue: Math.round(num(r.we)), marginRate: round1(r.margin),
    })),
    menuPerf: menu.rows.map((r) => ({
      name: r.name, category: r.category, price: r.price, cost: r.cost,
      qty: r.qty, revenue: r.revenue, marginRate: r.price ? round1(((r.price - r.cost) / r.price) * 100) : 0,
    })),
    reviews: {
      avgRating: round2(revAgg.rows[0].a),
      byRating: revByRating.rows.map((r) => ({ rating: r.rating, n: r.n })),
      byMonth: revByMonth.rows.map((r) => ({ month: r.month, avgRating: round2(r.a), n: r.n })),
      byChannel: revByChannel.rows.map((r) => ({ channel: r.channel, avgRating: round2(r.a), n: r.n })),
      lowRatingShare: { weekend: share(lowFamily), weekday: share(lowWeekday) },
    },
    membership: {
      active: mem.rows[0].active, cancelled: mem.rows[0].cancelled, mrr: mem.rows[0].mrr,
      byPlan: memByPlan.rows.map((r) => ({ plan: r.plan, n: r.n, mrr: r.mrr })),
      netAddByMonth: netAdd.rows.map((r) => ({ month: r.month, joins: r.joins, churns: r.churns, net: r.joins - r.churns })),
    },
  };
}

// GET /api/dashboard/charts
app.get('/api/dashboard/charts', authRequired, dbWrap(async (_req, res) => {
  const asOf = await getAsOf();
  res.json(await buildCharts(asOf));
}));

// ---------------------------------------------------------------------------
// 11) OpenAI + 외부 데이터 공통
//     - Node 20+ 전역 fetch 사용(axios/node-fetch 금지).
//     - 모든 OpenAI 호출은 try/catch + 20초 타임아웃. 실패해도 대시보드는 살아 있어야 한다.
//     - gpt-4o-search-preview 는 temperature 미지원(넣으면 400).
// ---------------------------------------------------------------------------
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

// 딥로스트 컨셉 제약 — 브리핑/예측 프롬프트에 공통 주입. 모델이 숫자를 지어내지 못하게 한다.
const CAFE_CONTEXT = [
  '딥로스트는 용인 수지구청역 이면도로의 작업자용 스페셜티 카페다.',
  '- 회전율이 낮고 멤버십 고정매출(MRR)이 사활이다.',
  '- 평일은 재택이 몰리는 월·금이 화·수·목보다 붐빈다.',
  '- 주말·공휴일은 가족 손님이 매출 피크지만, 작업 손님과 좌석이 충돌한다(의도된 트레이드오프이자 주말 저평점의 주원인).',
  '- 오피스 상권이 아니라 출근길 8시·점심 12시 파도가 없다. 오전 10~11시, 오후 13~15시(평일 피크)에 손님이 온다.',
  '- 평일 20시 마감(학원가 저녁 수요를 의도적으로 포기).',
  '규칙:',
  '- "고객 만족을 위해 노력하세요", "SNS 마케팅을 강화하세요" 같은 일반론은 절대 쓰지 마라.',
  '- 반드시 제공된 숫자를 인용하라. 제공되지 않은 수치를 지어내지 마라.',
  '- 데이터에 없는 것은 모른다고 말하라. 특히 과거 날씨-방문객 상관 데이터는 없다.',
].join('\n');

async function openaiChat({ model, messages, jsonMode = false, temperature, search = false, timeoutMs = 20000 }) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY 미설정');
  const body = { model, messages };
  if (jsonMode) body.response_format = { type: 'json_object' };
  if (!search && typeof temperature === 'number') body.temperature = temperature; // ⚠️ search 모델엔 넣지 않음
  if (search) {
    body.web_search_options = {
      user_location: { type: 'approximate', approximate: { country: 'KR', region: 'Gyeonggi-do', city: 'Yongin' } },
    };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data && data.error && data.error.message) || `OpenAI ${r.status}`);
    const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
    return { content: msg.content || '', annotations: msg.annotations || [] };
  } finally {
    clearTimeout(timer);
  }
}

// 코드블록/잡텍스트가 섞여도 JSON 한 덩어리를 최대한 파싱.
function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch (_) {}
  const i = t.indexOf('{'); const j = t.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch (_) {} }
  return null;
}
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return ''; } }

// ---------------------------------------------------------------------------
// 12) 날씨 — Open-Meteo(키 불필요). WMO code → 한국어 desc + 이모지 매핑은 서버 담당. 10분 캐시.
// ---------------------------------------------------------------------------
function wmo(code) {
  const c = Number(code);
  if (c === 0) return { desc: '맑음', icon: '☀️' };
  if (c === 1) return { desc: '대체로 맑음', icon: '🌤️' };
  if (c === 2) return { desc: '구름조금', icon: '⛅' };
  if (c === 3) return { desc: '흐림', icon: '☁️' };
  if (c === 45 || c === 48) return { desc: '안개', icon: '🌫️' };
  if (c >= 51 && c <= 57) return { desc: '이슬비', icon: '🌦️' };
  if (c >= 61 && c <= 67) return { desc: '비', icon: '🌧️' };
  if (c >= 71 && c <= 77) return { desc: '눈', icon: '❄️' };
  if (c >= 80 && c <= 82) return { desc: '소나기', icon: '🌦️' };
  if (c === 85 || c === 86) return { desc: '눈소나기', icon: '🌨️' };
  if (c >= 95) return { desc: '뇌우', icon: '⛈️' };
  return { desc: '알 수 없음', icon: '🌡️' };
}

let weatherCache = { at: 0, data: null };
async function getWeather() {
  if (weatherCache.data && Date.now() - weatherCache.at < 10 * 60 * 1000) return weatherCache.data;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${CAFE_LAT}&longitude=${CAFE_LON}` +
    `&current=temperature_2m,precipitation,weather_code` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max` +
    `&timezone=Asia%2FSeoul&forecast_days=3`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('open-meteo ' + r.status);
    const d = await r.json();
    const c = d.current || {};
    const cw = wmo(c.weather_code);
    const dd = d.daily || {};
    const daily = (dd.time || []).map((date, i) => {
      const w = wmo(dd.weather_code[i]);
      return {
        date, dayName: DAY_NAMES[dowOf(date)],
        tempMax: dd.temperature_2m_max[i], tempMin: dd.temperature_2m_min[i],
        precipSum: dd.precipitation_sum[i], precipProb: dd.precipitation_probability_max[i],
        code: dd.weather_code[i], desc: w.desc, icon: w.icon,
      };
    });
    const result = {
      current: { temp: c.temperature_2m, precipitation: c.precipitation, code: c.weather_code, desc: cw.desc, icon: cw.icon },
      daily,
    };
    weatherCache = { at: Date.now(), data: result };
    return result;
  } finally {
    clearTimeout(timer);
  }
}

// GET /api/weather
app.get('/api/weather', authRequired, wrap(async (_req, res) => {
  res.json(await getWeather());
}));

// ---------------------------------------------------------------------------
// 13) 손님수 예측 — SQL baseline(요일 평균·표준편차) 먼저, AI 는 보정만. caveat 항상 포함.
// ---------------------------------------------------------------------------
async function getPrediction() {
  const targetDate = addDays(seoulToday(), 1); // "내일"
  const dow = dowOf(targetDate);
  const dayName = DAY_NAMES[dow];
  const isWeekend = dow === 0 || dow === 6; // 미래 날짜라 공휴일 여부는 알 수 없음 → 요일만으로 판단
  const dtype = isWeekend ? '주말' : '평일';

  const { rows: [b] } = await pool.query(
    `SELECT AVG(visitors)::float8 AS avg, COALESCE(STDDEV_SAMP(visitors), 0)::float8 AS std, COUNT(*)::int AS n
       FROM cafe_daily_sales WHERE day_of_week = $1 AND NOT is_holiday`, [dow]
  );
  const baseline = { avgVisitors: round1(b.avg), stdVisitors: round1(b.std), n: b.n, source: 'DB 요일별 실적 91일' };

  const weather = await getWeather();
  const wDaily = weather.daily.find((x) => x.date === targetDate) || weather.daily[1] || weather.daily[0] || {};
  const wx = { tempMax: wDaily.tempMax, precipSum: wDaily.precipSum, precipProb: wDaily.precipProb, desc: wDaily.desc, icon: wDaily.icon };
  const rainForecast = (Number(wx.precipProb) >= 50) || (Number(wx.precipSum) > 0);

  const caveat = '과거 날씨-방문객 상관 데이터가 없어 AI의 정성 보정입니다. baseline(±1σ)을 벗어나면 AI가 아니라 baseline을 믿으세요.';
  const avg = baseline.avgVisitors || 0;
  const std = baseline.stdVisitors || 0;
  let prediction, reasoning, factors;
  try {
    const sys = CAFE_CONTEXT +
      '\n너는 방문객 예측 "보정기"다. baseline(요일 평균±표준편차)과 내일 날씨만으로 정성 보정한다. 아래 제약을 반드시 지켜라:\n' +
      '1. "비 오면 -15%" 같은 단일 보정 계수를 쓰지 마라. 우리 DB에는 과거 날씨-방문객 상관 데이터가 전혀 없다.\n' +
      '2. 평일과 주말은 우천 민감도의 "방향" 자체가 다를 수 있다. 평일 작업 손님은 목적형이라 비에 덜 민감하고, ' +
      '주말 가족 손님은 나들이형이라 비에 안 나올 수도/실내로 몰릴 수도 있어 방향이 불확실하다. dayType 에 맞게 다르게 보정하라.\n' +
      '3. 주말에 강수 예보가 있으면 low~high 간격을 넓게 잡아라(불확실성 반영).\n' +
      '4. baseline ±1 표준편차를 벗어나는 예측을 하려면 그 근거를 reasoning 에 반드시 써라.\n' +
      '반드시 JSON: {"expected":정수,"low":정수,"high":정수,"confidence":"높음|중|낮음","reasoning":"한국어 근거(숫자 인용)","factors":[{"name":"요인","effect":"+|-|0","weight":"높음|보통|낮음"}]}';
    const usr = JSON.stringify({ targetDate, dayName, dayType: dtype, rainForecast, baseline, weather: wx });
    const { content } = await openaiChat({
      model: 'gpt-4.1', messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
      jsonMode: true, temperature: 0.4,
    });
    const j = JSON.parse(content);
    const expected = Math.round(Number(j.expected));
    // 주말 + 강수 예보면 confidence 는 반드시 '낮음'(계약 5-2 규칙) — 모델이 뭘 줬든 서버가 강제.
    const confidence = (isWeekend && rainForecast) ? '낮음' : (j.confidence || '중');
    prediction = {
      expected,
      low: Math.round(Number(j.low)),
      high: Math.round(Number(j.high)),
      confidence,
      vsBaselinePct: avg ? round1(((expected - avg) / avg) * 100) : 0, // 서버가 재계산(모델값 신뢰 X)
    };
    reasoning = String(j.reasoning || '');
    factors = Array.isArray(j.factors) ? j.factors : [];
  } catch (e) {
    // AI 실패 → baseline 만으로 정직하게 폴백
    prediction = {
      expected: Math.round(avg), low: Math.round(avg - std), high: Math.round(avg + std),
      confidence: '낮음', vsBaselinePct: 0,
    };
    reasoning = 'AI 보정에 실패해 요일 baseline(평균)만으로 예측합니다.';
    factors = [];
  }

  // 예보+예측치를 날씨 로그에 upsert(나중에 실제 방문자와 대조해 진짜 계수를 뽑기 위함). 실패해도 예측은 반환.
  try {
    await pool.query(
      `INSERT INTO cafe_weather_log (log_date, temp_max, precip_sum, weather_code, baseline_expected, ai_expected)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (log_date) DO UPDATE SET
         temp_max=EXCLUDED.temp_max, precip_sum=EXCLUDED.precip_sum, weather_code=EXCLUDED.weather_code,
         baseline_expected=EXCLUDED.baseline_expected, ai_expected=EXCLUDED.ai_expected`,
      [targetDate, wx.tempMax ?? null, wx.precipSum ?? null, wDaily.code ?? null, baseline.avgVisitors, prediction.expected]
    );
  } catch (err) {
    console.error('[weather_log] upsert 실패(무시):', err.message);
  }

  return { targetDate, dayName, dayType: dtype, baseline, weather: wx, prediction, reasoning, factors, caveat };
}

// GET /api/predict/visitors
app.get('/api/predict/visitors', authRequired, dbWrap(async (_req, res) => {
  res.json(await getPrediction());
}));

// ---------------------------------------------------------------------------
// 14) 뉴스 — gpt-4o-search-preview(웹검색). temperature 금지. 실제 인용 URL 사용. 15분 캐시.
// ---------------------------------------------------------------------------
let newsCache = { at: 0, data: null };
async function getNews() {
  if (newsCache.data && Date.now() - newsCache.at < 15 * 60 * 1000) return newsCache.data;
  const sys = '너는 용인 수지구청역 스페셜티 카페 "딥로스트" 사장을 돕는 뉴스 큐레이터다. 웹 검색으로 한국의 최신 뉴스를 찾아라.\n' +
    'topic 은 반드시 다음 6개 중 하나: 원두시세 / 우윳값 / 최저임금 / 임대료 / 수수료 / 카페트렌드\n' +
    // 검색 모델이 "카페트렌드"를 핑계로 캠핑페스타 같은 행사 소식을 물어온 적이 있다.
    '★ 채택 기준: 우리 카페의 **원가나 손님 수요에 직접 영향을 주는 뉴스**만. ' +
    '행사·축제·박람회 소식, 광고성 글, 개인 블로그, 창업 컨설팅 홍보글은 제외한다.\n' +
    // 이걸 안 박아두면 같은 사건(예: 특정 프랜차이즈 가격 인상)을 매체만 바꿔 3건으로 채운다.
    '★ 같은 사건을 다룬 다른 매체 기사를 별도 항목으로 넣지 마라. 같은 회사·같은 이슈면 한 건만.\n' +
    '★ 조건에 맞는 뉴스가 적으면 억지로 채우지 말고 항목 수를 줄여라. 1~2건이어도 좋다.\n' +
    '각 뉴스마다 카페 운영에 미치는 영향(impact)을 구체적으로 한 문장.\n' +
    '반드시 아래 JSON만 출력(설명/코드블록 금지): {"items":[{"title":"","summary":"","impact":"","url":"","source":"","topic":""}]} (최대 4개)';
  // ⚠️ "최신 뉴스 3~5개 찾아줘"라고 뭉뚱그리면 검색 모델이 한 사건(예: 특정 프랜차이즈 가격 인상)에
  //    꽂혀 같은 기사만 매체 바꿔 물어온다. 주제를 열거해 "주제당 1건씩" 시키면 폭이 넓어진다.
  const usr = `오늘은 ${seoulToday()}.
다음 주제를 **각각 따로 검색**해서 주제당 최대 1건씩 가져와라. 한 주제에서 여러 건 찾지 말고 다음 주제로 넘어가라.
1) 커피 원두 국제 시세
2) 원유·우유 가격
3) 최저임금·인건비
4) 상가 임대료
5) 배달앱·카드 수수료
6) 카페 소비 트렌드
조건에 맞는 뉴스가 없는 주제는 건너뛴다.`;
  const { content, annotations } = await openaiChat({
    model: 'gpt-4o-search-preview',
    messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
    search: true, timeoutMs: 25000,
  });
  const cites = (annotations || []).filter((a) => a.type === 'url_citation').map((a) => a.url_citation || {});
  const parsed = extractJson(content);
  let items = parsed && Array.isArray(parsed.items) ? parsed.items : [];
  items = items.slice(0, 6).map((it, idx) => {
    const url = it.url || (cites[idx] && cites[idx].url) || (cites[0] && cites[0].url) || '';
    return {
      title: String(it.title || '').slice(0, 200),
      summary: String(it.summary || ''),
      impact: String(it.impact || ''),
      url,
      source: it.source || hostOf(url),
      topic: String(it.topic || ''),
    };
  });

  // 프롬프트로 막아도 모델이 (a) 같은 사건을 매체만 바꿔 여러 건으로 채우거나
  // (b) "카페트렌드"를 핑계로 행사 소식 같은 무관한 글을 물어온다. 서버에서 한 번 더 거른다.
  //
  // ⚠️ 예전엔 topic 이 겹치면 무조건 버렸는데, 그러면 서로 다른 사건도 날아가 뉴스가 1건으로 쪼그라들었다.
  //    이제 "같은 주체(subject)"만 중복으로 본다. 예: "이디야커피 스틱커피 15.2% 인상" 기사 3건 → 1건.
  // 주제 판정은 '정확 일치'가 아니라 '포함'으로 한다.
  // 모델이 topic 을 "배달/플랫폼 수수료" 처럼 자유롭게 적어서, 정확 일치로 하면 멀쩡한 기사가 버려진다.
  const TOPIC_PATTERNS = [/원두/, /우유|우윳/, /최저임금|인건비/, /임대료|월세/, /수수료/, /트렌드/];
  // 원가·수요와 무관한 홍보성 글. "카페트렌드"를 핑계로 딸려 오는 것들이라 제목으로 거른다.
  const OFF_TOPIC = /축제|페스타|박람회|엑스포|개최|세미나|컨설팅|창업\s*설명회|이벤트 안내/;

  const subjectKey = (t) => String(t)
    .replace(/[^가-힣a-zA-Z0-9]/g, '')  // 공백·기호 제거
    .replace(/\d+(\.\d+)?/g, '')        // 숫자 제거 → "15.2%"와 "15%"를 같게 본다
    .slice(0, 6);                       // 앞 6자 ≈ 기사의 주체(회사·기관명)

  const seenSubjects = new Set();
  const rawCount = items.length;
  const dropped = [];
  items = items.filter((it) => {
    const hay = `${it.topic} ${it.title}`;
    if (!TOPIC_PATTERNS.some((re) => re.test(hay))) { dropped.push(`주제밖: ${it.title}`); return false; }
    if (OFF_TOPIC.test(it.title)) { dropped.push(`행사·홍보: ${it.title}`); return false; }
    const sk = subjectKey(it.title);
    if (sk && seenSubjects.has(sk)) { dropped.push(`중복(${sk}): ${it.title}`); return false; }
    if (sk) seenSubjects.add(sk);
    return true;
  }).slice(0, 4);
  // 조용히 잘라내면 "원래 이만큼밖에 없었다"로 오해한다. 무엇이 왜 빠졌는지 남긴다.
  console.log(`[news] 모델 원본 ${rawCount}건 → 노출 ${items.length}건`);
  dropped.forEach((d) => console.log(`[news]   제외 — ${d}`));
  if (items.length === 0 && cites.length) {
    items = cites.slice(0, 5).map((c) => ({ title: c.title || '관련 기사', summary: '', impact: '', url: c.url || '', source: hostOf(c.url || '') }));
  }
  const result = { items, generatedAt: Date.now() };
  if (items.length) newsCache = { at: Date.now(), data: result };
  return result;
}

// GET /api/news — 실패해도 500 대신 빈 items.
app.get('/api/news', authRequired, wrap(async (_req, res) => {
  try {
    res.json(await getNews());
  } catch (err) {
    console.error('[news] 생성 실패:', err.message);
    res.json({ items: [], generatedAt: Date.now() });
  }
}));

// ---------------------------------------------------------------------------
// 15) 오늘의 카페 브리핑 ⭐ — 서버가 DB+날씨+예측+뉴스를 모아 한 번의 gpt-4.1 호출로 생성.
//     서버 메모리 10분 캐시(?refresh=1 강제 갱신). AI 실패해도 나머지 수치는 그대로 반환.
// ---------------------------------------------------------------------------
let briefingCache = { at: 0, data: null };
async function getBriefing({ refresh }) {
  if (!refresh && briefingCache.data && Date.now() - briefingCache.at < 10 * 60 * 1000) {
    return { ...briefingCache.data, cached: true };
  }
  const asOf = await getAsOf();
  const summary = await buildSummary(asOf);
  const weather = await getWeather();
  const month = asOf.slice(0, 7);
  const [dayRes, revRes, netRes] = await Promise.all([
    pool.query(
      `SELECT to_char(sale_date,'YYYY-MM-DD') AS date, day_name, visitors, orders,
              product_revenue, membership_revenue, total_revenue, is_weekend, is_holiday
         FROM cafe_daily_sales WHERE sale_date = $1`, [asOf]),
    pool.query(`SELECT rating, channel, content FROM cafe_reviews WHERE review_date=$1 ORDER BY id LIMIT 10`, [asOf]),
    pool.query(
      `SELECT (SELECT COUNT(*)::int FROM cafe_memberships WHERE to_char(joined_date,'YYYY-MM')=$1) AS joins,
              (SELECT COUNT(*)::int FROM cafe_memberships WHERE cancelled_date IS NOT NULL AND to_char(cancelled_date,'YYYY-MM')=$1) AS churns`, [month]),
  ]);
  const day = dayRes.rows[0] || null;
  const newReviews = revRes.rows.length
    ? revRes.rows.map((r) => ({ 별점: r.rating, 채널: r.channel, 내용: r.content }))
    : '새 리뷰 없음 (asOf 날짜에 등록된 리뷰가 없습니다)';
  const net = netRes.rows[0] || { joins: 0, churns: 0 };

  let prediction = null; let news = null;
  try { prediction = await getPrediction(); } catch (e) { console.error('[briefing] 예측 실패:', e.message); }
  try { news = await getNews(); } catch (e) { console.error('[briefing] 뉴스 실패:', e.message); news = { items: [], generatedAt: Date.now() }; }

  const k = summary.kpis;
  const realToday = seoulToday();
  const gather = {
    // ⚠️ 두 날짜는 다르다. 실적은 "마지막으로 마감 입력된 영업일"(asOf) 기준이고,
    //    날씨·예측·뉴스는 "실제 오늘/내일" 기준이다. 섞으면 모델이 오늘 날짜를 지어낸다.
    실제_오늘: realToday,
    최근_마감일: asOf, 최근_마감일_요일: summary.asOfDayName, dayType: summary.dayType,
    최근마감_실적: day && {
      방문자: day.visitors, 주문수: day.orders, 상품매출: day.product_revenue,
      멤버십매출: day.membership_revenue, 총매출: day.total_revenue, 객단가: k.avgTicket.value,
    },
    비교_deltaPct_양수면_평균보다_좋음: {
      총매출_전주동요일: k.revenue.vsLastWeek.deltaPct,
      총매출_요일평균: k.revenue.vsDowAvg.deltaPct,     // ⚠️ 평균보다 높으면 날씨 탓 금지
      방문자_요일평균: k.visitors.vsDowAvg.deltaPct,
      객단가_요일타입평균: k.avgTicket.vsDayTypeAvg.deltaPct,
    },
    멤버십: { MRR: k.membershipMrr.value, 요약: k.membershipMrr.sub, 이번달순증: { 가입: net.joins, 해지: net.churns, 순증: net.joins - net.churns } },
    매출총이익률: k.grossMargin.value,
    재고알림: summary.alerts.map((a) => ({ level: a.level, title: a.title, detail: a.detail })),
    재고알림요약: k.inventoryAlerts.sub,
    asOf_새리뷰: newReviews,
    현재날씨: weather.current,
    오늘날씨: weather.daily[0],
    내일예측: prediction && { 요일: prediction.dayName, dayType: prediction.dayType, baseline: prediction.baseline, 예측: prediction.prediction, 근거: prediction.reasoning, caveat: prediction.caveat },
    뉴스: (news.items || []).map((n) => ({ title: n.title, impact: n.impact })),
  };

  let headline, sections, actions; let ok = false;
  try {
    const sys = CAFE_CONTEXT +
      '\n너는 사장에게 "오늘의 브리핑"을 쓰는 운영 파트너다. 제공된 숫자만 사용하고 반드시 인용하라. 마지막은 오늘 당장 할 수 있는 구체 행동 1~3개.\n' +
      '금칙(반드시 지켜라):\n' +
      '1. 감성 인사말 금지("좋은 아침입니다, 향긋한 커피와 함께…" → 액션이 0개다).\n' +
      '2. 사장이 이미 아는 컨셉 재진술 금지("평일엔 직장인, 주말엔 가족이 옵니다" → 새 정보 없음).\n' +
      '3. 근거 없는 인과 단정 금지. 특히 "비가 와서 어제 손님이 적었다" 류 — 제공된 "비교_deltaPct" 를 보라. 양수면 어제는 요일 평균보다 좋았다는 뜻이다. 확인 안 된 날씨 핑계는 데이터와 충돌하는 거짓말이다.\n' +
      '4. 표본 작은 걸 확정으로 말하지 마라("프로 플랜은 인기 없다" — 활성 2명뿐).\n' +
      '5. 알려진 트레이드오프(주말 좌석 갈등)를 새 위기처럼 보고하지 마라. 설계 단계에서 선택한 것이지 새 발견이 아니다.\n' +
      '6. 액션 없는 일반론 금지("마케팅을 강화하세요", "고객 만족에 힘쓰세요").\n' +
      '7. 데이터에 없는 것은 모른다고 말하라.\n' +
      '8. 날짜를 지어내지 마라. "실제_오늘" 과 "최근_마감일" 은 서로 다른 날이다. ' +
      '실적 수치는 최근_마감일(마지막으로 마감 입력된 영업일) 것이고, 날씨·예측·뉴스는 실제_오늘 기준이다. ' +
      '최근_마감일을 "어제"라고 부르지 마라. 두 날짜가 다르면 "최근 마감일(M/D 요일)" 처럼 날짜를 명시하라.\n' +
      'headline 은 날짜 제목이 아니라 오늘의 핵심 상황+행동을 한 문장으로 압축(예: "오늘은 비 — 실내 체류 늘 것. 핫초코 파우더부터 발주하세요.").\n' +
      '반드시 JSON: {"headline":"","sections":[{"title":"","body":""}],"actions":[""]}. ' +
      'sections 는 정확히 4개, title 은 "📊 최근 마감 실적","🌧️ 오늘 날씨와 손님","⚠️ 오늘 조치할 것","📰 알아둘 뉴스".';
    const { content } = await openaiChat({
      model: 'gpt-4.1', messages: [{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify(gather) }],
      jsonMode: true, temperature: 0.6, timeoutMs: 25000,
    });
    const j = JSON.parse(content);
    headline = String(j.headline || '');
    sections = Array.isArray(j.sections) ? j.sections : [];
    actions = Array.isArray(j.actions) ? j.actions : [];
    ok = headline && sections.length > 0;
  } catch (e) {
    console.error('[briefing] AI 생성 실패:', e.message);
  }

  if (!ok) {
    // 폴백 — 화면이 죽지 않도록 수치 기반 기본 브리핑.
    const won = (n) => Number(n || 0).toLocaleString('ko-KR');
    headline = 'AI 브리핑 생성 실패 — 아래 수치는 정상입니다.';
    sections = [
      { title: '📊 어제 실적', body: day ? `${day.date}(${day.day_name}) 방문 ${day.visitors}명, 주문 ${day.orders}건, 총매출 ${won(day.total_revenue)}원.` : '어제 실적 데이터가 없습니다.' },
      { title: '🌧️ 오늘 날씨와 손님', body: `현재 ${weather.current.desc} ${weather.current.icon}, 기온 ${weather.current.temp}℃. 강수 ${weather.current.precipitation}mm.` },
      { title: '⚠️ 오늘 조치할 것', body: summary.alerts.length ? summary.alerts.map((a) => a.title).join(' · ') : '재고 경고 없음.' },
      { title: '📰 알아둘 뉴스', body: (news.items[0] && news.items[0].title) || '뉴스를 불러오지 못했습니다.' },
    ];
    actions = summary.alerts.slice(0, 3).map((a) => `${a.title} — 발주 검토`);
  }

  const result = { headline, sections, actions, weather, prediction, news, generatedAt: Date.now(), model: 'gpt-4.1', cached: false };
  if (ok) briefingCache = { at: Date.now(), data: result }; // 실패 응답은 캐시하지 않음(다음 요청서 재시도)
  return result;
}

// GET /api/briefing?refresh=1
app.get('/api/briefing', authRequired, dbWrap(async (req, res) => {
  res.json(await getBriefing({ refresh: req.query.refresh === '1' }));
}));

// ---------------------------------------------------------------------------
// 16) Notion 연동 — REST(2022-06-28). NOTION_TOKEN 이 비면 500 대신 "연결 안내" 반환.
//     ⚠️ 속성명은 한글. 상태 '할 일'(가운데 공백) ≠ 제목 속성 '할일'. 혼동 금지.
//     ⚠️ :id 는 Notion 페이지 UUID(숫자 아님) — parseId 쓰지 말 것.
// ---------------------------------------------------------------------------
function notionSetup() {
  return {
    parentPageUrl: NOTION_PARENT_PAGE_URL,
    steps: [
      'https://www.notion.so/my-integrations 에서 내부 통합을 만들고 시크릿(ntn_...)을 복사',
      "Notion에서 '☕ 딥로스트 카페 운영' 페이지 → ••• → 연결 → 방금 만든 통합 추가",
      '.env 의 NOTION_TOKEN= 뒤에 붙여넣고 서버 재시작',
    ],
  };
}
async function notionFetch(p, method = 'GET', body) {
  const r = await fetch('https://api.notion.com/v1' + p, {
    method,
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data && data.message) || `Notion ${r.status}`);
  return data;
}
const notionPlain = (rich) => (Array.isArray(rich) ? rich.map((t) => t.plain_text || '').join('') : '');
const selName = (prop) => (prop && prop.select ? prop.select.name : null);

function mapTodo(pg) {
  const p = pg.properties || {};
  return {
    id: pg.id,
    title: notionPlain(p['할일'] && p['할일'].title),
    status: selName(p['상태']), priority: selName(p['우선순위']), category: selName(p['분류']),
    due: p['마감일'] && p['마감일'].date ? p['마감일'].date.start : null,
    memo: notionPlain(p['메모'] && p['메모'].rich_text),
    url: pg.url,
  };
}
function mapOrderPage(pg) {
  const p = pg.properties || {};
  return {
    id: pg.id,
    item: notionPlain(p['품목'] && p['품목'].title),
    status: selName(p['상태']),
    supplier: notionPlain(p['공급처'] && p['공급처'].rich_text),
    qty: p['수량'] ? p['수량'].number : null,
    unit: selName(p['단위']),
    amount: p['예상금액'] ? p['예상금액'].number : null,
    due: p['발주예정일'] && p['발주예정일'].date ? p['발주예정일'].date.start : null,
    memo: notionPlain(p['메모'] && p['메모'].rich_text),
    url: pg.url,
  };
}
// 보낸 필드만 properties 로 변환(부분 수정 지원). create 면 title/기본 상태를 보장.
function buildTodoProps(b, create) {
  const props = {};
  if (create || b.title !== undefined) props['할일'] = { title: [{ text: { content: String(b.title || '') } }] };
  if (create || b.status !== undefined) props['상태'] = { select: { name: b.status || '할 일' } };
  if (b.priority !== undefined) props['우선순위'] = { select: { name: b.priority } };
  if (b.category !== undefined) props['분류'] = { select: { name: b.category } };
  if (b.due !== undefined) props['마감일'] = b.due ? { date: { start: b.due } } : { date: null };
  if (b.memo !== undefined) props['메모'] = { rich_text: [{ text: { content: String(b.memo || '') } }] };
  return props;
}
function buildOrderProps(b, create) {
  const props = {};
  if (create || b.item !== undefined) props['품목'] = { title: [{ text: { content: String(b.item || '') } }] };
  if (create || b.status !== undefined) props['상태'] = { select: { name: b.status || '발주필요' } };
  if (b.supplier !== undefined) props['공급처'] = { rich_text: [{ text: { content: String(b.supplier || '') } }] };
  if (b.qty !== undefined) props['수량'] = { number: b.qty == null ? null : Number(b.qty) };
  if (b.unit !== undefined) props['단위'] = { select: { name: b.unit } };
  if (b.amount !== undefined) props['예상금액'] = { number: b.amount == null ? null : Number(b.amount) };
  if (b.due !== undefined) props['발주예정일'] = b.due ? { date: { start: b.due } } : { date: null };
  if (b.memo !== undefined) props['메모'] = { rich_text: [{ text: { content: String(b.memo || '') } }] };
  return props;
}

// GET /api/notion/status
app.get('/api/notion/status', authRequired, wrap(async (_req, res) => {
  const body = { configured: !!NOTION_TOKEN, parentPageUrl: NOTION_PARENT_PAGE_URL, todoDbId: NOTION_TODO_DB_ID, orderDbId: NOTION_ORDER_DB_ID };
  if (!NOTION_TOKEN) body.setup = notionSetup();
  res.json(body);
}));

// 할일 — 정렬: 마감일 오름차순
app.get('/api/notion/todos', authRequired, wrap(async (_req, res) => {
  if (!NOTION_TOKEN) return res.json({ configured: false, items: [], setup: notionSetup() });
  const data = await notionFetch(`/databases/${NOTION_TODO_DB_ID}/query`, 'POST', { sorts: [{ property: '마감일', direction: 'ascending' }] });
  res.json({ configured: true, items: (data.results || []).map(mapTodo) });
}));
app.post('/api/notion/todos', authRequired, wrap(async (req, res) => {
  if (!NOTION_TOKEN) return res.json({ configured: false, setup: notionSetup() });
  if (!String(req.body.title || '').trim()) return res.status(400).json({ error: '할일 제목을 입력해 주세요.' });
  const data = await notionFetch('/pages', 'POST', { parent: { database_id: NOTION_TODO_DB_ID }, properties: buildTodoProps(req.body, true) });
  res.status(201).json(mapTodo(data));
}));
app.patch('/api/notion/todos/:id', authRequired, wrap(async (req, res) => {
  if (!NOTION_TOKEN) return res.json({ configured: false, setup: notionSetup() });
  const props = buildTodoProps(req.body, false);
  if (Object.keys(props).length === 0) return res.status(400).json({ error: '변경할 항목이 없습니다.' });
  const data = await notionFetch(`/pages/${req.params.id}`, 'PATCH', { properties: props });
  res.json(mapTodo(data));
}));

// 발주 메모 — 정렬: 발주예정일 오름차순
app.get('/api/notion/orders', authRequired, wrap(async (_req, res) => {
  if (!NOTION_TOKEN) return res.json({ configured: false, items: [], setup: notionSetup() });
  const data = await notionFetch(`/databases/${NOTION_ORDER_DB_ID}/query`, 'POST', { sorts: [{ property: '발주예정일', direction: 'ascending' }] });
  res.json({ configured: true, items: (data.results || []).map(mapOrderPage) });
}));
app.post('/api/notion/orders', authRequired, wrap(async (req, res) => {
  if (!NOTION_TOKEN) return res.json({ configured: false, setup: notionSetup() });
  if (!String(req.body.item || '').trim()) return res.status(400).json({ error: '품목을 입력해 주세요.' });
  const data = await notionFetch('/pages', 'POST', { parent: { database_id: NOTION_ORDER_DB_ID }, properties: buildOrderProps(req.body, true) });
  res.status(201).json(mapOrderPage(data));
}));
app.patch('/api/notion/orders/:id', authRequired, wrap(async (req, res) => {
  if (!NOTION_TOKEN) return res.json({ configured: false, setup: notionSetup() });
  const props = buildOrderProps(req.body, false);
  if (Object.keys(props).length === 0) return res.status(400).json({ error: '변경할 항목이 없습니다.' });
  const data = await notionFetch(`/pages/${req.params.id}`, 'PATCH', { properties: props });
  res.json(mapOrderPage(data));
}));

// POST /api/notion/orders/sync-from-inventory — 안전재고 하회 품목 중 발주메모에 없는 것만 생성.
app.post('/api/notion/orders/sync-from-inventory', authRequired, dbWrap(async (_req, res) => {
  if (!NOTION_TOKEN) return res.json({ configured: false, created: [], skipped: [], setup: notionSetup() });
  const { rows } = await pool.query(
    `SELECT item_name, unit, current_stock::float8 AS cs, safety_stock::float8 AS ss, unit_cost, supplier
       FROM cafe_inventory WHERE current_stock < safety_stock
      ORDER BY (current_stock / NULLIF(safety_stock, 0)) ASC`
  );
  const existing = await notionFetch(`/databases/${NOTION_ORDER_DB_ID}/query`, 'POST', {});
  const existingTitles = new Set(
    (existing.results || [])
      .map((pg) => notionPlain(pg.properties && pg.properties['품목'] && pg.properties['품목'].title).trim())
      .filter(Boolean)
  );
  const created = []; const skipped = [];
  for (const r of rows) {
    if (existingTitles.has(r.item_name)) { skipped.push(r.item_name); continue; }
    const qty = Math.max(1, Math.ceil(r.ss - r.cs)); // 부족분(최소 1)
    const unit = ['kg', 'L', 'ea'].includes(r.unit) ? r.unit : 'ea';
    await notionFetch('/pages', 'POST', {
      parent: { database_id: NOTION_ORDER_DB_ID },
      properties: buildOrderProps({
        item: r.item_name, status: '발주필요', supplier: r.supplier, qty, unit,
        amount: Math.round(qty * r.unit_cost),
        memo: `안전재고(${fmtQty(r.ss)}${r.unit}) 하회 자동 생성 — 현재고 ${fmtQty(r.cs)}${r.unit}`,
      }, true),
    });
    created.push(r.item_name);
  }
  res.json({ configured: true, created, skipped });
}));

// ---------------------------------------------------------------------------
// 17) 데이터 관리(CRUD) — 전부 JWT 필요. 금액/수량은 서버에서 타입 검증(음수 등 400).
//     ⚠️ cafe_daily_sales.total_revenue 는 생성 컬럼 → INSERT/UPDATE 대상에 넣지 않는다.
//     ⚠️ 숫자 컬럼은 SQL 캐스팅(::float8) 또는 정수 컬럼 그대로 → 프론트에 숫자로 전달.
// ---------------------------------------------------------------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PO_STATUS = new Set(['발주완료', '배송중', '입고완료', '취소']);
const MEMBER_STATUS = new Set(['active', 'cancelled']);

// 공용 INSERT/UPDATE 빌더 — 테이블/컬럼은 코드 상수만 사용(사용자 입력 아님, 인젝션 안전).
async function insertRow(table, fields, returning) {
  const cols = Object.keys(fields);
  const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await pool.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph}) RETURNING ${returning}`,
    cols.map((c) => fields[c])
  );
  return rows[0];
}
async function updateRow(table, fields, idCol, id, returning) {
  const cols = Object.keys(fields);
  const set = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
  const params = cols.map((c) => fields[c]);
  params.push(id);
  const { rows } = await pool.query(
    `UPDATE ${table} SET ${set} WHERE ${idCol} = $${params.length} RETURNING ${returning}`,
    params
  );
  return rows[0] || null;
}
const idOr400 = (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) { res.status(400).json({ error: '유효하지 않은 id 입니다.' }); return null; }
  return id;
};

// --- 메뉴 --------------------------------------------------------------------
const MENU_COLS = 'id, name, category, price, cost, is_signature';
const mapMenu = (r) => ({ id: r.id, name: r.name, category: r.category, price: r.price, cost: r.cost, isSignature: r.is_signature });
function validateMenu(b, create) {
  const f = {};
  const has = (k) => b[k] !== undefined && b[k] !== null;
  if (create || has('name')) { const v = typeof b.name === 'string' ? b.name.trim() : ''; if (!v) return { error: '메뉴명을 입력해 주세요.' }; f.name = v; }
  if (create || has('category')) { const v = typeof b.category === 'string' ? b.category.trim() : ''; if (!v) return { error: '카테고리를 입력해 주세요.' }; f.category = v; }
  if (create || has('price')) { const v = Number(b.price); if (!Number.isInteger(v) || v < 0) return { error: '가격은 0 이상의 정수여야 합니다.' }; f.price = v; }
  if (create || has('cost')) { const v = Number(b.cost); if (!Number.isInteger(v) || v < 0) return { error: '원가는 0 이상의 정수여야 합니다.' }; f.cost = v; }
  if (create || has('isSignature')) f.is_signature = !!b.isSignature;
  return { fields: f };
}
app.get('/api/menu', authRequired, dbWrap(async (_req, res) => {
  const { rows } = await pool.query(`SELECT ${MENU_COLS} FROM cafe_menu ORDER BY category, id`);
  res.json(rows.map(mapMenu));
}));
app.post('/api/menu', authRequired, dbWrap(async (req, res) => {
  const { error, fields } = validateMenu(req.body, true);
  if (error) return res.status(400).json({ error });
  try {
    res.status(201).json(mapMenu(await insertRow('cafe_menu', fields, MENU_COLS)));
  } catch (err) {
    if (err && err.code === '23505') return res.status(409).json({ error: '같은 이름의 메뉴가 이미 있습니다.' });
    throw err;
  }
}));
app.patch('/api/menu/:id', authRequired, dbWrap(async (req, res) => {
  const id = idOr400(req, res); if (id === null) return;
  const { error, fields } = validateMenu(req.body, false);
  if (error) return res.status(400).json({ error });
  if (Object.keys(fields).length === 0) return res.status(400).json({ error: '변경할 항목이 없습니다.' });
  const row = await updateRow('cafe_menu', fields, 'id', id, MENU_COLS);
  if (!row) return res.status(404).json({ error: '해당 메뉴를 찾을 수 없습니다.' });
  res.json(mapMenu(row));
}));
app.delete('/api/menu/:id', authRequired, dbWrap(async (req, res) => {
  const id = idOr400(req, res); if (id === null) return;
  const used = await pool.query('SELECT 1 FROM cafe_menu_sales WHERE menu_id = $1 LIMIT 1', [id]);
  if (used.rows.length) return res.status(409).json({ error: '판매 이력이 있는 메뉴는 삭제할 수 없습니다. 대신 비활성화하세요.' });
  try {
    const { rows } = await pool.query('DELETE FROM cafe_menu WHERE id = $1 RETURNING id', [id]);
    if (!rows.length) return res.status(404).json({ error: '해당 메뉴를 찾을 수 없습니다.' });
    res.json({ ok: true, deletedId: rows[0].id });
  } catch (err) {
    if (err && err.code === '23503') return res.status(409).json({ error: '판매 이력이 있는 메뉴는 삭제할 수 없습니다. 대신 비활성화하세요.' });
    throw err;
  }
}));

// --- 재고 --------------------------------------------------------------------
const INV_COLS = `id, item_name, category, unit, current_stock::float8 AS current_stock,
                  safety_stock::float8 AS safety_stock, unit_cost, supplier`;
const mapInv = (r) => ({
  id: r.id, itemName: r.item_name, category: r.category, unit: r.unit,
  currentStock: num(r.current_stock), safetyStock: num(r.safety_stock),
  unitCost: r.unit_cost, supplier: r.supplier,
  shortage: num(r.current_stock) < num(r.safety_stock),
});
app.get('/api/inventory', authRequired, dbWrap(async (_req, res) => {
  const { rows } = await pool.query(`SELECT ${INV_COLS} FROM cafe_inventory ORDER BY (current_stock - safety_stock) ASC`);
  res.json(rows.map(mapInv));
}));
app.patch('/api/inventory/:id', authRequired, dbWrap(async (req, res) => {
  const id = idOr400(req, res); if (id === null) return;
  const b = req.body; const f = {};
  const has = (k) => b[k] !== undefined && b[k] !== null;
  if (has('currentStock')) { const v = Number(b.currentStock); if (!(v >= 0)) return res.status(400).json({ error: '현재고는 0 이상이어야 합니다.' }); f.current_stock = v; }
  if (has('safetyStock')) { const v = Number(b.safetyStock); if (!(v >= 0)) return res.status(400).json({ error: '안전재고는 0 이상이어야 합니다.' }); f.safety_stock = v; }
  if (has('unitCost')) { const v = Number(b.unitCost); if (!Number.isInteger(v) || v < 0) return res.status(400).json({ error: '단가는 0 이상의 정수여야 합니다.' }); f.unit_cost = v; }
  if (has('supplier')) { const v = String(b.supplier).trim(); if (!v) return res.status(400).json({ error: '공급처를 입력해 주세요.' }); f.supplier = v; }
  if (Object.keys(f).length === 0) return res.status(400).json({ error: '변경할 항목이 없습니다.' });
  f.updated_at = new Date();
  const row = await updateRow('cafe_inventory', f, 'id', id, INV_COLS);
  if (!row) return res.status(404).json({ error: '해당 재고 품목을 찾을 수 없습니다.' });
  res.json(mapInv(row));
}));

// --- 발주 --------------------------------------------------------------------
const PO_COLS = `id, to_char(order_date,'YYYY-MM-DD') AS order_date, item_name, qty::float8 AS qty,
                 unit_price, total_cost, supplier, status, to_char(expected_date,'YYYY-MM-DD') AS expected_date`;
const mapPO = (r) => ({
  id: r.id, orderDate: r.order_date, itemName: r.item_name, qty: num(r.qty),
  unitPrice: r.unit_price, totalCost: r.total_cost, supplier: r.supplier,
  status: r.status, expectedDate: r.expected_date,
});
app.get('/api/purchase-orders', authRequired, dbWrap(async (_req, res) => {
  const { rows } = await pool.query(`SELECT ${PO_COLS} FROM cafe_purchase_orders ORDER BY order_date DESC, id DESC`);
  res.json(rows.map(mapPO));
}));
app.post('/api/purchase-orders', authRequired, dbWrap(async (req, res) => {
  const b = req.body;
  const orderDate = String(b.orderDate || '');
  const itemName = String(b.itemName || '').trim();
  const qty = Number(b.qty);
  const unitPrice = Number(b.unitPrice);
  const totalCost = b.totalCost != null ? Number(b.totalCost) : Math.round(qty * unitPrice);
  const supplier = String(b.supplier || '').trim();
  const status = String(b.status || '발주완료');
  const expectedDate = b.expectedDate ? String(b.expectedDate) : null;
  if (!DATE_RE.test(orderDate)) return res.status(400).json({ error: '발주일(orderDate)은 YYYY-MM-DD 형식이어야 합니다.' });
  if (!itemName) return res.status(400).json({ error: '품목(itemName)을 입력해 주세요.' });
  if (!(qty > 0)) return res.status(400).json({ error: '수량(qty)은 0보다 커야 합니다.' });
  if (!Number.isInteger(unitPrice) || unitPrice < 0) return res.status(400).json({ error: '단가(unitPrice)는 0 이상의 정수여야 합니다.' });
  if (!Number.isInteger(totalCost) || totalCost < 0) return res.status(400).json({ error: '총액(totalCost)은 0 이상의 정수여야 합니다.' });
  if (!supplier) return res.status(400).json({ error: '공급처(supplier)를 입력해 주세요.' });
  if (!PO_STATUS.has(status)) return res.status(400).json({ error: '상태는 발주완료/배송중/입고완료/취소 중 하나여야 합니다.' });
  if (expectedDate && !DATE_RE.test(expectedDate)) return res.status(400).json({ error: '입고예정일(expectedDate)은 YYYY-MM-DD 형식이어야 합니다.' });
  try {
    const row = await insertRow('cafe_purchase_orders',
      { order_date: orderDate, item_name: itemName, qty, unit_price: unitPrice, total_cost: totalCost, supplier, status, expected_date: expectedDate },
      PO_COLS);
    res.status(201).json(mapPO(row));
  } catch (err) {
    if (err && err.code === '23503') return res.status(400).json({ error: '존재하지 않는 재고 품목입니다. 재고에 먼저 등록하세요.' });
    throw err;
  }
}));
app.patch('/api/purchase-orders/:id', authRequired, dbWrap(async (req, res) => {
  const id = idOr400(req, res); if (id === null) return;
  const status = String(req.body.status || '');
  if (!PO_STATUS.has(status)) return res.status(400).json({ error: '상태는 발주완료/배송중/입고완료/취소 중 하나여야 합니다.' });
  const row = await updateRow('cafe_purchase_orders', { status }, 'id', id, PO_COLS);
  if (!row) return res.status(404).json({ error: '해당 발주를 찾을 수 없습니다.' });
  res.json(mapPO(row));
}));

// --- 일별 매출 (upsert) ------------------------------------------------------
const DAILY_COLS = `to_char(sale_date,'YYYY-MM-DD') AS sale_date, day_of_week, day_name, is_weekend,
                    is_holiday, visitors, orders, product_revenue, membership_revenue, total_revenue`;
const mapDaily = (r) => ({
  date: r.sale_date, dayOfWeek: r.day_of_week, dayName: r.day_name, isWeekend: r.is_weekend, isHoliday: r.is_holiday,
  visitors: r.visitors, orders: r.orders, productRevenue: r.product_revenue,
  membershipRevenue: r.membership_revenue, totalRevenue: r.total_revenue,
});
app.get('/api/daily-sales', authRequired, dbWrap(async (req, res) => {
  const from = req.query.from ? String(req.query.from) : null;
  const to = req.query.to ? String(req.query.to) : null;
  if (from && !DATE_RE.test(from)) return res.status(400).json({ error: 'from 은 YYYY-MM-DD 형식이어야 합니다.' });
  if (to && !DATE_RE.test(to)) return res.status(400).json({ error: 'to 는 YYYY-MM-DD 형식이어야 합니다.' });
  const { rows } = await pool.query(
    `SELECT ${DAILY_COLS} FROM cafe_daily_sales
      WHERE ($1::date IS NULL OR sale_date >= $1) AND ($2::date IS NULL OR sale_date <= $2)
      ORDER BY sale_date ASC`, [from, to]
  );
  res.json(rows.map(mapDaily));
}));
app.put('/api/daily-sales', authRequired, dbWrap(async (req, res) => {
  const b = req.body;
  const date = String(b.date || b.saleDate || '');
  if (!DATE_RE.test(date)) return res.status(400).json({ error: '날짜(date)는 YYYY-MM-DD 형식이어야 합니다.' });
  const visitors = Number(b.visitors);
  const orders = Number(b.orders);
  const productRevenue = Number(b.productRevenue);
  const membershipRevenue = b.membershipRevenue != null ? Number(b.membershipRevenue) : 0;
  for (const [k, v] of [['visitors', visitors], ['orders', orders], ['productRevenue', productRevenue], ['membershipRevenue', membershipRevenue]]) {
    if (!Number.isInteger(v) || v < 0) return res.status(400).json({ error: `${k} 는 0 이상의 정수여야 합니다.` });
  }
  const dow = dowOf(date);
  const dayName = DAY_NAMES[dow];
  const isWeekend = dow === 0 || dow === 6;
  const isHoliday = !!b.isHoliday;
  // ⚠️ total_revenue 는 생성 컬럼이라 컬럼 목록에서 제외.
  const { rows } = await pool.query(
    `INSERT INTO cafe_daily_sales (sale_date, day_of_week, day_name, is_weekend, is_holiday, visitors, orders, product_revenue, membership_revenue)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (sale_date) DO UPDATE SET
       day_of_week = EXCLUDED.day_of_week, day_name = EXCLUDED.day_name, is_weekend = EXCLUDED.is_weekend,
       is_holiday = EXCLUDED.is_holiday, visitors = EXCLUDED.visitors, orders = EXCLUDED.orders,
       product_revenue = EXCLUDED.product_revenue, membership_revenue = EXCLUDED.membership_revenue
     RETURNING ${DAILY_COLS}`,
    [date, dow, dayName, isWeekend, isHoliday, visitors, orders, productRevenue, membershipRevenue]
  );
  res.json(mapDaily(rows[0]));
}));

// --- 리뷰 (읽기 전용) --------------------------------------------------------
app.get('/api/reviews', authRequired, dbWrap(async (req, res) => {
  let limit = Number(req.query.limit) || 50;
  limit = Math.min(Math.max(limit, 1), 500);
  const minR = req.query.minRating != null ? Number(req.query.minRating) : null;
  const maxR = req.query.maxRating != null ? Number(req.query.maxRating) : null;
  const { rows } = await pool.query(
    `SELECT id, to_char(review_date,'YYYY-MM-DD') AS review_date, rating, channel, menu_id, is_member, content
       FROM cafe_reviews
      WHERE ($1::int IS NULL OR rating >= $1) AND ($2::int IS NULL OR rating <= $2)
      ORDER BY review_date DESC, id DESC LIMIT $3`,
    [Number.isFinite(minR) ? minR : null, Number.isFinite(maxR) ? maxR : null, limit]
  );
  res.json(rows.map((r) => ({
    id: r.id, date: r.review_date, rating: r.rating, channel: r.channel,
    menuId: r.menu_id, isMember: r.is_member, content: r.content,
  })));
}));

// --- 멤버십 ------------------------------------------------------------------
const MEM_COLS = `id, member_code, plan, monthly_fee, to_char(joined_date,'YYYY-MM-DD') AS joined_date,
                  to_char(cancelled_date,'YYYY-MM-DD') AS cancelled_date, status`;
const mapMem = (r) => ({
  id: r.id, memberCode: r.member_code, plan: r.plan, monthlyFee: r.monthly_fee,
  joinedDate: r.joined_date, cancelledDate: r.cancelled_date, status: r.status,
});
app.get('/api/memberships', authRequired, dbWrap(async (_req, res) => {
  const { rows } = await pool.query(`SELECT ${MEM_COLS} FROM cafe_memberships ORDER BY status, plan, id`);
  res.json(rows.map(mapMem));
}));
app.patch('/api/memberships/:id', authRequired, dbWrap(async (req, res) => {
  const id = idOr400(req, res); if (id === null) return;
  const b = req.body; const f = {};
  if (b.status !== undefined) { if (!MEMBER_STATUS.has(String(b.status))) return res.status(400).json({ error: "상태는 'active' 또는 'cancelled' 여야 합니다." }); f.status = String(b.status); }
  if (b.cancelledDate !== undefined) {
    if (b.cancelledDate === null || b.cancelledDate === '') f.cancelled_date = null;
    else { if (!DATE_RE.test(String(b.cancelledDate))) return res.status(400).json({ error: '해지일(cancelledDate)은 YYYY-MM-DD 형식이어야 합니다.' }); f.cancelled_date = String(b.cancelledDate); }
  }
  if (Object.keys(f).length === 0) return res.status(400).json({ error: '변경할 항목이 없습니다.' });
  const row = await updateRow('cafe_memberships', f, 'id', id, MEM_COLS);
  if (!row) return res.status(404).json({ error: '해당 멤버십을 찾을 수 없습니다.' });
  res.json(mapMem(row));
}));

// ---------------------------------------------------------------------------
// 18) 404 + 오류 처리 (반드시 모든 라우트 뒤). JSON 파싱 오류는 400 으로.
// ---------------------------------------------------------------------------
app.use((_req, res) => res.status(404).json({ error: '요청하신 경로를 찾을 수 없습니다.' }));
app.use((err, req, res, _next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: '요청 본문(JSON)이 올바르지 않습니다.' });
  }
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: '요청 본문이 너무 큽니다.' });
  console.error('[UNHANDLED]', req.method, req.path, '-', err && err.message);
  if (!res.headersSent) res.status(500).json({ error: '서버 오류가 발생했습니다.' });
});
