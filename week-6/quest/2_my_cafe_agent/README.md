# ☕ 딥로스트 카페 운영 DB + 어드바이저 에이전트

[`my_cafe.md`](./my_cafe.md)의 카페 컨셉 — **용인시 수지구 풍덕천동, 수지구청역 도보 5분, 구청 뒤 조용한 이면도로** —
을 **실제로 3개월간 운영했다고 가정한** 운영 데이터를 Supabase(Postgres)에 구성하고,
그 데이터로 조언·논의하는 서브에이전트를 붙인 것.

기간: **2026-04-01 ~ 2026-06-30 (91일)**

## 파일

| 파일 | 역할 |
|---|---|
| `my_cafe.md` | 카페 컨셉 기획서 (지역 특정 반영본) |
| `schema.sql` | 테이블 8개 + 인덱스 DDL |
| `db.mjs` | Supabase 연결 헬퍼 |
| `seed.mjs` | 스키마 생성 → 기존 `cafe_*` 비우기 → 가상 운영 데이터 생성·적재 |
| `verify.mjs` | 정합성 검증 + 컨셉 정합성 리포트 |
| `cafe-analyze.mjs` | **읽기 전용** 분석 CLI — 에이전트가 쓰는 데이터 창구 |
| `screenshots/` | Supabase 대시보드 캡처 |

```bash
node seed.mjs     # 적재 (재실행 가능 — cafe_* 만 truncate 후 재생성)
node verify.mjs   # 검증 + 요약
```

## 테이블

모두 `cafe_` 접두사를 쓴다. 이 Supabase 프로젝트는 부트캠프의 여러 퀘스트가 **하나의 DB를 공유**하고 있어서,
`orders`·`reviews` 같은 범용 이름을 쓰면 다른 퀘스트의 기존 테이블과 충돌한다.

| 테이블 | 행 수 | 내용 |
|---|---:|---|
| `cafe_menu` | 15 | 메뉴 마스터 (판매가·원가·시그니처 여부) |
| `cafe_daily_sales` | 91 | 일별 손님 수·주문 수·상품매출·멤버십매출 |
| `cafe_menu_sales` | 1,365 | 일자 × 메뉴별 판매량·매출 |
| `cafe_hourly_traffic` | 1,096 | 시간대별 손님 수 |
| `cafe_reviews` | 124 | 손님 리뷰 (별점·채널·언급 메뉴·멤버 여부) |
| `cafe_inventory` | 19 | 재고 (현재고·안전재고·단가·공급처) |
| `cafe_purchase_orders` | 47 | 주간 발주 내역 |
| `cafe_memberships` | 30 | 멤버십 가입·해지 (라이트/데일리/프로) |

### 관계

```
cafe_menu ──< cafe_menu_sales >── cafe_daily_sales ──< cafe_hourly_traffic
    └──< cafe_reviews (menu_id, nullable)
cafe_inventory ──< cafe_purchase_orders (item_name)
cafe_memberships  (독립)
```

`cafe_daily_sales.total_revenue`는 `product_revenue + membership_revenue`의 **생성 컬럼**이다.

## 데이터에 심어둔 컨셉

`my_cafe.md`의 기획이 숫자로 드러나도록 생성했다. `verify.mjs`가 이걸 실제로 확인한다.

- **주거 상권 → 주말이 성수기.** 주말/평일 매출비 **160%** (토 1,095,270원 vs 수 584,125원).
- **공휴일도 성수기.** 오피스 상권과 정반대. **어린이날(5/5)이 전 기간 매출 1위** (1,225,967원).
- **하이브리드 근무 → 평일 안의 요일 편차.** 재택이 몰리는 월·금(116명·110명)이 화·수·목(92~94명)보다 붐빈다.
- **이면도로 → 출근길 파도 없음.** 평일 8시는 5.1명뿐. 오전 10~11시(재택 시작)와 오후 13~15시(피크 14시)에 손님이 몰린다.
- **평일 20시 마감.** 학원가 저녁 손님을 포기한 결과 19~20시 매출이 사실상 없다.
- **평일과 주말은 다른 사업이다.** 평일 객단가 6,788원(1인 1주문) vs 주말 15,392원(가족이 한 건에 여러 잔).
- **좌석 충돌이 별점에 찍힌다.** 평일 4.17점 / 주말·공휴일 3.53점. 저평점 비율은 11.9% vs **25.0%**.
- **멤버십은 평일 전용 상품.** 활성 27명, MRR 1,063,000원. 멤버 별점 4.65점 vs 비멤버 3.85점.

