// 배포 검증 중 만든 테스트 계정 삭제 (비번이 대화/스크립트에 노출됨).
// fridge_items는 user_id ON DELETE CASCADE라 재고도 함께 삭제된다.
const { pool } = require('../db');

// 테스트 스크립트가 쓰는 도메인만 정리 (@test.com / @t.com / @nowaste.app).
// ⚠️ 실제 사용자 이메일(예: 개인 네이버 메일)은 절대 넣지 말 것 — 진짜 계정·데이터가 지워진다.
const TEST_EMAILS_LIKE = ['%@nowaste.app', '%@test.com', '%@t.com'];
const TEST_EMAILS_EXACT = [];

(async () => {
  const like = TEST_EMAILS_LIKE.map((_, i) => `email LIKE $${i + 1}`).join(' OR ');
  const exact = TEST_EMAILS_EXACT.map((_, i) => `$${TEST_EMAILS_LIKE.length + i + 1}`).join(',');
  const params = [...TEST_EMAILS_LIKE, ...TEST_EMAILS_EXACT];

  const found = await pool.query(
    `SELECT email FROM fridge_users WHERE (${like}) OR email IN (${exact}) ORDER BY email`, params);
  console.log(`삭제 대상 ${found.rowCount}건:`);
  found.rows.forEach((r) => console.log('  -', r.email));

  const del = await pool.query(
    `DELETE FROM fridge_users WHERE (${like}) OR email IN (${exact})`, params);
  console.log(`\n삭제 완료: ${del.rowCount}건 (재고도 CASCADE로 함께 삭제)`);

  const left = await pool.query('SELECT count(*)::int n FROM fridge_users');
  console.log(`남은 계정: ${left.rows[0].n}건`);
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
