# ☕ 딥로스트 사장님 대시보드 — API 계약서

`server.js`(백엔드)와 `index.html`(프론트)이 **이 문서를 유일한 기준**으로 삼는다.
한쪽이 계약을 바꾸면 반드시 이 문서를 먼저 고친다.

---

## 0. 프로젝트 원칙

| 항목 | 결정 |
|---|---|
| 파일 구성 | `server.js` + `index.html` + `.env` (+ `schema.sql`) |
| 프론트 | CDN React 18 + Tailwind + Babel **7.x 고정** (8.x는 백지 렌더) |
| 서버 | Express, `require('pg')` (로컬 node_modules에 설치됨) |
| 실행 | `npm start` → `http://localhost:3000` (Live Server 금지) |
| 정적 서빙 | **`index.html` 단일 파일만 allowlist로 서빙.** 폴더 통째 서빙 금지 — `.env`가 유출된다 |
| 인증 | JWT (Bearer). `/api/health` 외 모든 `/api/*`는 토큰 필요 |
| 타임존 | 매장 기준 `Asia/Seoul`. 날짜는 `YYYY-MM-DD` 문자열로 주고받는다 |
| pg 집계 | `AVG/SUM → ::float8`, `COUNT → ::int` **SQL에서 캐스팅**. 안 하면 클라에서 NaN |
| 신규 테이블 | 부트캠프 Supabase는 여러 퀘스트가 **한 DB를 공유**한다. 반드시 `cafe_` 접두사 |

에러 응답은 전부 동일 형태:
```json
{ "error": "사람이 읽을 수 있는 한국어 메시지" }
```

---

## 1. 신규 테이블

기존 `cafe_menu`, `cafe_daily_sales`, `cafe_menu_sales`, `cafe_hourly_traffic`,
`cafe_reviews`, `cafe_inventory`, `cafe_purchase_orders`, `cafe_memberships` 는
**이미 존재하고 91일치(2026-04-01 ~ 2026-06-30) 실데이터가 들어 있다. 스키마를 바꾸지 말 것.**

추가로 만들 테이블은 하나뿐:

```sql
create table if not exists cafe_owners (
  id            serial primary key,
  email         text        not null unique,
  password_hash text        not null,
  name          text        not null,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);
```

서버 부팅 시 `create table if not exists`로 자동 생성한다.

---

## 2. 인증

`.env`의 `OWNER_EMAILS`(쉼표 구분)에 있는 이메일만 **가입**할 수 있다.
그 외 이메일로 가입 시도 → `403 { "error": "사장님 계정만 가입할 수 있습니다." }`

비밀번호: `bcryptjs` 해시(rounds 10). 토큰: `jsonwebtoken`, `expiresIn: '12h'`,
payload `{ id, email, name }`.

| 메서드 | 경로 | 바디 | 응답 |
|---|---|---|---|
| POST | `/api/auth/register` | `{email, password, name}` | `{token, user:{id,email,name}}` |
| POST | `/api/auth/login` | `{email, password}` | `{token, user}` |
| GET | `/api/auth/me` | — | `{user}` |

프론트는 토큰을 `localStorage['cafe_dash_token']`에 저장하고
모든 요청에 `Authorization: Bearer <token>` 헤더를 붙인다.
`401` 응답을 받으면 토큰을 지우고 로그인 화면으로 돌아간다.

---

## 3. 헬스체크 (인증 불필요)

```
GET /api/health
→ { "ok": true, "db": true, "openai": true,
    "notion": { "configured": false },
    "dataRange": { "from": "2026-04-01", "to": "2026-06-30" } }
```

프론트는 부팅 시 이걸 먼저 호출한다.
실패하면 "server.js로 열어주세요" 안내를 띄운다 (Live Server로 연 경우 404).

---

## 4. 대시보드 데이터

### 4-1. `GET /api/dashboard/summary`

KPI 카드 + 알림. **모든 수치는 숫자 타입**(문자열 금지).

> ⚠️ **평일과 주말은 사실상 다른 사업이다.** 요일이 다른 날과 매출을 비교하면 반드시 착시가 생긴다.
> 그래서 모든 KPI는 **① 전주 같은 요일**과 **② 그 요일의 91일 평균(baseline)** 두 가지로 동시에 비교한다.

