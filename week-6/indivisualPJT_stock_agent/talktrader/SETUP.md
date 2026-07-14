# 🔑 발급 가이드 — KIS 모의 앱키 & 텔레그램 봇 (초보용)

> 이 문서대로 따라 하면 `talktrader/.env` 를 채울 값(**KIS 모의 앱키·시크릿·계좌번호**, **텔레그램 봇토큰·chat_id**)을 전부 준비할 수 있습니다.
> ⏱️ 예상 소요: KIS 20~40분(심사 대기 포함) + 텔레그램 5분.
> ⚠️ 모든 값은 **비밀**입니다. 절대 코드·깃허브·카톡에 붙여넣지 마세요. `.env` 에만.

---

## Part A. 한국투자증권 KIS **모의투자** 앱키·시크릿 발급

> 핵심 순서: **모의투자 계좌를 먼저 만들고 → 그 계좌번호로 API를 신청**해야 앱키가 나옵니다.
> ⚠️ 실전용 앱키와 **모의용 앱키는 완전히 다릅니다.** 우리는 v1 내내 **모의용**만 씁니다.

### 0단계 — 한국투자증권 회원가입 (HTS ID 확보)
- [ ] 「한국투자」 앱 또는 홈페이지(`securities.koreainvestment.com`)에서 회원가입/로그인.
- KIS Developers의 로그인 **ID는 이 HTS ID와 동일**합니다.
- (실계좌가 없어도 모의투자 신청은 대개 가능하지만, 화면 안내를 따르세요.)

### 1단계 — 모의투자 계좌 신청 (가상계좌)
- [ ] 한국투자 홈페이지/MTS에서 **「모의투자」 서비스 신청** → **모의투자 계좌번호**를 발급받습니다.
- 가상 돈이라 실제 입금은 필요 없습니다. 이 계좌번호를 메모해 두세요(예: `50123456-01`).

### 2단계 — KIS Developers 접속 & 서비스 신청
- [ ] `https://apiportal.koreainvestment.com` 접속 → **「KIS Developers 서비스 신청하기」** 클릭.

### 3단계 — 모의투자계좌 선택 후 신청
- [ ] 신청 화면에서 **계좌 구분을 「모의투자계좌」로 선택** → 1단계에서 받은 **모의 계좌번호 입력**.
- [ ] 신청 버튼 → (홈페이지 로그인과 같은 방식으로) **인증 팝업**에서 인증.
- 모의투자계좌는 최대 2개까지 신청할 수 있습니다.

### 4단계 — 앱키 / 앱시크릿 발급 확인
- [ ] 인증 완료 메시지가 뜨면, 해당 계좌로 **App Key / App Secret 발급 완료**.
- [ ] 카카오톡 알림톡/문자로 **신청완료 안내 + KIS Developers 초기 비밀번호**가 옵니다.
- [ ] 임시비밀번호로 KIS Developers 로그인(ID = HTS ID) → **App Key / App Secret 복사**.

### 5단계 — `.env` 에 넣기
```
KIS_APP_KEY=여기에_모의용_앱키
KIS_APP_SECRET=여기에_모의용_앱시크릿
KIS_ACCOUNT_NO=50123456-01     # 모의 계좌번호 (앞 8자리-뒤 2자리)
IS_REAL=false                  # ⚠️ 반드시 false (모의). 우리 settings가 모의 도메인을 자동 선택
```
> 우리 `config/settings.py` 는 `IS_REAL=false` 면 모의 도메인(`openapivts.koreainvestment.com:29443`)을 자동으로 씁니다. **키가 모의용인데 IS_REAL=true면 인증 실패**하니 짝을 맞추세요.

---

## Part B. 텔레그램 봇 만들기 (토큰 + chat_id)

### 1단계 — BotFather 찾기
- [ ] 텔레그램 앱에서 **`@BotFather`** 검색 → 이름 옆 **파란 인증 배지** 있는 공식 계정 선택 → `/start`.

### 2단계 — 새 봇 생성
- [ ] `/newbot` 입력 → 안내에 따라:
  1. **봇 표시 이름**(아무거나, 예: 톡트레이더)
  2. **봇 username**(반드시 `bot` 으로 끝나고 전 세계에서 고유해야 함, 예: `my_talktrader_bot`)
