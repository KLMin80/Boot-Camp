# Notion MCP 설치 Runbook (AI 실행용)

> **이 문서는 AI 에이전트가 직접 따라 실행하는 설치 절차서입니다.**
> 사람이 읽는 설명용 가이드는 → `notion-mcp-설치가이드.md`
> Claude Code에 노션을 **OAuth 호스티드 방식**(`mcp.notion.com/mcp`)으로 연결합니다. API 토큰·페이지별 연동 불필요.

---

## 🤖 AI 실행 규칙 (먼저 읽을 것)

1. **위에서부터 순서대로** 스텝을 진행한다.
2. 각 스텝의 **[실행자]** 를 지킨다:
   - `🤖 AI` → AI가 직접 명령어 실행
   - `⏸️ 사람` → 사용자에게 요청하고 **완료할 때까지 대기** (브라우저·로그인은 AI가 못 함)
3. 각 스텝의 **[성공 판정]** 조건을 만족하면, **이 파일의 해당 체크박스를 `- [ ]` → `- [x]` 로 Edit** 한다.
4. 판정 실패 시 → 맨 아래 **문제 해결** 표를 보고 대응, 안 되면 사용자에게 상황 보고.
5. 명령어 출력은 요약해서 사용자에게 보고한다.

---

## ✅ Progress 체크리스트

- [x] **0단계** — 설치 전 기존 상태 확인
- [x] **1단계** — 설치 명령 실행 (로컬 user config 등록)
- [x] **2단계** — OAuth 로그인 (노션 인증) ⏸️ 사람
- [x] **3단계** — 연결 상태 검증 (`✔ Connected`)
- [x] **4단계** — 접근 범위 확인 (읽기 테스트)
- [x] **5단계** — 쓰기 테스트 (최종 검증)

---

## 0단계 — 설치 전 기존 상태 확인  `[🤖 AI]`

노션이 **로컬 CLI**와 **claude.ai 계정 커넥터** 두 군데에 붙을 수 있어, 먼저 현재 상태를 스냅샷한다.

```bash
claude mcp list 2>&1 | grep -i notion || echo "(notion 항목 없음 = 클린)"
```

**[성공 판정]** 출력을 확인하고 아래 중 어디에 해당하는지 사용자에게 보고:
- `(notion 항목 없음)` → 완전 클린. 바로 1단계로.
- `notion: ... ✔ Connected` → 이미 로컬 설치됨. 재설치 불필요하거나, 재설치하려면 먼저 `claude mcp remove notion -s user`.
- `claude.ai Notion: ...` → claude.ai 계정 커넥터가 별도로 존재. **이건 CLI로 못 지움** (claude.ai 웹/데스크탑앱 → Settings → Connectors에서 관리). 로컬 설치와 이름이 달라 충돌하진 않으니 그대로 1단계 진행 가능.

- [x] 0단계 완료

---

## 1단계 — 설치 명령 실행  `[🤖 AI]`

user scope(모든 프로젝트 공용)로 HTTP 원격 서버를 등록한다.

```bash
claude mcp add --transport http --scope user notion https://mcp.notion.com/mcp
```

> 특정 프로젝트에서만 쓰려면 `--scope user` → `--scope project`.

**[성공 판정]** 출력에 다음이 뜨면 성공:
```
Added HTTP MCP server notion ... to user config
```
확인 명령:
```bash
claude mcp get notion 2>&1
```
→ `Type: http`, `URL: https://mcp.notion.com/mcp`, `Scope: User config` 확인.

- [x] 1단계 완료

---

## 2단계 — OAuth 로그인  `[⏸️ 사람]`

> ⚠️ **AI가 실행하지 말 것.** 브라우저 로그인은 사용자가 직접 해야 함. 아래 안내를 사용자에게 전달하고 **완료 회신을 기다린다.**

사용자에게 요청할 내용:
1. **Claude Code를 재시작** (커넥터 목록 새로고침)
2. Claude Code 안에서 **`/mcp`** 입력 → 목록에서 **notion** 선택 → **Authenticate**
3. 브라우저가 열리면 **노션 로그인 → 워크스페이스 선택**
4. **접근 범위 선택 화면**에서 MCP에 줄 페이지 선택 (→ 4단계 개념 참고)
5. 승인 후 자동으로 Claude Code로 복귀

