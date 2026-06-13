// ========================================
// AI 꿈해몽 앱 — 백엔드 서버 (의존성 0개)
// ----------------------------------------
// - Node의 내장 http 모듈 + 전역 fetch만 사용 (npm install 불필요)
// - 정적 파일(index.html 등)을 __dirname 기준으로 서빙
// - POST /api/interpret : 꿈 내용을 받아 OpenAI로 해몽 결과(JSON) 생성
// - OPENAI_API_KEY 는 process.env 에서만 읽고, 절대 클라이언트로 보내지 않음
// - 키가 없으면 간이 규칙기반 '데모 해몽'으로 폴백 → UI는 항상 동작
// 실행: npm start  (= node --env-file=.env server.js)  /  node server.js (.env 자동 로드)
// ========================================

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .env 자동 로드 — `npm start`(--env-file) 없이 `node server.js`로 켜도
// 같은 폴더의 .env에서 OPENAI_API_KEY 등을 읽어오게 한다. (Node 20.12+)
// 이미 환경변수가 설정돼 있으면(--env-file 또는 OS 환경변수) 그 값을 우선한다.
if (!process.env.OPENAI_API_KEY && typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(path.join(__dirname, ".env"));
  } catch {
    // .env가 없으면 무시 → 데모 모드로 동작
  }
}

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

// ----------------------------------------
// 작은 유틸
// ----------------------------------------
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v)).trim();
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

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
// 해몽가 캐릭터 — 시스템 프롬프트
//  · 신비로운 점술가 70% + MZ 위트 30%
//  · 무섭게 겁주지 않고, 흉몽도 따뜻하게 풀어 액운을 달래는 조언
//  · 출력은 반드시 정해진 JSON 스키마로만
// ----------------------------------------
const SYSTEM_PROMPT = [
  "너는 '몽몽도사'라는 이름의 AI 꿈해몽가야.",
  "",
  "[캐릭터]",
  "- 분위기: 별·달·운명·기운을 즐겨 말하는 신비로운 점술가. 차분하고 자신감 있게 운세를 풀이한다.",
  "- 말투: 동시에 MZ 감성. '완전', '찐', '~각', '갓생', '럭키비키', 'ㄹㅇ' 같은 요즘 말과 이모지를 가끔 자연스럽게 섞는다.",
  "- 균형: 신비로움 70% + MZ 위트 30%. 과하게 오글거리지 않게.",
  "- 태도: 절대 무섭게 겁주지 않는다. 흉몽이어도 따뜻하게 해석하고, 액운을 푸는 방법을 알려준다.",
  "",
  "[역할]",
  "- 사용자가 입력한 꿈을 한국 전통 해몽 + 상징 심리 관점으로 풀이한다.",
  "",
  "[출력 형식 — 매우 중요]",
  "반드시 아래 JSON 객체 '하나'로만 답한다. 인사·설명·코드펜스 금지, 오직 JSON.",
  "{",
  '  "summary": "꿈을 한 문장으로 압축한 한줄요약 (40자 이내, 신비로운 도사 말투)",',
  '  "keywords": ["꿈 속 상징 키워드 3~5개 (각 8자 이내, # 없이)"],',
  '  "verdict": "길몽 / 흉몽 / 반길몽반흉몽 중 짧은 라벨 하나",',
  '  "verdictReason": "왜 그렇게 보는지 1~2문장 풀이 (80자 이내)",',
  '  "verdictType": "good | bad | neutral 중 하나",',
  '  "advice": "오늘 하루를 위한 따뜻한 한 줄 조언 (60자 이내, MZ 감성 살짝)",',
  '  "luckScore": 0~100 사이 정수 (오늘의 행운지수)',
  "}",
  "",
  "[일관성 규칙]",
  "- verdictType이 good이면 luckScore는 보통 66~100.",
  "- verdictType이 bad이면 luckScore는 보통 0~44.",
  "- verdictType이 neutral이면 luckScore는 보통 45~70.",
  "- 모든 텍스트는 한국어.",
].join("\n");

// ----------------------------------------
// OpenAI 응답 → 해몽 결과 객체로 견고하게 파싱/정규화
// ----------------------------------------
function parseInterpretation(content) {
  if (!content || typeof content !== "string") return null;
  let text = content.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { obj = JSON.parse(m[0]); } catch { /* fallthrough */ }
    }
  }
  if (!obj || typeof obj !== "object") return null;
  return normalizeResult(obj);
}

