# DEV.md - 개발 가이드

> **남김없이** — 장 보는 순간부터 다 먹는 순간까지, 집에 있는 식자재를 남김없이 소진하도록 도와 음식물 쓰레기와 식비를 함께 줄여주는 앱.
> **Architecture: Supabase(PostgreSQL) + `server.js`(Express + pg) 하이브리드 웹앱.** 입력은 **OCR 우선**. 궁극적으로 Capacitor로 감싸 안드로이드 앱으로 배포(Phase 5).

---

## Requirements

- [ ] **찍어두고 나중에 확인 (Capture → Confirm)** — 장 본 직후엔 **사진만 찍고**(서서, 30초), 정리 끝나고 **앉아서 한꺼번에 확인·수정**. 이 앱의 심장
- [ ] **OCR로 라벨 읽기** — 포장/라벨 사진에서 **제품명·용량·유통기한**을 추출
- [ ] **라벨 없는 신선식품** — 재료 선택 + **보관방법 아이콘 탭**(냉장/냉동/실온/실온그늘) → 구매일 기준 **권장 유효기간 자동 부여**
- [ ] **유통기한 관리 + 냉동 전환** — 임박 재료 알림 + 냉동으로 옮기면 기한 재계산
- [ ] **보유 재고 기반 레시피 추천** — 지금 있는 재료로 만들 요리 제안 (아이들용·건강식 등 옵션)
- [ ] **부족 재료 구매 링크** — 쿠팡으로 바로 주문 (v1은 검색 URL, 파트너스는 배포 후)
- [ ] **용량(g/ml) 기반 잔량 자동 차감** — 레시피에 쓴 만큼 재고 차감
- [ ] **소진·폐기 기록** — "다 먹음 / 버림(얼마나)". ⚠️ 이게 있어야 **"식비 10~20% 절감"을 측정**할 수 있고, 장기적으로 이 앱의 **유일한 방어 자산**이 된다 ([STRATEGY.md](STRATEGY.md))
- [ ] **계정 + 여러 기기 동기화**

**핵심 설계 기준선: 장 본 뒤 촬영에 30초** (장바구니 한 건 전체). 확인 단계는 시간 제약에서 제외 — 앉아서 편하게 하는 작업이므로.

**관련 문서:** [MISSION.md](MISSION.md) (제품 비전) · [STRATEGY.md](STRATEGY.md) (사업 전략·방어 설계)

## Non-goals (v1에서 하지 않을 것)

- **수기 입력·음성 입력 중심 UX** — 예외 상황의 최소 보조 수단으로만
- **B2B(급식·음식점) 기능** — 대량 수량, 원가·마진, HACCP 제외
- **범용 가계부** — 카드내역 연동·전체 소비 분석 제외
- **레시피 커뮤니티/SNS** — 공유·댓글·팔로우 제외
- **바코드 스캔** — v1에서는 **선택적 보조**로 강등 (이유는 Open Questions 참고). OCR이 충분하면 아예 넣지 않는다

## Style

- **모바일 세로 화면 우선.** 한 손 조작, 큰 터치 타깃, 큰 글씨.
- **촬영은 연속으로.** 찍고-찍고-찍고가 끊기지 않아야 한다. 장바구니 앞에서 멈칫하면 실패.
- **확인은 카드 넘기듯.** 사진 + 읽어낸 값을 나란히, 틀리면 그 자리에서 고치고 다음.
- **유통기한 임박은 색으로 즉시 인지** (빨강=임박, 노랑=주의, 초록=여유).
- **보관방법은 아이콘으로** 🧊냉동 ❄️냉장 🌡️실온 🌥️실온+그늘 — 탭 한 번.

## Key Concepts

