// ========================================
// 🧑‍💼 About Me Q&A — Express 백엔드 서버
// ----------------------------------------
// 흐름:  브라우저(챗봇 UI) → (우리 서버) POST /api/ask → Claude API → 답변 → 응답
//   - 프런트엔드(index.html)는 우리 서버의 /api/ask 만 호출한다 (Claude 를 직접 부르지 않음)
//   - ANTHROPIC_API_KEY 는 .env 에서만 읽고, 절대 클라이언트로 내려보내지 않는다
//   - 서버 시작 시 같은 폴더의 두 파일을 메모리에 캐싱:
//       · about-me-qa-bot.md → 시스템 프롬프트(페르소나)
//       · about-me.md        → 지식 자료(이 내용에만 근거해 답함)
//   - 🔒 폴더 전체를 정적 서빙하지 않음. GET / 에서 index.html 만 sendFile →
//     .env / server.js / about-me*.md 가 URL 로 노출될 위험을 원천 차단.
//
// 실행:  .env 에 ANTHROPIC_API_KEY 입력  →  npm install (최초 1회)  →  npm start
//        (= node --env-file=.env server.js,  Node 20.6+ 내장 --env-file 사용)
// ========================================

import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// 모델 기본값: about-me-qa-bot 에이전트가 model: sonnet 으로 정의되어 있어 이를 따름.
// .env 의 ANTHROPIC_MODEL 로 교체 가능.
const MODEL = (process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6").trim();
const MAX_TOKENS = 1024;

// API 키 감지(시작 로그용). 실제 호출 시에는 SDK 가 ANTHROPIC_API_KEY 를 자동 사용한다.
const HAS_KEY = Boolean((process.env.ANTHROPIC_API_KEY || "").trim());

// ANTHROPIC_API_KEY 환경변수를 SDK 가 자동으로 사용한다(키 값을 코드/로그에 노출하지 않음).
const client = new Anthropic();

// ========================================
// 📄 시작 시 지식/페르소나 파일 로드 (메모리 캐싱)
//   파일이 없으면 빈 문자열로 두고 경고만 남긴다(서버는 계속 뜸).
// ----------------------------------------
function readLocalFile(filename) {
  try {
    return fs.readFileSync(path.join(__dirname, filename), "utf-8");
  } catch (e) {
    console.warn(`⚠️  ${filename} 를 읽지 못했습니다. (빈 내용으로 진행) — ${e.message}`);
    return "";
  }
}

const SYSTEM_PROMPT = readLocalFile("about-me-qa-bot.md");
const ABOUT_ME = readLocalFile("about-me.md");

// ========================================
// 🤖 Claude 호출: (사용자 질문) + (시스템 프롬프트) + (about-me.md 지식)
//   - system: 텍스트 블록 배열. about-me.md 블록에 prompt caching 적용(반복 호출 비용 절감).
//   - thinking/스트리밍 미사용(단순 Q&A, max_tokens 1024 → 타임아웃 안전).
// ----------------------------------------
async function askClaude(question) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: [
      { type: "text", text: SYSTEM_PROMPT },
      {
        type: "text",
        text:
          "다음은 이 인물의 about-me.md 내용입니다. 이 내용에만 근거해 답하세요:\n\n" +
          ABOUT_ME,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: question }],
  });

  // 첫 번째 text 블록을 답변으로 사용. 없으면 규칙에 따라 "몰라요".
  return (response.content.find((b) => b.type === "text")?.text || "몰라요").trim();
}

// ========================================
// 🛣️  라우트
// ========================================
app.use(express.json());

// (1) 핵심 엔드포인트: 질문 → Claude 답변
//     요청 바디 { question: string } → 응답 { success, answer, model }
app.post("/api/ask", async (req, res) => {
  const question = req.body?.question;

  // 입력 검증: 문자열이 아니거나 공백뿐이면 400
  if (typeof question !== "string" || question.trim() === "") {
    return res.status(400).json({ success: false, message: "질문을 입력해 주세요." });
  }

  // 키 미설정: 실제 호출 전에 친절히 안내 (시작 로그에도 경고됨)
  if (!HAS_KEY) {
    console.error("[/api/ask] ANTHROPIC_API_KEY 미설정");
    return res.status(500).json({
      success: false,
      code: "NO_KEY",
      message: "서버에 ANTHROPIC_API_KEY가 설정되지 않았습니다. (.env 확인)",
    });
  }

  try {
    const answer = await askClaude(question.trim());
    res.json({ success: true, answer, model: MODEL });
  } catch (e) {
    // 타입드 예외별로 상태코드/메시지 매핑 (키 값은 절대 로그에 남기지 않음)
    if (e instanceof Anthropic.AuthenticationError) {
      console.error("[/api/ask] BAD_KEY:", e.message);
      return res.status(502).json({
        success: false,
        code: "BAD_KEY",
        message: "API 키가 유효하지 않습니다.",
      });
    }
    if (e instanceof Anthropic.RateLimitError) {
      console.error("[/api/ask] RATE_LIMIT:", e.message);
      return res.status(429).json({
        success: false,
        code: "RATE_LIMIT",
        message: "요청이 많아 잠시 후 다시 시도해 주세요.",
      });
    }
    if (e instanceof Anthropic.APIError) {
      console.error("[/api/ask] API_ERROR:", e.status || "", e.message);
      return res.status(502).json({
        success: false,
        code: "API_ERROR",
        message: e.message || "Claude API 호출 중 오류가 발생했습니다.",
      });
    }
    console.error("[/api/ask] UNKNOWN:", e.message);
    res.status(500).json({
      success: false,
      code: "UNKNOWN",
      message: "알 수 없는 오류가 발생했습니다.",
    });
  }
});

// (2) 프런트엔드: index.html 만 명시적으로 서빙.
//     ⚠️ 폴더 전체를 정적 서빙(express.static)하지 않음 → .env / server.js / about-me*.md 노출 차단
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// 안전망: 처리되지 않은 거부가 서버를 죽이지 않도록
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

app.listen(PORT, () => {
  console.log(`✅ About Me Q&A 서버 실행 중 → http://localhost:${PORT}`);
  console.log(`   Claude 모델: ${MODEL}`);
  console.log(`   ANTHROPIC_API_KEY ${HAS_KEY ? "감지됨 ✓" : "없음 ✗ (.env 확인 필요)"}`);
  if (!SYSTEM_PROMPT) console.warn("   ⚠️  about-me-qa-bot.md 내용이 비어 있습니다.");
  if (!ABOUT_ME) console.warn("   ⚠️  about-me.md 내용이 비어 있습니다.");
});
