-- ☕ 딥로스트 사장님 대시보드 — 인증 테이블 (cafe_owners)
--
-- 이 파일은 대시보드 로그인 전용 테이블 "하나"만 추가한다.
-- 기존 운영 테이블(cafe_menu, cafe_daily_sales, cafe_menu_sales, cafe_hourly_traffic,
-- cafe_reviews, cafe_inventory, cafe_purchase_orders, cafe_memberships)은
-- week-6/quest/2_my_cafe_agent/schema.sql 로 이미 만들어져 91일치 실데이터가 들어 있다.
-- → 절대 변경/DROP/ALTER 하지 않는다. (부트캠프 Supabase는 여러 퀘스트가 한 DB를 공유한다)
--
-- server.js 도 부팅 시 아래와 동일한 `create table if not exists` 를 자동 실행하므로
-- 이 파일을 수동으로 돌리지 않아도 서버가 알아서 테이블을 보장한다.

create table if not exists cafe_owners (
  id            serial primary key,
  email         text        not null unique,
  password_hash text        not null,
  name          text        not null,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);
