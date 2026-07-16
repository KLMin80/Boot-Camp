// 단군마켓 — API 서버
//
// 이 파일이 보안 경계다. pooler 연결은 postgres 역할로 붙어 RLS를 우회하므로,
// "본인만 수정/삭제" 같은 소유권 규칙은 전부 SQL의 WHERE user_id = $N 으로 강제한다.
// 정적 서빙도 allowlist 로만 — 안 그러면 GET /.env 로 키가 통째로 샌다.

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = (process.env.JWT_SECRET || '').trim();
if (!JWT_SECRET) {
  console.error('.env에 JWT_SECRET이 없습니다.');
  process.exit(1);
}

// ImageKit (상품 이미지). PRIVATE 키는 서버에서만 서명에 쓰고 클라엔 절대 안 준다.
const IK_ENDPOINT = (process.env.IMAGEKIT_URL_ENDPOINT || '').trim().replace(/\/+$/, '');
const IK_PUBLIC = (process.env.IMAGEKIT_PUBLIC_KEY || '').trim();
const IK_PRIVATE = (process.env.IMAGEKIT_PRIVATE_KEY || '').trim();

app.use(express.json({ limit: '1mb' })); // 이미지는 ImageKit로 직접 올라가므로 본문은 작다.

const CATEGORIES = [
  '디지털기기', '생활가전', '가구/인테리어', '유아동', '의류',
  '뷰티/미용', '스포츠/레저', '취미/게임/음반', '도서',
  '생활/주방', '반려동물용품', '식물', '기타 중고물품',
];

/* ───────────────── 인증 ───────────────── */
const sign = (id) => jwt.sign({ uid: String(id) }, JWT_SECRET, { expiresIn: '30d' });

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: '로그인이 필요합니다.' });
  try {
    req.userId = String(jwt.verify(token, JWT_SECRET).uid);
    next();
  } catch {
    return res.status(401).json({ error: '로그인이 만료됐습니다. 다시 로그인해 주세요.' });
  }
}

const USER_PUBLIC = `id, email, nickname, region, manner_temp::float8 AS manner_temp,
  to_char(created_at, 'YYYY-MM-DD') AS joined_on`;

async function loadUser(id) {
  const r = await pool.query(`SELECT ${USER_PUBLIC} FROM dangun_users WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

app.post('/api/auth/signup', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const nickname = String(req.body.nickname || '').trim();
  const region = String(req.body.region || '').trim();
  const lat = req.body.lat != null ? Number(req.body.lat) : null;
  const lon = req.body.lon != null ? Number(req.body.lon) : null;

  if (!email.includes('@')) return res.status(400).json({ error: '이메일 형식을 확인해 주세요.' });
  if (password.length < 6) return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다.' });
  if (!nickname) return res.status(400).json({ error: '닉네임을 입력해 주세요.' });
  if (!region) return res.status(400).json({ error: '동네를 설정해 주세요.' });

  const hash = await bcrypt.hash(password, 10);
  try {
    const r = await pool.query(
      `INSERT INTO dangun_users (email, password_hash, nickname, region, lat, lon)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [email, hash, nickname, region, lat, lon]
    );
    res.status(201).json({ token: sign(r.rows[0].id), user: await loadUser(r.rows[0].id) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: '이미 가입된 이메일입니다.' });
    throw e;
  }
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const r = await pool.query('SELECT id, password_hash FROM dangun_users WHERE email = $1', [email]);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(password, u.password_hash))) {
    return res.status(401).json({ error: '이메일 또는 비밀번호가 맞지 않습니다.' });
  }
  res.json({ token: sign(u.id), user: await loadUser(u.id) });
});

app.get('/api/auth/me', auth, async (req, res) => {
  const u = await loadUser(req.userId);
  if (!u) return res.status(401).json({ error: '로그인이 필요합니다.' });
  res.json({ user: u });
});

// 동네 변경 (마이페이지)
app.patch('/api/auth/region', auth, async (req, res) => {
  const region = String(req.body.region || '').trim();
  if (!region) return res.status(400).json({ error: '동네를 입력해 주세요.' });
  const lat = req.body.lat != null ? Number(req.body.lat) : null;
  const lon = req.body.lon != null ? Number(req.body.lon) : null;
  await pool.query('UPDATE dangun_users SET region=$1, lat=$2, lon=$3 WHERE id=$4',
    [region, lat, lon, req.userId]);
  res.json({ user: await loadUser(req.userId) });
});

