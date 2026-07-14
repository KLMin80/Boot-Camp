// schema.sql을 실제 DB에 적용한다. 여러 번 돌려도 안전(idempotent).
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('schema.sql 적용 완료');

  const t = await pool.query(
    "select tablename from pg_tables where schemaname='public' and tablename like 'fridge_%' order by tablename"
  );
  console.log('테이블:', t.rows.map((r) => r.tablename).join(', '));

  const s = await pool.query('select count(*)::int as n from fridge_shelf_life');
  const f = await pool.query(
    "select count(distinct ingredient)::int as n from fridge_shelf_life where storage='freezer'"
  );
  const all = await pool.query('select count(distinct ingredient)::int as n from fridge_shelf_life');
  console.log(`보관 프리셋 ${s.rows[0].n}행 · 재료 ${all.rows[0].n}종`);
  console.log(`그중 냉동 가능 ${f.rows[0].n}종 — 나머지는 얼리면 못 쓰는 재료`);

  await pool.end();
})().catch((e) => { console.error('실패:', e.code || '', e.message); process.exit(1); });
