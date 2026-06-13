// ========================================
// 🧑‍💼 About Me Q&A — Express 백엔드 (Claude Agent SDK)
// ----------------------------------------
// 흐름:  브라우저(챗봇 UI) → (우리 서버) POST /api/ask
//        → ⟦about-me-qa-bot 에이전트 실행(Claude Agent SDK)⟧ → 답변 → 응답
//
//   - 핵심: Claude Messages API 를 직접(raw) 부르지 않는다.
//     server 는 "나의 AI 에이전트(about-me-qa-bot)" 를 그대로 구동해서 답을 받는다.
//   - 에이전트 정의(페르소나)는 about-me-qa-bot.md, 지식은 about-me.md 에서 읽어
//     에이전트에게 함께 전달한다.
//   - options.agent 로 about-me-qa-bot 을 "메인 스레드 에이전트"로 지정 → 사용자 질문이
//     이 에이전트에게 직접 전달되고, 에이전트의 규칙대로 답한다(없으면 "몰라요").
//   - ANTHROPIC_API_KEY 는 .env 에서만 읽고 클라이언트로 내려보내지 않는다.
//   - 🔒 GET / 에서 index.html 만 sendFile → .env / server.js / about-me*.md 노출 차단.
//
// 실행:  .env 에 ANTHROPIC_API_KEY 입력  →  npm install (최초 1회)  →  npm start
//        (= node --env-file=.env server.js,  Node 20.6+ 내장 --env-file 사용)
// ========================================

import express from "express";
import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// 에이전트 이름과 모델. about-me-qa-bot 에이전트가 model: sonnet 으로 정의되어 있어 따름.
const AGENT_NAME = "about-me-qa-bot";
const MODEL = (process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6").trim();

// API 키 감지(시작 로그/요청 가드용). Agent SDK 가 ANTHROPIC_API_KEY 를 자동 사용한다.
const HAS_KEY = Boolean((process.env.ANTHROPIC_API_KEY || "").trim());

// ========================================
// 📄 시작 시 페르소나/지식 파일 로드 (메모리 캐싱)
//   · about-me-qa-bot.md → 에이전트 시스템 프롬프트(페르소나)
//   · about-me.md        → 지식 자료(이 내용에만 근거해 답함)
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

const PERSONA = readLocalFile("about-me-qa-bot.md");
const ABOUT_ME = readLocalFile("about-me.md");

// 에이전트의 시스템 프롬프트 = 페르소나 + (함께 전달하는) about-me.md 내용
const AGENT_PROMPT = [
  PERSONA,
  "",
  "---",
  "다음은 이 인물의 about-me.md 내용입니다. 이 내용에만 근거해 답하세요:",
  "",
  ABOUT_ME,
].join("\n");

// ========================================
// 🤖 about-me-qa-bot 에이전트 실행 (Claude Agent SDK)
//   - options.agent 로 about-me-qa-bot 을 메인 스레드 에이전트로 지정 → 사용자 질문이
//     이 에이전트에게 직접 전달된다.
//   - 읽기 전용 도구만 허용(Read/Glob/Grep), permissionMode "dontAsk" 로 무프롬프트 동작.
//   - 최종 결과(type:"result", subtype:"success")의 result 문자열이 답변.
// ----------------------------------------
async function askAgent(question) {
  let answer = null;
  let errMsg = null;

  for await (const message of query({
    prompt: question,
    options: {
      cwd: __dirname,
      // 프로젝트/유저 설정(.claude 등)을 끌어오지 않고, 에이전트를 인라인으로만 정의 → 결정적 동작
      settingSources: [],
      // about-me-qa-bot 을 "메인 스레드 에이전트"로 지정
      agent: AGENT_NAME,
      agents: {
        [AGENT_NAME]: {
          description: "about-me.md에 근거해서만 이 인물에 대해 답하는 개인 Q&A 에이전트",
          prompt: AGENT_PROMPT,
          tools: ["Read", "Glob", "Grep"],
          model: MODEL,
        },
      },
      // 헤드리스: 허용 도구만 자동 승인, 그 외에는 프롬프트 없이 거부
      allowedTools: ["Read", "Glob", "Grep"],
      disallowedTools: ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Task"],
      permissionMode: "dontAsk",
      maxTurns: 3,
      model: MODEL,
    },
  })) {
    if (message.type === "result") {
      if (message.subtype === "success") {
        answer = (message.result || "몰라요").trim();
      } else {
        // error_during_execution / error_max_turns 등
        errMsg = (message.errors && message.errors.join("; ")) || message.subtype || "agent_error";
      }
      break;
    }
  }

  if (errMsg) throw new Error(errMsg);
  return answer || "몰라요";
}

// ========================================
// 🛣️  라우트
// ========================================
app.use(express.json());

// (1) 핵심 엔드포인트: 질문 → about-me-qa-bot 에이전트 답변
//     요청 바디 { question: string } → 응답 { success, answer, model }
app.post("/api/ask", async (req, res) => {
  const question = req.body?.question;

  // 입력 검증
  if (typeof question !== "string" || question.trim() === "") {
    return res.status(400).json({ success: false, message: "질문을 입력해 주세요." });
  }

  // 키 미설정: 실제 호출 전에 친절히 안내
  if (!HAS_KEY) {
    console.error("[/api/ask] ANTHROPIC_API_KEY 미설정");
    return res.status(500).json({
      success: false,
      code: "NO_KEY",
      message: "서버에 ANTHROPIC_API_KEY가 설정되지 않았습니다. (.env 확인)",
    });
  }

  try {
    const answer = await askAgent(question.trim());
    res.json({ success: true, answer, model: MODEL });
  } catch (e) {
    // Agent SDK 는 raw 메시지를 던지므로 키워드로 분류 (키 값은 로그에 남기지 않음)
    const raw = (e && e.message) || "";
    const low = raw.toLowerCase();
    let status = 502;
    let code = "API_ERROR";
    let message = "에이전트 호출 중 오류가 발생했습니다.";

    if (
      low.includes("401") || low.includes("unauthorized") ||
      low.includes("authentication") || low.includes("api key") || low.includes("api_key")
    ) {
      status = 502;
      code = "BAD_KEY";
      message = "API 키가 유효하지 않습니다. (.env의 ANTHROPIC_API_KEY 확인)";
    } else if (
      low.includes("429") || low.includes("rate limit") ||
      low.includes("rate_limit") || low.includes("overloaded")
    ) {
      status = 429;
      code = "RATE_LIMIT";
      message = "요청이 많아 잠시 후 다시 시도해 주세요.";
    } else if (raw) {
      message = raw;
    }

    console.error(`[/api/ask] ${code}:`, raw);
    res.status(status).json({ success: false, code, message });
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
  console.log(`✅ About Me Q&A 서버(Agent SDK) 실행 중 → http://localhost:${PORT}`);
  console.log(`   에이전트: ${AGENT_NAME}  ·  모델: ${MODEL}`);
  console.log(`   ANTHROPIC_API_KEY ${HAS_KEY ? "감지됨 ✓" : "없음 ✗ (.env 확인 필요)"}`);
  if (!PERSONA) console.warn("   ⚠️  about-me-qa-bot.md 내용이 비어 있습니다.");
  if (!ABOUT_ME) console.warn("   ⚠️  about-me.md 내용이 비어 있습니다.");
});