/* ───────────────── 위치 인증 (역지오코딩) ─────────────────
   브라우저 geolocation 좌표 → 동네 이름. 키 없는 Nominatim(OSM)을 서버가 호출
   (CORS 회피 + User-Agent 요구 충족). 실패해도 앱은 직접 입력으로 진행 가능. */
app.post('/api/geo/reverse', async (req, res) => {
  const lat = Number(req.body.lat), lon = Number(req.body.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: '좌표가 올바르지 않습니다.' });
  }
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}` +
      `&format=json&accept-language=ko&zoom=18&addressdetails=1`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'DangunMarket/1.0 (bootcamp clone demo)' },
      signal: AbortSignal.timeout(4500),
    });
    if (!r.ok) throw new Error('geocode ' + r.status);
    const a = (await r.json()).address || {};
    const dong = a.quarter || a.neighbourhood || a.suburb || a.village || a.town || a.city_district;
    const gu = a.city_district || a.borough || a.county || '';
    const city = a.city || a.province || a.state || '';
    const region = dong || gu || city;
    if (!region) return res.status(404).json({ error: '동네를 찾지 못했어요. 직접 입력해 주세요.' });
    res.json({ region, full: [city, gu, dong].filter(Boolean).join(' ') });
  } catch {
    res.status(502).json({ error: '위치 확인에 실패했어요. 직접 입력해 주세요.' });
  }
});

/* ───────────────── ImageKit 업로드 서명 ─────────────────
   클라가 이 서명으로 ImageKit에 직접 업로드한다. 이미지 바이트는 우리 서버를 안 거친다.
   응답엔 signature/publicKey/urlEndpoint 만 — PRIVATE 키는 절대 X. */
app.get('/api/imagekit/auth', auth, (req, res) => {
  if (!IK_PRIVATE) return res.status(500).json({ error: '이미지 업로드 설정이 없습니다.' });
  const token = crypto.randomUUID();
  const expire = Math.floor(Date.now() / 1000) + 40 * 60; // 최대 1h
  const signature = crypto.createHmac('sha1', IK_PRIVATE).update(token + expire).digest('hex');
  res.json({ token, expire, signature, publicKey: IK_PUBLIC, urlEndpoint: IK_ENDPOINT });
});

// 클라가 보낸 이미지 URL이 우리 ImageKit 것인지 검증 (임의 URL 저장 차단)
function validImageUrls(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((u) => String(u || '').trim())
    .filter((u) => IK_ENDPOINT && u.startsWith(IK_ENDPOINT + '/'))
    .slice(0, 3);
}

/* ───────────────── 상품 ───────────────── */
const LIST_COLS = `
  p.id, p.title, p.price, p.category, p.region, p.status,
  p.created_at, p.view_count,
  (SELECT url FROM dangun_product_images i WHERE i.product_id = p.id
     ORDER BY i.sort_order, i.id LIMIT 1) AS thumb,
  (SELECT COUNT(*)::int FROM dangun_favorites f WHERE f.product_id = p.id) AS fav_count,
  (SELECT COUNT(*)::int FROM dangun_chats  c WHERE c.product_id = p.id) AS chat_count`;

// 목록: 최신순 + 카테고리 필터 + 키워드 검색 (동네는 표시만, 하드필터 X — 데모 피드가 비지 않게)
app.get('/api/products', auth, async (req, res) => {
  const category = req.query.category ? String(req.query.category) : null;
  const q = req.query.q ? String(req.query.q).trim() : null;
  const r = await pool.query(
    `SELECT ${LIST_COLS}
       FROM dangun_products p
      WHERE ($1::text IS NULL OR p.category = $1)
        AND ($2::text IS NULL OR p.title ILIKE '%'||$2||'%' OR p.description ILIKE '%'||$2||'%')
      ORDER BY p.created_at DESC
      LIMIT 100`,
    [category, q]
  );
  res.json({ products: r.rows, categories: CATEGORIES });
});

app.post('/api/products', auth, async (req, res) => {
  const title = String(req.body.title || '').trim();
  const description = String(req.body.description || '').trim();
  const category = String(req.body.category || '').trim();
  const price = Math.max(0, Math.floor(Number(req.body.price) || 0));
  const images = validImageUrls(req.body.images);

  if (!title) return res.status(400).json({ error: '제목을 입력해 주세요.' });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: '카테고리를 선택해 주세요.' });

  const me = await loadUser(req.userId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = await client.query(
      `INSERT INTO dangun_products (user_id, title, price, description, category, region)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.userId, title, price, description, category, me.region]
    );
    const id = p.rows[0].id;
    for (let i = 0; i < images.length; i++) {
      await client.query(
        'INSERT INTO dangun_product_images (product_id, url, sort_order) VALUES ($1,$2,$3)',
        [id, images[i], i]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ id: String(id) });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