**[성공 판정]** 사용자가 "로그인 완료"를 회신하면 3단계로.

- [x] 2단계 완료

---

## 3단계 — 연결 상태 검증  `[🤖 AI]`

```bash
claude mcp list 2>&1 | grep -i "notion"
```

**[성공 판정]**
```
notion: https://mcp.notion.com/mcp (HTTP) - ✔ Connected
```
- `✔ Connected` → 성공.
- `! Needs authentication` → 2단계 재시도 (Authenticate 미완료).
- `✘ Failed to connect` → 문제 해결 표 참조.

- [x] 3단계 완료

---

## 4단계 — 접근 범위 확인 (읽기 테스트)  `[🤖 AI]`

> **개념**: 페이지마다 연동을 붙이는 게 아니라, **2단계 OAuth 때 고른 페이지(+그 하위 자동 상속)** 안에서만 읽고 쓸 수 있다. 권한 상한은 "사용자 계정이 볼 수 있는 범위".

노션 검색 도구로 실제 접근 가능한 페이지가 잡히는지 확인한다.

```
mcp__notion__notion-search 도구로 임의 키워드(예: 워크스페이스 대표 페이지명) 검색
```

**[성공 판정]** 검색 결과로 페이지가 반환되면 접근 범위 정상. 결과가 비면 → OAuth 때 페이지를 안 골랐을 수 있음. 아래 "범위 추가" 참조.

**범위 추가 방법** (이미 연결된 상태에서 페이지 더 주기):
- 노션 **설정 → 해당 연결(integration)의 Access 탭**에서 페이지 추가, 또는
- 대상 페이지에서 `⋯ → Connect to integration`

- [x] 4단계 완료

---

## 5단계 — 쓰기 테스트 (최종 검증)  `[🤖 AI + ⏸️ 사람]`

> 실제 페이지에 쓰는 작업이므로, **어느 페이지에 테스트할지 사용자에게 먼저 확인**받고 진행.

1. 사용자에게 테스트용 페이지(또는 새 페이지 생성 허용) 확인
2. `mcp__notion__notion-create-pages` 또는 기존 페이지에 블록 추가로 "MCP 테스트" 한 줄 작성
3. 노션 앱에서 반영됐는지 사용자에게 확인 요청

**[성공 판정]** 노션에 테스트 내용이 실제로 보이면 **설치 전체 검증 완료** 🎉

- [x] 5단계 완료

---

## 🔧 문제 해결

| 증상 | 원인 / 해결 |
|---|---|
| `! Needs authentication` | 2단계 미완료 → `/mcp` → notion → Authenticate 다시 |
| `✘ Failed to connect` | 인증 만료·해제 상태 → Authenticate 재시도. claude.ai 커넥터를 지운 잔재면 **Claude Code 재시작**으로 목록에서 사라짐 |
| `claude mcp list`에 안 뜸 | Claude Code 재시작 후 재확인 |
| 특정 페이지에 쓰기 안 됨 | 그 페이지가 접근 범위 **밖** → 4단계 "범위 추가" |
| `claude.ai Notion` 항목이 계속 보임 | 로컬 CLI로 못 지움. claude.ai 웹/데스크탑앱 → Settings → Connectors에서 해제 후 Claude Code 재시작 |
| 재설치하려는데 이미 있음 | `claude mcp remove notion -s user` 후 1단계부터 |

---

## 📌 한눈 요약

| 구분 | 명령 / 액션 |
|---|---|
| 설치 | `claude mcp add --transport http --scope user notion https://mcp.notion.com/mcp` |
| 로그인 | 재시작 → `/mcp` → notion → Authenticate → 페이지 선택 |
| 확인 | `claude mcp list` → `✔ Connected` |
| 제거 | `claude mcp remove notion -s user` (계정 커넥터는 claude.ai 설정에서) |

**핵심**: 페이지마다 연동 붙일 필요 X. OAuth 연결 때 부모 페이지 주면 하위는 자동 상속. 나중에 필요하면 Access 탭에서 추가.
