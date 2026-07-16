-- 남김없이 — 스키마
-- ⚠️ 모든 테이블에 fridge_ 접두. 부트캠프 프로젝트들이 Supabase DB 하나를 공유한다.
--    items/users 같은 범용 이름은 남의 테이블과 충돌하고,
--    CREATE TABLE IF NOT EXISTS는 기존 테이블이 있으면 조용히 스킵해서
--    나중에 "컬럼이 없다"는 엉뚱한 에러로 나타난다.
--
-- ⚠️ RLS는 방어막이 아니다. pooler/Direct는 postgres 역할로 붙어 RLS를 통과한다.
--    보안은 server.js가 모든 쿼리에 WHERE user_id = $1 을 붙이는 것으로만 지켜진다.

-- 계정 (Supabase Auth를 쓰지 않으므로 직접 만든다)
CREATE TABLE IF NOT EXISTS fridge_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 재료별 권장 보관기간.
-- ⚠️ 행이 없다는 것 자체가 정보다: (두부, freezer) 행이 없으면 "두부는 얼리면 못 쓴다"는 뜻.
--    '냉동실로' 기능은 freezer 행이 있는 재료에만 적용해야 한다.
CREATE TABLE IF NOT EXISTS fridge_shelf_life (
  ingredient text NOT NULL,
  storage    text NOT NULL CHECK (storage IN ('fridge','freezer','room','room_shade')),
  days       int  NOT NULL CHECK (days > 0),
  PRIMARY KEY (ingredient, storage)
);

-- 재고
CREATE TABLE IF NOT EXISTS fridge_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES fridge_users(id) ON DELETE CASCADE,

  name             text NOT NULL,                 -- 제품명 "서울우유 1A 흰우유 1L"
  ingredient       text NOT NULL,                 -- 재료명 "우유" — 레시피 매칭·프리셋 조회용
  capacity         numeric NOT NULL CHECK (capacity > 0),
  remaining        numeric NOT NULL CHECK (remaining >= 0),
  unit             text NOT NULL DEFAULT 'g',

  price            int,                           -- 구매가(원). 없으면 "식비 절감"을 측정 못 한다
  purchased_on     date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Seoul')::date,
  expiry_date      date NOT NULL,
  expiry_source    text NOT NULL DEFAULT 'manual' CHECK (expiry_source IN ('ocr','preset','manual')),

  storage          text NOT NULL DEFAULT 'fridge' CHECK (storage IN ('fridge','freezer','room','room_shade')),
  -- pending=사진 판독 후 확인 대기 / confirmed=냉장고에 있음 / ordered=주문함, 도착 예정
  status           text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending','confirmed','ordered')),

  -- 소진·폐기 (STRATEGY.md: 이걸 안 쌓으면 절감을 측정할 수 없고, 자산도 안 남는다)
  closed_on        date,
  outcome          text CHECK (outcome IN ('eaten','discarded')),
  discarded_amount numeric CHECK (discarded_amount >= 0),

  ocr_text         text,                          -- 확인 화면에서 대조용
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fridge_items_user_expiry ON fridge_items (user_id, expiry_date);
CREATE INDEX IF NOT EXISTS idx_fridge_items_user_status ON fridge_items (user_id, status);
CREATE INDEX IF NOT EXISTS idx_fridge_items_user_open   ON fridge_items (user_id) WHERE outcome IS NULL;

