-- ☕ 딥로스트(Deep Roast) 카페 운영 DB 스키마
-- 부트캠프 Supabase는 여러 퀘스트가 하나의 DB를 공유하므로 모든 테이블에 cafe_ 접두사를 붙인다.

-- 1) 메뉴 마스터
create table if not exists cafe_menu (
  id           serial primary key,
  name         text    not null unique,
  category     text    not null,                 -- 커피 / 논커피 / 구움과자 / 세트
  price        integer not null,                 -- 판매가(원)
  cost         integer not null,                 -- 원가(원)
  is_signature boolean not null default false
);

-- 2) 일별 매출 (요일별 손님 수 분석의 기준 테이블)
create table if not exists cafe_daily_sales (
  sale_date          date primary key,
  day_of_week        smallint not null,          -- 0=일 ... 6=토
  day_name           text     not null,          -- 월,화,...
  is_weekend         boolean  not null,
  is_holiday         boolean  not null default false,
  visitors           integer  not null,          -- 방문 손님 수
  orders             integer  not null,          -- 주문 건수
  product_revenue    integer  not null,          -- 상품 매출(메뉴 판매 합계)
  membership_revenue integer  not null default 0,-- 멤버십 구독 매출(일할 인식)
  total_revenue      integer  generated always as (product_revenue + membership_revenue) stored
);

-- 3) 메뉴별 판매량 (일자 x 메뉴)
create table if not exists cafe_menu_sales (
  id        serial primary key,
  sale_date date    not null references cafe_daily_sales(sale_date) on delete cascade,
  menu_id   integer not null references cafe_menu(id),
  qty       integer not null,
  revenue   integer not null,
  unique (sale_date, menu_id)
);

-- 4) 시간대별 손님 수 (하루 3번의 손님 파도 확인용)
create table if not exists cafe_hourly_traffic (
  id        serial primary key,
  sale_date date     not null references cafe_daily_sales(sale_date) on delete cascade,
  hour      smallint not null check (hour between 0 and 23),
  visitors  integer  not null,
  unique (sale_date, hour)
);

-- 5) 손님 리뷰
create table if not exists cafe_reviews (
  id          serial primary key,
  review_date date     not null,
  rating      smallint not null check (rating between 1 and 5),
  channel     text     not null,                 -- 네이버 / 카카오맵 / 구글 / 인스타그램 / 매장설문
  menu_id     integer  references cafe_menu(id), -- 특정 메뉴 언급이 없으면 null
  is_member   boolean  not null default false,
  content     text     not null,
  created_at  timestamptz not null default now()
);

-- 6) 재고
create table if not exists cafe_inventory (
  id            serial primary key,
  item_name     text          not null unique,
  category      text          not null,          -- 원두 / 유제품 / 베이킹 / 부자재
  unit          text          not null,          -- kg / L / ea
  current_stock numeric(10,2) not null,
  safety_stock  numeric(10,2) not null,          -- 이 아래로 떨어지면 발주 필요
  unit_cost     integer       not null,
  supplier      text          not null,
  updated_at    timestamptz   not null default now()
);

-- 7) 발주
create table if not exists cafe_purchase_orders (
  id            serial primary key,
  order_date    date          not null,
  item_name     text          not null references cafe_inventory(item_name),
  qty           numeric(10,2) not null,
  unit_price    integer       not null,
  total_cost    integer       not null,
  supplier      text          not null,
  status        text          not null check (status in ('발주완료','배송중','입고완료','취소')),
  expected_date date
);

-- 8) 멤버십 (컨셉의 핵심: 단골 → 고정매출 전환)
create table if not exists cafe_memberships (
  id              serial primary key,
  member_code     text    not null unique,
  plan            text    not null check (plan in ('라이트','데일리','프로')),
  monthly_fee     integer not null,
  joined_date     date    not null,
  cancelled_date  date,
  status          text    not null check (status in ('active','cancelled'))
);

-- 분석용 인덱스
create index if not exists idx_cafe_menu_sales_date    on cafe_menu_sales (sale_date);
create index if not exists idx_cafe_menu_sales_menu    on cafe_menu_sales (menu_id);
create index if not exists idx_cafe_hourly_date        on cafe_hourly_traffic (sale_date);
create index if not exists idx_cafe_reviews_date       on cafe_reviews (review_date);
create index if not exists idx_cafe_reviews_rating     on cafe_reviews (rating);
create index if not exists idx_cafe_po_date            on cafe_purchase_orders (order_date);
create index if not exists idx_cafe_daily_dow          on cafe_daily_sales (day_of_week);
