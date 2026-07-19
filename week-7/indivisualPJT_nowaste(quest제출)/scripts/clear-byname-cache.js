// 어휘 제한 버그로 잘못 생성된 byname 레시피 삭제 → 새 어휘로 재생성됨.
const { pool } = require('../db');
(async () => {
  const r = await pool.query("DELETE FROM fridge_recipe_cache WHERE source = 'byname' RETURNING title");
  console.log(`byname 레시피 ${r.rowCount}건 삭제:`, r.rows.map((x) => x.title).join(', ') || '(없음)');
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
