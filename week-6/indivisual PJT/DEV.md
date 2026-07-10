# DEV.md - 개발 가이드

> **남김없이** — 장 보는 순간부터 다 먹는 순간까지, 집에 있는 식자재를 남김없이 소진하도록 도와 음식물 쓰레기와 식비를 함께 줄여주는 앱.
> **Architecture: Supabase 기반 구조 (Option 2)** — Supabase Auth + PostgreSQL(RLS) + Edge Function 프록시. 사용자별 "내 냉장고" 데이터를 여러 기기에서 동기화.

---

## Requirements

MISSION.md 핵심 기능 5개 + 설계 기준선. v1 완료 시 아래가 모두 동작해야 함.

- [ ] **스캔 기반 원터치 입력** — 바코드/영수증 스캔으로 품목·용량·유통기한을 한 번에 등록 (이 앱의 심장)
- [ ] **유통기한 관리 + 냉동 전환** — 임박 재료 알림 + '냉동실로 옮기기(유통기한 연장)'로 버리기 직전 구제
- [ ] **보유 재고 기반 레시피 추천** — 지금 집에 있는 재료로 만들 요리 제안 (아이들용·건강식 등 상황별)
- [ ] **부족 재료 쿠팡프레시 주문 연동** — 레시피에 부족한 재료를 앱에서 바로 주문 (쿠팡파트너스 수익)
- [ ] **용량(g/ml) 기반 잔량 자동 차감** — 레시피에 쓴 만큼 재고를 실제 용량 단위로 자동 차감
- [ ] **장 본 뒤 입력 30초 이내** — 장바구니 한 건 전체 기준 (품목당 아님). 핵심 설계 기준선
- [ ] **사용자별 계정 + 여러 기기 동기화** — 향후 사용자 증가에 대비한 확장성 요구 (Supabase Auth/DB로 충족)

## Non-goals (v1에서 하지 않을 것)

- **수기·음성 입력 중심 UX** — 스캔 불가 예외 상황의 최소 보조 수단으로만. 주 입력 방식으로 만들지 않음
- **B2B(급식·음식점) 기능** — 대량 수량 계산, 원가·마진, 위생/HACCP 기록 제외
- **범용 가계부** — 카드내역 연동·전체 소비 분석 같은 일반 가계부 기능 제외
- **레시피 커뮤니티/SNS** — 사용자 간 공유·댓글·팔로우 제외

## Style

- **모바일 세로 화면 우선.** 한 손 조작, 큰 터치 타깃. 주부 대상이라 군더더기 없는 큰 글씨·최소 단계.
- **스캔 우선 진입.** 첫 화면에서 최소 탭으로 스캔에 도달. 30초 입력 기준선을 UI로 강제.
- **유통기한 임박은 색으로 즉시 인지** (빨강=임박, 노랑=주의, 초록=여유).
- **냉장/냉동 구분이 한눈에.** 탭 또는 섹션으로 분리.

## Key Concepts

- **선순환(플라이휠):** 앱에서 재료를 살수록 유통기한·용량이 자동으로 채워져 입력이 편해지고 → 편하니 더 쓰고 → 남은 재료를 레시피로 소진하다 부족분을 다시 앱에서 산다. '사용자의 절약'과 '앱의 수익(쿠팡파트너스)'이 같은 고리에서 돈다.
- **스캔 원터치 입력:** 수기 입력을 대체하는 앱의 심장. 이게 30초 안에 안 되면 아무도 안 쓴다.
- **냉동 전환:** 유통기한 임박 재료를 냉동실로 옮겨 기한을 연장, 버리기 직전에 구제하는 동작.
- **잔량 차감(용량 기반):** '개수'가 아닌 실제 g/ml 용량으로 잔량 관리.

## Open Questions (미검증 가정 — 리스크)

- 영수증/바코드 스캔만으로 **유통기한**이 실제로 확보되는가? (영수증엔 보통 유통기한이 안 찍힘 — 별도 입력·추정 필요)
- 쿠팡 구매내역에서 **용량·유통기한이 자동으로 넘어오는가?** (선순환의 전제이나 미검증) — ⚠️ **쿠팡파트너스는 개인 구매내역 API를 제공하지 않음.** 현실적으로는 바코드→상품 DB 조회로 용량만 확보하고 유통기한은 별도 보정하는 우회가 필요할 가능성이 큼. → Phase 3 첫 검증 항목.
- **오프라인 구매분**의 유통기한은 어떻게 편하게 입력·관리하나?
- 가정에서 **버리는 재료의 금액 baseline** 측정 필요 ('10~20% 절감'을 판단할 출발점 수치).

