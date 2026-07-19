const { pool } = require('../db');

(async () => {
  const r = await pool.query(
    "select tablename from pg_tables where schemaname='public' order by tablename"
  );
  console.log(`기존 public 테이블 ${r.rowCount}개`);
  console.log(r.rows.map((x) => x.tablename).join(', ') || '(없음)');

  const mine = r.rows.filter((x) => x.tablename.startsWith('fridge_'));
  console.log('\nfridge_ 접두:', mine.length ? mine.map((x) => x.tablename).join(', ') : '없음 → 충돌 없음');
  await pool.end();
})().catch((e) => { console.error('실패:', e.code || '', e.message); process.exit(1); });
