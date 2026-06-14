'use strict';

/**
 * About Me · Q&A 챗봇 백엔드 (의존성 0개)
 * --------------------------------------------------
 * Node 내장 http 모듈 + 전역 fetch(Node 18+)만 사용합니다.
 * express / axios / dotenv / node-fetch 등 외부 패키지를 일절 쓰지 않습니다.
 *
 * 역할:
 *   1) 정적 서빙: GET / , GET /index.html → index.html 만 제공 (allowlist).
 *      .env / .md / dotfile / server.js 등은 절대 서빙하지 않음(404).
 *   2) POST /api/ask : 작업지시서(본문) + 참고자료(about-me.md)를 system 메시지로,
 *      사용자 질문을 user 메시지로 OpenAI Chat Completions 에 전달하고 answer 반환.
 *
 * 보안:
 *   - OPENAI_API_KEY 는 .env 에서 읽어 서버 메모리에만 보관하며
 *     응답/로그 어디에도 그 값을 출력하지 않습니다.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// ──────────────────────────────────────────────────────────────
// 1. 경로 상수 (server.js 기준 상대경로 → 절대경로). cwd 와 무관하게 동작.
// ──────────────────────────────────────────────────────────────
const ROOT_DIR = __dirname; // 이 앱(정적 파일) 폴더
const INDEX_HTML = path.join(ROOT_DIR, 'index.html');
const ENV_FILE = path.join(ROOT_DIR, '.env');

// 작업지시서(system prompt 출처): 레포 루트의 .claude/agents 아래
const INSTRUCTION_FILE = path.join(
  ROOT_DIR, '..', '..', '..', '.claude', 'agents', 'about-me-qa-bot.md'
);

// 참고자료(유일한 사실 출처): 형제 폴더 "나를설명하는Q&A에이전트"(폴더명에 & 있음!)
const ABOUT_ME_FILE = path.join(
  ROOT_DIR, '..', '나를설명하는Q&A에이전트', 'about-me.md'
);

// ──────────────────────────────────────────────────────────────
// 2. 환경변수 로딩 (.env → 서버 메모리). dotenv 미사용.
//    Node 20.12+ 의 process.loadEnvFile 를 우선 시도하고,
//    실패 시 직접 파싱(라인별 첫 '=' 기준 split)으로 폴백.
// ──────────────────────────────────────────────────────────────
function loadEnv() {
  try {
    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(ENV_FILE); // process.env 에 주입
      return;
    }
  } catch (err) {
    // loadEnvFile 실패(파일 없음/포맷 문제 등) → 수동 파싱으로 폴백
    console.warn('[env] process.loadEnvFile 실패, 수동 파싱으로 폴백합니다.');
  }
  try {
    const raw = fs.readFileSync(ENV_FILE, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      // 양끝 따옴표 제거
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch (err) {
    console.warn('[env] .env 파일을 읽지 못했습니다. OPENAI_API_KEY 미설정 상태로 진행합니다.');
  }
}
loadEnv();

// 키는 메모리에만 보관. trailing newline 방지를 위해 trim.
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
const PORT = process.env.PORT || 3000;

// ──────────────────────────────────────────────────────────────
// 3. 작업지시서에서 "본문 지시"만 추출
//    - 상단 YAML frontmatter( --- ... --- ) 제거
//    - "# Persistent Agent Memory" 섹션부터 끝까지 제거(메모리 운영 보일러플레이트)
// ──────────────────────────────────────────────────────────────
function extractInstruction(rawMarkdown) {
  let text = rawMarkdown;

  // (a) frontmatter 제거: 파일 맨 앞이 --- 로 시작하면 다음 --- 까지 잘라냄
  if (/^﻿?---\s*\r?\n/.test(text)) {
    // 첫 --- 이후의 닫는 --- 위치 탐색
    const afterOpen = text.replace(/^﻿?---\s*\r?\n/, '');
    const closeIdx = afterOpen.search(/\r?\n---\s*(\r?\n|$)/);
    if (closeIdx !== -1) {
      const closeMatch = afterOpen.slice(closeIdx).match(/\r?\n---\s*(\r?\n|$)/);
      text = afterOpen.slice(closeIdx + closeMatch[0].length);
    }
  }

  // (b) "# Persistent Agent Memory" (대소문자 무시) 이후 전부 제거
  const memIdx = text.search(/^#\s+Persistent Agent Memory\s*$/im);
  if (memIdx !== -1) {
    text = text.slice(0, memIdx);
  }

  return text.trim();
}

// ──────────────────────────────────────────────────────────────
// 4. 매 요청마다 작업지시서 + 참고자료를 새로 읽어 system 메시지 구성
//    파일이 없거나 비면 안전한 기본값으로 동작(=> 정보 없으면 "몰라요").
// ──────────────────────────────────────────────────────────────
function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return ''; // 없음/접근불가 → 빈 문자열
  }
}

function buildSystemPrompt() {
  const rawInstruction = safeRead(INSTRUCTION_FILE);
  const instruction = rawInstruction ? extractInstruction(rawInstruction) : '';
  const aboutMe = safeRead(ABOUT_ME_FILE).trim();

  // 작업지시서가 없을 때를 대비한 최소 규칙(원본 지시의 핵심 요약).
  const fallbackRule = [
    '당신은 사용자에 대해 엄격하게 근거 기반으로만 답하는 한국어 Q&A 봇입니다.',
    '아래 "참고 자료"에 명시적으로 적힌 내용만 사용하세요.',
    '추론·추측·창작·외부지식 결합을 하지 마세요.',
    '참고 자료에서 답을 찾을 수 없으면 정확히 한 단어로만: 몰라요',
    '답변은 한국어로 간결하게.'
  ].join('\n');

  const rulesSection = instruction || fallbackRule;

  // 참고자료를 명확히 라벨링하여 system 메시지에 포함.
  const referenceSection = aboutMe
    ? `참고 자료 (이 내용에 명시된 것만 사용하세요. 여기에 없는 정보는 "몰라요"):\n"""\n${aboutMe}\n"""`
    : '참고 자료: (제공되지 않음 — 어떤 개인 정보도 알 수 없으므로 "몰라요"라고 답하세요.)';

  return `${rulesSection}\n\n${referenceSection}`;
}

// ──────────────────────────────────────────────────────────────
// 5. OpenAI Chat Completions 호출
// ──────────────────────────────────────────────────────────────
async function askOpenAI(question) {
  if (!OPENAI_API_KEY) {
    const e = new Error('OPENAI_API_KEY 가 설정되어 있지 않습니다.');
    e.userMessage = '서버에 API 키가 설정되어 있지 않아요. 관리자에게 문의해 주세요.';
    e.statusCode = 500;
    throw e;
  }

  const systemPrompt = buildSystemPrompt();
  const body = {
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: question },
    ],
    temperature: 0.2,
  };

  let resp;
  try {
    resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // 네트워크 실패 등 (키 값은 절대 로그에 남기지 않음)
    console.error('[openai] 네트워크 오류:', err && err.message);
    const e = new Error('OpenAI 네트워크 오류');
    e.userMessage = '답변 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.';
    e.statusCode = 502;
    throw e;
  }

  if (!resp.ok) {
    // 상태코드/유형만 로깅, 본문에 키가 들어갈 일은 없지만 안전하게 status 만 표시
    let detail = '';
    try { detail = await resp.text(); } catch (_) {}
    console.error(`[openai] 응답 오류 status=${resp.status}`);
    const e = new Error(`OpenAI 응답 오류 status=${resp.status}`);
    e.statusCode = resp.status === 401 ? 500 : 502; // 401(키문제)은 내부 문제로 처리
    e.userMessage = resp.status === 429
      ? '요청이 많아 잠시 후 다시 시도해 주세요.'
      : '답변을 생성하지 못했어요. 잠시 후 다시 시도해 주세요.';
    // detail 은 사용자에게 노출하지 않음(키/민감정보 유출 방지)
    void detail;
    throw e;
  }

  let data;
  try {
    data = await resp.json();
  } catch (err) {
    const e = new Error('OpenAI 응답 파싱 실패');
    e.statusCode = 502;
    e.userMessage = '답변 형식을 해석하지 못했어요. 잠시 후 다시 시도해 주세요.';
    throw e;
  }

  const answer = data
    && data.choices
    && data.choices[0]
    && data.choices[0].message
    && typeof data.choices[0].message.content === 'string'
      ? data.choices[0].message.content.trim()
      : '';

  return answer || '몰라요';
}

// ──────────────────────────────────────────────────────────────
// 6. 요청 바디 수집(스트림) → JSON 파싱
// ──────────────────────────────────────────────────────────────
function readJsonBody(req, limitBytes = 1024 * 100) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
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
      } catch (err) {
        reject(Object.assign(new Error('invalid JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

function sendJson(res, statusCode, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

// ──────────────────────────────────────────────────────────────
// 7. 정적 서빙 (allowlist) — index.html 만 제공.
//    그 외 모든 경로(.env, .md, server.js, dotfile 등)는 404.
// ──────────────────────────────────────────────────────────────
function serveIndex(res) {
  fs.readFile(INDEX_HTML, (err, buf) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('index.html 을 찾을 수 없습니다.');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': buf.length,
    });
    res.end(buf);
  });
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

// ──────────────────────────────────────────────────────────────
// 8. 라우팅
// ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // URL 의 path 만 사용(쿼리스트링 무시). 디코드 후 정규화.
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (_) {
    pathname = req.url.split('?')[0];
  }

  // ── API: POST /api/ask ──────────────────────────────────────
  if (pathname === '/api/ask') {
    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'POST 메서드만 허용됩니다.' });
    }
    try {
      const body = await readJsonBody(req);
      const question = (body && typeof body.question === 'string')
        ? body.question.trim()
        : '';
      if (!question) {
        return sendJson(res, 400, { error: 'question 필드가 필요합니다.' });
      }
      const answer = await askOpenAI(question);
      return sendJson(res, 200, { answer });
    } catch (err) {
      const status = err.statusCode || 500;
      const message = err.userMessage
        || (status === 400 ? '요청 형식이 올바르지 않아요.'
          : status === 413 ? '질문이 너무 길어요.'
          : '답변을 가져오지 못했어요. 잠시 후 다시 시도해 주세요.');
      // 키 값은 절대 응답에 포함하지 않음
      return sendJson(res, status, { error: message });
    }
  }

  // ── 정적: GET / 또는 /index.html → index.html ───────────────
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (pathname === '/' || pathname === '/index.html') {
      return serveIndex(res);
    }
    // allowlist 에 없는 모든 경로(.env, .md, server.js, dotfile, 이미지 등) → 404
    return notFound(res);
  }

  return notFound(res);
});

// ──────────────────────────────────────────────────────────────
// 9. 서버 시작 (키는 출력하지 않음)
// ──────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`About Me Q&A 서버가 실행 중입니다: http://localhost:${PORT}`);
  console.log(`사용 모델: ${OPENAI_MODEL}`);
  console.log(`OPENAI_API_KEY: ${OPENAI_API_KEY ? '로드됨(서버 메모리에만 보관)' : '미설정'}`);
});

module.exports = server;
