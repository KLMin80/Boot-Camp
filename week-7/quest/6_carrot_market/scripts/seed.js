// 데모 데이터 시드 — 유저/상품/이미지(ImageKit 실제 업로드)/관심/채팅.
// 재실행 안전: @dangun.test 시드 유저를 지우고(cascade) 새로 만든다.
// 사용법: node scripts/seed.js
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

const IK_PRIVATE = process.env.IMAGEKIT_PRIVATE_KEY;
const IK_ENDPOINT = (process.env.IMAGEKIT_URL_ENDPOINT || '').replace(/\/+$/, '');
const sq = (u) => `${u}?fit=crop&w=1000&h=1000&q=75`; // 정사각 크롭

async function uploadRemote(remoteUrl, fileName) {
  // 이미 우리 ImageKit URL이면 그대로 사용
  if (remoteUrl.startsWith(IK_ENDPOINT)) return remoteUrl.split('?')[0];
  const auth = 'Basic ' + Buffer.from(IK_PRIVATE + ':').toString('base64');
  const fd = new FormData();
  fd.append('file', sq(remoteUrl));          // 원격 URL 문자열 → ImageKit이 직접 내려받아 저장
  fd.append('fileName', fileName);
  fd.append('folder', '/dangun_market/seed');
  fd.append('useUniqueFileName', 'true');
  const r = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
    method: 'POST', headers: { Authorization: auth }, body: fd,
  });
  const j = await r.json();
  if (!r.ok) throw new Error('ImageKit 업로드 실패: ' + (j.message || r.status));
  return (j.url || '').split('?')[0];
}

const UN = {
  iphone: 'https://images.unsplash.com/photo-1592750475338-74b7b21085ab',
  hand:   'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9',
  bike:   'https://images.unsplash.com/photo-1485965120184-e220f721d03e',
  sofa:   'https://images.unsplash.com/photo-1555041469-a586c61ea9bc',
  books:  'https://images.unsplash.com/photo-1512820790803-83ca734da794',
  books2: 'https://images.unsplash.com/photo-1607853202273-797f1c22a38e',
  plant:  'https://images.unsplash.com/photo-1485955900006-10f4d324d411',
  switch: 'https://images.unsplash.com/photo-1493711662062-fa541adb3fc8',
  switch2:'https://images.unsplash.com/photo-1578991624414-276ef23a534f',
};