// 상세: 이미지 전체 + 작성자 + 관심수/관심여부 + 소유여부. (소유자가 아니면 조회수 +1)
app.get('/api/products/:id', auth, async (req, res) => {
  const id = req.params.id;
  const pr = await pool.query(
    `SELECT p.*, u.nickname AS author_nick, u.region AS author_region,
            u.manner_temp::float8 AS author_manner
       FROM dangun_products p JOIN dangun_users u ON u.id = p.user_id
      WHERE p.id = $1`,
    [id]
  );
  const p = pr.rows[0];
  if (!p) return res.status(404).json({ error: '없는 상품입니다.' });

  const isOwner = String(p.user_id) === req.userId;
  if (!isOwner) {
    await pool.query('UPDATE dangun_products SET view_count = view_count + 1 WHERE id=$1', [id]);
    p.view_count += 1;
  }

  const imgs = await pool.query(
    'SELECT url FROM dangun_product_images WHERE product_id=$1 ORDER BY sort_order, id', [id]
  );
  const fav = await pool.query(
    `SELECT COUNT(*)::int AS n, BOOL_OR(user_id = $2) AS mine
       FROM dangun_favorites WHERE product_id = $1`,
    [id, req.userId]
  );
  const chat = await pool.query('SELECT COUNT(*)::int AS n FROM dangun_chats WHERE product_id=$1', [id]);

  res.json({
    product: {
      id: String(p.id),
      user_id: String(p.user_id),
      title: p.title, price: p.price, description: p.description,
      category: p.category, region: p.region, status: p.status,
      view_count: p.view_count, created_at: p.created_at,
      images: imgs.rows.map((r) => r.url),
      author: { nickname: p.author_nick, region: p.author_region, manner_temp: p.author_manner },
      fav_count: fav.rows[0].n,
      favorited: !!fav.rows[0].mine,
      chat_count: chat.rows[0].n,
      is_owner: isOwner,
    },
  });
});

