// ============================================================================
// 냉장고 요리사 — 백엔드 서버 (server.js)
//   - 의존성: pg 만 사용. 정적 서빙/라우팅은 Node 내장 http 모듈로 직접 처리.
//   - DB: Supabase Postgres (트랜잭션 풀러 :6543, SSL 필수).
//   - 접속 URL(DB_URL)은 오직 .env 에서만 읽으며 절대 로그/응답에 노출하지 않음.
// ============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// 1) 환경변수 로드 (node v20.6+/v24: process.loadEnvFile)
//    __dirname 기준으로 .env 를 찾으므로 실행 cwd 와 무관하게 동작한다.
// ---------------------------------------------------------------------------
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (_) {
  // .env 가 이미 환경에 주입돼 있거나(예: 배포 플랫폼) 파일이 없을 수 있음 → 무시
}

const PORT = process.env.PORT || 3000;
const DB_URL = (process.env.DB_URL || '').trim(); // trailing newline 방지
// AI 키: 없어도 서버를 죽이지 않는다(DB 기능은 정상, generate 만 503). 값은 절대 노출 금지.
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = 'gpt-4o-mini';

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
      CREATE TABLE IF NOT EXISTS ingredients (
        id       BIGSERIAL PRIMARY KEY,
        name     TEXT NOT NULL,
        quantity TEXT,
        category TEXT NOT NULL DEFAULT '냉장'
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS recipes (
        id          BIGSERIAL PRIMARY KEY,
        name        TEXT NOT NULL,
        ingredients JSONB NOT NULL DEFAULT '[]'::jsonb,
        steps       TEXT
      );
    `);

    // --- recipes 확장 컬럼 (기존 행/시드 보존, 재실행 안전) ---
    //   cook_time_min: 예상 조리시간(분), difficulty: 쉬움|보통|어려움, option: 간단|다이어트|야식|일반
    await client.query('ALTER TABLE recipes ADD COLUMN IF NOT EXISTS cook_time_min INTEGER');
    await client.query('ALTER TABLE recipes ADD COLUMN IF NOT EXISTS difficulty TEXT');
    await client.query('ALTER TABLE recipes ADD COLUMN IF NOT EXISTS option TEXT');

    // --- 시드: 각 테이블이 비어 있을 때만 1회 ---
    const ingCount = await client.query('SELECT COUNT(*)::int AS c FROM ingredients');
    if (ingCount.rows[0].c === 0) {
      const seedIngredients = [
        ['계란', '6개', '냉장'],
        ['양파', '3개', '실온'],
        ['김치', '1포기', '냉장'],
        ['햄', '1캔', '실온'],
        ['라면', '5개', '실온'],
      ];
      for (const [name, quantity, category] of seedIngredients) {
        await client.query(
          'INSERT INTO ingredients (name, quantity, category) VALUES ($1, $2, $3)',
          [name, quantity, category]
        );
      }
      console.log(`[seed] ingredients ${seedIngredients.length}건 주입 완료`);
    }

    const recCount = await client.query('SELECT COUNT(*)::int AS c FROM recipes');
    if (recCount.rows[0].c === 0) {
      const seedRecipes = [
        {
          name: '김치 햄 라면',
          ingredients: ['라면', '김치', '햄', '계란', '양파'],
          steps:
            '1. 양파는 얇게 채 썰고, 햄은 먹기 좋게 썬다. 김치도 한 줌 덜어 썬다.\n' +
            '2. 냄비에 물 약 550ml를 붓고 센 불에서 끓인다.\n' +
            '3. 물이 끓으면 김치·양파·햄을 먼저 넣고 1분간 끓여 감칠맛을 낸다.\n' +
            '4. 라면 면과 스프를 넣고 4~5분간 끓인다.\n' +
            '5. 면이 거의 익으면 계란을 깨 넣고 30초~1분 더 끓여 마무리한다.',
        },
        {
          name: '계란 양파 볶음',
          ingredients: ['계란', '양파'],
          steps:
            '1. 양파 1개를 얇게 채 썬다.\n' +
            '2. 팬에 기름을 두르고 양파를 투명해질 때까지 볶는다.\n' +
            '3. 계란 2개를 풀어 넣고 소금 약간을 더해 부드럽게 스크램블한다.\n' +
            '4. 한 김 식혀 그릇에 담아낸다.',
        },
      ];
      for (const r of seedRecipes) {
        await client.query(
          'INSERT INTO recipes (name, ingredients, steps) VALUES ($1, $2::jsonb, $3)',
          [r.name, JSON.stringify(r.ingredients), r.steps]
        );
      }
      console.log(`[seed] recipes ${seedRecipes.length}건 주입 완료`);
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
// 4.5) AI 레시피 생성 — OpenAI Chat Completions (전역 fetch, 새 의존성 없음)
//      OPENAI_API_KEY 는 서버에서만 사용. 응답/로그/클라이언트에 키·URL·원문 에러 비노출.
// ---------------------------------------------------------------------------
const DIFFICULTIES = new Set(['쉬움', '보통', '어려움']);

// cookTimeMin → 양의 정수 또는 null. (저장용: 알 수 없으면 null)
function toCookTimeOrNull(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// 옵션 정규화: 허용 4값만, 그 외/누락은 '일반'
const RECIPE_OPTIONS = new Set(['간단', '다이어트', '야식', '일반']);
function normalizeOption(v) {
  return typeof v === 'string' && RECIPE_OPTIONS.has(v.trim()) ? v.trim() : '일반';
}

const OPENAI_SYSTEM_PROMPT = [
  "너는 한국 가정식 요리 보조다. 사용자의 '냉장고 재료'를 우선 활용해 현실적으로 만들 수 있는 레시피 1개를 제안한다.",
  '옵션 의미 — 간단: 재료·단계 최소의 빠른 요리 / 다이어트: 저칼로리·건강한 조리 / 야식: 부담 적고 간단한 야식 / 일반: 무난한 한 끼.',
  '반드시 지정된 JSON 스키마로만 응답한다. 모든 텍스트는 한국어.',
  '',
  'JSON 스키마(이 키들만 사용):',
  '{',
  '  "name": string,            // 요리명(한국어)',
  '  "ingredients": string[],   // 이 레시피에 쓰는 재료 이름 배열',
  '  "steps": string,           // "1. ...\\n2. ...\\n3. ..." 형태로 줄바꿈 구분된 조리 단계',
  '  "cookTimeMin": number,     // 예상 조리시간(정수, 분)',
  '  "difficulty": "쉬움" | "보통" | "어려움"',
  '}',
].join('\n');

// OpenAI 호출 → 파싱된 객체 반환. 실패 시 throw('AI_FAIL') (원인은 server-side 로깅, 키/URL 비노출).
async function callOpenAIForRecipe(ingredientRows, option) {
  // user 메시지: 냉장고 재료(이름·수량) + 선택 옵션
  const fridgeList = ingredientRows
    .map((r) => {
      const q = r.quantity ? ` (${r.quantity})` : '';
      return `- ${r.name}${q}`;
    })
    .join('\n');
  const userMessage =
    `냉장고 재료 목록:\n${fridgeList}\n\n` +
    `선택된 옵션: ${option}\n` +
    `위 재료를 우선 활용해 옵션에 맞는 레시피 1개를 JSON 스키마로만 제안해줘.`;

  // 30초 타임아웃
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  let resp;
  try {
    resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.8,
        max_tokens: 900,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: OPENAI_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
      }),
    });
  } catch (err) {
    // 네트워크/타임아웃(AbortError 포함)
    console.error('[OpenAI] 요청 실패:', err.name === 'AbortError' ? 'timeout(30s)' : err.message);
    throw new Error('AI_FAIL');
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    // 상태 코드만 로깅, 응답 본문(키/조직정보 등) 은 노출하지 않음
    console.error('[OpenAI] 비정상 응답 status:', resp.status);
    throw new Error('AI_FAIL');
  }

  let data;
  try {
    data = await resp.json();
  } catch (_) {
    console.error('[OpenAI] 응답 JSON 파싱 실패(envelope)');
    throw new Error('AI_FAIL');
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    console.error('[OpenAI] content 누락');
    throw new Error('AI_FAIL');
  }

  let parsed;
  try {
    parsed = JSON.parse(content); // json_object 모드라 객체 문자열이 보장됨
  } catch (_) {
    console.error('[OpenAI] content JSON 파싱 실패');
    throw new Error('AI_FAIL');
  }
  return parsed;
}

// 모델 출력 → 계약 스키마로 정규화 (방어적: 누락/이상치 보정)
function normalizeRecipe(parsed, option) {
  const name =
    typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : '추천 요리';

  const ingredients = Array.isArray(parsed.ingredients)
    ? parsed.ingredients
        .map((x) => (typeof x === 'string' ? x.trim() : String(x ?? '').trim()))
        .filter((x) => x.length > 0)
    : [];

  let steps = '';
  if (typeof parsed.steps === 'string') {
    steps = parsed.steps;
  } else if (Array.isArray(parsed.steps)) {
    // 혹시 배열로 오면 줄바꿈 문자열로 합침
    steps = parsed.steps.map((s) => String(s ?? '').trim()).filter(Boolean).join('\n');
  }

  // cookTimeMin: 정수 강제, NaN/비정상이면 합리적 기본값 20
  const t = Math.round(Number(parsed.cookTimeMin));
  const cookTimeMin = Number.isFinite(t) && t > 0 ? t : 20;

  // difficulty: 3값이 아니면 '보통'
  const difficulty = DIFFICULTIES.has(parsed.difficulty) ? parsed.difficulty : '보통';

  return { name, ingredients, steps, cookTimeMin, difficulty, option };
}

// POST /api/recipes/generate  { option }  — 생성만, 저장하지 않음
async function generateRecipe(req, res) {
  const body = await readJSONBody(req);
  const option = normalizeOption(body.option);

  // 1) 키 미설정 → 503 (서버 전체는 정상, 이 기능만 비활성)
  if (!OPENAI_API_KEY) {
    return sendJSON(res, 503, { error: 'AI 기능이 설정되지 않았습니다.' });
  }

  // 2) 냉장고 재료 조회
  const { rows } = await pool.query(
    'SELECT name, quantity FROM ingredients ORDER BY id ASC'
  );
  if (rows.length === 0) {
    return sendJSON(res, 400, {
      error: '냉장고에 재료가 없습니다. 먼저 재료를 등록해 주세요.',
    });
  }

  // 3) OpenAI 호출 + 파싱 + 정규화
  let parsed;
  try {
    parsed = await callOpenAIForRecipe(rows, option);
  } catch (_) {
    // callOpenAIForRecipe 내부에서 이미 원인 로깅(키/URL 비노출). 클라이언트엔 일반 메시지.
    return sendJSON(res, 502, {
      error: 'AI 레시피 생성에 실패했습니다. 다시 시도해 주세요.',
    });
  }

  const recipe = normalizeRecipe(parsed, option);
  sendJSON(res, 200, recipe);
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

// GET /api/ingredients
async function listIngredients(_req, res) {
  const { rows } = await pool.query(
    'SELECT id, name, quantity, category FROM ingredients ORDER BY id DESC'
  );
  sendJSON(res, 200, rows);
}

// POST /api/ingredients  { name, quantity, category }
async function createIngredient(req, res) {
  const body = await readJSONBody(req);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return sendJSON(res, 400, { error: 'name 은 필수입니다.' });
  }
  const quantity = typeof body.quantity === 'string' ? body.quantity.trim() : null;
  const category =
    typeof body.category === 'string' && body.category.trim() ? body.category.trim() : '냉장';

  const { rows } = await pool.query(
    'INSERT INTO ingredients (name, quantity, category) VALUES ($1, $2, $3) RETURNING id, name, quantity, category',
    [name, quantity, category]
  );
  sendJSON(res, 201, rows[0]);
}

// DELETE /api/ingredients/:id
async function deleteIngredient(_req, res, id) {
  const { rowCount } = await pool.query('DELETE FROM ingredients WHERE id = $1', [id]);
  if (rowCount === 0) {
    return sendJSON(res, 404, { error: '해당 재료를 찾을 수 없습니다.' });
  }
  sendJSON(res, 200, { ok: true });
}

// GET /api/recipes
async function listRecipes(_req, res) {
  // DB 컬럼 cook_time_min → API 키 cookTimeMin 으로 alias 매핑
  const { rows } = await pool.query(
    `SELECT id, name, ingredients, steps,
            cook_time_min AS "cookTimeMin", difficulty, option
       FROM recipes
      ORDER BY id DESC`
  );
  // ingredients(JSONB)는 pg 가 이미 JS 배열로 파싱해 반환함.
  // 기존 행은 cookTimeMin/difficulty/option 이 null 일 수 있음(계약 허용).
  sendJSON(res, 200, rows);
}

// POST /api/recipes  { name, ingredients:[string], steps, cookTimeMin?, difficulty?, option? }
async function createRecipe(req, res) {
  const body = await readJSONBody(req);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return sendJSON(res, 400, { error: 'name 은 필수입니다.' });
  }
  if (!Array.isArray(body.ingredients)) {
    return sendJSON(res, 400, { error: 'ingredients 는 문자열 배열이어야 합니다.' });
  }
  // 문자열 배열로 정규화 (빈 값 제거)
  const ingredients = body.ingredients
    .map((x) => (typeof x === 'string' ? x.trim() : String(x ?? '').trim()))
    .filter((x) => x.length > 0);
  const steps = typeof body.steps === 'string' ? body.steps : '';

  // --- 확장 필드 정규화 (선택값: 없으면 null 로 저장) ---
  const cookTimeMin = toCookTimeOrNull(body.cookTimeMin);
  const difficulty = DIFFICULTIES.has(body.difficulty) ? body.difficulty : null;
  const option =
    typeof body.option === 'string' && body.option.trim() ? body.option.trim() : null;

  const { rows } = await pool.query(
    `INSERT INTO recipes (name, ingredients, steps, cook_time_min, difficulty, option)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6)
     RETURNING id, name, ingredients, steps,
               cook_time_min AS "cookTimeMin", difficulty, option`,
    [name, JSON.stringify(ingredients), steps, cookTimeMin, difficulty, option]
  );
  sendJSON(res, 201, rows[0]);
}

// DELETE /api/recipes/:id
async function deleteRecipe(_req, res, id) {
  const { rowCount } = await pool.query('DELETE FROM recipes WHERE id = $1', [id]);
  if (rowCount === 0) {
    return sendJSON(res, 404, { error: '해당 레시피를 찾을 수 없습니다.' });
  }
  sendJSON(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// 7) API 라우터 — /api/* 매칭 후 위 핸들러로 분기
// ---------------------------------------------------------------------------
async function handleApi(req, res, pathname) {
  const method = req.method;

  // 라우팅/입력 검증을 먼저 수행해 DB 와 무관한 응답(404/405/400)은
  // DB 연결 상태와 관계없이 즉시 반환한다. DB 가 실제로 필요한 핸들러를
  // 고른 뒤에만 ensureDB() 로 스키마/시드를 보장한다.

  // 컬렉션 라우트
  if (pathname === '/api/ingredients') {
    if (method === 'GET') return ensureDB().then(() => listIngredients(req, res));
    if (method === 'POST') return ensureDB().then(() => createIngredient(req, res));
    return sendJSON(res, 405, { error: 'Method Not Allowed' });
  }
  if (pathname === '/api/recipes') {
    if (method === 'GET') return ensureDB().then(() => listRecipes(req, res));
    if (method === 'POST') return ensureDB().then(() => createRecipe(req, res));
    return sendJSON(res, 405, { error: 'Method Not Allowed' });
  }
  // AI 생성(저장 안 함). /:id 아이템 라우트보다 먼저 매칭해야 'generate' 가 id 로 해석되지 않음.
  if (pathname === '/api/recipes/generate') {
    if (method === 'POST') return ensureDB().then(() => generateRecipe(req, res));
    return sendJSON(res, 405, { error: 'Method Not Allowed' });
  }

  // 아이템 라우트 /api/ingredients/:id , /api/recipes/:id
  const ingMatch = pathname.match(/^\/api\/ingredients\/([^/]+)$/);
  if (ingMatch) {
    if (method !== 'DELETE') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    const id = Number(ingMatch[1]);
    if (!Number.isInteger(id) || id <= 0) {
      return sendJSON(res, 400, { error: '유효하지 않은 id 입니다.' });
    }
    return ensureDB().then(() => deleteIngredient(req, res, id));
  }
  const recMatch = pathname.match(/^\/api\/recipes\/([^/]+)$/);
  if (recMatch) {
    if (method !== 'DELETE') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    const id = Number(recMatch[1]);
    if (!Number.isInteger(id) || id <= 0) {
      return sendJSON(res, 400, { error: '유효하지 않은 id 입니다.' });
    }
    return ensureDB().then(() => deleteRecipe(req, res, id));
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
    console.log(`[server] 냉장고 요리사 백엔드 실행 → http://localhost:${PORT}`);
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
