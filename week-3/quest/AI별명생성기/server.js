// ========================================
// AI 별명 생성기 — 백엔드 서버 (의존성 0개)
// ----------------------------------------
// - Node 24의 내장 http 모듈 + 전역 fetch만 사용 (npm install 불필요)
// - 정적 파일(index.html 등)을 __dirname 기준으로 서빙
// - POST /api/nicknames : OpenAI Chat Completions로 별명 8개 생성
// - OPENAI_API_KEY 는 process.env 에서만 읽고, 절대 클라이언트로 보내지 않음
// 실행: npm start  (= node --env-file=.env server.js)
// ========================================

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// 정적 파일 MIME 타입 (http 모듈 직접 사용 시 수동 지정 필요)
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

// UI가 사용하는 5가지 스타일 키 → 한국어 라벨/설명 (프롬프트 가독성 향상용)
const STYLE_LABELS = {
  animal: "귀여운 동물 (말랑말랑하고 포근한 동물 컨셉)",
  game: "게임 캐릭터 (필드를 누비는 RPG 캐릭터 느낌, 영문/특수문자 살짝 가능)",
  fantasy: "신비/판타지 (몽환적이고 신비로운 분위기)",
  mz: "MZ/밈 (요즘 감성 가득한 인터넷 밈 스타일)",
  elegant: "우아/고급 (기품 있고 우아한 호칭)",
};

// ----------------------------------------
// 응답 헬퍼: 일관된 JSON 구조로 응답
// ----------------------------------------
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// ----------------------------------------
// 요청 본문(JSON) 읽기 — 과도한 페이로드 방어 포함
// ----------------------------------------
function readJsonBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let aborted = false;
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > limit) {
        aborted = true;
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (aborted) return;
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ----------------------------------------
// OpenAI 응답에서 별명 배열을 견고하게 파싱
//  - ```json ... ``` 코드펜스 제거
//  - { "nicknames": [...] } 또는 순수 배열 모두 허용
//  - 모두 실패하면 줄 단위 추출로 폴백
// ----------------------------------------
function parseNicknames(content) {
  if (!content || typeof content !== "string") return [];
  let text = content.trim();

  // 코드펜스(```json ... ```) 제거
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  // 1) JSON 파싱 시도
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return cleanList(parsed);
    if (parsed && Array.isArray(parsed.nicknames)) return cleanList(parsed.nicknames);
  } catch {
    // 본문 어딘가에 묻혀 있을 수 있는 JSON 객체/배열을 추출 시도
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        const obj = JSON.parse(objMatch[0]);
        if (obj && Array.isArray(obj.nicknames)) return cleanList(obj.nicknames);
      } catch { /* fallthrough */ }
    }
    const arrMatch = text.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try {
        const arr = JSON.parse(arrMatch[0]);
        if (Array.isArray(arr)) return cleanList(arr);
      } catch { /* fallthrough */ }
    }
  }

  // 2) 최후 폴백: 줄 단위로 끊고 번호/불릿 제거
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*\d.)\]]+\s*/, "").replace(/^["'`]|["'`]$/g, "").trim())
    .filter(Boolean);
  return cleanList(lines);
}

function cleanList(arr) {
  return arr
    .map((x) => (typeof x === "string" ? x : String(x ?? "")))
    .map((s) => s.trim())
    .filter((s) => s.length >= 1 && s.length <= 30)
    .slice(0, 8);
}

// ----------------------------------------
// OpenAI Chat Completions 호출
// ----------------------------------------
async function generateWithOpenAI({ name, personality, hobby, likes, style }) {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    const err = new Error("OPENAI_API_KEY가 설정되지 않았습니다.");
    err.code = "NO_KEY";
    throw err;
  }

  const styleLabel = STYLE_LABELS[style] || STYLE_LABELS.animal;

  const systemPrompt =
    "너는 창의적인 한국어 별명(닉네임) 작가야. " +
    "사용자의 이름·성격·취미·관심사와 선택한 스타일을 반영해 " +
    "재치 있고 다양한 별명을 만들어. 결과는 반드시 한국어로, " +
    '오직 JSON 객체 {"nicknames": ["별명1", ..., "별명8"]} 형식으로만 답해. ' +
    "설명·인사·코드펜스 없이 JSON만 출력해.";

  const userPrompt =
    `다음 정보를 바탕으로 어울리는 한국어 별명을 정확히 8개 만들어줘.\n` +
    `- 이름: ${name || "(미입력)"}\n` +
    `- 성격: ${personality || "(미입력)"}\n` +
    `- 취미: ${hobby || "(미입력)"}\n` +
    `- 좋아하는 것/키워드: ${likes || "(미입력)"}\n` +
    `- 스타일: ${styleLabel}\n\n` +
    `조건: 각 별명은 1~20자 내외로 짧고 임팩트 있게. 서로 겹치지 않게 다양하게. ` +
    `선택한 스타일의 분위기를 확실히 살릴 것. ` +
    `반드시 {"nicknames": [...]} JSON 형식으로만 답할 것.`;

  // 12초 타임아웃 (네트워크 지연 시 무한 대기 방지)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  let resp;
  try {
    resp = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.9,
        max_tokens: 400,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
  } catch (e) {
    const err = new Error(
      e.name === "AbortError" ? "OpenAI 요청이 시간 초과되었습니다." : "OpenAI 서버에 연결하지 못했습니다."
    );
    err.code = "NETWORK";
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    let detail = "";
    try {
      const errBody = await resp.json();
      detail = errBody?.error?.message || "";
    } catch { /* ignore */ }
    const err = new Error(`OpenAI API 오류 (${resp.status})${detail ? ": " + detail : ""}`);
    err.code = "API_ERROR";
    err.status = resp.status;
    throw err;
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || "";
  const nicknames = parseNicknames(content);

  if (nicknames.length === 0) {
    const err = new Error("OpenAI 응답에서 별명을 추출하지 못했습니다.");
    err.code = "PARSE_ERROR";
    throw err;
  }
  return nicknames;
}

// 클라이언트에 공개해도 되는 정적 자산만 허용 (allowlist).
// 이렇게 해야 .env(키)·server.js(소스)·package.json 등이 절대 노출되지 않는다.
const PUBLIC_EXT = new Set([".html", ".js", ".css", ".svg", ".png", ".jpg", ".ico", ".json"]);
// 확장자가 public이라도 절대 내보내면 안 되는 파일들 (서버 소스/메타)
const BLOCKED_FILES = new Set(["server.js", "package.json", "package-lock.json"]);

function serveIndex(res) {
  fs.readFile(path.join(__dirname, "index.html"), (e, html) => {
    if (e) return sendJson(res, 404, { success: false, message: "Not found" });
    res.writeHead(200, { "Content-Type": MIME[".html"] });
    res.end(html);
  });
}

// ----------------------------------------
// 정적 파일 서빙 (allowlist + 경로 탈출/도트파일 차단)
// ----------------------------------------
function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (urlPath === "/" || urlPath === "") return serveIndex(res);

  const filePath = path.join(__dirname, urlPath);

  // 1) 디렉터리 탈출 차단: 해석된 경로가 __dirname 밖이면 거부
  if (filePath !== __dirname && !filePath.startsWith(__dirname + path.sep)) {
    return sendJson(res, 403, { success: false, message: "Forbidden" });
  }

  const base = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  // 2) 도트파일(.env, .gitignore 등)·차단 목록·비공개 확장자는 노출 금지
  //    → 그냥 index.html로 폴백(SPA 친화)하여 파일 존재 여부도 흘리지 않음
  if (base.startsWith(".") || BLOCKED_FILES.has(base) || !PUBLIC_EXT.has(ext)) {
    return serveIndex(res);
  }

  fs.readFile(filePath, (err, content) => {
    if (err) return serveIndex(res); // 없는 파일은 index.html로 폴백
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(content);
  });
}