---

## 선택된 개발 구조 (Supabase 기반)

**왜 이 구조인가:** 이 앱의 본질은 "내 냉장고 상태"라는 사용자별 데이터가 3개월 내내 여러 기기에서 살아있어야 한다는 것. Supabase Auth(계정) + PostgreSQL(지속 저장) + RLS(본인 데이터 보호)가 이 요구에 정확히 맞는다. 사용자가 늘어나도 '나중에 승급'이 아니라 **처음부터 확장 가능한 구조**로 출발한다.

**구성 요소**
- **Auth:** Supabase Auth (이메일 로그인). 각 사용자의 냉장고를 계정에 귀속.
- **DB:** Supabase PostgreSQL. 모든 테이블에 `fridge_` prefix + RLS 필수.
- **Frontend:** `index.html`(React 18 CDN + Tailwind CDN) + `app.js`/`supabase.js`/`auth.js`. Supabase JS 클라이언트로 DB 직접 접근.
- **Edge Function (Deno):** 쿠팡파트너스 HMAC 서명, 바코드 상품정보 조회 등 **비밀 키가 필요한 외부 API 프록시.** anon key만 있는 프론트에서는 절대 못 하는 작업.

⚠️ **정직한 리스크:** Option 2 기본 구조엔 자체 서버가 없다. 쿠팡파트너스 시크릿 키로 HMAC 서명을 해야 하는데 이를 프론트에 두면 키가 유출된다. 그래서 **Supabase Edge Function을 반드시 만들어야 하고, `supabase` CLI 설치와 배포 과정이 추가된다.** "프론트에서 그냥 부르면 된다"가 아니다. 바코드 조회 API도 동일.

## 프로젝트 구조

```
indivisual PJT/
├── prototype-v1.html          # Phase 1 산출물 (더미 데이터, 서버 없이 브라우저로 직접 열기)
├── index.html                 # Phase 2에서 전환 (React CDN + Tailwind CDN)
├── app.js                     # 앱 로직 / 뷰 전환 / 상태
├── supabase.js                # Supabase 클라이언트 초기화 (URL, ANON_KEY)
├── auth.js                    # 로그인/회원가입/세션
├── supabase/
│   ├── migrations/            # fridge_ 테이블 + RLS 정책 SQL
│   └── functions/
│       ├── barcode-lookup/    # 바코드 상품정보 조회 프록시 (Edge Function)
│       └── coupang-deeplink/  # 쿠팡파트너스 HMAC 서명·딥링크 (Edge Function)
├── package.json
├── .env                       # SUPABASE_URL, SUPABASE_ANON_KEY (프론트 노출 OK)
└── .env.local                 # 쿠팡/바코드 시크릿은 여기 (Edge Function secrets로 등록, git 제외)
```

## 데이터 모델 & RLS 설계

**테이블 (모두 `fridge_` prefix — 이유는 아래 '향후 확장' 참고)**

`fridge_items` (재고 항목)
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | uuid (PK) | 기본키 |
| user_id | uuid (FK → auth.users) | 소유자. RLS 기준 |
| name | text | 상품명 |
| capacity | numeric | 총 용량 (g/ml) |
| remaining | numeric | 잔량 (g/ml) |
| unit | text | 단위 (g/ml/개) |
| expiry_date | date | 유통기한 (⚠️ toISOString 금지, 아래 주의사항 참고) |
| storage | text | 보관위치 (`fridge`/`freezer`) |
| purchase_channel | text | 구매경로 (`coupang`/`offline`) |
| barcode | text | 바코드(GTIN), nullable |
| created_at | timestamptz | 생성 시각 |

- `fridge_recipes` (레시피, 선택), `fridge_purchases` (구매/주문 이력, 선택)도 같은 prefix 규칙.
- **냉동 전환** = `storage`를 `freezer`로 UPDATE + `expiry_date` 재계산.

**RLS (Row Level Security) — 필수, 선택 아님**
- Supabase anon key는 프론트에 노출되는 게 정상. **하지만 RLS를 안 걸면 anon key만으로 남의 냉장고를 다 읽고 지울 수 있다.**
- 각 테이블에 4개 정책: SELECT/INSERT/UPDATE/DELETE 모두 `auth.uid() = user_id` 기준.
- **반드시 다른 계정으로 접근해보고 실제로 막히는지 검증** (Phase 2.5 핵심 항목).