```json
{
  "asOf": "2026-06-30",
  "asOfDayName": "화",
  "dayType": "평일",
  "kpis": {
    "revenue":  { "label": "어제 총매출", "value": 695933, "unit": "원",
                  "vsLastWeek":  { "prev": 667400, "deltaPct": 4.3 },
                  "vsDowAvg":    { "prev": 608606, "deltaPct": 14.3 } },
    "visitors": { "label": "어제 방문자", "value": 104, "unit": "명",
                  "vsLastWeek": { "prev": 102, "deltaPct": 2.0 },
                  "vsDowAvg":   { "prev": 94.1, "deltaPct": 10.5 } },
    "avgTicket":{ "label": "객단가 (평일)", "value": 6809, "unit": "원",
                  "vsLastWeek": { "prev": 6661, "deltaPct": 2.2 },
                  "vsDayTypeAvg": { "prev": 6788, "deltaPct": 0.3 } },
    "membershipMrr": { "label": "멤버십 MRR", "value": 1063000, "unit": "원", "sub": "활성 27명 / 누적 30명" },
    "grossMargin":   { "label": "매출총이익률", "value": 74.0, "unit": "%",
                       "vsPrevMonth": { "prev": 73.9, "deltaPct": 0.1 } },
    "inventoryAlerts": { "label": "재고 알림", "value": 5, "unit": "건",
                         "sub": "미발주 3 · 지연 1 · 정상진행 1", "snapshot": true }
  },
  "alerts": [ /* 아래 규칙 */ ]
}
```

**객단가 정의 (실측으로 확정)**: `product_revenue / orders`. `total_revenue / visitors`가 **아니다.**
주말엔 가족이 한 번에 주문해 주문수 < 방문자수가 되므로, 방문자로 나누면 주말 객단가가 실제보다 낮게 나온다.
- 평일 기준선 6,788원 / 주말 기준선 15,392원. **오늘의 `dayType`에 맞는 기준선으로 비교하고, 라벨에도 `(평일)`/`(주말)`을 붙인다.**

`asOf` = **DB의 `max(sale_date)`** (2026-06-30). 오늘 날짜(2026-07-10)로 조회하면 빈 값이다.

#### 알림(alerts) 규칙 — 실제 데이터로 검증된 것만

`level`: `"danger" | "warn" | "info" | "ok"`

| level | 조건 | 현재 발동 |
|---|---|---|
| `danger` | 안전재고 하회 **AND** 미결 발주(`발주완료`/`배송중`)가 **없음** | 3건: 케냐 AA 생두, 무염버터, 테이크아웃컵(아이스) |
| `warn` | 안전재고 하회 **AND** 발주는 있으나 `expected_date < asOf` | 1건: 핫초코 파우더 (6/21 발주, 6/23 입고예정인데 아직 배송중) |
| `info` | 재고는 정상인데 `expected_date < asOf` 인 미결 발주 | 다크초콜릿, 냅킨 |
| `ok` | 안전재고 하회지만 발주가 정상 진행 중 | 아몬드가루 (6/28 발주, 7/1 입고예정) → **"조치 불필요"로 표시** |
| `warn` | 최근 30일 평균 별점 < 직전 30일 평균 − 0.3 | **현재 미발동** |
| `warn` | `asOf` 매출 < 해당 요일 평균 − 2×표준편차 | **현재 미발동** |
| `info` | 특정 플랜에 해지가 집중 (해지 건수 ≥ 3 **AND** 한 플랜이 전체 해지의 100%) | 라이트 플랜 3건 |

> **"별점 급락", "요일 매출 붕괴"를 하드코딩하지 말 것.** 실측하면 별점은 4월 3.76 → 5월 3.85 → 6월 4.22로 **개선 중**이고,
> 6/30 매출은 화요일 평균보다 14.3% **높다.** 조건이 안 맞으면 알림은 뜨지 않아야 한다.
> 없는 위기를 지어내는 대시보드는 사장님이 두 번째 날부터 안 본다.

### 4-2. `GET /api/dashboard/charts`