- **Capture → Confirm (담기 → 확인):** 입력을 **두 단계로 쪼갠다.** ①장 본 직후: 사진만 빠르게(서서, 30초). ②나중에: 앉아서 확인·수정. 정리하는 동안 **백그라운드로 OCR**이 돌아가므로 확인 시점엔 이미 다 읽혀 있다. 이 분리가 30초 목표를 달성하는 유일한 현실적 방법이다.
- **보관방법이 유통기한을 결정한다:** `구매일 + 재료 + 보관방법 → 예상 유통기한`. 라벨 없는 신선식품의 기한을 이걸로 부여하고, **'냉동 전환'도 같은 공식으로 재계산**한다. 두 기능이 하나의 모델을 공유한다.
- **제품명 vs 재료명:** `name`(제품명, "서울우유 1A 흰우유 1L")과 `ingredient`(재료명, "우유")를 **분리**한다. 레시피 매칭과 보관기간 프리셋 조회는 `ingredient`로 한다. → OCR이 제품명을 좀 뭉개도 앱은 동작한다.
- **선순환(플라이휠):** 재료를 다 소진하도록 도와 → 부족분을 앱에서 사게 되고 → 그게 수익(쿠팡파트너스)이 된다. 사용자의 절약과 앱의 수익이 같은 고리에서 돈다.

## Open Questions

### ✅ 조사 완료 (2026-07) — MISSION의 가정 셋이 깨졌다

**1. "바코드 스캔으로 유통기한 자동 입력" — 원리적으로 불가능.**
바코드(GTIN)는 **"무슨 상품인지"만 식별**한다. "이 봉지가 언제까지인지"는 개별 포장에 인쇄되는 값이라 바코드에 없다. 공공 API의 `POG_DAYCNT`도 만료일이 아니라 소비기한 **"일수"**다.

**2. 바코드 API는 정작 잘 썩는 것을 못 잡는다.**
양파·대파·돼지고기 등 마트 소분품은 **매장 자체 바코드**라 공공 DB에 없다. 게다가 공공 바코드 API(15060549, 15064775)는 **2018년 이후 갱신 중단**이고 **용량 필드도 없다**. → **그래서 바코드를 주 경로에서 내리고 OCR을 주 경로로 올린다.** 포장·라벨에는 제품명·용량·유통기한이 **전부 글자로 인쇄**돼 있다.

**3. 쿠팡파트너스는 앱이 먼저 있어야 신청된다.**
운영 중인 사이트/앱을 등록해야 심사가 진행된다. → **순서:** 앱 배포 → 그 URL로 신청 → 승인 후 딥링크. **v1은 파트너스 없이 쿠팡 검색 URL**(`https://www.coupang.com/np/search?q=<재료명>`)로 가면 기능은 100% 동작한다. 수익만 나중에.

### 아직 열려 있는 질문

- **Tesseract.js의 한글 정확도가 쓸 만한가?** 한글이 약한 것으로 알려져 있다. 다만 우리가 꼭 필요한 건 **날짜(숫자)** 라서 해볼 만하다. → Phase 3에서 실제 라벨 10장으로 측정. 안 되면 **CLOVA OCR**(유료·정확)로 교체, 궁극적으로는 **Capacitor 온디바이스 OCR**(무료·정확).
- **유통기한 표기가 제각각이다.** `2026.08.15` / `26.08.15` / `20260815` / `상단 표기` / 제조일만 있는 것. → 정규식으로 여러 패턴을 잡고, **여러 날짜가 나오면 가장 가까운 미래 날짜**를 고른 뒤 확인 단계에서 사용자가 검증. (사용자 승인 완료)
- **미확인 항목이 쌓여 방치되지 않을까?** → 홈에 "확인 대기 N건" 배지 + 유통기한 알림으로 넛지. Phase 4에서 관찰.
- 가정에서 **버리는 재료의 금액 baseline** 측정 필요.

---

## 선택된 개발 구조

**왜 이 구조인가:** 개발자가 **여러 번 만들어봐서 직관적으로 이해하는 구조**여야 혼자 유지보수할 수 있다. 그래서 Supabase의 서비스층(PostgREST/Auth/Edge Function)을 쓰지 않고, **Supabase는 순수 Postgres DB로만 쓰고 `server.js`가 모든 것을 중개**한다.