-- 레시피 캐시 — 전역 공유 카탈로그 (user_id 없음).
-- 하이브리드: 여기서 먼저 찾고, 없으면 LLM으로 생성해 여기 저장한다.
-- 한 사용자가 만든 레시피가 모두에게 남는다 = 쓸수록 LLM 호출이 줄어드는 플라이휠.
CREATE TABLE IF NOT EXISTS fridge_recipe_cache (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text UNIQUE NOT NULL,
  tag        text NOT NULL DEFAULT '어른' CHECK (tag IN ('아이','어른','건강')),
  mins       int  NOT NULL DEFAULT 20,
  emoji      text NOT NULL DEFAULT '🍽️',
  uses       jsonb NOT NULL,                    -- [{"ing":"두부","amt":300,"unit":"g"}] — servings 기준 양
  servings   int  NOT NULL DEFAULT 2,           -- 기준 인분 (UI서 인분 바꾸면 uses 양을 비례 스케일)
  core_ings  text[] NOT NULL,                   -- uses의 재료명만 정렬 — 부분집합 매칭용
  seasonings text[] NOT NULL DEFAULT '{}',      -- 집에 있다고 가정하는 양념 (주문 대상 아님)
  steps      jsonb NOT NULL DEFAULT '[]',       -- 조리 단계
  source     text NOT NULL DEFAULT 'llm' CHECK (source IN ('llm','seed','byname')),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- core_ings 배열 겹침(&&) 질의를 빠르게
CREATE INDEX IF NOT EXISTS idx_recipe_core_ings ON fridge_recipe_cache USING gin (core_ings);
CREATE INDEX IF NOT EXISTS idx_recipe_tag ON fridge_recipe_cache (tag);

-- 보관기간 프리셋 시드
-- freezer 행이 없는 재료 = 얼리면 못 쓰는 재료 (두부·감자·달걀·우유·오이·상추·토마토)
INSERT INTO fridge_shelf_life (ingredient, storage, days) VALUES
  ('양파','room_shade',60), ('양파','fridge',30), ('양파','freezer',90),
  ('감자','room_shade',45), ('감자','fridge',21),
  ('고구마','room_shade',30),
  ('대파','fridge',14),     ('대파','freezer',90),
  ('마늘','room_shade',90), ('마늘','fridge',60), ('마늘','freezer',180),
  ('당근','fridge',30),     ('당근','freezer',90),
  ('애호박','fridge',10),   ('애호박','freezer',60),
  ('오이','fridge',7),
  ('상추','fridge',5),
  ('시금치','fridge',5),    ('시금치','freezer',60),
  ('배추','fridge',14),
  ('무','fridge',21),
  ('브로콜리','fridge',7),  ('브로콜리','freezer',90),
  ('버섯','fridge',7),      ('버섯','freezer',60),
  ('파프리카','fridge',10), ('파프리카','freezer',60),
  ('토마토','room',5),      ('토마토','fridge',10),
  ('콩나물','fridge',3),
  ('부추','fridge',5),

  ('사과','fridge',30),     ('사과','room',7),
  ('배','fridge',30),
  ('바나나','room',5),      ('바나나','freezer',60),
  ('딸기','fridge',3),      ('딸기','freezer',90),
  ('포도','fridge',7),
  ('귤','room_shade',14),   ('귤','fridge',21),

  ('돼지고기','fridge',3),  ('돼지고기','freezer',90),
  ('소고기','fridge',3),    ('소고기','freezer',120),
  ('닭고기','fridge',2),    ('닭고기','freezer',90),
  ('다짐육','fridge',1),    ('다짐육','freezer',60),
  ('생선','fridge',2),      ('생선','freezer',60),
  ('새우','fridge',2),      ('새우','freezer',90),

  ('우유','fridge',10),
  ('달걀','fridge',30),
  ('두부','fridge',7),
  ('치즈','fridge',30),     ('치즈','freezer',60),
  ('요거트','fridge',14),
  ('버터','fridge',60),     ('버터','freezer',180),

  ('밥','fridge',2),        ('밥','freezer',30),
  ('식빵','room',3),        ('식빵','fridge',7), ('식빵','freezer',30)
ON CONFLICT (ingredient, storage) DO UPDATE SET days = EXCLUDED.days;

-- ── 기존 DB 마이그레이션 (여러 번 돌려도 안전) ──
-- 재고 status에 'ordered'(주문함, 도착 예정) 추가
ALTER TABLE fridge_items DROP CONSTRAINT IF EXISTS fridge_items_status_check;
ALTER TABLE fridge_items ADD CONSTRAINT fridge_items_status_check
  CHECK (status IN ('pending','confirmed','ordered'));

-- 레시피에 기준 인분(servings) + source에 'byname' 허용
ALTER TABLE fridge_recipe_cache ADD COLUMN IF NOT EXISTS servings int NOT NULL DEFAULT 2;
ALTER TABLE fridge_recipe_cache DROP CONSTRAINT IF EXISTS fridge_recipe_cache_source_check;
ALTER TABLE fridge_recipe_cache ADD CONSTRAINT fridge_recipe_cache_source_check
  CHECK (source IN ('llm','seed','byname'));

-- ordered 항목을 빠르게 (곧 도착 목록)
CREATE INDEX IF NOT EXISTS idx_fridge_items_user_ordered
  ON fridge_items (user_id) WHERE status = 'ordered' AND outcome IS NULL;