## TODO List

> 바이브 코딩 순서: **디자인 → 기본기능(쉬운 것) → 플랫폼 검증 → 어려운 기능(불확실한 것) → 마무리.** AI 코딩 실패율을 낮추기 위해 확실한 것부터 쌓고, 불확실한 것은 나중에 우회 가능하도록 배치.

### Phase 1: 디자인 & 프로토타이핑
- [ ] 🟢 UI 프로토타입 — `prototype-v1.html` (React 18 CDN + Tailwind CDN, **더미 데이터**, 서버·Supabase·package.json 없이 브라우저로 직접 열기)
  - 화면: 재고 리스트(냉장/냉동 탭), 유통기한 임박 알림, 스캔 입력(목업), 레시피 추천, 부족 재료 쿠팡 주문, 하단 네비게이션
- 📌 **체크포인트:** 더미 데이터로 모든 화면이 보이고 네비게이션이 동작 (파일을 브라우저에서 직접 열어 확인). 여기서 30초 입력 흐름의 화면 설계를 눈으로 검증.
- 📌 `git commit` — Phase 1 세이브 포인트

### Phase 2: 기본 기능 (쉬운 것부터)
- [ ] 🟢 프로젝트 초기화 — `package.json`, `@supabase/supabase-js` 설치, 로컬 정적 서버(예: `npx serve` 또는 Vite dev)
- [ ] 🟢 Supabase 클라이언트 연결 — `supabase.js` (`.env`의 `SUPABASE_URL`, `SUPABASE_ANON_KEY`)
- [ ] 🟢 `prototype-v1.html` → `index.html` + `app.js` 전환 (더미 → 실제 연결 준비)
- [ ] 🟢 이메일 회원가입/로그인 — `auth.js` (Supabase Auth), 세션 유지
- [ ] 🟡 재고 CRUD — `fridge_items` 읽기/추가/수정/삭제 (**수동 입력 폼**으로 먼저). 컴포넌트: `InventoryListView`, `FridgeItemCard`, `ItemFormModal`
- [ ] 🟡 유통기한 임박 표시 + 냉장/냉동 필터 — 색상 배지(빨강/노랑/초록). 컴포넌트: `ExpiryAlertView`
- [ ] 🟡 냉동 전환 — `storage`를 `freezer`로 UPDATE + `expiry_date` 재계산
- 📌 **체크포인트:** 로그인 후 수동으로 재고를 추가/조회/수정/삭제하고, 유통기한 임박 항목이 색으로 표시됨. (스캔·외부 API 없이 앱의 뼈대가 동작)
- 📌 `git commit` — Phase 2 세이브 포인트

### Phase 2.5: 플랫폼/인프라 연결 검증 (필수)
- [ ] 🟡 Supabase 프로젝트 생성 + `fridge_` prefix 테이블 생성 (SQL migration: `fridge_items` 등)
- [ ] 🔴 **RLS 정책 작성 및 검증** — 각 테이블에 `auth.uid() = user_id` 기반 SELECT/INSERT/UPDATE/DELETE 정책. **⚠️ 반드시 다른 계정으로 로그인해 남의 데이터에 접근해보고 실제로 막히는지 확인** (안 막히면 anon key로 전체 유출)
- [ ] 🟡 `supabase` CLI 설치 + Edge Function 배포 파이프라인 검증 — 더미 `health` 함수 하나를 배포하고 프론트에서 호출 성공 확인 (배포 과정 자체를 먼저 뚫어둠)
- 📌 **체크포인트:** 실제 Supabase에서 **본인 데이터만** 접근 가능하고, Edge Function이 배포·호출된다. (Phase 3의 외부 API 프록시를 얹을 토대 완성)
- 📌 `git commit` — Phase 2.5 세이브 포인트

### Phase 3: 핵심 & 어려운 기능 (불확실한 것부터)
- [ ] 🔴 **바코드/영수증 스캔으로 용량·유통기한 실제 확보 검증** (가장 불확실 — MISSION Open Questions의 전제이자 선순환 핵심)
  - `barcode-lookup` Edge Function으로 상품정보 API 프록시 → 바코드(GTIN)로 상품명·용량을 받아올 수 있는지 실측
  - ⚠️ **실패 시 우회:** (1) 상품 DB 조회로 **용량만** 확보하고 유통기한은 **수동 보정/기본값 추정**(예: 냉장 7일, 냉동 90일 프리셋). (2) 영수증은 유통기한이 없으니 **품목명만 추출**하고 용량·기한은 보조 입력. (3) 쿠팡파트너스는 개인 구매내역 API가 없으므로 '구매내역 자동 수신'은 v1에서 배제, 스캔 경로로 대체.