**구성 요소**
- **DB:** Supabase PostgreSQL. **Direct 연결 문자열**로 `pg`가 직접 접속. 모든 테이블에 `fridge_` prefix.
- **Backend:** `server.js` (Express + pg). API + 정적 서빙 + DB 접근 전담 + 외부 API 프록시(비밀 키 보관).
- **Auth:** `server.js`가 직접 구현. `bcryptjs` 해시 + `jsonwebtoken` JWT.
- **Frontend:** `index.html` (React 18 CDN + Tailwind CDN). DB에 직접 붙지 않고 **오직 `/api/*`만 호출**.
- **OCR:** v1은 **Tesseract.js**(브라우저 내장, 무료, 키 불필요). 정확도 부족 시 CLOVA OCR로 교체.

**anon key는 쓰지 않는다.** supabase-js를 안 쓰기 때문. 열쇠는 **DB 연결 문자열**이다.

⚠️ **이 선택의 대가 — 보안 경계가 RLS가 아니라 내 코드다.**
Direct 연결은 `postgres` 역할로 붙으므로 **RLS를 그냥 통과한다.** DB가 지켜주지 않는다. **`server.js`의 모든 쿼리가 `WHERE user_id = $1`을 반드시 포함**해야 하고, 한 군데라도 빠뜨리면 그 엔드포인트에서 남의 냉장고가 통째로 샌다. → Phase 2.5에서 실제로 검증한다.

✅ **대신 얻는 것:** Edge Function / Deno / `supabase` CLI가 **통째로 불필요**해진다. 쿠팡 HMAC 서명도 `server.js`가 하면 끝이다.

## 입력 흐름 설계 (이 앱의 핵심)

```
━━━ 장 본 직후 — 서서, 30초 ━━━━━━━━━━━━━━━━━━━━━━━━━
  라벨 있는 것 (공산품·마트 소분품)
      → 📷 찰칵 (사진만. 확인 안 함)

  라벨 없는 것 (과일·채소 등)
      → 재료 탭 + 보관방법 아이콘 탭  🧊 ❄️ 🌡️ 🌥️
      → 구매일(오늘) + 프리셋으로 유통기한 자동 부여

           ↓ (정리하는 동안 백그라운드에서 OCR 처리)

━━━ 나중에 — 앉아서, 편하게 ━━━━━━━━━━━━━━━━━━━━━━━
  "확인 대기 8건"  → 카드 넘기며 확인
      · 날짜 읽힘  → 그대로 확인 ✓
      · 못 읽음    → 프리셋 추정값 제시 → 확인 or 수정
      · 제품명 이상 → 그 자리에서 수정
  → 확정되면 재고에 편입
```

**왜 이렇게 쪼개는가:** 냉장고 앞에 서서 하나씩 확인하는 건 손도 마음도 바쁘다. 찍기와 확인을 분리하면 각자 편한 자리로 간다. 덤으로 **OCR 처리 시간을 벌 수 있어** Tesseract.js가 느린 게 문제가 안 된다.

## 프로젝트 구조

```
indivisual PJT/
├── prototype-v1.html      # Phase 1 산출물 (더미 데이터, 서버 없이 브라우저로 열기)
├── index.html             # Phase 2에서 전환. React 18 CDN + Tailwind CDN. /api/*만 호출
├── server.js              # Express + pg. API · 정적 서빙 · 인증 · 라벨 파싱 · 외부 API
├── schema.sql             # fridge_ 테이블 DDL + 보관기간 프리셋 시드
├── package.json
├── .env                   # ⚠️ DB_URL, JWT_SECRET. git 제외 + 정적 서빙 차단 필수
└── .gitignore
```

## API 설계 (server.js)

