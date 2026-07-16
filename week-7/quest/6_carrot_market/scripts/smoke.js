// E2E smoke — 실제 서버 + 실제 Supabase DB 로 계약을 검증한다. (목 없음)
// 사용법: 서버를 먼저 띄운 뒤 `npm run smoke`
require('dotenv').config();
const { pool } = require('../db');

const BASE = process.env.SMOKE_BASE || 'http://localhost:3000';
const IK = (process.env.IMAGEKIT_URL_ENDPOINT || '').replace(/\/+$/, '');
const ts = Date.now();
const sellerEmail = `smoke_seller_${ts}@dangun.test`;
const buyerEmail = `smoke_buyer_${ts}@dangun.test`;

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label); }
}
async function api(method, path, token, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

(async () => {
  console.log('BASE =', BASE);

  // health
  const h = await api('GET', '/api/health');
  ok(h.status === 200 && h.json.ok, 'health');

  // signup
  const s1 = await api('POST', '/api/auth/signup', null,
    { email: sellerEmail, password: 'test1234', nickname: '판매왕', region: '역삼동' });
  ok(s1.status === 201 && s1.json.token, 'seller 가입');
  const seller = s1.json.token;

  const s2 = await api('POST', '/api/auth/signup', null,
    { email: buyerEmail, password: 'test1234', nickname: '구매러', region: '삼성동' });
  ok(s2.status === 201 && s2.json.token, 'buyer 가입');
  const buyer = s2.json.token;

  // dup email → 409
  const dup = await api('POST', '/api/auth/signup', null,
    { email: sellerEmail, password: 'test1234', nickname: 'x', region: 'y' });
  ok(dup.status === 409, '중복 이메일 409');

  // login
  const lg = await api('POST', '/api/auth/login', null, { email: buyerEmail, password: 'test1234' });
  ok(lg.status === 200 && lg.json.token, 'buyer 로그인');

  // me
  const me = await api('GET', '/api/auth/me', buyer);
  ok(me.status === 200 && me.json.user.region === '삼성동', 'me (동네 반영)');

  // 상품 등록 (이미지 3장, IK endpoint prefix 라 검증 통과)
  const imgs = [`${IK}/dangun_market/a.jpg`, `${IK}/dangun_market/b.jpg`, `${IK}/dangun_market/c.jpg`];
  const cr = await api('POST', '/api/products', seller, {
    title: '스모크 자전거 삼천리', price: 55000, description: '거의 새것 접이식 자전거입니다',
    category: '스포츠/레저', images: imgs,
  });
  ok(cr.status === 201 && cr.json.id, '상품 등록');
  const pid = cr.json.id;

  // 임의 URL 이미지는 저장 안 됨 (보안)
  const cr2 = await api('POST', '/api/products', seller, {
    title: '악성URL 테스트', price: 0, description: '', category: '도서',
    images: ['https://evil.example.com/x.jpg'],
  });
  ok(cr2.status === 201, '악성 이미지 URL 상품도 생성은 되되');
  const badPid = cr2.json.id;
  const badDetail = await api('GET', `/api/products/${badPid}`, seller);
  ok(badDetail.json.product.images.length === 0, '  → 외부 URL 이미지는 걸러짐(0장)');

  // 목록 + 검색 + 카테고리 필터
  const list = await api('GET', '/api/products', buyer);
  ok(list.status === 200 && list.json.products.some((p) => String(p.id) === String(pid)), '목록에 노출(최신순)');
  const search = await api('GET', '/api/products?q=' + encodeURIComponent('삼천리'), buyer);
  ok(search.json.products.some((p) => String(p.id) === String(pid)), '키워드 검색');
  const cat = await api('GET', '/api/products?category=' + encodeURIComponent('스포츠/레저'), buyer);
  ok(cat.json.products.every((p) => p.category === '스포츠/레저'), '카테고리 필터');
  const catMiss = await api('GET', '/api/products?category=' + encodeURIComponent('도서'), buyer);
  ok(!catMiss.json.products.some((p) => String(p.id) === String(pid)), '다른 카테고리엔 안 나옴');

  // 상세 (조회수 +1, 작성자, 이미지 3장)
  const d1 = await api('GET', `/api/products/${pid}`, buyer);
  ok(d1.status === 200 && d1.json.product.images.length === 3, '상세 이미지 3장');
  ok(d1.json.product.author.nickname === '판매왕', '상세 작성자');
  ok(d1.json.product.is_owner === false && d1.json.product.view_count >= 1, '비소유자 조회수 증가');
  const dOwner = await api('GET', `/api/products/${pid}`, seller);
  ok(dOwner.json.product.is_owner === true, '소유자 판별');

  // 관심 토글
  const f1 = await api('POST', `/api/products/${pid}/favorite`, buyer);
  ok(f1.json.favorited === true && f1.json.fav_count === 1, '관심 등록');
  const f2 = await api('POST', `/api/products/${pid}/favorite`, buyer);
  ok(f2.json.favorited === false && f2.json.fav_count === 0, '관심 해제');
  await api('POST', `/api/products/${pid}/favorite`, buyer); // 다시 등록
  const myFav = await api('GET', '/api/me/favorites', buyer);
  ok(myFav.json.products.some((p) => String(p.id) === String(pid)), '관심 목록에 노출');

  // 채팅: 본인 상품엔 불가
  const selfChat = await api('POST', `/api/products/${pid}/chat`, seller);
  ok(selfChat.status === 400, '본인 상품 채팅 차단');

  // 구매자 → 채팅 시작 (재호출해도 같은 방)
  const c1 = await api('POST', `/api/products/${pid}/chat`, buyer);
  const c2 = await api('POST', `/api/products/${pid}/chat`, buyer);
  ok(c1.status === 201 && String(c1.json.chat_id) === String(c2.json.chat_id), '채팅방 생성(멱등)');
  const cid = c1.json.chat_id;

  // 판매자 채팅 목록에 노출
  const sellerChats = await api('GET', '/api/chats', seller);
  ok(sellerChats.json.chats.some((c) => String(c.id) === String(cid)), '판매자 채팅목록 노출');

  // 메시지 왕복 + polling(after)
  const m1 = await api('POST', `/api/chats/${cid}/messages`, buyer, { body: '안녕하세요 구매 가능할까요?' });
  ok(m1.status === 201, '구매자 메시지 전송');
  const sPoll = await api('GET', `/api/chats/${cid}/messages?after=0`, seller);
  ok(sPoll.json.messages.length === 1 && sPoll.json.messages[0].mine === false, '판매자 polling 수신(mine=false)');
  const lastId = sPoll.json.messages[sPoll.json.messages.length - 1].id;
  await api('POST', `/api/chats/${cid}/messages`, seller, { body: '네 가능합니다!' });
  const bPoll = await api('GET', `/api/chats/${cid}/messages?after=${lastId}`, buyer);
  ok(bPoll.json.messages.length === 1 && bPoll.json.messages[0].body === '네 가능합니다!', '구매자 polling 신규만 수신');

  // 참여자 아닌 사람은 접근 불가 — 제3자
  const s3 = await api('POST', '/api/auth/signup', null,
    { email: `smoke_third_${ts}@dangun.test`, password: 'test1234', nickname: '제3자', region: '역삼동' });
  const third = s3.json.token;
  const intrude = await api('GET', `/api/chats/${cid}/messages`, third);
  ok(intrude.status === 404, '제3자 채팅 접근 차단');

  // 소유권: 구매자는 남의 상품 수정 불가
  const badEdit = await api('PATCH', `/api/products/${pid}`, buyer, { title: '해킹' });
  ok(badEdit.status === 404, '비소유자 수정 차단(RLS 대체)');

  // 상태 변경(판매자)
  const st = await api('POST', `/api/products/${pid}/status`, seller, { status: 'sold' });
  ok(st.status === 200 && st.json.status === 'sold', '거래완료 상태 변경');

  // 마이페이지 내 상품
  const myProd = await api('GET', '/api/me/products', seller);
  ok(myProd.json.products.some((p) => String(p.id) === String(pid)), '내 등록 상품 목록');

  // 위치 역지오코딩 (역삼역 좌표) — 외부 서비스라 실패해도 앱은 직접입력으로 진행 → 경고만
  const geo = await api('POST', '/api/geo/reverse', null, { lat: 37.5006, lon: 127.0366 });
  if (geo.status === 200) ok(!!geo.json.region, '위치인증 역지오코딩: ' + geo.json.region);
  else console.log('  ⚠ 위치인증 역지오코딩 스킵(외부 Nominatim 응답', geo.status + ') — 직접입력으로 대체 가능');

  // ─── 정리 ───
  console.log('테스트 데이터 정리 중…');
  await pool.query('DELETE FROM dangun_products WHERE id = ANY($1)', [[pid, badPid]]);
  await pool.query('DELETE FROM dangun_users WHERE email LIKE $1', [`smoke_%_${ts}@dangun.test`]);
  await pool.end();

  console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('smoke 예외:', e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
