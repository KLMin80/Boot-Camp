// ============================================================================
// migrate-images.js — 상품 이미지를 ImageKit 으로 이관하는 1회성 스크립트
//
//   실행:  node migrate-images.js
//
//   하는 일:
//     1) shop_products 에서 image_url 이 우리 ImageKit 엔드포인트가 아닌 행을 찾는다.
//     2) 그 URL 을 ImageKit 서버 업로드 API 로 보낸다.
//        (ImageKit 은 file 필드에 "원격 URL" 을 주면 자기가 직접 내려받아 저장한다.
//         → 우리가 이미지를 다운로드했다가 다시 올릴 필요가 없다.)
//     3) 돌아온 ImageKit URL 로 DB 의 image_url 을 갱신한다.
//
//   멱등(idempotent): 이미 ImageKit URL 인 행은 건너뛴다. 여러 번 돌려도 안전하다.
//   PRIVATE_KEY 는 이 스크립트(서버 사이드)에서만 쓰이며 출력하지 않는다.
// ============================================================================

const path = require('path');
const { Pool } = require('pg');

process.loadEnvFile(path.join(__dirname, '.env'));

const DB_URL = (process.env.SUPABASE_DB_URL || process.env.DB_URL || '').trim();
const IK_URL_ENDPOINT = (process.env.URL_ENDPOINT || '').trim().replace(/\/+$/, '');
const IK_PRIVATE_KEY = (process.env.PRIVATE_KEY || '').trim();

const IK_UPLOAD_URL = 'https://upload.imagekit.io/api/v1/files/upload';
const FOLDER = '/shop/products'; // ImageKit 안의 정리용 폴더

if (!DB_URL) {
  console.error('[FATAL] .env 의 SUPABASE_DB_URL 이 없습니다.');
  process.exit(1);
}
if (!IK_URL_ENDPOINT || !IK_PRIVATE_KEY) {
  console.error('[FATAL] .env 의 URL_ENDPOINT / PRIVATE_KEY 가 필요합니다.');
  process.exit(1);
}

const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false }, max: 2 });

// 한글 상품명 → ImageKit 파일명으로 쓸 ASCII slug.
//   ImageKit 은 파일명에 허용되지 않는 문자를 자동 치환하지만, 결과 URL 이 예측 가능하도록 우리가 먼저 정리한다.
function toFileName(id, name) {
  const ascii = String(name)
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')   // 한글/특수문자 제거
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();
  // 한글 상품명은 slug 가 통째로 비게 된다 → 그때는 id 만으로 이름을 짓는다.
  return ascii ? `product-${id}-${ascii}.jpg` : `product-${id}.jpg`;
}

// ImageKit 서버 업로드 — Authorization: Basic base64(PRIVATE_KEY + ':')
async function uploadFromUrl(sourceUrl, fileName) {
  const auth = 'Basic ' + Buffer.from(`${IK_PRIVATE_KEY}:`).toString('base64');

  const form = new FormData();
  form.append('file', sourceUrl);            // 원격 URL 을 그대로 전달 → ImageKit 이 fetch 해서 저장
  form.append('fileName', fileName);
  form.append('folder', FOLDER);
  form.append('useUniqueFileName', 'false'); // 같은 이름이면 덮어쓰기(재실행 시 사본 안 쌓이게)
  form.append('overwriteFile', 'true');

  const res = await fetch(IK_UPLOAD_URL, { method: 'POST', headers: { Authorization: auth }, body: form });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message || text; } catch (_) {}
    throw new Error(`ImageKit 업로드 실패 (HTTP ${res.status}): ${msg}`);
  }
  const data = JSON.parse(text);
  // data.url 에는 ?updatedAt=... 쿼리가 붙을 수 있다 → 시드/DB 에는 깔끔한 URL 만 저장.
  return String(data.url).split('?')[0];
}

(async () => {
  const { rows } = await pool.query(
    'SELECT id, name, image_url FROM shop_products ORDER BY id ASC'
  );

  const pending = rows.filter((r) => !String(r.image_url).startsWith(`${IK_URL_ENDPOINT}/`));
  console.log(`상품 ${rows.length}개 중 이관 대상 ${pending.length}개`);

  if (pending.length === 0) {
    console.log('이미 전부 ImageKit URL 입니다. 할 일이 없습니다.');
    await pool.end();
    return;
  }

  const results = [];
  for (const row of pending) {
    const fileName = toFileName(row.id, row.name);
    process.stdout.write(`  [${row.id}] ${row.name} → ${fileName} ... `);
    try {
      const newUrl = await uploadFromUrl(row.image_url, fileName);
      await pool.query('UPDATE shop_products SET image_url = $1 WHERE id = $2', [newUrl, row.id]);
      console.log('OK');
      results.push({ id: row.id, name: row.name, url: newUrl });
    } catch (err) {
      console.log('실패');
      console.error(`      ${err.message}`);
    }
  }

  console.log('\n=== 새 ImageKit URL (server.js 의 SEED_PRODUCTS 에 반영) ===');
  results.forEach((r) => console.log(`${r.id}\t${r.url}`));
  console.log(`\n완료: ${results.length}/${pending.length}`);

  await pool.end();
})().catch(async (err) => {
  console.error('[FATAL]', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