프론트는 DB를 모른다. 오직 아래 엔드포인트만 안다.

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/api/auth/signup` | 회원가입 (bcrypt 해시) |
| POST | `/api/auth/login` | 로그인 → JWT 발급 |
| POST | `/api/label/parse` | **OCR 원문 텍스트 → 제품명·용량·유통기한 구조화** (핵심) |
| GET | `/api/items?status=pending` | 확인 대기 목록 |
| POST | `/api/items` | 재고 추가 (촬영 직후엔 `status=pending`) |
| PATCH | `/api/items/:id` | 수정 · 확인(`status=confirmed`) · 냉동 전환 · 잔량 차감 |
| POST | `/api/items/:id/close` | **소진·폐기 처리** — `outcome`(먹음/버림) + `closed_on` + `discarded_amount` |
| DELETE | `/api/items/:id` | 삭제 |
| GET | `/api/shelf-life?ingredient=양파&storage=room_shade` | 권장 보관일수 조회 |
| GET | `/api/stats/waste?months=6` | **월별 폐기 금액·절감 추이** — MISSION 성공 지표 측정 |
| POST | `/api/recipes/suggest` | 보유 재고 기반 레시피 추천 |
| POST | `/api/coupang/link` | 구매 링크 생성. **v1: 쿠팡 검색 URL** → 승인 후 딥링크로 교체 |

**OCR 엔진을 바꿔도 프론트는 안 바뀐다.** `/api/label/parse`가 텍스트를 받아 구조화하므로, OCR을 Tesseract.js → CLOVA → ML Kit으로 갈아타도 **파싱 로직과 응답 형태는 그대로**다.

**모든 `/api/items*`·`/api/recipes*`는 JWT를 검증하고 쿼리에 `WHERE user_id = $1`을 붙인다. 예외 없음.**

## 데이터 모델

모든 테이블에 **`fridge_` prefix** (이유는 함정 1)

**`fridge_users`** — 계정 (Supabase Auth를 안 쓰므로 직접 만든다)

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | uuid (PK) | |
| email | text UNIQUE | 로그인 ID |
| password_hash | text | bcryptjs 해시 (평문 금지) |
| created_at | timestamptz | |

**`fridge_items`** — 재고 항목

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | uuid (PK) | |
| user_id | uuid FK → fridge_users | **모든 쿼리의 필수 조건** |
| name | text | 제품명 ("서울우유 1A 흰우유 1L") |
| ingredient | text | **재료명** ("우유") — 레시피 매칭·프리셋 조회용 |
| capacity | numeric | 총 용량 (g/ml) |
| remaining | numeric | 잔량 (g/ml) |
| unit | text | `g` / `ml` / `개` |
| **price** | **int** | **구매가(원). ⚠️ 이게 없으면 "식비 10~20% 절감"을 측정조차 못 한다** |
| purchased_on | date | 구매일 — 프리셋 기한 계산의 기준 |
| expiry_date | date | 유통기한 (⚠️ `toISOString()` 금지 — 함정 6) |
| expiry_source | text | `ocr` / `preset` / `manual` — 어디서 온 값인지 |
| storage | text | `fridge` / `freezer` / `room` / `room_shade` |
| status | text | **`pending`(확인 대기) / `confirmed`(확정)** |
| **closed_on** | **date** | **소진·폐기일.** 소비 속도의 원천 (`purchased_on` → `closed_on`) |
| **outcome** | **text** | **`eaten`(다 먹음) / `discarded`(버림) / null(보유 중)** |
| **discarded_amount** | **numeric** | **버린 양(g/ml).** 폐기 금액 = `price × discarded_amount / capacity` |
| ocr_text | text | OCR 원문 (확인 화면에서 대조용), nullable |
| created_at | timestamptz | |

> ⚠️ **`price` · `closed_on` · `outcome` · `discarded_amount`는 지금 넣어야 한다.**
> MISSION의 성공 지표("월 식비 10~20% 절감")를 측정하는 유일한 근거이고, 나중에 추가하면 **과거 데이터가 없어 무용지물**이다. 자세한 이유는 [STRATEGY.md](STRATEGY.md) 참고.

**`fridge_shelf_life`** — 보관기간 프리셋 (전역 공유, `user_id` 없음)

| 컬럼 | 타입 | 설명 |
|------|------|------|
| ingredient | text | 재료명 ("양파") |
| storage | text | 보관방법 |
| days | int | 권장 보관일수 |

> PK: `(ingredient, storage)`. 흔한 재료 30~50개로 시작하면 충분하다.
> 예: 양파+`room_shade` 60일 / 양파+`fridge` 30일 / 대파+`fridge` 14일 / 사과+`fridge` 30일 / 돼지고기+`fridge` 3일 / 돼지고기+`freezer` 90일

**유통기한 계산 규칙 (한 곳으로 통일)**
1. OCR로 날짜를 읽었으면 → 그 값 (`expiry_source='ocr'`)
2. 못 읽었거나 라벨이 없으면 → `purchased_on + fridge_shelf_life.days` (`expiry_source='preset'`)
3. 사용자가 확인 단계에서 고치면 → 그 값 (`expiry_source='manual'`)
4. **냉동 전환** = `storage`를 `freezer`로 UPDATE + **같은 프리셋 공식으로 재계산**

## TODO List

> 순서: **디자인 → 기본기능(쉬운 것) → 인프라·보안 검증 → 어려운 기능(불확실한 것) → 마무리 → 앱화·수익화**

### Phase 1: 디자인 & 프로토타이핑
- [ ] 🟢 UI 프로토타입 — `prototype-v1.html` (React 18 CDN + Tailwind CDN, **더미 데이터**, 서버·DB 없이 브라우저로 직접 열기)
  - 화면: **촬영 화면(연속 촬영)**, **확인 대기 목록**, **확인 카드(사진+읽은 값)**, 재고 리스트(냉장/냉동/실온 탭), 유통기한 임박, 레시피 추천, 부족 재료 주문, 하단 네비
  - **라벨 없는 신선식품 입력**: 재료 선택 + 보관방법 아이콘 4종
- 📌 **체크포인트:** 더미 데이터로 **"찍기 → 확인"** 두 단계 흐름이 눈에 보이고 손으로 넘어간다.
- 📌 `git commit`

### Phase 2: 기본 기능 (쉬운 것부터)
- [ ] 🟢 프로젝트 초기화 — `express` `pg` `dotenv` `bcryptjs` `jsonwebtoken` 설치
- [ ] 🟡 **DB 연결 뚫기** — Supabase 프로젝트 생성 → `.env`의 `DB_URL` → `pg` Pool 연결 확인 (⚠️ 함정 4·5)
- [ ] 🟢 `schema.sql` — `fridge_users`, `fridge_items`, `fridge_shelf_life` 생성 + **프리셋 시드 데이터 30~50건**
- [ ] 🟢 `prototype-v1.html` → `index.html` 전환 + `server.js` 정적 서빙 (⚠️ `.env` 노출 차단 — 함정 3)
- [ ] 🟡 회원가입/로그인 — bcrypt + JWT
- [ ] 🟡 재고 CRUD — `/api/items` (**수동 입력 폼**으로 먼저). 모든 쿼리에 `WHERE user_id = $1`
- [ ] 🟡 **라벨 없는 신선식품 입력** — 재료 + 보관방법 아이콘 → `/api/shelf-life`로 기한 자동 계산 (OCR 없이 동작하는 완결된 경로!)
- [ ] 🟡 유통기한 임박 표시 + 보관위치 필터 + 냉동 전환(기한 재계산)
- [ ] 🟢 **소진·폐기 기록** — `/api/items/:id/close`로 "다 먹음 / 버림(얼마나)" 기록. ⚠️ **이 데이터가 없으면 "식비 절감"을 측정할 수 없다** ([STRATEGY.md](STRATEGY.md))
- 📌 **체크포인트:** `node server.js`로 띄워 로그인 → **신선식품을 아이콘 두 번 탭으로 등록** → 유통기한이 자동으로 잡힌다. (OCR 없이도 앱이 쓸모 있다)
- 📌 `git commit`

### Phase 2.5: 인프라 · 보안 검증 (필수)
- [ ] 🔴 **소유권 검증** — 계정 A의 재고를 **계정 B 토큰으로** 조회·수정·삭제 시도 → 전부 막히는지 확인. ⚠️ RLS가 안 지켜주므로 `WHERE user_id` 빠진 엔드포인트 하나면 전면 유출
- [ ] 🔴 **`.env` 노출 차단** — 브라우저에서 `GET /.env` → **404여야 함** (200이면 DB 비번·JWT 시크릿 유출)
- [ ] 🟡 JWT 검증 미들웨어 — 없음/만료/위조 시 401
- [ ] 🟡 배포 환경(Vercel 등)에서 DB 연결 확인
- 📌 **체크포인트:** 남의 데이터 접근이 실제로 차단되고, `.env`가 안 보이고, 배포 환경에서도 DB가 붙는다.
- 📌 `git commit`

### Phase 3: 핵심 & 어려운 기능 (불확실한 것부터)
- [ ] 🔴 **OCR 정확도 실측** (가장 불확실 — 앱의 성패가 여기 달렸다)
  - `Tesseract.js`(CDN)로 브라우저에서 라벨 사진 → 텍스트 추출
  - **실제 라벨 10장으로 측정** (공산품 5 + 마트 소분품 5). 재는 것: ①**날짜**를 뽑아내는가 ②용량을 뽑아내는가 ③제품명이 알아볼 만한가
  - ⚠️ **실패 시 우회 순서:** (1) 날짜만이라도 건지고 제품명은 사용자 입력 → (2) **CLOVA OCR**(유료·한글 강함)로 교체 → (3) Phase 5의 **Capacitor 온디바이스 OCR**(무료·정확)까지 미룸
  - ⚠️ **최악의 경우에도 앱은 죽지 않는다** — Phase 2의 '재료 + 보관방법' 경로가 이미 완결돼 있으므로
- [ ] 🔴 `/api/label/parse` — OCR 원문에서 **날짜 정규식**(`2026.08.15` / `26.08.15` / `20260815` / `26년 8월 15일`), **용량 정규식**(`500g` `1L` `1.8kg`), 제품명 추정
  - **여러 날짜가 잡히면 가장 가까운 미래 날짜**를 유통기한으로 (제조일과 구분)
- [ ] 🔴 **촬영 → 백그라운드 OCR → 확인 대기 큐** — 연속 촬영, 사진은 IndexedDB에 임시 보관, OCR은 백그라운드, 완료 시 `status=pending`으로 적재
- [ ] 🟡 **확인 화면** — 사진 + 읽어낸 값 나란히, 카드 넘기며 확인/수정 → `status=confirmed`
- [ ] 🟡 **촬영 30초 기준선 실측** — 실제 장바구니로 재본다 (확인 단계 제외)
- [ ] 🟡 보유 재고 기반 레시피 추천 — `ingredient`로 매칭 + 상황별(아이들용/건강식) 필터
- [ ] 🟡 용량 기반 잔량 자동 차감 — 사용량만큼 `remaining` UPDATE
- [ ] 🟢 부족 재료 구매 링크 — **쿠팡 검색 URL 생성**. ⚠️ 링크 생성을 **함수 하나에 가둘 것** (승인 후 딥링크로 교체할 지점)
- [ ] ⬜ (선택) 바코드 스캔 보조 — OCR이 제품명을 못 잡을 때만. 공공 API 커버리지가 나쁘므로 **없어도 무방**
- 📌 **체크포인트:** 촬영 → 백그라운드 OCR → 확인 → 재고 → 레시피 → 구매링크 → 잔량 차감의 **전체 흐름**이 동작.
- 📌 `git commit`

### Phase 4: 마무리 & 배포 (웹)
- [ ] 🟡 UI 폴리싱 + **유통기한 하루 밀림 버그 점검** (함정 6)
- [ ] 🟡 "확인 대기 N건" 배지 + 유통기한 알림 — 미확인 방치 방지
- [ ] 🟡 **절감 리포트 화면** — `/api/stats/waste`로 월별 폐기 금액·절감 추이 (⚠️ SQL 집계는 캐스팅 필수 — 함정 11)
- [ ] 🔴 **개인정보 처리방침 작성 — 영업양도 조항 반드시 포함**. ⚠️ 나중에 넣으면 **전체 사용자 재동의**가 필요하다. 지금 넣으면 0원, 나중엔 딜이 깨진다 ([STRATEGY.md](STRATEGY.md))
- [ ] 🟡 에러 처리 — DB 끊김/auto-pause, OCR 실패, 카메라 권한 거부, 토큰 만료
- [ ] 🟡 웹 배포 (HTTPS 필수 — 카메라 권한 때문) + 모바일 실기기 확인
- 📌 **체크포인트:** 실기기에서 촬영 30초 기준선 통과. **배포 URL 확보** (다음 단계의 전제)

### Phase 5: 앱화 & 수익화 (배포 이후)
- [ ] 🟡 **쿠팡파트너스 가입 신청** — 배포된 앱 URL로. (앱이 있어야 심사 가능)
- [ ] 🟡 승인 후 `/api/coupang/link` 내부를 **딥링크 + HMAC 서명**으로 교체 (시크릿은 `.env`에만). **프론트 수정 없음**
- [ ] 🔴 **Capacitor로 안드로이드 앱 감싸기** — `npx cap add android`. 웹 코드 그대로 사용
- [ ] 🟡 **온디바이스 OCR로 교체** — `@capacitor-community/image-to-text` (iOS Vision / Android ML Kit). **무료·오프라인·한글 정확.** Tesseract.js 정확도 문제가 여기서 해소된다
- [ ] ⬜ iOS 앱 — ⚠️ **맥 + Xcode 필수.** 윈도우에선 빌드 불가. 맥이 생기면 진행
- 📌 **체크포인트:** 스토어에 앱이 올라가고, 링크 클릭이 파트너스 실적으로 잡힌다.

## 외부 설정 필요 항목

### 필수 (Must Have)

| 항목 | 설명 | 획득 방법 |
|------|------|----------|
| `DB_URL` | Supabase Postgres 연결 문자열 | supabase.com → Connect → **Direct connection**. 안 붙으면 pooler로 폴백 (함정 4) |
| `JWT_SECRET` | JWT 서명 키 | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| Tesseract.js | 브라우저 OCR | **CDN. 키·계정·비용 없음.** 바로 시작 가능 |

> **anon key 불필요** (supabase-js 안 씀). **supabase CLI 불필요** (Edge Function 안 씀). **바코드 API 불필요** (OCR 우선으로 전환).

### 정확도 부족 시 (Phase 3 실측 후 판단)

| 항목 | 설명 | 획득 방법 |
|------|------|----------|
| `CLOVA_OCR_URL` / `CLOVA_OCR_SECRET` | 네이버 CLOVA OCR — 한글 정확도 높음 | 네이버 클라우드 플랫폼 가입 → OCR 서비스 신청 (**유료**, 가입 크레딧 있음). `server.js`가 프록시하므로 키 안전 |

### Phase 5 (배포 이후)

| 항목 | 설명 | 획득 방법 |
|------|------|----------|
| `COUPANG_ACCESS_KEY` / `COUPANG_SECRET_KEY` | 파트너스 딥링크 (HMAC) | ⚠️ **앱 URL이 있어야 신청 가능.** partners.coupang.com → 사이트/앱 등록 → 심사 |
| Google Play 개발자 계정 | 안드로이드 배포 | $25 (1회). Android Studio는 **Windows에서 됨** |
| Apple Developer Program | iOS 배포 | $99/년. ⚠️ **맥 + Xcode 필수. 윈도우 불가** |

## ⚠️ 이 스택에서 자주 터지는 함정

1. **테이블명 충돌.** 부트캠프 프로젝트들이 **Supabase DB 하나를 공유**한다. `items`·`users` 같은 범용 이름은 기존 테이블과 충돌하고, `CREATE TABLE IF NOT EXISTS`는 **조용히 스킵**해서 나중에 "컬럼이 없다"는 엉뚱한 에러로 나타난다. → **모든 테이블에 `fridge_` prefix.**

2. **`WHERE user_id` 누락 = 전면 유출.** Direct 연결은 RLS를 통과하므로 **DB가 지켜주지 않는다.** 새 엔드포인트를 만들 때마다 이것부터 확인.

3. **`.env` 정적 노출.** `server.js`가 프로젝트 폴더를 통째로 정적 서빙하면 `GET /.env`로 **DB 비밀번호·JWT 시크릿이 그대로 유출**된다. → 정적 서빙은 **허용 목록(allowlist)** 방식으로. 배포 전 `GET /.env`가 404인지 반드시 확인.

4. **Direct 연결이 안 붙을 수 있다.** `db.<ref>.supabase.co:5432`는 IPv6 전용이라 IPv4 환경에선 실패한다. → 대시보드의 **Session/Transaction pooler** 문자열로 폴백.

5. **비밀번호 특수문자 → 연결 문자열 파싱 깨짐.** `@`, `!` 등이 있으면 `connectionString`이 오파싱된다. → URL을 직접 분해해 `host`/`port`/`user`/`password`/`database`를 **개별 필드로** Pool에 넘긴다. (`28P01`이 나면 비밀번호 값 자체를 의심)

6. **유통기한 하루 밀림.** `expiry_date`를 `toISOString()`으로 다루면 **KST 자정이 UTC 전날로 밀려 하루 어긋난다.** 유통기한 앱에서 이건 치명적. → 서버는 `to_char`로 문자열 반환, 브라우저의 '오늘'은 `Intl.DateTimeFormat`의 `Asia/Seoul`로.

7. **카메라는 HTTPS에서만 열린다.** `getUserMedia`는 `localhost`가 아니면 **HTTPS 필수**. 실기기 테스트 시 http로 배포하면 카메라가 안 켜진다.

8. **Live Server로 열면 API가 404.** `server.js`가 API를 제공하는 하이브리드다. → 반드시 **`node server.js`로 띄우고 그 주소로 접속.**

9. **`@babel/standalone` 최신 버전에서 백지 화면.** CDN 8.x에서 렌더가 안 되는 사례. → **7.x로 pin.**

10. **Supabase 무료 auto-pause.** 미사용 시 프로젝트가 자동 정지되어 연결이 끊긴다. → 대시보드에서 **restore**.

11. **pg 집계 결과는 문자열로 온다.** `SUM`·`AVG`는 문자열, `COUNT`는 bigint로 넘어와서 그대로 쓰면 클라이언트에서 **NaN**이 된다. → SQL에서 캐스팅: `SUM(...)::float8`, `COUNT(*)::int`. 절감 리포트(`/api/stats/waste`) 만들 때 반드시 걸린다.

## 향후 확장 설계

- **프론트는 DB를 모른다.** `index.html`은 `/api/*`만 호출하므로, DB를 바꾸든 OCR 엔진을 바꾸든 **`server.js` 안에서만 고치면 된다.**
- **OCR 엔진 교체 경로:** Tesseract.js(무료, 지금) → CLOVA OCR(유료, 정확) → **Capacitor 온디바이스 OCR(무료, 정확, 오프라인)**. `/api/label/parse`가 텍스트를 받는 구조라 **프론트·파싱 로직은 그대로**.
- **앱화 경로:** Capacitor는 웹앱을 **그대로 감싼다.** 지금 구조를 지키면 나중에 코드 수정 거의 없이 안드로이드 앱이 된다. **지금 결정할 필요 없다.**
- **테이블 네임스페이스:** `fridge_` prefix로 충돌 없이 확장.
- **사용자가 늘면:** 커넥션 풀 한계가 먼저 온다 → pooler 전환 + Pool 크기 조정. 그다음이 인덱스(`fridge_items(user_id, expiry_date)`, `fridge_items(user_id, status)`).
- **B2B(v2):** 급식·음식점은 요구가 달라 v1 스키마를 오염시키지 말고 별도 테이블(`fridge_biz_*`)로.

## 시작하기

```bash
# 0. 프로젝트 폴더로 이동 (폴더명에 공백 — 따옴표 필수)
cd "D:/Boot Camp/week-6/indivisual PJT"

# --- Phase 1: 서버 없이 프로토타입만 ---
start prototype-v1.html

# --- Phase 2: 서버 + DB ---
npm init -y
npm install express pg dotenv bcryptjs jsonwebtoken

# .env 작성 (git 제외!)
#   DB_URL=postgresql://postgres:[비밀번호]@db.[ref].supabase.co:5432/postgres
#   JWT_SECRET=<랜덤 32바이트 hex>

node server.js        # ⚠️ Live Server 말고 반드시 이걸로 (함정 8)
# → http://localhost:3000
```

**지금 당장 하실 일**

1. **supabase.com에서 프로젝트 생성** → Connect → **Direct connection** 문자열 복사 → `.env`의 `DB_URL`
2. 끝. **Tesseract.js는 CDN이라 신청할 게 없고, 바코드 API도 이제 안 씁니다.**

> 쿠팡파트너스·Google Play 계정은 **Phase 5**에서. 앱이 배포되어 URL이 있어야 신청이 된다.