```json
{
  "dailyRevenue": [ { "date": "2026-06-24", "dayName": "수", "product": 380000, "membership": 39000, "total": 419000, "visitors": 96 } ],
  "byDayOfWeek":  [ { "dayName": "월", "avgVisitors": 116.4, "stdVisitors": 5.1, "avgRevenue": 732869, "n": 13 } ],
  "hourly":       [ { "hour": 8, "weekday": 5.1, "weekend": null },
                    { "hour": 14, "weekday": 13.2, "weekend": 21.0 } ],
  "monthlyTrend": [ { "month": "2026-06", "totalRevenue": 24012467, "weekdayAvgRevenue": 690398, "weekendAvgRevenue": 1066347, "marginRate": 74.0 } ],
  "menuPerf":     [ { "name": "아메리카노", "category": "커피", "price": 4500, "cost": 900, "qty": 2731, "revenue": 12289500, "marginRate": 80.0 } ],
  "reviews":      { "avgRating": 3.95, "byRating": [ { "rating": 5, "n": 61 } ],
                    "byMonth": [ { "month": "2026-06", "avgRating": 4.22, "n": 45 } ],
                    "byChannel": [ { "channel": "네이버", "avgRating": 4.1, "n": 44 } ],
                    "lowRatingShare": { "weekend": 25.0, "weekday": 11.9 } },
  "membership":   { "active": 27, "cancelled": 3, "mrr": 1063000,
                    "byPlan": [ { "plan": "데일리", "n": 11, "mrr": 495000 } ],
                    "netAddByMonth": [ { "month": "2026-06", "joins": 13, "churns": 3, "net": 10 } ] }
}
```

- `byDayOfWeek`: **일(0)~토(6) 순서로 7개 모두.** `stdVisitors`는 `STDDEV_SAMP(visitors)::float8`, **공휴일 제외**(`where not is_holiday`).
  실측: 일 129.9±6.8 · 월 116.4±5.1 · 화 94.1±6.8 · 수 92.3±5.1 · 목 92.0±5.9 · 금 110.3±5.3 · 토 146.3±5.8
- `hourly`: **평일 8~20시, 주말·공휴일 10~19시.** 영업시간이 다르다.
  주말에 영업하지 않는 시간(8·9·20시)은 **`0`이 아니라 `null`** 로 반환한다.
  `0`으로 주면 "손님이 없었다"는 착시가 생긴다. 프론트는 `null` 구간의 선을 끊고 '휴무'로 표시한다.
  실제 모양: 평일은 **쌍봉**(10~11시 소파도 → 12시 골 7.2명 → **14시 피크 13.2명**), 주말은 **단봉**(14시 피크 21.0명).
- `monthlyTrend`: 총매출만 보면 5월(25.1M)이 6월(24.0M)보다 높아 "6월이 나빴나?" 오해하기 쉽다.
  실제로는 **그 달에 주말·공휴일이 며칠 있었느냐**의 문제이고, **평일 일평균 매출은 612,850 → 652,181 → 690,398원으로 3개월 연속 성장**했다.
  그래서 총매출과 평일/주말 일평균을 **반드시 분리**해서 보여준다.
- `menuPerf`: 마진율 = `(price - cost) / price * 100`. 매출 1위(딥세트)와 마진율 1위(아이스티 84.4%)가 다르다는 걸 보여주는 게 목적.

---

## 5. 날씨 · 예측 · 뉴스

### 5-1. `GET /api/weather` — Open-Meteo, **API 키 불필요**

좌표는 `.env`의 `CAFE_LAT`/`CAFE_LON` (수지구청역 37.3225, 127.0947).

```
https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..
  &current=temperature_2m,precipitation,weather_code
  &daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max
  &timezone=Asia%2FSeoul&forecast_days=3
```

```json
{
  "current": { "temp": 25.9, "precipitation": 1.2, "code": 63, "desc": "비", "icon": "🌧️" },
  "daily": [ { "date": "2026-07-10", "dayName": "금", "tempMax": 26.5, "tempMin": 23.1,
               "precipSum": 25.5, "precipProb": 100, "code": 63, "desc": "비", "icon": "🌧️" } ]
}
```

WMO `weather_code` → 한국어 `desc` + 이모지 매핑은 서버가 담당한다
(0 맑음 ☀️ / 1-3 구름 🌤️⛅☁️ / 45-48 안개 🌫️ / 51-57 이슬비 🌦️ / 61-67 비 🌧️ / 71-77 눈 ❄️ / 80-82 소나기 🌦️ / 95-99 뇌우 ⛈️).

### 5-2. `GET /api/predict/visitors` — 날씨 기반 손님수 예측

**정직한 예측을 위한 규칙: 우리 DB에는 과거 날씨 이력이 없다.**
따라서 AI에게 "날씨로 예측해줘"라고 통째로 맡기지 않는다. 대신:

