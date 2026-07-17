# 🧺 남김없이

> **장 본 것부터 다 먹는 것까지 — 냉장고 재료를 남김없이 소진해 음식물 쓰레기와 식비를 함께 줄여주는 앱**

🔗 **[nowaste-app-seven.vercel.app](https://nowaste-app-seven.vercel.app)** (웹 베타 · 폰 브라우저 권장)

---

## 이런 앱이에요

싸다고 왕창 사서 냉장고 뒤에서 썩혀 버리는 재료 — 문제의 뿌리는 '깜빡함'이 아니라 **관리가 귀찮다**는 거예요. 그래서 **입력을 최대한 편하게** 만들고, 있는 재료로 **뭘 해 먹을지**까지 이어줍니다.

## 주요 기능

| 기능 | 설명 |
|------|------|
| 📷 **사진으로 담기** | 라벨을 찍으면 AI가 제품명·용량·유통기한을 읽어 자동 입력 (연도 없는 도장도 추론) |
| 🥬 **재료로 담기** | 라벨 없는 신선식품은 재료 + 보관방법(냉장/냉동/실온/그늘) 두 번 탭이면 유통기한 자동 계산 |
| 🔴 **유통기한 관리** | 임박 재료를 색으로 알려주고, **냉동실로 옮기면** 기한을 연장 (얼리면 안 되는 재료는 막아줌) |
| 🥘 **레시피 추천** | 지금 있는 재료(+남은 음식·김치·잡채까지)로 만들 요리 제안. **먹고 싶은 음식 직접 입력**도 가능. 인분 선택 시 재료 양이 비례 |
| 🛒 **멀티 마켓 주문** | 부족한 재료를 쿠팡·마켓컬리·이마트몰·네이버쇼핑에서 **직접 비교**해 주문. 미리 주문한 재료('곧 도착')도 레시피에 반영 |
| 📊 **절감 리포트** | 버린 재료의 금액과 월별 추이 — "식비 10~20% 절감" 목표를 눈으로 |

## 사용법 (사용자)

1. **가입** — 이메일·비밀번호로 시작
2. **담기** — 장 봐온 걸 넣어요
   - 라벨 있는 것 → 📷 **사진으로 담기** (찍기만 하고 확인은 나중에)
   - 라벨 없는 것 → 🥬 **재료로 담기** (재료 고르고 보관방법 탭)
3. **확인** — 정리 끝나고 앉아서, 사진에서 읽은 값이 맞는지 카드로 확인 (틀리면 그 자리서 수정)
4. **요리** — 급한 재료부터 쓰는 레시피 추천. 원하는 음식은 직접 입력
5. **주문** — 부족한 재료는 마켓 비교해서 주문, '주문했어요' 누르면 '곧 도착'으로 추적
6. **정리** — 다 먹으면 "다 먹었어요", 버리면 "버렸어요" → 리포트에 반영

> 💡 폰 브라우저에서 **홈 화면에 추가**하면 앱처럼 쓸 수 있어요. 사진 촬영은 HTTPS(배포 주소)에서만 됩니다.

---

## 개발자 가이드

### 기술 스택
- **프론트**: `index.html` 한 파일 (React 18 CDN + Tailwind CDN, 빌드 없음)
- **백엔드**: `server.js` (Express + `pg`) — API·인증·정적 서빙·외부 API 프록시
- **DB**: Supabase PostgreSQL (순수 DB로만 사용, `pg` 직접 연결)
- **AI**: OpenAI `gpt-4o-mini` — 라벨 OCR(비전) + 레시피 생성
- **배포**: Vercel (Express 자동감지)

> 프론트는 DB를 모르고 `/api/*`만 호출해요. 인증은 직접 구현(bcryptjs + JWT), Supabase Auth·anon key·Edge Function은 쓰지 않습니다.

### 로컬 실행

```bash
npm install

# .env 준비 (.env.example 참고, git 커밋 금지)
#   SUPABASE_DB_URL=postgresql://...   # Supabase → Connect
#   JWT_SECRET=...                     # npm run secret 이 생성
#   OPEN_AI_API=sk-...                 # platform.openai.com
npm run secret          # JWT_SECRET 없으면 생성
npm run migrate         # 테이블 생성 (여러 번 돌려도 안전)

npm start               # → http://localhost:3000
```

> ⚠️ **`node server.js`로 띄우세요.** Live Server나 `npx serve`로 `index.html`을 열면 `/api/*`가 전부 404입니다.

### 환경변수

| 변수 | 필수 | 설명 |
|------|:---:|------|
| `SUPABASE_DB_URL` | ✅ | Supabase Postgres 연결 문자열 (Direct 안 되면 pooler 6543) |
| `JWT_SECRET` | ✅ | JWT 서명 키 (`npm run secret`) |
| `OPEN_AI_API` | ✅ | OpenAI 키 (OCR + 레시피) |
| `NAVER_CLIENT_ID` / `NAVER_CLIENT_SECRET` | ⬜ | 구매 시트의 네이버 참고 최저가 (없으면 딥링크만) |

### 배포 (Vercel)

```bash
vercel link           # 최초 1회
# Vercel 대시보드/CLI로 위 환경변수 3개 설정 (production)
vercel --prod
```

### 검증 스크립트

```bash
npm run smoke          # 보안·CRUD·날짜 등 API 35건 (실제 DB)
node scripts/test-features.js   # 단위·주문분·인분·음식명 레시피
node scripts/test-leftover.js   # 남은 음식·김치 반영
node scripts/test-back.js       # 폰 뒤로가기 (playwright-core 필요)
```

### 프로젝트 문서

| 문서 | 내용 |
|------|------|
| [MISSION.md](MISSION.md) | 제품 비전·타깃·성공 지표 |
| [DEV.md](DEV.md) | 개발 가이드·API·데이터 모델·함정 모음 |
| [STRATEGY.md](STRATEGY.md) | 사업 전략·방어 설계 (플랫폼 중립성 해자) |
| [COST.md](COST.md) | OCR·레시피 LLM 운영비 산출 |
| [MARKETPLACES.md](MARKETPLACES.md) | 멀티 마켓 제휴 수익 조사 |

### 폴더 구조

```
├── index.html      # 앱 본체 (React CDN + Tailwind CDN, /api/*만 호출)
├── server.js       # Express + pg · API · 인증 · 정적 서빙
├── db.js           # pg Pool
├── ocr.js          # 라벨 OCR (GPT-4o-mini 비전)
├── recipes.js      # 레시피 하이브리드 엔진 (캐시 + LLM)
├── schema.sql      # fridge_ 테이블 + 보관기간 프리셋
├── scripts/        # migrate · 검증 · 정리 스크립트
└── *.md            # 문서
```