function normalizeResult(obj) {
  const summary = str(obj.summary).slice(0, 120);

  let keywords = Array.isArray(obj.keywords)
    ? obj.keywords
    : (typeof obj.keywords === "string" ? obj.keywords.split(/[,\n]+/) : []);
  keywords = keywords
    .map((k) => str(k).replace(/^#/, "").trim())
    .filter(Boolean)
    .slice(0, 6);

  let verdictType = str(obj.verdictType).toLowerCase();
  if (!["good", "bad", "neutral"].includes(verdictType)) verdictType = "neutral";

  const verdict =
    str(obj.verdict) ||
    (verdictType === "good" ? "길몽" : verdictType === "bad" ? "흉몽" : "반길몽반흉몽");

  const verdictReason = str(obj.verdictReason).slice(0, 160);
  const advice = str(obj.advice).slice(0, 200);

  let luckScore = Math.round(Number(obj.luckScore));
  if (!Number.isFinite(luckScore)) {
    luckScore = verdictType === "good" ? 80 : verdictType === "bad" ? 35 : 58;
  }
  luckScore = clamp(luckScore, 0, 100);

  // 핵심 필드가 비면 무효 처리 (호출부에서 에러 반환)
  if (!summary || keywords.length === 0 || !advice) return null;

  return { summary, keywords, verdict, verdictReason, verdictType, advice, luckScore };
}

// ----------------------------------------
// OpenAI Chat Completions 호출 → 해몽 결과
// ----------------------------------------
async function interpretWithOpenAI(dream) {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    const err = new Error("OPENAI_API_KEY가 설정되지 않았습니다.");
    err.code = "NO_KEY";
    throw err;
  }

  const userPrompt =
    `다음 꿈을 몽몽도사의 시선으로 해몽해줘. 정해진 JSON 형식으로만 답할 것.\n\n` +
    `[꿈 내용]\n"""${dream.slice(0, 1500)}"""`;

  // 15초 타임아웃 (네트워크 지연 시 무한 대기 방지)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

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
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.9,
        max_tokens: 500,
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
  const result = parseInterpretation(content);

  if (!result) {
    const err = new Error("OpenAI 응답에서 해몽 결과를 추출하지 못했습니다.");
    err.code = "PARSE_ERROR";
    throw err;
  }
  return result;
}

// ----------------------------------------
// 간이 규칙기반 '데모 해몽' — API 키가 없을 때만 사용
//  (AI 호출 없이도 UI 전체 흐름을 체험할 수 있게 함)
// ----------------------------------------
const DEMO_SYMBOLS = [
  { re: /(돈|금괴|복권|로또|지폐|현금)/, kw: "재물", good: true },
  { re: /(뱀|구렁이|이무기)/, kw: "뱀", good: true },
  { re: /(똥|배설|화장실|대변)/, kw: "황금똥", good: true },
  { re: /(물|바다|강|호수|홍수|파도)/, kw: "물", good: true },
  { re: /(불|화재|불길|타오)/, kw: "불꽃", good: true },
  { re: /(아기|임신|출산|태아)/, kw: "새 생명", good: true },
  { re: /(하늘|날|비행|날아)/, kw: "비상", good: true },
  { re: /(용|봉황|호랑이)/, kw: "영물", good: true },
  { re: /(이빨|이가|치아|이 빠)/, kw: "이빨", good: false },
  { re: /(떨어|추락|낙하|낭떠러지)/, kw: "추락", good: false },
  { re: /(쫓|도망|괴한|쫒)/, kw: "쫓김", good: false },
  { re: /(죽|시체|장례|관)/, kw: "죽음", good: true }, // 죽음은 재생·새출발의 길몽
  { re: /(시험|지각|학교|발표)/, kw: "시험", good: false },
  { re: /(거미|벌레|곤충)/, kw: "벌레", good: false },
];

function localFallback(dream) {
  const text = str(dream);
  const hits = DEMO_SYMBOLS.filter((s) => s.re.test(text));
  const keywords = (hits.length ? hits.map((h) => h.kw) : ["미지", "무의식", "상징"]).slice(0, 5);

  const goodCount = hits.filter((h) => h.good).length;
  const badCount = hits.filter((h) => !h.good).length;
  let verdictType = goodCount > badCount ? "good" : badCount > goodCount ? "bad" : "neutral";

  // 텍스트 길이를 약한 가변 요소로 사용 (Math.random 없이 결정적)
  let luckScore = 52 + goodCount * 12 - badCount * 9 + (text.length % 11);
  if (verdictType === "good") luckScore = Math.max(luckScore, 66);
  if (verdictType === "bad") luckScore = Math.min(luckScore, 44);
  luckScore = clamp(luckScore, 12, 99);

  const verdict =
    verdictType === "good" ? "길몽" : verdictType === "bad" ? "흉몽" : "반길몽반흉몽";

  const lead = keywords[0];
  const summary =
    verdictType === "good"
      ? `${lead}의 기운이 환하게 감도는, 복이 들어오는 꿈이로구나. ✨`
      : verdictType === "bad"
      ? `${lead}이(가) 마음을 흔드나, 조심하면 능히 다스릴 꿈이니라. 🌙`
      : `${lead}의 양면이 교차하는, 의미심장한 꿈이로구나. 🔮`;

  const verdictReason =
    verdictType === "good"
      ? "별의 흐름이 그대 편이니, 들어오는 복을 가만히 받아도 좋다."
      : verdictType === "bad"
      ? "잠시 기운이 어지러우나 큰 화는 아니다. 작은 조심이 액운을 막아준다."
      : "길과 흉이 반반, 그대의 오늘 마음가짐이 저울을 기울인다.";

  const advice =
    verdictType === "good"
      ? "오늘은 흐름 타는 날 ✨ 망설이던 거 그냥 ㄱㄱ, 완전 럭키비키잖앙."
      : verdictType === "bad"
      ? "급할수록 한 박자 쉬어가기 🌙 작은 조심이 오늘을 지켜줄 거야."
      : "기대 반 긴장 반인 하루 🔮 무리만 안 하면 평타는 친다, 갓생 ㄱ.";

  return { summary, keywords, verdict, verdictReason, verdictType, advice, luckScore };
}

// ----------------------------------------
// 정적 파일 서빙 (allowlist + 경로 탈출/도트파일 차단)
//  → .env(키)·server.js(소스)·package.json 등이 절대 노출되지 않도록
// ----------------------------------------
const PUBLIC_EXT = new Set([".html", ".js", ".css", ".svg", ".png", ".jpg", ".ico", ".json"]);
const BLOCKED_FILES = new Set(["server.js", "package.json", "package-lock.json"]);

function serveIndex(res) {
  fs.readFile(path.join(__dirname, "index.html"), (e, html) => {
    if (e) return sendJson(res, 404, { success: false, message: "Not found" });
    res.writeHead(200, { "Content-Type": MIME[".html"] });
    res.end(html);
  });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (urlPath === "/" || urlPath === "") return serveIndex(res);

  const filePath = path.join(__dirname, urlPath);

  // 1) 디렉터리 탈출 차단: 해석된 경로가 __dirname 밖이면 거부
  if (filePath !== __dirname && !filePath.startsWith(__dirname + path.sep)) {
    return sendJson(res, 403, { success: false, message: "Forbidden" });
  }

  const base = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  // 2) 도트파일(.env 등)·차단목록·비공개 확장자는 노출 금지 → index.html로 폴백
  //    (파일 존재 여부조차 흘리지 않음)
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

  // --- API: 꿈 해몽 ---
  if (pathname === "/api/interpret" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const dream = str(body.dream);

      if (dream.length < 4) {
        return sendJson(res, 400, {
          success: false,
          message: "꿈 내용을 조금만 더 자세히 적어주세요. (최소 4자)",
          code: "TOO_SHORT",
        });
      }

      const hasKey = !!(process.env.OPENAI_API_KEY || "").trim();
      if (!hasKey) {
        // 키가 없으면 데모 해몽으로 폴백 (UI 체험용)
        return sendJson(res, 200, { success: true, demo: true, result: localFallback(dream) });
      }

      const result = await interpretWithOpenAI(dream);
      return sendJson(res, 200, { success: true, demo: false, result });
    } catch (e) {
      const status =
        e.code === "NO_KEY" ? 500 :
        e.code === "API_ERROR" ? (e.status === 429 ? 429 : 502) :
        e.code === "NETWORK" ? 504 :
        e.code === "PARSE_ERROR" ? 502 :
        e.message === "Invalid JSON body" || e.message === "Payload too large" ? 400 :
        500;
      console.error("[/api/interpret] 오류:", e.code || "", e.message);
      return sendJson(res, status, {
        success: false,
        message: e.message || "해몽에 실패했습니다.",
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
  console.log(`🔮 AI 꿈해몽 서버 실행 중 → http://localhost:${PORT}`);
  console.log(
    `   모델: ${OPENAI_MODEL} | API 키 ${
      (process.env.OPENAI_API_KEY || "").trim() ? "감지됨" : "없음 → 데모 해몽 모드"
    }`
  );
});