(async () => {
  console.log('기존 시드 정리…');
  await pool.query(`DELETE FROM dangun_users WHERE email LIKE '%@dangun.test'`);

  const hash = await bcrypt.hash('demo1234', 10);
  async function addUser(email, nickname, region, manner) {
    const r = await pool.query(
      `INSERT INTO dangun_users (email, password_hash, nickname, region, manner_temp)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`, [email, hash, nickname, region, manner]);
    return r.rows[0].id;
  }
  console.log('유저 생성…');
  const demo  = await addUser('dangun.demo@dangun.test', '단군이',   '역삼동', 37.2);
  const panda = await addUser('seller.panda@dangun.test','행복한판다','역삼동', 42.5);
  const mint  = await addUser('seller.mint@dangun.test', '민트초코',  '삼성동', 39.0);
  const book  = await addUser('seller.book@dangun.test', '책방주인',  '역삼동', 36.5);

  console.log('이미지 업로드(ImageKit)…');
  const img = {};
  for (const [k, url] of Object.entries(UN)) {
    img[k] = await uploadRemote(url, 'seed_' + k + '.jpg');
    process.stdout.write(' ' + k);
  }
  console.log('\n상품 생성…');

  async function addProduct(uid, title, price, cat, desc, status, minsAgo, imgs) {
    const p = await pool.query(
      `INSERT INTO dangun_products (user_id,title,price,description,category,region,status,view_count,created_at)
       VALUES ($1,$2,$3,$4,$5,(SELECT region FROM dangun_users WHERE id=$1),$6,$7, now()-make_interval(mins=>$8))
       RETURNING id`,
      [uid, title, price, desc, cat, status, Math.floor(Math.random()*40)+3, minsAgo]);
    const id = p.rows[0].id;
    for (let i = 0; i < imgs.length; i++)
      await pool.query('INSERT INTO dangun_product_images (product_id,url,sort_order) VALUES ($1,$2,$3)', [id, imgs[i], i]);
    return id;
  }

  const pIphone = await addProduct(panda, '아이폰 13 128GB 미드나이트', 550000, '디지털기기',
    '2년 사용했고 케이스+필름 끼고 써서 상태 좋아요.\n배터리 성능 89%, 잔기스 거의 없습니다.\n역삼역 직거래 선호해요 :)', 'selling', 35, [img.iphone, img.hand]);
  const pBike = await addProduct(mint, '삼천리 접이식 자전거 팝니다', 85000, '스포츠/레저',
    '출퇴근용으로 잘 탔습니다. 접이식이라 보관 편해요.\n브레이크/체인 점검 완료했습니다.', 'selling', 180, [img.bike]);
  await addProduct(panda, '무인양품 3인용 패브릭 소파', 120000, '가구/인테리어',
    '이사 가면서 내놓습니다. 직접 가져가실 분 우대!\n오염 거의 없고 쿠션감 좋아요.', 'sold', 2880, [img.sofa]);
  await addProduct(book, '무라카미 하루키 소설 세트 (7권)', 30000, '도서',
    '깨끗하게 봤습니다. 상실의 시대 포함 7권 일괄 판매해요.', 'selling', 300, [img.books, img.books2]);
  await addProduct(mint, '몬스테라 대형 화분 무료 나눔해요', 0, '식물',
    '분갈이가 필요해서 키우실 분께 무료로 나눔합니다.\n상태 좋아요, 직접 가져가시면 됩니다!', 'selling', 1200, [img.plant]);
  await addProduct(demo, '닌텐도 스위치 OLED 화이트', 260000, '취미/게임/음반',
    '박스 풀구성이고 젤다 칩 같이 드려요.\n생활기스만 있는 깨끗한 상태입니다.', 'reserved', 480, [img.switch, img.switch2]);

  console.log('관심/채팅 생성…');
  await pool.query('INSERT INTO dangun_favorites (user_id, product_id) VALUES ($1,$2)', [demo, pBike]);

  const c = await pool.query(
    `INSERT INTO dangun_chats (product_id, buyer_id, seller_id, created_at)
     VALUES ($1,$2,$3, now()-make_interval(mins=>30)) RETURNING id`, [pIphone, demo, panda]);
  const cid = c.rows[0].id;
  const msgs = [
    [demo,  '안녕하세요! 아이폰 13 아직 판매하나요?', 28],
    [panda, '네 판매 중입니다 :)', 26],
    [demo,  '배터리 성능 89% 맞을까요? 직거래 가능한 시간대 있으신가요?', 24],
    [panda, '네 맞아요. 평일 저녁 7시 이후 역삼역에서 가능합니다!', 21],
    [demo,  '좋아요! 그럼 내일 저녁에 연락드릴게요 😊', 5],
  ];
  for (const [sid, body, minsAgo] of msgs)
    await pool.query(
      `INSERT INTO dangun_messages (chat_id, sender_id, body, created_at)
       VALUES ($1,$2,$3, now()-make_interval(mins=>$4))`, [cid, sid, body, minsAgo]);

  const cnt = await pool.query(`SELECT
    (SELECT count(*) FROM dangun_products p JOIN dangun_users u ON u.id=p.user_id WHERE u.email LIKE '%@dangun.test')::int AS products,
    (SELECT count(*) FROM dangun_users WHERE email LIKE '%@dangun.test')::int AS users`);
  console.log('시드 완료:', cnt.rows[0]);
  console.log('로그인: dangun.demo@dangun.test / demo1234  (닉네임: 단군이)');
  await pool.end();
})().catch(async (e) => { console.error('시드 실패:', e); try{ await pool.end(); }catch{} process.exit(1); });