1. 서버가 SQL로 **요일별 방문객 평균·표준편차**를 구해 baseline을 만든다.
2. baseline + 내일 날씨 예보를 OpenAI에 넘겨 **보정치와 근거**만 받는다.
3. 응답에 baseline을 그대로 노출해, 사장님이 AI 보정을 검증할 수 있게 한다.

```json
{
  "targetDate": "2026-07-11",
  "dayName": "토",
  "baseline": { "avgVisitors": 128.5, "stdVisitors": 14.2, "n": 13, "source": "DB 요일별 실적 91일" },
  "weather":  { "tempMax": 31.5, "precipSum": 0, "precipProb": 12, "desc": "구름조금", "icon": "🌤️" },
  "prediction": { "expected": 138, "low": 124, "high": 152, "confidence": "중",
                  "vsBaselinePct": 7.4 },
  "reasoning": "비 예보 없음(강수확률 12%)이고 최고 31.5℃로 더워 실내 체류가 늘어난다. 주말 가족 손님 피크 요일이라 baseline 대비 상향.",
  "factors": [ { "name": "무강수", "effect": "+", "weight": "높음" } ],
  "caveat": "과거 날씨-방문객 상관 데이터가 없어 AI의 정성 보정입니다. baseline 대비 ±10% 밖이면 의심하세요."
}
```

- 모델: `gpt-4.1`, `response_format: { type: "json_object" }`
- `caveat`는 **항상 포함**한다. 없는 데이터를 있는 척하지 않는다.
- baseline SQL: `avg(visitors)::float8`, `stddev_samp(visitors)::float8`, `where not is_holiday`, 해당 요일만.

**AI 프롬프트에 반드시 넣을 제약 (실측 근거 있음)**

1. "비 오면 −15%" 같은 **단일 보정 계수를 쓰지 말 것.** 우리 DB에는 과거 날씨-방문객 상관 데이터가 **전혀 없다.**
2. 평일과 주말은 **우천 민감도의 방향 자체가 다를 수 있다**:
   - 평일 작업 손님은 "오늘 여기서 일하자"고 작정하고 오는 **목적형 방문**이라 비에 덜 민감할 수 있다.
   - 주말 가족 손님은 **나들이형**이라 비가 오면 아예 안 나올 수도, 반대로 실내 대안으로 몰릴 수도 있다. **방향이 불확실하다.**
   → 따라서 보정은 `dayType`에 따라 다르게, 그리고 주말 우천 시에는 **범위를 넓게(low~high 간격 확대)** 잡아야 한다.
3. baseline에서 **±1 표준편차를 벗어나는 예측을 하려면 근거를 반드시 `reasoning`에 쓸 것.**
4. `confidence`는 강수 예보가 있는 주말이면 반드시 `"낮음"`.

`caveat` 예시 문구:
> "과거 날씨-방문객 상관 데이터가 없어 AI의 정성 보정입니다. baseline(±1σ)을 벗어나면 AI가 아니라 baseline을 믿으세요."

### 5-2b. 날씨 로그 적재 (예측을 나중에 검증 가능하게)

지금은 근거가 없지만, **오늘부터 쌓으면 3개월 뒤엔 진짜 회귀계수를 뽑을 수 있다.**
`/api/predict/visitors` 호출 시 아래 테이블에 **예보와 예측치를 upsert**한다. (실제 방문자수는 나중에 채워진다)

```sql
create table if not exists cafe_weather_log (
  log_date          date primary key,
  temp_max          numeric(4,1),
  precip_sum        numeric(5,1),
  weather_code      smallint,
  baseline_expected numeric(6,1),   -- 요일 평균
  ai_expected       integer,        -- AI 보정 예측
  actual_visitors   integer         -- 나중에 cafe_daily_sales에서 채움
);
```

### 5-3. `GET /api/news` — 카페 운영 관련 뉴스

- 모델: **`gpt-4o-search-preview`** (웹 검색 내장, 실제 인용 링크 반환)
- ⚠️ 이 모델은 `temperature` 파라미터를 **지원하지 않는다**. 넣으면 400.
- `web_search_options.user_location`에 `KR / Gyeonggi-do / Yongin` 지정.
- 응답의 `choices[0].message.annotations[]`에서 `url_citation`을 뽑아 출처로 쓴다.

