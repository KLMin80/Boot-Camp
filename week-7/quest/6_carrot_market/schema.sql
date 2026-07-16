-- 단군마켓 스키마
-- ⚠️ 모든 퀘스트가 하나의 Supabase DB를 공유한다. 범용 이름(users/products/chats)은
--    기존 스키마와 충돌하므로 반드시 dangun_ prefix 를 쓴다.
--    CREATE IF NOT EXISTS 는 기존 테이블이 있으면 no-op 라 새 컬럼이 안 생긴다 →
--    스키마 변경은 ALTER 로. (지금은 전부 신규 테이블이라 안전)

-- 사용자 ─ 이메일/비밀번호 + 동네(직접입력 또는 위치인증) + 매너온도
CREATE TABLE IF NOT EXISTS dangun_users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  nickname      TEXT NOT NULL,
  region        TEXT NOT NULL,                       -- 동네 이름 (예: 역삼동)
  lat           DOUBLE PRECISION,                    -- 위치인증 시 좌표
  lon           DOUBLE PRECISION,
  manner_temp   NUMERIC(4,1) NOT NULL DEFAULT 36.5,  -- 매너온도 °C
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 상품
CREATE TABLE IF NOT EXISTS dangun_products (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES dangun_users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  price       INTEGER NOT NULL DEFAULT 0,            -- 원 (0 이면 나눔)
  description TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL,
  region      TEXT NOT NULL,                         -- 등록 시점 동네
  status      TEXT NOT NULL DEFAULT 'selling',       -- selling | reserved | sold
  view_count  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 상품 이미지 (최대 3장, sort_order 로 순서 유지)
CREATE TABLE IF NOT EXISTS dangun_product_images (
  id         BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES dangun_products(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- 관심(찜) — 한 사람이 한 상품에 하나
CREATE TABLE IF NOT EXISTS dangun_favorites (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES dangun_users(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES dangun_products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, product_id)
);

-- 채팅방 — 상품별 (구매자 × 판매자) 1:1. 같은 상품에 같은 구매자는 방 하나.
CREATE TABLE IF NOT EXISTS dangun_chats (
  id         BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES dangun_products(id) ON DELETE CASCADE,
  buyer_id   BIGINT NOT NULL REFERENCES dangun_users(id) ON DELETE CASCADE,
  seller_id  BIGINT NOT NULL REFERENCES dangun_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, buyer_id)
);

-- 메시지 (polling 으로 실시간 흉내)
CREATE TABLE IF NOT EXISTS dangun_messages (
  id         BIGSERIAL PRIMARY KEY,
  chat_id    BIGINT NOT NULL REFERENCES dangun_chats(id) ON DELETE CASCADE,
  sender_id  BIGINT NOT NULL REFERENCES dangun_users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dangun_products_created  ON dangun_products(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dangun_products_category ON dangun_products(category);
CREATE INDEX IF NOT EXISTS idx_dangun_images_product    ON dangun_product_images(product_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_dangun_messages_chat     ON dangun_messages(chat_id, id);
CREATE INDEX IF NOT EXISTS idx_dangun_favorites_user    ON dangun_favorites(user_id);