// 수정: 본인만 (WHERE user_id 로 강제). images 배열이 오면 통째로 교체.
app.patch('/api/products/:id', auth, async (req, res) => {
  const id = req.params.id;
  const own = await pool.query('SELECT id FROM dangun_products WHERE id=$1 AND user_id=$2', [id, req.userId]);
  if (!own.rowCount) return res.status(404).json({ error: '없거나 권한이 없는 상품입니다.' });

  const sets = [], params = [];
  const b = req.body || {};
  if (b.title !== undefined) { params.push(String(b.title).trim()); sets.push(`title=$${params.length}`); }
  if (b.description !== undefined) { params.push(String(b.description).trim()); sets.push(`description=$${params.length}`); }
  if (b.price !== undefined) { params.push(Math.max(0, Math.floor(Number(b.price) || 0))); sets.push(`price=$${params.length}`); }
  if (b.category !== undefined) {
    if (!CATEGORIES.includes(String(b.category))) return res.status(400).json({ error: '카테고리를 선택해 주세요.' });
    params.push(String(b.category)); sets.push(`category=$${params.length}`);
  }
  if (b.status !== undefined) {
    if (!['selling', 'reserved', 'sold'].includes(b.status)) return res.status(400).json({ error: '상태값이 올바르지 않습니다.' });
    params.push(b.status); sets.push(`status=$${params.length}`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (sets.length) {
      params.push(id, req.userId);
      await client.query(
        `UPDATE dangun_products SET ${sets.join(', ')}
          WHERE id=$${params.length - 1} AND user_id=$${params.length}`, params);
    }
    if (b.images !== undefined) {
      const images = validImageUrls(b.images);
      await client.query('DELETE FROM dangun_product_images WHERE product_id=$1', [id]);
      for (let i = 0; i < images.length; i++) {
        await client.query('INSERT INTO dangun_product_images (product_id, url, sort_order) VALUES ($1,$2,$3)',
          [id, images[i], i]);
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  res.json({ ok: true });
});

// 거래 상태만 빠르게 변경 (판매중/예약중/판매완료)
app.post('/api/products/:id/status', auth, async (req, res) => {
  const status = req.body.status;
  if (!['selling', 'reserved', 'sold'].includes(status)) {
    return res.status(400).json({ error: '상태값이 올바르지 않습니다.' });
  }
  const r = await pool.query(
    'UPDATE dangun_products SET status=$1 WHERE id=$2 AND user_id=$3 RETURNING status',
    [status, req.params.id, req.userId]
  );
  if (!r.rowCount) return res.status(404).json({ error: '없거나 권한이 없는 상품입니다.' });
  res.json({ status: r.rows[0].status });
});

app.delete('/api/products/:id', auth, async (req, res) => {
  const r = await pool.query('DELETE FROM dangun_products WHERE id=$1 AND user_id=$2',
    [req.params.id, req.userId]);
  if (!r.rowCount) return res.status(404).json({ error: '없거나 권한이 없는 상품입니다.' });
  res.status(204).end();
});

/* ───────────────── 관심(찜) ───────────────── */
app.post('/api/products/:id/favorite', auth, async (req, res) => {
  const id = req.params.id;
  const exists = await pool.query('SELECT id FROM dangun_products WHERE id=$1', [id]);
  if (!exists.rowCount) return res.status(404).json({ error: '없는 상품입니다.' });

  const del = await pool.query(
    'DELETE FROM dangun_favorites WHERE user_id=$1 AND product_id=$2', [req.userId, id]);
  if (!del.rowCount) {
    await pool.query('INSERT INTO dangun_favorites (user_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [req.userId, id]);
  }
  const c = await pool.query('SELECT COUNT(*)::int AS n FROM dangun_favorites WHERE product_id=$1', [id]);
  res.json({ favorited: del.rowCount === 0, fav_count: c.rows[0].n });
});

app.get('/api/me/favorites', auth, async (req, res) => {
  const r = await pool.query(
    `SELECT ${LIST_COLS}
       FROM dangun_favorites fv JOIN dangun_products p ON p.id = fv.product_id
      WHERE fv.user_id = $1
      ORDER BY fv.created_at DESC`,
    [req.userId]
  );
  res.json({ products: r.rows });
});

app.get('/api/me/products', auth, async (req, res) => {
  const r = await pool.query(
    `SELECT ${LIST_COLS} FROM dangun_products p
      WHERE p.user_id = $1 ORDER BY p.created_at DESC`,
    [req.userId]
  );
  res.json({ products: r.rows });
});

/* ───────────────── 채팅 (1:1) ───────────────── */
// 상품 상세 "채팅하기" → 방 생성 or 기존 방 반환. 본인 상품엔 불가.
app.post('/api/products/:id/chat', auth, async (req, res) => {
  const pr = await pool.query('SELECT user_id FROM dangun_products WHERE id=$1', [req.params.id]);
  if (!pr.rowCount) return res.status(404).json({ error: '없는 상품입니다.' });
  const sellerId = String(pr.rows[0].user_id);
  if (sellerId === req.userId) return res.status(400).json({ error: '본인 상품에는 채팅할 수 없어요.' });

  await pool.query(
    `INSERT INTO dangun_chats (product_id, buyer_id, seller_id) VALUES ($1,$2,$3)
     ON CONFLICT (product_id, buyer_id) DO NOTHING`,
    [req.params.id, req.userId, sellerId]
  );
  const c = await pool.query(
    'SELECT id FROM dangun_chats WHERE product_id=$1 AND buyer_id=$2', [req.params.id, req.userId]);
  res.status(201).json({ chat_id: String(c.rows[0].id) });
});

// 내 채팅 목록 (구매자든 판매자든) — 상대·상품·마지막 메시지
app.get('/api/chats', auth, async (req, res) => {
  const r = await pool.query(
    `SELECT c.id, c.product_id, p.title, p.status AS product_status,
            (SELECT url FROM dangun_product_images i WHERE i.product_id=p.id
               ORDER BY i.sort_order, i.id LIMIT 1) AS thumb,
            (c.buyer_id = $1) AS i_am_buyer,
            ou.nickname AS other_nick, ou.region AS other_region,
            m.body AS last_body, m.created_at AS last_at
       FROM dangun_chats c
       JOIN dangun_products p ON p.id = c.product_id
       JOIN dangun_users ou ON ou.id = CASE WHEN c.buyer_id=$1 THEN c.seller_id ELSE c.buyer_id END
       LEFT JOIN LATERAL (
         SELECT body, created_at FROM dangun_messages WHERE chat_id=c.id ORDER BY id DESC LIMIT 1
       ) m ON true
      WHERE c.buyer_id=$1 OR c.seller_id=$1
      ORDER BY COALESCE(m.created_at, c.created_at) DESC`,
    [req.userId]
  );
  res.json({
    chats: r.rows.map((x) => ({
      id: String(x.id), product_id: String(x.product_id), title: x.title,
      product_status: x.product_status, thumb: x.thumb, i_am_buyer: x.i_am_buyer,
      other: { nickname: x.other_nick, region: x.other_region },
      last_body: x.last_body, last_at: x.last_at,
    })),
  });
});

async function chatGuard(chatId, userId) {
  const r = await pool.query(
    `SELECT c.id, c.product_id, c.buyer_id, c.seller_id, p.title, p.price, p.status,
            (SELECT url FROM dangun_product_images i WHERE i.product_id=p.id
               ORDER BY i.sort_order, i.id LIMIT 1) AS thumb
       FROM dangun_chats c JOIN dangun_products p ON p.id=c.product_id
      WHERE c.id=$1 AND (c.buyer_id=$2 OR c.seller_id=$2)`,
    [chatId, userId]
  );
  return r.rows[0] || null;
}

app.get('/api/chats/:id', auth, async (req, res) => {
  const c = await chatGuard(req.params.id, req.userId);
  if (!c) return res.status(404).json({ error: '없거나 참여하지 않은 채팅입니다.' });
  const otherId = String(c.buyer_id) === req.userId ? c.seller_id : c.buyer_id;
  const ou = await pool.query(
    'SELECT nickname, region, manner_temp::float8 AS manner_temp FROM dangun_users WHERE id=$1', [otherId]);
  res.json({
    chat: {
      id: String(c.id),
      i_am_buyer: String(c.buyer_id) === req.userId,
      product: { id: String(c.product_id), title: c.title, price: c.price, status: c.status, thumb: c.thumb },
      other: ou.rows[0] || { nickname: '탈퇴한 사용자', region: '', manner_temp: 36.5 },
    },
  });
});

// polling: ?after=<마지막으로 받은 메시지 id> → 그 이후 메시지만
app.get('/api/chats/:id/messages', auth, async (req, res) => {
  const c = await chatGuard(req.params.id, req.userId);
  if (!c) return res.status(404).json({ error: '없거나 참여하지 않은 채팅입니다.' });
  const after = Math.max(0, Math.floor(Number(req.query.after) || 0));
  const r = await pool.query(
    `SELECT id, sender_id, body, created_at FROM dangun_messages
      WHERE chat_id=$1 AND id > $2 ORDER BY id ASC`,
    [req.params.id, after]
  );
  res.json({
    messages: r.rows.map((m) => ({
      id: String(m.id), body: m.body, created_at: m.created_at,
      mine: String(m.sender_id) === req.userId,
    })),
  });
});

app.post('/api/chats/:id/messages', auth, async (req, res) => {
  const c = await chatGuard(req.params.id, req.userId);
  if (!c) return res.status(404).json({ error: '없거나 참여하지 않은 채팅입니다.' });
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: '메시지를 입력해 주세요.' });
  const r = await pool.query(
    'INSERT INTO dangun_messages (chat_id, sender_id, body) VALUES ($1,$2,$3) RETURNING id, created_at',
    [req.params.id, req.userId, body]
  );
  res.status(201).json({ message: { id: String(r.rows[0].id), body, created_at: r.rows[0].created_at, mine: true } });
});

/* ───────────────── 정적 서빙 (allowlist) ─────────────────
   express.static 으로 폴더를 통째로 열면 GET /.env 로 키가 샌다.
   그래서 index.html 만 시작 시 1회 읽어 메모리에서 서빙한다. */
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
app.get(['/', '/index.html'], (req, res) => res.type('html').send(INDEX_HTML));

app.get('/api/health', async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: '서버에서 문제가 생겼습니다.' });
});

app.listen(PORT, () => {
  console.log(`단군마켓 → http://localhost:${PORT}`);
  console.log('⚠️ Live Server 말고 이 주소로 접속하세요. 아니면 /api/* 가 전부 404입니다.');
});