```json
{
  "items": [
    { "title": "2026년 최저시급 10,030원", "summary": "전년 대비 1.7% 인상.",
      "impact": "인건비 상승 → 평일 화·수·목 인력 배치 재검토 필요",
      "url": "https://...", "source": "연합뉴스" }
  ],
  "generatedAt": 1783668184000
}
```

검색 주제는 **원두 시세 · 우윳값 · 최저임금 · 임대료 · 배달/플랫폼 수수료 · 카페 트렌드**로 한정한다.

### 5-4. `GET /api/briefing` — 오늘의 카페 브리핑 ⭐

서버가 **DB 집계 + 날씨 + 예측 + 뉴스를 먼저 모아** 한 번의 OpenAI 호출로 만든다.
프론트가 4개 API를 각각 부르고 조립하는 게 아니다. **이 엔드포인트 하나면 브리핑 카드가 완성된다.**

```json
{
  "headline": "오늘은 비. 작업 손님이 늘 것 — 케냐 생두부터 발주하세요.",
  "sections": [
    { "title": "📊 어제 실적", "body": "..." },
    { "title": "🌧️ 오늘 날씨와 손님", "body": "..." },
    { "title": "⚠️ 오늘 조치할 것", "body": "..." },
    { "title": "📰 알아둘 뉴스", "body": "..." }
  ],
  "actions": [ "베이킹마트 3건 합배송 발주 (오늘 마감)" ],
  "weather": { "...5-1 형태..." },
  "prediction": { "...5-2 형태..." },
  "news": { "...5-3 형태..." },
  "generatedAt": 1783668184000,
  "model": "gpt-4.1",
  "cached": false
}
```

- 모델 `gpt-4.1`, `response_format: { type: "json_object" }`
- **서버 메모리에 10분 캐시.** 새로고침마다 과금되면 안 된다. `?refresh=1`로 강제 갱신.
- 브리핑 생성 실패(OpenAI 오류)해도 **weather/prediction/news/DB 수치는 그대로 반환**하고
  `headline`에 "AI 브리핑 생성 실패"를 넣는다. 화면이 통째로 죽으면 안 된다.

#### 브리핑에 넘길 재료 (서버가 SQL로 먼저 집계 — 모델이 숫자를 지어내면 안 된다)

`asOf` 실측치(방문자·주문·상품매출·멤버십매출·객단가) / 그 요일 baseline·전주 동요일 대비 % /
`dayType` / 안전재고 하회 리스트(품목·부족량·공급처·**발주 여부**) / 입고예정일 경과 발주 /
`asOf`에 새로 달린 리뷰(없으면 "새 리뷰 없음"이라고 명시) / 멤버십 순증·플랜별 이탈 / 날씨 예보 / 뉴스 헤드라인

#### 브리핑 금칙 (프롬프트에 그대로 넣을 것)

1. **감성 인사말 금지.** "좋은 아침입니다, 향긋한 커피와 함께…" → 액션이 0개다.
2. **사장님이 이미 아는 컨셉 재진술 금지.** "평일엔 직장인, 주말엔 가족이 옵니다" → 새 정보가 없다.
3. **근거 없는 인과 단정 금지.** "오늘 비가 와서 어제 손님이 적었습니다" → 어제(6/30)는 오히려 baseline보다 손님이 **많았다.**
   실측을 확인하지 않고 날씨 핑계부터 대면 데이터와 충돌하는 거짓말이 된다.
4. **표본 작은 걸 확정으로 말하지 말 것.** "프로 플랜은 인기가 없습니다" (활성 2명뿐).
5. **알려진 트레이드오프를 새 위기처럼 보고하지 말 것.** 주말 좌석 갈등은 사장님이 설계 단계에서 **선택한 것**이지 새 발견이 아니다.
6. **액션 없는 일반론 금지.** "마케팅을 강화하세요", "고객 만족에 힘쓰세요".
7. 데이터에 없는 것은 **모른다고 말할 것.**

반드시 **제공된 숫자를 인용**하고, **오늘 당장 할 수 있는 구체적 행동 1~3개**로 끝낼 것.

---

## 6. Notion 연동 — 할일 · 발주메모

Notion DB는 **이미 Notion MCP로 생성·시드 완료**되었다. 서버는 Notion REST API로 읽고 쓴다.

