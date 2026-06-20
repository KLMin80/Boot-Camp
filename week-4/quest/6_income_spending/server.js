// ============================================================================
// 익명 연봉·지출 비교 — 백엔드 서버 (server.js)
//   - 의존성: pg 만 사용. 정적 서빙/라우팅은 Node 내장 http 모듈로 직접 처리.
//   - DB: Supabase Postgres (트랜잭션 풀러 :6543, SSL 필수).
//   - 접속 URL(DB_URL)은 오직 .env 에서만 읽으며 절대 로그/응답에 노출하지 않음.
//   - 핵심: 익명 제출(submissions)을 행으로 쌓고, 평균/백분위/히스토그램을
//           전부 SQL 집계로 계산해서 돌려준다. (분포·내 위치 산출 = 서버 책임)
//           AVG/SUM 은 ::float8, COUNT 는 ::int 로 캐스팅(미캐스팅 시 문자열 → 클라 NaN).
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
// 3) 도메인 상수 — index.html 의 JOBS/LEVELS/CATEGORIES 와 id·수치를 100% 미러링.
//    (시드 표본 생성에 base/mult/ratio 가 필요하고, 검증 화이트리스트로도 쓴다.)
//    ⚠️ 클라이언트의 라벨/아이콘/색은 서버가 몰라도 됨 — 서버는 id 와 수치만 안다.
// ---------------------------------------------------------------------------
const JOBS = [
  { id: 'dev', base: 470, spread: 1.15 },
  { id: 'design', base: 380, spread: 1.0 },
  { id: 'pm', base: 430, spread: 1.05 },
  { id: 'mkt', base: 360, spread: 1.0 },
  { id: 'sales', base: 400, spread: 1.3 },
  { id: 'data', base: 500, spread: 1.1 },
  { id: 'hr', base: 350, spread: 0.9 },
];
const JOB_IDS = new Set(JOBS.map((j) => j.id));

const LEVELS = [
  { id: 'junior', mult: 0.78, weight: 0.34 },
  { id: 'middle', mult: 1.0, weight: 0.3 },
  { id: 'senior', mult: 1.3, weight: 0.22 },
  { id: 'lead', mult: 1.65, weight: 0.14 },
];
const LEVEL_IDS = new Set(LEVELS.map((l) => l.id));

// 지출 카테고리 6종 (DB 컬럼명과 동일). ratio = 월급 대비 평균 비율(시드 생성용).
const CATEGORIES = [
  { id: 'food', ratio: 0.16 },
  { id: 'housing', ratio: 0.27 },
  { id: 'transport', ratio: 0.07 },
  { id: 'subscribe', ratio: 0.035 },
  { id: 'leisure', ratio: 0.1 },
  { id: 'etc', ratio: 0.09 },
];
const CAT_IDS = CATEGORIES.map((c) => c.id);

// 히스토그램 버킷 폭(만원)
const BIN_SIZE = 50;

// ---------------------------------------------------------------------------
// 4) 시드용 난수 (서버에서 Box-Muller 정규분포 생성)
//    Math.random 기반 — 시드 표본은 1회만 INSERT 되므로 결정성은 불필요.
// ---------------------------------------------------------------------------
function gaussian() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// index.html buildDataset 과 같은 결의 1행 생성 (job/level/salary/spend/total)
function makeSampleRow() {
  // 직군 가중 선택 (개발/데이터 약간 더)
  const jobWeights = { dev: 1.4, design: 1.0, pm: 1.0, mkt: 1.0, sales: 1.1, data: 1.2, hr: 0.9 };
  const jobPool = [];
  JOBS.forEach((j) => {
    const w = Math.round((jobWeights[j.id] || 1) * 10);
    for (let i = 0; i < w; i++) jobPool.push(j);
  });
  const levelPool = [];
  LEVELS.forEach((l) => {
    const w = Math.round(l.weight * 100);
    for (let i = 0; i < w; i++) levelPool.push(l);
  });

  const job = jobPool[Math.floor(Math.random() * jobPool.length)];
  const level = levelPool[Math.floor(Math.random() * levelPool.length)];

  // 월급(만원): 평균 = base*mult, 표준편차 = 평균*0.18*spread, 5만원 단위 클램프
  const avg = job.base * level.mult;
  const sd = avg * 0.18 * job.spread;
  let salary = avg + gaussian() * sd;
  salary = Math.round(Math.max(180, Math.min(2200, salary)) / 5) * 5;

  // 카테고리 지출: ratio 중심으로 흔들되 저소득일수록 주거/식비↑, 고소득일수록 여가↑
  const spend = {};
  let total = 0;
  CATEGORIES.forEach((c) => {
    let r = c.ratio;
    if ((c.id === 'housing' || c.id === 'food') && salary < 350) r *= 1.18;
    if (c.id === 'leisure' && salary > 600) r *= 1.25;
    const noise = 1 + gaussian() * 0.28;
    let val = salary * r * Math.max(0.3, noise);
    val = Math.max(2, Math.round(val));
    spend[c.id] = val;
    total += val;
  });

  return { job: job.id, level: level.id, salary, spend, total };
}

