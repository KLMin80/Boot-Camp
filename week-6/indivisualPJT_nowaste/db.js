// DB 연결 한 곳. server.js와 스크립트가 같이 쓴다.
require('dotenv').config();
const { Pool } = require('pg');

const url = process.env.SUPABASE_DB_URL || process.env.DB_URL;
if (!url) {
  console.error('.env에 SUPABASE_DB_URL이 없습니다.');
  process.exit(1);
}

// 비밀번호에 @ ! 같은 특수문자가 있으면 connectionString이 authority를 오파싱한다.
// URL을 직접 분해해 개별 필드로 넘긴다. (DEV.md 함정 5)
const u = new URL(url);
const pool = new Pool({
  host: u.hostname,
  port: Number(u.port || 5432),
  user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
  database: u.pathname.slice(1) || 'postgres',
  ssl: { rejectUnauthorized: false }, // Supabase는 SSL 필수
  max: 5,
});

pool.on('error', (e) => console.error('[pg pool]', e.message));

module.exports = { pool };