| | ID |
|---|---|
| 부모 페이지 | `399450d9-d50b-8162-b67e-e5b28238f1ea` |
| 카페 할일 DB | `f7fabd33-9701-4fca-84e3-0291324aee24` |
| 발주 메모 DB | `a367668e-5a20-408c-9bd6-2251d5cca2fe` |

- 엔드포인트 `https://api.notion.com/v1/...`, 헤더 `Notion-Version: 2022-06-28`
- 토큰은 `.env`의 `NOTION_TOKEN` (내부 통합 시크릿 `ntn_...`).
  **Claude Code의 MCP OAuth 토큰은 REST API에서 401이다. 재사용 시도 금지.**

### 토큰이 없을 때 (중요)

`NOTION_TOKEN`이 비어 있으면 **500을 던지지 말고** 아래를 반환한다.
프론트는 이걸 받아 "연결 안내 카드"를 그린다. 대시보드의 나머지는 정상 동작해야 한다.

```json
{
  "configured": false,
  "items": [],
  "setup": {
    "parentPageUrl": "https://app.notion.com/p/399450d9d50b8162b67ee5b28238f1ea",
    "steps": [
      "https://www.notion.so/my-integrations 에서 내부 통합을 만들고 시크릿(ntn_...)을 복사",
      "Notion에서 '☕ 딥로스트 카페 운영' 페이지 → ••• → 연결 → 방금 만든 통합 추가",
      ".env 의 NOTION_TOKEN= 뒤에 붙여넣고 서버 재시작"
    ]
  }
}
```

### 스키마 (속성 이름은 한글이며 정확히 일치해야 한다)

**카페 할일**: `할일`(title), `상태`(select: `할 일`/`진행중`/`완료`), `우선순위`(select: `높음`/`보통`/`낮음`), `분류`(select: `운영`/`발주`/`마케팅`/`설비`/`멤버십`), `마감일`(date), `메모`(rich_text)

**발주 메모**: `품목`(title), `상태`(select: `발주필요`/`발주완료`/`배송중`/`입고완료`), `공급처`(rich_text), `수량`(number), `단위`(select: `kg`/`L`/`ea`), `예상금액`(number), `발주예정일`(date), `메모`(rich_text)

> `상태`의 `할 일`에는 **가운데 공백이 있다**. `할일`(title 속성명)과 혼동 금지.

### 엔드포인트

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/notion/status` | `{configured, parentPageUrl, todoDbId, orderDbId, setup?}` |
| GET | `/api/notion/todos` | `{configured, items:[{id,title,status,priority,category,due,memo,url}]}` |
| POST | `/api/notion/todos` | `{title,status?,priority?,category?,due?,memo?}` → 생성된 item |
| PATCH | `/api/notion/todos/:id` | `{status?}` 등 부분 수정 |
| GET | `/api/notion/orders` | `{configured, items:[{id,item,status,supplier,qty,unit,amount,due,memo,url}]}` |
| POST | `/api/notion/orders` | 발주 메모 생성 |
| PATCH | `/api/notion/orders/:id` | `{status?}` |
| POST | `/api/notion/orders/sync-from-inventory` | `cafe_inventory`에서 안전재고 하회 품목을 찾아, **아직 발주메모에 없는 것만** `발주필요`로 생성. → `{created:[...], skipped:[...]}` |

정렬: 할일은 `마감일` 오름차순, 발주메모는 `발주예정일` 오름차순.

---

## 7. 데이터 관리 (CRUD)

사장님이 대시보드에서 직접 고치는 테이블. 전부 JWT 필요.

> ⚠️ **응답·요청 필드는 모두 camelCase다.** DB 컬럼(snake_case)을 그대로 노출하지 않는다.
> 대시보드 API가 `deltaPct` · `avgVisitors` · `marginRate` 로 통일돼 있으므로 CRUD도 같은 규칙을 따른다.
> (이걸 명시 안 해서 프론트가 `item_name`으로 읽다가 표가 통째로 비는 사고가 났다.)

| 리소스 | 지원 | 응답 필드 |
|---|---|---|
| `/api/menu` | GET, POST, PATCH `/:id`, DELETE `/:id` | `id, name, category, price, cost, isSignature` |
| `/api/inventory` | GET, PATCH `/:id` | `id, itemName, category, unit, currentStock, safetyStock, unitCost, supplier, shortage` |
| `/api/purchase-orders` | GET, POST, PATCH `/:id` | `id, orderDate, itemName, qty, unitPrice, totalCost, supplier, status, expectedDate` |
| `/api/daily-sales` | GET `?from=&to=`, PUT (upsert) | `date, dayOfWeek, dayName, isWeekend, isHoliday, visitors, orders, productRevenue, membershipRevenue, totalRevenue` |
| `/api/reviews` | GET `?limit=&minRating=&maxRating=` | `id, date, rating, channel, menuId, isMember, content` |
| `/api/memberships` | GET, PATCH `/:id` | `id, memberCode, plan, monthlyFee, joinedDate, cancelledDate, status` |

- `inventory.shortage`(boolean)는 **서버가 `current_stock < safety_stock` 를 계산해서 내려준다.**
  프론트가 다시 비교하지 말 것.
- PATCH 바디도 camelCase: `{ currentStock, safetyStock, unitCost, supplier }`, `{ status, cancelledDate }`.
  서버는 **알 수 없는 키를 무시**하므로, snake_case 로 보내면 조용히 `400 변경할 항목이 없습니다` 가 된다.
- 날짜는 전부 `YYYY-MM-DD` **문자열**로 주고받는다. 서버는 `to_char(col,'YYYY-MM-DD')` 로 뽑는다.
  `Date` 객체를 `toISOString()` 하면 KST 자정이 UTC 전날로 밀려 **하루가 어긋난다.**

- `DELETE /api/menu/:id`는 `cafe_menu_sales`가 FK로 참조하므로 **판매 이력이 있으면 409**로 거부하고
  `{ "error": "판매 이력이 있는 메뉴는 삭제할 수 없습니다. 대신 비활성화하세요." }`
- `cafe_daily_sales.total_revenue`는 **생성 컬럼**이다. INSERT/UPDATE 대상에 넣으면 에러.
- 금액·수량은 서버에서 타입 검증한다. 음수 가격 등은 `400`.

---

## 8. 프론트 화면 구성

해시 라우팅(`#/`, `#/data`, `#/notion`). 로그인 안 되어 있으면 무조건 로그인 화면.

