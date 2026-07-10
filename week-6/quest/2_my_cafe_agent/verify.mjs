// 적재된 데이터가 컨셉과 맞는지, 정합성이 깨지지 않았는지 검증한다.
// pg는 AVG/SUM을 문자열로 돌려주므로 SQL에서 ::float8 / ::int 로 캐스팅한다.
import { createPool } from './db.mjs';

const pool = createPool();
const q = async (sql) => (await pool.query(sql)).rows;
const won = (n) => Math.round(n).toLocaleString('ko-KR');

try {
  console.log('=== 테이블별 행 수 ===');
  for (const t of ['cafe_menu', 'cafe_daily_sales', 'cafe_menu_sales', 'cafe_hourly_traffic',
    'cafe_reviews', 'cafe_inventory', 'cafe_purchase_orders', 'cafe_memberships']) {
    const [r] = await q(`select count(*)::int as n from ${t}`);
    console.log(`  ${t.padEnd(22)} ${String(r.n).padStart(5)} rows`);
  }

  console.log('\n=== 정합성 체크 ===');
  const [a] = await q(`
    select count(*)::int as mismatched from (
      select d.sale_date
      from cafe_daily_sales d
      join cafe_menu_sales m on m.sale_date = d.sale_date
      group by d.sale_date, d.product_revenue
      having sum(m.revenue)::int <> d.product_revenue
    ) x`);
  console.log(`  일별매출 = 메뉴판매합계 불일치: ${a.mismatched}일 ${a.mismatched === 0 ? '✅' : '❌'}`);

  const [b] = await q(`
    select count(*)::int as mismatched from (
      select d.sale_date
      from cafe_daily_sales d
      join cafe_hourly_traffic h on h.sale_date = d.sale_date
      group by d.sale_date, d.visitors
      having sum(h.visitors)::int <> d.visitors
    ) x`);
  console.log(`  일별손님 = 시간대합계 불일치: ${b.mismatched}일 ${b.mismatched === 0 ? '✅' : '❌'}`);

  // 영업시간: 평일 08~20시, 주말·공휴일 10~19시 밖에 손님이 찍히면 안 된다
  const [c] = await q(`
    select count(*)::int as bad
      from cafe_hourly_traffic h join cafe_daily_sales d using (sale_date)
     where (not d.is_weekend and not d.is_holiday and (h.hour < 8 or h.hour > 20))
        or ((d.is_weekend or d.is_holiday) and (h.hour < 10 or h.hour > 19))`);
  console.log(`  영업시간 밖 트래픽: ${c.bad}건 ${c.bad === 0 ? '✅' : '❌'}`);

  console.log('\n=== 요일별 평균 (공휴일 제외) — 주거상권: 주말↑, 월·금(재택)↑ ===');
  for (const r of await q(`
    select day_name, is_weekend,
           avg(visitors)::float8      as v,
           avg(orders)::float8        as o,
           avg(total_revenue)::float8 as rev
    from cafe_daily_sales where not is_holiday
    group by day_of_week, day_name, is_weekend order by day_of_week`)) {
    const bar = '█'.repeat(Math.round(r.v / 5));
    const tag = r.is_weekend ? '주말' : '평일';
    console.log(`  ${r.day_name}(${tag}) ${r.v.toFixed(0).padStart(4)}명  주문 ${r.o.toFixed(0).padStart(3)}건  ${won(r.rev).padStart(10)}원  ${bar}`);
  }

  const [wk] = await q(`
    select avg(total_revenue) filter (where not is_weekend)::float8 as weekday_rev,
           avg(total_revenue) filter (where is_weekend)::float8     as weekend_rev
      from cafe_daily_sales where not is_holiday`);
  const ratio = wk.weekend_rev / wk.weekday_rev;
  console.log(`  → 주말/평일 매출비: ${(ratio * 100).toFixed(0)}% ${ratio > 1 ? '✅ 주말이 성수기' : '❌ 컨셉과 불일치'}`);

  console.log('\n=== 공휴일 (주거상권: 평일보다 붐벼야 함) ===');
  for (const r of await q(`
    select to_char(sale_date,'MM-DD') as d, day_name, visitors, total_revenue
      from cafe_daily_sales where is_holiday order by sale_date`)) {
    console.log(`  ${r.d}(${r.day_name})  ${String(r.visitors).padStart(3)}명  ${won(r.total_revenue).padStart(10)}원`);
  }

  console.log('\n=== 평일 시간대별 손님 (출근길 파도 없음 · 10~11시, 13~15시 피크) ===');
  for (const r of await q(`
    select h.hour, avg(h.visitors)::float8 as v
    from cafe_hourly_traffic h join cafe_daily_sales d on d.sale_date = h.sale_date
    where not d.is_weekend and not d.is_holiday
    group by h.hour order by h.hour`)) {
    console.log(`  ${String(r.hour).padStart(2)}시  ${r.v.toFixed(1).padStart(5)}명  ${'▇'.repeat(Math.round(r.v * 2))}`);
  }

  console.log('\n=== 주말·공휴일 시간대별 손님 (12~16시 가족 피크) ===');
  for (const r of await q(`
    select h.hour, avg(h.visitors)::float8 as v
    from cafe_hourly_traffic h join cafe_daily_sales d on d.sale_date = h.sale_date
    where d.is_weekend or d.is_holiday
    group by h.hour order by h.hour`)) {
    console.log(`  ${String(r.hour).padStart(2)}시  ${r.v.toFixed(1).padStart(5)}명  ${'▇'.repeat(Math.round(r.v * 2))}`);
  }

  console.log('\n=== 객단가: 평일(1인 주문) vs 주말(가족 단위) ===');
  for (const r of await q(`
    select case when is_weekend or is_holiday then '주말·공휴일' else '평일' end as kind,
           sum(product_revenue)::float8 / sum(orders)::float8 as aov,
           sum(orders)::int as orders, sum(visitors)::int as visitors
      from cafe_daily_sales group by 1 order by 1`)) {
    console.log(`  ${r.kind.padEnd(7)} 객단가 ${won(r.aov).padStart(7)}원  (주문 ${r.orders}건 / 손님 ${r.visitors}명)`);
  }

  console.log('\n=== 메뉴별 판매량 TOP 5 ===');
  for (const r of await q(`
    select m.name, sum(s.qty)::int as qty, sum(s.revenue)::int as rev
    from cafe_menu_sales s join cafe_menu m on m.id = s.menu_id
    group by m.name order by qty desc limit 5`)) {
    console.log(`  ${r.name.padEnd(14)} ${String(r.qty).padStart(5)}개  ${won(r.rev).padStart(11)}원`);
  }

  console.log('\n=== 리뷰: 평일 vs 주말 별점 (좌석 충돌이 드러나야 함) ===');
  for (const r of await q(`
    select case when d.is_weekend or d.is_holiday then '주말·공휴일' else '평일' end as kind,
           count(*)::int as n, avg(r.rating)::float8 as avg_rating
      from cafe_reviews r join cafe_daily_sales d on d.sale_date = r.review_date
     group by 1 order by 1`)) {
    console.log(`  ${r.kind.padEnd(7)} ${String(r.n).padStart(3)}건  평균 ${r.avg_rating.toFixed(2)}점`);
  }
  for (const r of await q(`
    select case when is_member then '멤버' else '비멤버' end as kind,
           count(*)::int as n, avg(rating)::float8 as avg_rating
      from cafe_reviews group by 1 order by 1`)) {
    console.log(`  ${r.kind.padEnd(7)} ${String(r.n).padStart(3)}건  평균 ${r.avg_rating.toFixed(2)}점`);
  }

  console.log('\n=== 안전재고 미달 품목 (발주 필요) ===');
  const low = await q(`
    select item_name, current_stock::float8 as cur, safety_stock::float8 as safe, unit
    from cafe_inventory where current_stock < safety_stock order by (safety_stock - current_stock) desc`);
  if (!low.length) console.log('  없음');
  for (const r of low) console.log(`  ⚠️ ${r.item_name.padEnd(20)} ${r.cur}/${r.safe} ${r.unit}`);

  console.log('\n=== 멤버십 현황 (평일 전용 상품) ===');
  for (const r of await q(`
    select plan, count(*)::int as n, sum(monthly_fee)::int as mrr
    from cafe_memberships where status='active' group by plan order by mrr desc`)) {
    console.log(`  ${r.plan.padEnd(5)} ${r.n}명  월 ${won(r.mrr)}원`);
  }
  const [mrr] = await q(`select coalesce(sum(monthly_fee),0)::int as t from cafe_memberships where status='active'`);
  const [ch] = await q(`select count(*)::int as n from cafe_memberships where status='cancelled'`);
  console.log(`  → 활성 MRR ${won(mrr.t)}원 / 해지 ${ch.n}명`);

  console.log('\n=== 월별 매출 (상품 vs 멤버십) ===');
  for (const r of await q(`
    select to_char(sale_date,'YYYY-MM') as month,
           sum(product_revenue)::int    as prod,
           sum(membership_revenue)::int as mem,
           sum(total_revenue)::int      as total
    from cafe_daily_sales group by 1 order by 1`)) {
    console.log(`  ${r.month}  상품 ${won(r.prod).padStart(11)}원 + 멤버십 ${won(r.mem).padStart(9)}원 = ${won(r.total).padStart(11)}원`);
  }
} finally {
  await pool.end();
}
