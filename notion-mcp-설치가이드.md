# Notion MCP 설치 가이드 (Claude Code)

Claude Code에서 노션을 연결하는 가이드입니다. **OAuth 호스티드 방식**이라 API 토큰을 발급하거나 페이지마다 연동을 붙일 필요가 없습니다. 명령어 한 줄 + 노션 로그인이면 끝납니다.

> 🤖 AI 에이전트가 대신 설치·검증해줄 때는 → `notion-mcp-설치-runbook-ai.md` (진행 체크 포함)

---

## 0. 준비물

- **Claude Code**가 설치돼 있을 것 (터미널에서 `claude` 명령이 되면 OK)
- **Notion 계정** (로그인만 하면 됨, 개발자 설정 불필요)

---

## 1. 설치 — 명령어 한 줄

터미널에 그대로 붙여넣으세요.

```bash
claude mcp add --transport http --scope user notion https://mcp.notion.com/mcp
```

- `--transport http` → 원격 HTTP 서버 방식 (로컬에 뭘 깔지 않음)
- `--scope user` → 내 계정의 **모든 프로젝트에서 공용**으로 사용
- 마지막 URL은 노션이 직접 운영하는 공식 MCP 서버 주소입니다

> 특정 프로젝트에서만 쓰려면 `--scope user` 대신 `--scope project`로 바꾸세요.

---

## 2. 노션 로그인 (OAuth 연결)

1. Claude Code를 **재시작**합니다.
2. Claude Code 안에서 `/mcp` 를 입력 → 목록에서 **notion** 선택 → **Authenticate**.
3. 브라우저가 열리면 **노션에 로그인 → 워크스페이스 선택**.
4. **접근 범위 선택 화면**에서 MCP가 접근할 페이지를 고릅니다. (아래 3번 참고)
5. 승인하면 자동으로 Claude Code로 돌아오고 연결 완료.

---

## 3. ⭐ 접근 범위 — 여기가 핵심

**페이지마다 하나씩 연동을 붙일 필요는 없습니다.** 대신 **로그인(연결)하는 그 순간에 범위를 한 번에 고릅니다.**

- OAuth 화면에서 **"Edit access"** 로 접근을 줄 페이지를 선택
- **부모 페이지 하나를 주면 그 안의 하위 페이지·DB는 전부 자동 상속** → 그래서 "페이지마다"가 아님
- **권한 상한 = 내 계정** — 내가 볼 수 있는 페이지까지만 접근 가능. 내가 못 보는 페이지는 MCP도 못 씀
- 전체 접근을 허용하면 워크스페이스 전체를 읽고 쓸 수 있게 됩니다
  → ⚠️ 노션 공식 경고: *"MCP tools act with your full Notion permissions — they can access everything you can access."*

### 나중에 페이지를 추가로 주고 싶으면
연결을 다시 할 필요 없이 둘 중 하나:
- 노션 **설정 → 해당 연결(integration)의 Access 탭**에서 페이지 추가
- 또는 그 페이지에서 `⋯ (점 3개) → Connect to integration`

---

## 4. 설치 확인

```bash
claude mcp list
```

아래처럼 나오면 성공입니다.

```
notion: https://mcp.notion.com/mcp (HTTP) - ✔ Connected
```

상세 확인:

```bash
claude mcp get notion
```

---

## 5. 참고 — 잘못 알기 쉬운 부분

시중 가이드에 **"페이지 3점 메뉴 → Connect to integration을 페이지마다 해야 한다"** 는 설명이 많은데,
그건 **예전 방식(Internal integration + API 토큰, self-hosted)** 얘기입니다.

| | **이 가이드 (OAuth 호스티드)** | 예전 API 토큰 방식 |
|---|---|---|
| 인증 | 노션 로그인만 | 토큰 발급 필요 |
| 기본 접근 | 연결할 때 고른 페이지(+하위) | 0에서 시작, 페이지마다 공유 필수 |
| 로컬 설치물 | 없음 (원격 서버) | 서버 직접 구동 |

지금 이 방식이 **훨씬 간단**합니다.

> 참고: 노션은 로컬 CLI 설치분 외에, **claude.ai 계정 커넥터**로도 붙을 수 있습니다(`claude.ai Notion`). 이건 CLI로 안 지워지고 claude.ai 웹/데스크탑앱 → Settings → Connectors에서 관리합니다.

---

## 6. 문제 해결

| 증상 | 해결 |
|---|---|
| 특정 페이지에 글쓰기가 안 됨 | 그 페이지가 연결 범위 **밖**임 → 3번 "나중에 추가" 방식으로 그 페이지 추가 |
| `- ! Needs authentication` | `/mcp` → notion → Authenticate 다시 |
| `- ✘ Failed to connect` | 인증 만료·해제 상태 → Authenticate 재시도 (또는 Claude Code 재시작) |
| 목록에 안 뜸 | Claude Code 재시작 후 `claude mcp list` 재확인 |
| 잘못 설치해서 지우고 싶음 | `claude mcp remove notion -s user` |

---

## 요약 (친구용 3줄)

1. `claude mcp add --transport http --scope user notion https://mcp.notion.com/mcp`
2. Claude Code 재시작 → `/mcp` → notion → 노션 로그인 → **접근할 페이지 선택**
3. 페이지마다 연동 붙일 필요 X. 부모 페이지 주면 하위는 자동. 나중에 필요하면 Access 탭에서 추가.