- [ ] 🔴 카메라 스캔 UX — `html5-qrcode`(CDN)로 바코드 인식, 모바일 카메라 권한, **장바구니 한 건 30초 입력 기준선** 실측. 컴포넌트: `ScanInputView`
- [ ] 🟡 보유 재고 기반 레시피 추천 — `fridge_items` 조회 후 매칭. 상황별(아이들용/건강식) 필터. 컴포넌트: `RecipeRecommendView`, `RecipeCard`
- [ ] 🟡 용량(g/ml) 기반 잔량 자동 차감 — 레시피 실행 시 사용량만큼 `remaining` UPDATE (0 이하 시 소진 처리)
- [ ] 🟡 부족 재료 쿠팡 주문 연동 — `coupang-deeplink` Edge Function(**HMAC 서명, 시크릿 키는 함수 안에서만**)으로 파트너스 딥링크 생성. 컴포넌트: `CoupangOrderView`
- 📌 **체크포인트:** 스캔 → 입력 → 레시피 추천 → 부족분 쿠팡 주문 → 잔량 차감의 **전체 선순환 흐름**이 실제 환경에서 동작.
- 📌 `git commit` — Phase 3 세이브 포인트

### Phase 4: 마무리 & 배포
- [ ] 🟡 UI 폴리싱 + **유통기한 날짜 처리 버그(KST/UTC) 점검** (아래 주의사항 참고)
- [ ] 🟡 에러 처리 — Supabase auto-pause('Tenant not found'), 네트워크 실패, 스캔 인식 실패, 빈 재고
- [ ] 🟡 최종 테스트 및 배포 — 정적 호스팅(Vercel/Netlify) + Edge Function 배포, 환경변수 설정
- 📌 **체크포인트:** 배포 가능한 상태. 모바일 실기기에서 30초 입력 기준선 최종 확인.

## 외부 설정 필요 항목

### 필수 (Must Have)
| 항목 | 설명 | 획득 방법 |
|------|------|----------|
| `SUPABASE_URL` | Supabase 프로젝트 URL (프론트 노출 OK) | supabase.com 프로젝트 생성 → Settings → API |
| `SUPABASE_ANON_KEY` | 익명 공개 키 (프론트 노출 OK, **RLS로 보호**) | 같은 API 설정 화면 |
| Supabase 프로젝트 | Auth + PostgreSQL + Edge Function 호스팅 | supabase.com 무료 플랜으로 생성 |
| `supabase` CLI | Edge Function 배포·로컬 개발 | `npm i -g supabase` 또는 scoop/brew |

### 외부 API — Phase 3에서 필요 (Edge Function 시크릿으로만)
| 항목 | 설명 | 획득 방법 |
|------|------|----------|
| `COUPANG_ACCESS_KEY` / `COUPANG_SECRET_KEY` | 쿠팡파트너스 딥링크 생성용 (HMAC 서명) | partners.coupang.com 가입 → 심사 승인 후 오픈API 키 발급. **시크릿은 절대 프론트에 두지 말 것** → `supabase secrets set`으로 Edge Function에만 |
| 바코드 상품정보 조회 API 키 | 바코드(GTIN)→상품명·용량 조회 | 공공데이터포털(data.go.kr) '바코드 연계 상품정보' 또는 식약처(식품안전나라) 오픈API 신청. 국내 바코드 커버리지가 제한적일 수 있어 **Phase 3에서 실측 필수** |

### 선택 (Nice to Have)
| 항목 | 설명 | 획득 방법 |
|------|------|----------|
| 영수증 OCR API | 영수증 이미지에서 품목 추출 (네이버 CLOVA OCR 등) | 유통기한은 영수증에 없으니 품목명 보조 용도로만. v1 후반/v2 고려 |

**시크릿 등록 예시 (Edge Function):**
```bash
supabase secrets set COUPANG_ACCESS_KEY=xxx COUPANG_SECRET_KEY=yyy BARCODE_API_KEY=zzz
```

## ⚠️ 이 스택에서 자주 터지는 함정 (주의사항)