데이터는 **시드 고정 난수**(`mulberry32(20260709)`)로 만들어서, `seed.mjs`를 다시 돌려도 같은 결과가 나온다.

## 정합성

`verify.mjs`가 세 가지를 확인한다. 91일 전부 통과해야 한다.

- 일별 상품매출 == 그날 메뉴별 판매 매출의 합
- 일별 손님 수 == 그날 시간대별 손님 수의 합
- 영업시간 밖(평일 08~20시 / 주말·공휴일 10~19시) 트래픽 0건

> 시간대별 손님 수는 처음에 "마지막 시간대에 잔여를 몰아주는" 방식으로 만들었는데,
> 난수 지터 때문에 앞선 시간대 합이 이미 일별 손님 수를 넘으면 총합이 어긋났다(91일 중 14일).
> 지금은 **최대잉여법(largest remainder)**으로 정수 배분한다.

## 🤖 my-cafe-advisor 에이전트

`my_cafe.md`(컨셉)와 위 DB(실제 결과)를 함께 읽고 **조언·논의**하는 서브에이전트.
정의: `.claude/agents/my-cafe-advisor.md` · 메모리: `.claude/agent-memory/my-cafe-advisor/`

설계 원칙은 `household-spending-analyst` 와 같다 — **집계는 SQL 이, 해석과 조언은 LLM 이.**
에이전트는 숫자를 지어내지 않고 반드시 `cafe-analyze.mjs` 출력만 인용한다.

```bash
node cafe-analyze.mjs                                   # 전체 기간
node cafe-analyze.mjs --month 2026-06                   # 특정 월
node cafe-analyze.mjs --from 2026-05-01 --to 2026-06-30 # 임의 구간
node cafe-analyze.mjs --section menu,reviews            # 필요한 섹션만 (출력이 크므로 권장)
node cafe-analyze.mjs --help
```

섹션: `overview` `weekday` `hourly` `trend` `menu` `category` `reviews` `inventory` `orders` `membership` `days`

- stdout 에는 **JSON 한 덩어리만**, 진단 로그는 stderr 로 나간다.
- 오직 `SELECT` 만 한다. 테이블이 없으면 `hasData:false` 로 정상 종료(종료코드 0).
- 연결 문자열·비밀번호는 stdout/stderr 어디에도 찍히지 않는다.
- pg 는 `SUM`/`AVG`/`COUNT` 를 문자열로 돌려주므로 SQL 에서 `::int` / `::float8` 로 캐스팅한다.

### 에이전트가 조심하도록 만든 것들

이 상권의 데이터는 **순진하게 읽으면 틀리기 쉽다.** 그래서 도구와 프롬프트 양쪽에 방지책을 넣었다.

1. **월별 총매출 착시.** 주말이 평일의 1.6배를 버니, 그 달의 주말 일수가 총매출을 좌우한다.
   6월(24,012,467원)이 5월(25,161,701원)보다 낮지만 가족일이 12일 → 9일로 줄었을 뿐이고,
   **평일 일평균은 612,850 → 652,181 → 690,398원으로 계속 성장**했다.
   → `trend[]` 가 `familyDays` · `weekdayAvgRevenue` · `familyAvgRevenue` 를 함께 내보낸다.
2. **주말 일수 이중계산.** `weekendDays`(26) + `holidayDays`(5) = 31 은 **틀린다.** 5/24는 일요일, 6/6은 토요일이라 양쪽에 잡힌다.
   실제 주말·공휴일은 **29일**(전체의 31.9%). 그래서 `overview.familyDays` · `weekdayDays` · `familyDayShare` · `weekendHolidayOverlap` 을 따로 내보낸다.
   → 실제로 에이전트가 첫 테스트에서 이 둘을 더해 "33일(36.3%)"이라고 답했다. 프롬프트로만 막지 않고 **도구가 정답 필드를 직접 주도록** 고쳤다.