- [ ] 성공하면 **HTTP API 토큰**을 줍니다. 형태: `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxx`

### 3단계 — 토큰을 `.env` 에
```
TELEGRAM_BOT_TOKEN=123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 4단계 — 내 chat_id 알아내기
- [ ] 방금 만든 **내 봇과의 대화창을 열고 아무 메시지나 전송**(예: `안녕`). ← 이걸 먼저 안 하면 다음 단계가 빈 값으로 나옵니다.
- [ ] 웹브라우저 주소창에 아래를 열기 (`<토큰>` 을 내 토큰으로 교체):
  ```
  https://api.telegram.org/bot<토큰>/getUpdates
  ```
- [ ] 나온 JSON에서 **`"chat":{"id":숫자`** 의 숫자가 내 chat_id 입니다.
- [ ] `.env` 에 넣기:
```
TELEGRAM_CHAT_ID=숫자
```
> 💡 안 나오면: (1) 봇에게 메시지를 먼저 보냈는지 (2) 토큰 오타 확인 후 페이지 새로고침. 대안: `@userinfobot` 에게 말 걸면 내 숫자 ID를 알려줍니다(개인 채팅이면 chat_id = 내 user id).

### 5단계 — 보안
- 토큰이 유출되면 **누구나 내 봇을 조종**할 수 있습니다. 실수로 노출됐다면 BotFather에서 `/revoke` → 새 토큰 재발급.

---

## Part C. `.env` 완성하고 확인하기

1. `talktrader` 폴더에서 견본 복사:
   - Windows(파워셸/cmd): `copy .env.example .env`
   - Git Bash: `cp .env.example .env`
2. `.env` 를 열어 위에서 받은 값들을 채웁니다.
3. (아직 안 했다면) 의존성 설치: `pip install -r requirements.txt`
4. 확인 실행:
   ```
   python main.py
   ```
   - 아래 문구가 나오면 **성공** → 다음은 Phase 1(인증):
     ```
     ✅ 모든 비밀값이 채워져 있습니다. Phase 1(인증)로 진행 가능!
     ✅ 설정 로드 완료 (모의모드)
     ```

---

## ⚠️ 자주 나는 문제

| 증상 | 원인 / 해결 |
|---|---|
| Phase 1에서 토큰 발급 **401/403** | ① 모의/실전 키 혼동 ② `IS_REAL` 값과 키 종류 불일치 ③ 접속 IP 미등록 → 이 3가지부터 점검 |
| getUpdates 결과가 **빈 배열** | 봇에게 메시지를 **먼저** 안 보냄 → 보내고 새로고침 |
| 앱키 발급 화면이 안 뜸 | **모의투자 계좌를 먼저** 신청했는지 확인(Part A 1단계) |
| 계좌번호 형식 오류 | 앞 8자리-뒤 2자리 형태(`50123456-01`)인지 확인 |
| `.env` 가 git에 올라갈까 걱정 | 이미 `.gitignore` 처리됨(검증 완료). 그래도 `git status` 에 `.env` 안 보이는지 확인 |

## 🔒 보안 체크 (커밋 전 습관)
- [ ] `.env` 는 절대 커밋 안 함 (이미 무시됨)
- [ ] 앱키·시크릿·봇토큰을 채팅/문서/스크린샷에 노출 안 함
- [ ] 유출 시 즉시 재발급 (KIS: 앱키 재발급 / 텔레그램: `/revoke`)

---

### 출처 (공식)
- [KIS Developers 개발자센터](https://apiportal.koreainvestment.com/intro) · [오픈API 서비스 신청](https://apiportal.koreainvestment.com/apiservice)
- [한국투자증권 공식 오픈API GitHub(예제)](https://github.com/koreainvestment/open-trading-api)
- 텔레그램 봇: 앱 내 `@BotFather` (별도 가입 불필요)

> 화면 구성은 업데이트로 바뀔 수 있습니다. 문구가 다르면 "모의투자/서비스 신청/App Key" 키워드로 찾으세요.