1. **테이블명 충돌 (매우 중요).** 이 부트캠프는 여러 프로젝트가 **Supabase DB 하나를 공유**한다. `items`·`users`·`recipes` 같은 범용 이름은 이미 있는 테이블과 충돌한다. 게다가 `CREATE TABLE IF NOT EXISTS`는 기존 테이블이 있으면 **조용히 스킵**해서 나중에 "컬럼이 없다"는 엉뚱한 에러로 나타난다. → **모든 테이블에 `fridge_` prefix.**
2. **RLS 미설정 = 데이터 전면 유출.** anon key는 프론트에 노출되는 게 정상이지만, RLS가 없으면 그 키만으로 남의 냉장고를 다 읽고 지운다. **RLS는 선택이 아니라 필수**이고, 다른 계정으로 실제 차단을 검증해야 한다.
3. **시크릿 키를 프론트에 두면 유출.** 쿠팡파트너스 시크릿으로 HMAC 서명을 해야 하는데, 이건 반드시 **Edge Function 안에서만.** 프론트 코드/`.env`(브라우저 번들)에 넣으면 그대로 노출된다.
4. **유통기한 하루 밀림 버그.** `expiry_date`를 `toISOString()`으로 다루면 **KST 자정이 UTC 전날로 밀려 하루 어긋난다.** 유통기한 앱에서 이건 치명적. → DB/서버는 문자열(`to_char`)로, 브라우저의 '오늘'은 `Intl.DateTimeFormat`의 `Asia/Seoul`로 계산.
5. **Supabase 무료 auto-pause.** 무료 플랜은 일정 기간 미사용 시 프로젝트가 **auto-pause**되어 갑자기 "Tenant not found" 류 에러가 난다. → 대시보드에서 **restore**하면 복구. (ref가 죽은 것과 혼동 말 것)

## 향후 확장 설계 (Scalability)

Supabase는 애초에 '사용자 증가'에 맞는 선택이라, 확장은 '나중에 승급'이 아니라 **처음부터 제대로 설계**의 문제다.

- **테이블 네임스페이스:** `fridge_` prefix로 다른 프로젝트/향후 기능과 충돌 없이 확장 (위 함정 1).
- **모든 데이터에 `user_id` + RLS:** 사용자가 1명이든 10만 명이든 같은 스키마. 계정별 격리가 처음부터 보장됨.
- **외부 연동은 Edge Function으로 분리:** 쿠팡·바코드·OCR 등 비밀 키가 필요한 로직을 프론트와 분리해, 나중에 로직 교체·추가가 프론트 변경 없이 가능.
- **B2B(v2) 확장 여지:** MISSION의 향후 비전(급식·음식점)은 대량 수량·원가·HACCP로 요구가 다르므로 v1 스키마를 오염시키지 말고, 필요 시 별도 테이블 세트(`fridge_biz_*` 등)로 확장.

## 시작하기

```bash
# 0. 프로젝트 폴더로 이동 (폴더명에 공백 있음 — 따옴표 필수)
cd "D:/Boot Camp/week-6/indivisual PJT"

# --- Phase 1: 서버 없이 프로토타입만 ---
# prototype-v1.html 을 만들고 브라우저로 직접 열기 (더블클릭 또는)
start prototype-v1.html

# --- Phase 2: 프로젝트 초기화 & Supabase 연결 ---
npm init -y
npm install @supabase/supabase-js
# .env 에 SUPABASE_URL, SUPABASE_ANON_KEY 입력 후 로컬 서버 실행
npx serve .            # 또는 Vite 등

# --- Phase 2.5: Supabase CLI & Edge Function ---
npm install -g supabase
supabase login
supabase link --project-ref <프로젝트-ref>
supabase functions deploy barcode-lookup      # Phase 3에서 사용
supabase secrets set COUPANG_ACCESS_KEY=xxx COUPANG_SECRET_KEY=yyy
```

**지금 당장 사용자가 해야 할 일:**
1. **supabase.com에서 프로젝트 생성** → `SUPABASE_URL` + `SUPABASE_ANON_KEY` 확보 (Phase 2 진입 전제)
2. **쿠팡파트너스(partners.coupang.com) 가입 신청** → 심사에 시간이 걸리므로 미리 신청 (Phase 3에서 필요)
3. **바코드 상품정보 조회 API 신청**(공공데이터포털/식약처) → 승인까지 대기시간 있음. Phase 3에서 커버리지 실측 예정
4. 위 셋은 승인 대기가 있으니 **먼저 신청**해두고, 그동안 Phase 1(프로토타입)·Phase 2(수동 입력 CRUD)를 진행하면 대기시간이 낭비되지 않음.