1. **로그인 / 가입** — 사장님 전용임을 명시
2. **`#/` 대시보드** (기본)
   - 오늘의 카페 브리핑 (헤드라인 + 섹션 + 조치사항) ⭐ 화면 최상단
   - 날씨 카드 + 내일 손님수 예측 (baseline과 AI 보정을 나란히)
   - KPI 카드 6개 (각 카드에 **전주 동요일 대비**와 **요일 평균 대비**를 함께)
   - 알림 리스트 (`danger`/`warn`/`info`/`ok` 4단계. `ok`는 "조치 불필요"로 차분하게)
   - 차트 4개:
     ① **시간대별 손님 파도** — 평일·주말 두 라인. 주말 `null` 구간(8·9·20시)은 선을 끊고 '휴무'로. `spanGaps: false`
     ② **요일별 방문자·매출** — 막대 + 표준편차 오차막대
     ③ **메뉴 매트릭스** — 버블(x=판매량, y=마진율, 크기=매출, 색=카테고리). "매출 1위 ≠ 마진 1위"를 보여주는 게 목적
     ④ **월별 평일 vs 주말 일평균 매출** — 라인. 총매출 막대는 작게 보조로. (총매출만 보면 6월이 5월보다 낮아 오해하지만, 평일 일평균은 3개월 연속 성장)
   - 뉴스 카드 (출처 링크)
3. **`#/notion` 할일 & 발주** — Notion 양방향. 미연결 시 안내 카드
4. **`#/data` 데이터 관리** — 메뉴/재고/발주/멤버십 테이블 편집

### 프론트 필수 주의사항 (과거에 실제로 터진 것들)

- `@babel/standalone`은 **7.x로 버전 고정**. 최신(8.x)을 쓰면 화면이 백지가 된다.
- `text/babel` 스크립트의 **최상위 함수는 `window` 전역이 된다.** SDK가 스니핑하는 흔한 이름
  (`PaymentWidget` 등)을 컴포넌트명으로 쓰지 말 것.
- 차트는 CDN Chart.js. `useEffect` 정리 함수에서 `chart.destroy()` 필수 (리렌더 시 중첩).
- 숫자 포맷: `Intl.NumberFormat('ko-KR')`. 금액은 `원`, 비율은 소수 1자리.
- 로딩/에러/빈 상태를 각각 그린다. 브리핑은 수 초 걸리므로 **스켈레톤**을 보여준다.