// ---------------------------------------------------------------------------
// 5) 스키마 + 시드 (lazy init: 최초 1회만 실행, cold start 대응)
//    submissions: 익명 제출 1건 = 1행. PII(이름/이메일 등) 저장 안 함.
//    비어 있으면 현실감 있는 가상 표본 약 500행을 1회 INSERT.
// ---------------------------------------------------------------------------
let dbReady = null; // Promise 캐시 — 동시 요청에도 init 1회만

const SEED_COUNT = 500;

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS submissions (
        id          BIGSERIAL PRIMARY KEY,
        salary      INTEGER NOT NULL,
        job         TEXT NOT NULL,
        level       TEXT NOT NULL,
        food        INTEGER NOT NULL DEFAULT 0,
        housing     INTEGER NOT NULL DEFAULT 0,
        transport   INTEGER NOT NULL DEFAULT 0,
        subscribe   INTEGER NOT NULL DEFAULT 0,
        leisure     INTEGER NOT NULL DEFAULT 0,
        etc         INTEGER NOT NULL DEFAULT 0,
        total_spend INTEGER NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_submissions_job ON submissions(job)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_submissions_level ON submissions(level)');

    // --- 시드: submissions 가 비어 있을 때만 1회 (첫 화면 분포가 비지 않도록) ---
    const { rows } = await client.query('SELECT COUNT(*)::int AS c FROM submissions');
    if (rows[0].c === 0) {
      // 한 번의 멀티-VALUES INSERT 로 약 500행 주입 (시드도 실제 행 → 집계 경로 100% 동일)
      const values = [];
      const params = [];
      for (let i = 0; i < SEED_COUNT; i++) {
        const r = makeSampleRow();
        const base = params.length;
        // salary, job, level, food, housing, transport, subscribe, leisure, etc, total_spend
        values.push(
          `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10})`
        );
        params.push(
          r.salary,
          r.job,
          r.level,
          r.spend.food,
          r.spend.housing,
          r.spend.transport,
          r.spend.subscribe,
          r.spend.leisure,
          r.spend.etc,
          r.total
        );
      }
      await client.query(
        `INSERT INTO submissions
           (salary, job, level, food, housing, transport, subscribe, leisure, etc, total_spend)
         VALUES ${values.join(',')}`,
        params
      );
      console.log(`[seed] submissions ${SEED_COUNT}행 주입 완료`);
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
// 6) HTTP 유틸
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
// 7) 정적 서빙 — allowlist 방식
//    오직 index.html 만 서빙. 그 외 모든 경로(.env, package.json, *.png, .git ...)
//    는 404. path.basename 으로 디렉터리 성분을 제거하므로 /../ 트래버설도 무력화.
//    (이 프로젝트는 과거 server.js 가 .env 를 정적 서빙해 GET /.env 로 키가 샌 적 있음
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
// 8) 집계 로직 — 비교군(scope)별 통계 묶음을 SQL 로 계산
//    scope: 'all'(전체) / 'job'(같은 직군) / 'level'(같은 연차)
//    ⚠️ AVG → ::float8, COUNT → ::int 캐스팅 필수(미캐스팅 시 numeric 문자열 → 클라 NaN)
// ---------------------------------------------------------------------------

// scope 에 따른 WHERE 절 + 파라미터를 만든다. ($1 자리부터 채움)
function scopeWhere(scope, me, startIdx) {
  if (scope === 'job') return { sql: `WHERE job = $${startIdx}`, params: [me.job] };
  if (scope === 'level') return { sql: `WHERE level = $${startIdx}`, params: [me.level] };
  return { sql: '', params: [] }; // all
}

// 한 scope 의 통계 묶음 계산 → { n, salaryAvg, totalAvg, catAvg, top, hist }
async function computeScopeStats(client, scope, me) {
  // (1) 집계: n, salaryAvg, totalAvg, 카테고리별 평균 + 내 월급 이하 개수(백분위용)
  //     COALESCE 로 빈 표본일 때 0 보장. AVG/내값비교 모두 한 쿼리에서.
  const w1 = scopeWhere(scope, me, 1);
  const mySalaryIdx = w1.params.length + 1; // WHERE 파라미터 다음 자리
  const aggSql = `
    SELECT
      COUNT(*)::int                                            AS n,
      COALESCE(AVG(salary), 0)::float8                         AS salary_avg,
      COALESCE(AVG(total_spend), 0)::float8                    AS total_avg,
      COALESCE(AVG(food), 0)::float8                           AS food_avg,
      COALESCE(AVG(housing), 0)::float8                        AS housing_avg,
      COALESCE(AVG(transport), 0)::float8                      AS transport_avg,
      COALESCE(AVG(subscribe), 0)::float8                      AS subscribe_avg,
      COALESCE(AVG(leisure), 0)::float8                        AS leisure_avg,
      COALESCE(AVG(etc), 0)::float8                            AS etc_avg,
      COUNT(*) FILTER (WHERE salary <= $${mySalaryIdx})::int   AS count_le
    FROM submissions
    ${w1.sql}
  `;
  const aggParams = [...w1.params, me.salary];
  const { rows: aggRows } = await client.query(aggSql, aggParams);
  const a = aggRows[0];

  // 백분위(상위 %): top = 100 - (내 이하 개수 / 전체) * 100. 표본 0이면 50으로.
  let top = 50;
  if (a.n > 0) {
    top = 100 - (a.count_le / a.n) * 100;
    top = Math.min(99.9, Math.max(0.1, top));
  }

  // (2) 히스토그램: 50만원 버킷팅. bin_start 별 COUNT.
  const w2 = scopeWhere(scope, me, 1);
  const histSql = `
    SELECT (floor(salary / ${BIN_SIZE}.0) * ${BIN_SIZE})::int AS bin_start,
           COUNT(*)::int AS count
    FROM submissions
    ${w2.sql}
    GROUP BY 1
    ORDER BY 1
  `;
  const { rows: histRows } = await client.query(histSql, w2.params);
  const hist = histRows.map((h) => ({
    binStart: h.bin_start,
    binEnd: h.bin_start + BIN_SIZE,
    count: h.count,
  }));

  return {
    n: a.n,
    salaryAvg: a.salary_avg,
    totalAvg: a.total_avg,
    catAvg: {
      food: a.food_avg,
      housing: a.housing_avg,
      transport: a.transport_avg,
      subscribe: a.subscribe_avg,
      leisure: a.leisure_avg,
      etc: a.etc_avg,
    },
    top,
    hist,
  };
}

// 직군별 / 연차별 평균 월급 (전체 표본 기준, 그룹 비교용)
async function computeGroupAverages(client) {
  const { rows: jobRows } = await client.query(`
    SELECT job AS id, COALESCE(AVG(salary), 0)::float8 AS avg, COUNT(*)::int AS count
    FROM submissions GROUP BY job
  `);
  const { rows: levelRows } = await client.query(`
    SELECT level AS id, COALESCE(AVG(salary), 0)::float8 AS avg, COUNT(*)::int AS count
    FROM submissions GROUP BY level
  `);
  // id → {avg,count} 맵으로 (없는 직군/연차는 0 으로 채워 클라가 전체 목록을 그릴 수 있게)
  const jobMap = Object.fromEntries(jobRows.map((r) => [r.id, { avg: r.avg, count: r.count }]));
  const levelMap = Object.fromEntries(levelRows.map((r) => [r.id, { avg: r.avg, count: r.count }]));
  const jobAvg = JOBS.map((j) => ({
    id: j.id,
    avg: jobMap[j.id]?.avg ?? 0,
    count: jobMap[j.id]?.count ?? 0,
  }));
  const levelAvg = LEVELS.map((l) => ({
    id: l.id,
    avg: levelMap[l.id]?.avg ?? 0,
    count: levelMap[l.id]?.count ?? 0,
  }));
  return { jobAvg, levelAvg };
}

// me(salary/job/level) 기준으로 3개 scope 통계 + 그룹 평균을 한 번에 묶어 반환
async function buildStatsBundle(me) {
  // ⚠️ 단일 client 를 공유한 채 Promise.all 로 동시에 query 하면
  //    "client is already executing a query" 경고가 뜨고(pg@9 에선 하드 에러),
  //    쿼리가 직렬화되며 결과가 깨질 수 있다.
  //    → pool 을 그대로 넘긴다. pool.query 는 호출마다 풀에서 독립 커넥션을
  //      빌렸다가 자동 반납하므로 Promise.all 동시 실행에 안전하다.
  const [all, job, level, groups] = await Promise.all([
    computeScopeStats(pool, 'all', me),
    computeScopeStats(pool, 'job', me),
    computeScopeStats(pool, 'level', me),
    computeGroupAverages(pool),
  ]);
  return {
    scopes: { all, job, level },
    jobAvg: groups.jobAvg,
    levelAvg: groups.levelAvg,
  };
}

// ---------------------------------------------------------------------------
// 9) 입력 검증 — 숫자/필수, job·level 화이트리스트, 음수/비현실 값 컷
//    반환: { ok:true, value:{salary,job,level,spend{},total} } | { ok:false, error }
// ---------------------------------------------------------------------------
function validateSubmission(body) {
  const salary = Number(body.salary);
  if (!Number.isFinite(salary) || salary <= 0) {
    return { ok: false, error: '월급(salary)은 0보다 큰 숫자여야 합니다.' };
  }
  if (salary > 5000) {
    return { ok: false, error: '월급이 너무 큽니다. 만원 단위가 맞나요? (예: 350)' };
  }

  const job = typeof body.job === 'string' ? body.job : '';
  if (!JOB_IDS.has(job)) {
    return { ok: false, error: '유효하지 않은 직군(job)입니다.' };
  }
  const level = typeof body.level === 'string' ? body.level : '';
  if (!LEVEL_IDS.has(level)) {
    return { ok: false, error: '유효하지 않은 연차(level)입니다.' };
  }

  // 지출: 객체 형태 { food, housing, ... }. 빈/누락 칸은 0. 음수·비현실 컷.
  const rawSpend = body.spend && typeof body.spend === 'object' ? body.spend : {};
  const spend = {};
  let total = 0;
  for (const id of CAT_IDS) {
    let v = rawSpend[id];
    if (v === '' || v === null || v === undefined) v = 0;
    v = Number(v);
    if (!Number.isFinite(v) || v < 0) {
      return { ok: false, error: `지출(${id})은 0 이상 숫자여야 합니다.` };
    }
    if (v > 5000) {
      return { ok: false, error: `지출(${id}) 값이 너무 큽니다.` };
    }
    v = Math.round(v);
    spend[id] = v;
    total += v;
  }

  // 총지출이 월급의 3배를 넘으면 단위 오류로 판단
  if (total > Math.round(salary) * 3) {
    return { ok: false, error: '총지출이 월급의 3배를 넘습니다. 단위를 다시 확인해 주세요.' };
  }

  return { ok: true, value: { salary: Math.round(salary), job, level, spend, total } };
}

// ---------------------------------------------------------------------------
// 10) API 핸들러
// ---------------------------------------------------------------------------

// POST /api/submissions  { salary, job, level, spend:{food,...} }
//   1) 검증 → 2) INSERT 1행 → 3) 방금 값 기준 scope별 통계 묶음 계산해 반환
//   응답: { id, scopes:{all,job,level}, jobAvg, levelAvg }
async function createSubmission(req, res) {
  const body = await readJSONBody(req);
  const v = validateSubmission(body);
  if (!v.ok) {
    return sendJSON(res, 400, { error: v.error });
  }
  const { salary, job, level, spend, total } = v.value;

  const { rows } = await pool.query(
    `INSERT INTO submissions
       (salary, job, level, food, housing, transport, subscribe, leisure, etc, total_spend)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      salary,
      job,
      level,
      spend.food,
      spend.housing,
      spend.transport,
      spend.subscribe,
      spend.leisure,
      spend.etc,
      total,
    ]
  );
  const id = rows[0].id;

  // 방금 제출 값을 포함한 표본 기준으로 통계 묶음 계산 (한 번의 왕복으로 결과까지)
  const bundle = await buildStatsBundle({ salary, job, level });
  sendJSON(res, 201, { id, ...bundle });
}

// GET /api/stats?salary=&job=&level=  (선택적 — scope 토글이 추가 데이터 필요 시)
//   POST 응답의 scopes 로 클라가 토글을 처리하므로 보통 안 쓰이지만, 재조회용으로 제공.
async function getStats(query, res) {
  const v = validateSubmission({
    salary: query.get('salary'),
    job: query.get('job'),
    level: query.get('level'),
    spend: {}, // 통계 조회는 지출 불필요 — 빈 객체로 통과
  });
  if (!v.ok) {
    return sendJSON(res, 400, { error: v.error });
  }
  const { salary, job, level } = v.value;
  const bundle = await buildStatsBundle({ salary, job, level });
  sendJSON(res, 200, bundle);
}

// ---------------------------------------------------------------------------
// 11) API 라우터 — /api/* 매칭 후 위 핸들러로 분기
//    라우팅/입력 검증을 먼저 수행해 DB 와 무관한 응답(404/405)은 즉시 반환한다.
//    DB 가 실제로 필요한 핸들러를 고른 뒤에만 ensureDB() 로 스키마/시드를 보장한다.
//    (이렇게 하면 DB 가 down 이어도 라우터가 옳다는 걸 404/405 로 증명 가능)
// ---------------------------------------------------------------------------
async function handleApi(req, res, pathname, query) {
  const method = req.method;

  // 헬스체크: 클라이언트가 로드 시 백엔드(server.js) 연결 여부를 확인하는 용도. DB 불필요 → 즉시 200.
  // 정적 서버(Live Server·npx serve)로 열면 이 경로가 404 가 되어, 클라이언트가 "백엔드 없음"을 감지한다.
  if (pathname === '/api/health') {
    if (method === 'GET') return sendJSON(res, 200, { ok: true });
    return sendJSON(res, 405, { error: 'Method Not Allowed' });
  }

  if (pathname === '/api/submissions') {
    if (method === 'POST') return ensureDB().then(() => createSubmission(req, res));
    return sendJSON(res, 405, { error: 'Method Not Allowed' });
  }

  if (pathname === '/api/stats') {
    if (method === 'GET') return ensureDB().then(() => getStats(query, res));
    return sendJSON(res, 405, { error: 'Method Not Allowed' });
  }

  return sendJSON(res, 404, { error: 'API Not Found' });
}

// ---------------------------------------------------------------------------
// 12) 서버 — /api 와 정적 경로를 명확히 분기
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
// 13) 기동: DB 연결을 한 번 확인(성공/실패만 알림, URL 비노출) 후 listen
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
  console.log(`\n[server] 익명 연봉·지출 비교 백엔드 실행 → http://localhost:${currentPort}`);
  console.log('[중요] 반드시 위 주소로 접속하세요. VS Code Live Server·npx serve 로 열면');
  console.log('       /api 백엔드가 없어 제출이 "API를 찾을 수 없음" 으로 실패합니다.\n');
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