3. **평일/주말을 섞은 평균.** 손님층·주문 행동이 다르므로 `overview.byDayType` 과 `reviews.byDayType` 으로 항상 분리해서 본다.
4. **주말 객단가 15,392원**을 "주말 손님이 두 배 쓴다"로 읽으면 틀린다. 주문 1건에 가족 2~3명이 묶여 있을 뿐이다(`ordersPerVisitor` 0.48).
5. **비용 데이터가 없다.** 임대료·인건비·고정비는 DB에 없으므로, 손익 판단이 필요한 질문에는 에이전트가 사장님께 되묻는다.
6. **표본이 작은 지표.** 메뉴별 리뷰는 2~4건, 멤버십 프로 플랜은 2명뿐이다. 단정하지 않는다.

### 물어볼 만한 것

> "우리 카페 요즘 어때?" · "주말 가족 손님 때문에 작업 단골이 나간대" · "빼도 되는 메뉴 있어?"
> "리뷰에서 제일 많이 나오는 불만이 뭐야?" · "멤버십 가격 올려도 될까?" · "평일 손님 늘리려면?"

## 알려진 단순화

- 리뷰 본문은 템플릿에서 뽑아 써서 같은 문장이 여러 번 나온다. 별점 분포와 언급 메뉴는 다르다.
- 멤버십 매출은 실제 결제일이 아니라 일할 인식(월 구독료 ÷ 30)으로 계산한다. 주말엔 지정석을 운영하지 않지만 구독료는 월정액이므로 매일 인식된다.
- 재고의 `current_stock`은 스냅샷이며, 판매량에 따라 차감되도록 연동돼 있지는 않다.
- 임대료·인건비 등 **비용 데이터는 없다.** 손익(P&L)이 아니라 매출·마진까지만 다룬다.

## 분석 예시

```sql
-- 요일별 평균 (공휴일 제외) — 주말·월·금이 높아야 정상
select day_name, round(avg(visitors))::int as 평균손님수, round(avg(total_revenue))::int as 평균매출
from cafe_daily_sales where not is_holiday
group by day_of_week, day_name order by day_of_week;

-- 평일 vs 주말·공휴일: 다른 사업이다
select case when is_weekend or is_holiday then '주말·공휴일' else '평일' end as 구분,
       count(*)::int as 일수,
       (sum(product_revenue)::float8 / sum(orders))::int as 객단가,
       (sum(orders)::float8 / sum(visitors))::numeric(4,2) as 손님당주문
from cafe_daily_sales group by 1;

-- 월별 비교는 반드시 가족일 수를 함께 본다
select to_char(sale_date,'YYYY-MM') as 월,
       count(*) filter (where is_weekend or is_holiday)::int as 가족일수,
       round(avg(total_revenue) filter (where not (is_weekend or is_holiday)))::int as 평일일평균,
       sum(total_revenue)::int as 총매출
from cafe_daily_sales group by 1 order by 1;

-- 메뉴별 매출 기여도 + 마진 (매출 비중과 마진 기여 비중의 괴리를 본다)
select m.name, sum(s.qty)::int as 판매량, sum(s.revenue)::int as 매출,
       sum(s.qty * (m.price - m.cost))::int as 마진
from cafe_menu_sales s join cafe_menu m on m.id = s.menu_id
group by m.name order by 마진 desc;

-- 좌석 충돌: 평일 vs 주말 별점
select case when d.is_weekend or d.is_holiday then '주말·공휴일' else '평일' end as 구분,
       count(*)::int as 리뷰수, round(avg(r.rating), 2) as 평균별점
from cafe_reviews r join cafe_daily_sales d on d.sale_date = r.review_date
group by 1;

-- 발주가 필요한 품목
select item_name, current_stock, safety_stock, unit,
       ceil(safety_stock * 2 - current_stock) as 권장발주량
from cafe_inventory where current_stock < safety_stock
order by (safety_stock - current_stock) desc;
```

## 주의

`.env`의 `SUPABASE_DB_URL`은 **Postgres 접속용**이며 커밋되지 않는다(`.gitignore`의 `*.env`).
Supabase 대시보드 로그인 계정과는 다른 자격증명이다.