// ----------------------------------------
// 라우터
// ----------------------------------------
const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");

  // --- API: 별명 생성 ---
  if (pathname === "/api/nicknames" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const input = {
        name: typeof body.name === "string" ? body.name : "",
        personality: typeof body.personality === "string" ? body.personality : "",
        hobby: typeof body.hobby === "string" ? body.hobby : "",
        // 프런트엔드는 'keyword' 키를 쓰지만, 표준화를 위해 둘 다 허용
        likes: typeof body.likes === "string" ? body.likes : (typeof body.keyword === "string" ? body.keyword : ""),
        style: typeof body.style === "string" ? body.style : "animal",
      };

      const nicknames = await generateWithOpenAI(input);
      return sendJson(res, 200, { success: true, nicknames });
    } catch (e) {
      // 어떤 경우에도 서버는 죽지 않고 명확한 에러를 반환
      const status =
        e.code === "NO_KEY" ? 500 :
        e.code === "API_ERROR" ? (e.status === 429 ? 429 : 502) :
        e.code === "NETWORK" ? 504 :
        e.code === "PARSE_ERROR" ? 502 :
        e.message === "Invalid JSON body" || e.message === "Payload too large" ? 400 :
        500;
      console.error("[/api/nicknames] 오류:", e.code || "", e.message);
      return sendJson(res, status, {
        success: false,
        message: e.message || "별명 생성에 실패했습니다.",
        code: e.code || "UNKNOWN",
      });
    }
  }

  // --- API 경로인데 매칭 안 됨 ---
  if (pathname.startsWith("/api/")) {
    return sendJson(res, 404, { success: false, message: "API endpoint not found" });
  }

  // --- 그 외: 정적 파일 ---
  if (req.method === "GET" || req.method === "HEAD") {
    return serveStatic(req, res);
  }

  return sendJson(res, 405, { success: false, message: "Method not allowed" });
});

// 프로세스 전역 안전망: 처리되지 않은 거부가 서버를 죽이지 않도록
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

server.listen(PORT, () => {
  console.log(`✅ AI 별명 생성기 서버 실행 중 → http://localhost:${PORT}`);
  console.log(`   모델: ${OPENAI_MODEL} | API 키 ${process.env.OPENAI_API_KEY ? "감지됨" : "없음(폴백 모드)"}`);
});
