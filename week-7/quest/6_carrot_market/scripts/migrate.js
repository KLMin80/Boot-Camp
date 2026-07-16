// schema.sql 을 실행해 dangun_* 테이블을 만든다. (여러 번 실행해도 안전)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await pool.query(sql);
  const r = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name LIKE 'dangun_%' ORDER BY table_name`
  );
  console.log('마이그레이션 완료. dangun_* 테이블:', r.rows.map((x) => x.table_name).join(', '));
  await pool.end();
})().catch((e) => {
  console.error('마이그레이션 실패:', e.message);
  process.exit(1);
});
