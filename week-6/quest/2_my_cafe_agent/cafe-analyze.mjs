// ============================================================================
// 딥로스트 카페 운영 분석 — 읽기 전용 CLI (cafe-analyze.mjs)
//   'my-cafe-advisor' 서브에이전트가 실행해 stdout 의 JSON 한 덩어리를 파싱해 쓴다.
//
//   ★★ 읽기 전용(READ-ONLY) ★★
//   - 오직 SELECT 만 한다. INSERT/UPDATE/DELETE/CREATE/DROP/ALTER/TRUNCATE 없음.
//   - 테이블이 없으면 graceful 하게 hasData:false 로 보고(종료코드 0).
//   - 연결 문자열/비밀번호는 stdout/stderr 어디에도 노출하지 않는다.
//
//   데이터 계약:
//   - pg 는 SUM/AVG/COUNT 를 문자열로 돌려주므로 SQL 에서 ::int / ::float8 로 캐스팅한다.
//     (안 하면 클라이언트에서 NaN 또는 문자열 연결로 깨진다)
//   - 날짜는 to_char(...,'YYYY-MM-DD') 문자열로 내보낸다(타임존 밀림 방지).
//   - stdout 에는 유효한 JSON 한 덩어리만. 진단 로그는 전부 stderr 로.
//
//   사용법:
//     node cafe-analyze.mjs                          # 전체 기간
//     node cafe-analyze.mjs --month 2026-06          # 특정 월
//     node cafe-analyze.mjs --from 2026-05-01 --to 2026-06-30
//     node cafe-analyze.mjs --section menu,reviews   # 필요한 섹션만
// ============================================================================

import { createPool } from './db.mjs';

const SECTIONS = [
  'overview',      // 매출·손님·객단가·원가·마진 요약
  'weekday',       // 요일별 평균 (공휴일 제외) + 공휴일 요약
  'hourly',        // 시간대별 평균 손님 (평일/주말)
  'trend',         // 월별 추세
  'menu',          // 메뉴별 판매량·매출·마진
  'category',      // 카테고리(커피/논커피/구움과자/세트) 믹스
  'reviews',       // 별점 분포·채널별·메뉴별·저평점 원문
  'inventory',     // 재고 및 안전재고 미달
  'orders',        // 발주 현황
  'membership',    // 멤버십 MRR·플랜별·이탈
  'days',          // 매출 상·하위 날짜, 공휴일 상세
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

const logErr = (m) => process.stderr.write(String(m) + '\n');
const emit = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');

const num = (v) => (v === null || v === undefined ? null : Number(v));
const ratio3 = (n, d) => (!d ? null : Math.round((n / d) * 1000) / 1000);
const round1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
const round2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);

// ---------------------------------------------------------------------------
// CLI 인자
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { from: null, to: null, month: null, sections: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = (key, flag) => {
      if (a === flag) { out[key] = argv[++i] ?? ''; return true; }
      if (a.startsWith(flag + '=')) { out[key] = a.slice(flag.length + 1); return true; }
      return false;
    };
    if (take('from', '--from')) continue;
    if (take('to', '--to')) continue;
    if (take('month', '--month')) continue;
    if (take('sections', '--section')) continue;
    if (take('sections', '--sections')) continue;
    if (a === '--help' || a === '-h') { out.help = true; }
  }
  return out;
}

function usage() {
  logErr(`사용법:
  node cafe-analyze.mjs [--month YYYY-MM | --from YYYY-MM-DD --to YYYY-MM-DD] [--section a,b,c]

섹션: ${SECTIONS.join(', ')} (기본: 전부)`);
}

// ---------------------------------------------------------------------------
// 메인
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }

  // --- 섹션 선택 검증 ---
  let sections = SECTIONS;
  if (args.sections) {
    const want = args.sections.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = want.filter((s) => !SECTIONS.includes(s));
    if (bad.length) {
      logErr(`[analyze] 알 수 없는 섹션: ${bad.join(', ')}`);
      usage();
      process.exit(1);
    }
    sections = want;
  }

  // --- 기간 인자 검증 (--month 는 --from/--to 로 환산) ---
  let from = null, to = null;
  if (args.month) {
    if (!MONTH_RE.test(args.month)) {
      logErr('[analyze] --month 는 YYYY-MM 형식이어야 합니다. (예: --month 2026-06)');
      process.exit(1);
    }
    const y = Number(args.month.slice(0, 4));
    const m = Number(args.month.slice(5, 7));
    if (m < 1 || m > 12) { logErr('[analyze] --month 의 월이 올바르지 않습니다.'); process.exit(1); }
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    from = `${args.month}-01`;
    to = `${args.month}-${String(last).padStart(2, '0')}`;
  } else {
    for (const [k, v] of [['from', args.from], ['to', args.to]]) {
      if (v && !DATE_RE.test(v)) {
        logErr(`[analyze] --${k} 는 YYYY-MM-DD 형식이어야 합니다.`);
        process.exit(1);
      }
    }
    from = args.from || null;
    to = args.to || null;
  }
  if (from && to && from > to) {
    logErr('[analyze] --from 이 --to 보다 늦습니다.');
    process.exit(1);
  }

  let pool;
  try {
    pool = createPool();
  } catch (e) {
    logErr('[analyze] 연결 설정 실패: ' + e.message);
    emit({ error: '.env 의 SUPABASE_DB_URL 을 읽지 못했습니다.' });
    process.exit(1);
  }
  pool.on('error', (err) => logErr('[analyze][pg] idle error: ' + err.message));

  try {
    emit(await analyze(pool, { from, to, sections }));
  } catch (err) {
    if (err && err.code === '42P01') {
      // cafe_* 테이블이 아직 없음 → 데이터 없음으로 정상 종료
      emit({
        meta: { hasData: false, message: '카페 DB 테이블이 아직 없습니다. `node seed.mjs` 를 먼저 실행하세요.' },
      });
      return;
    }
    logErr('[analyze] 분석 실패: ' + (err?.message ?? err));
    emit({ error: '데이터베이스에 연결하거나 분석하는 중 오류가 발생했습니다.' });
    process.exitCode = 1;
  } finally {
    await pool?.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 분석 본체 — 모든 쿼리 SELECT 전용. $1=from, $2=to (null 이면 전체 기간)
// ---------------------------------------------------------------------------
const SCOPE = `($1::date IS NULL OR sale_date >= $1) AND ($2::date IS NULL OR sale_date <= $2)`;

async function analyze(pool, { from, to, sections }) {
  // 데이터 존재 여부 + 실제 기간
  const { rows: [bounds] } = await pool.query(
    `SELECT COUNT(*)::int AS days,
            to_char(MIN(sale_date),'YYYY-MM-DD') AS first_date,
            to_char(MAX(sale_date),'YYYY-MM-DD') AS last_date
       FROM cafe_daily_sales WHERE ${SCOPE}`,
    [from, to]
  );

  const meta = {
    generatedAt: new Date().toISOString(),
    scope: { from, to, label: scopeLabel(from, to) },
    daysInScope: bounds.days,
    dataRange: { first: bounds.first_date, last: bounds.last_date },
    hasData: bounds.days > 0,
    sections,
  };

  if (!meta.hasData) {
    meta.message = from || to
      ? '지정한 기간에 영업 데이터가 없습니다. 기간을 넓혀 보세요.'
      : '카페 운영 데이터가 없습니다. `node seed.mjs` 를 먼저 실행하세요.';
    return { meta };
  }

  const want = (s) => sections.includes(s);
  const p = [from, to];

  const [
    overview, weekday, hourly, trend, menu, category,
    reviews, inventory, orders, membership, days,
  ] = await Promise.all([
    want('overview')   ? queryOverview(pool, p)   : null,
    want('weekday')    ? queryWeekday(pool, p)    : null,
    want('hourly')     ? queryHourly(pool, p)     : null,
    want('trend')      ? queryTrend(pool, p)      : null,
    want('menu')       ? queryMenu(pool, p)       : null,
    want('category')   ? queryCategory(pool, p)   : null,
    want('reviews')    ? queryReviews(pool, p)    : null,
    want('inventory')  ? queryInventory(pool)     : null,
    want('orders')     ? queryOrders(pool, p)     : null,
    want('membership') ? queryMembership(pool, p) : null,
    want('days')       ? queryDays(pool, p)       : null,
  ]);

  const out = { meta };
  for (const [k, v] of Object.entries({
    overview, weekday, hourly, trend, menu, category, reviews, inventory, orders, membership, days,
  })) {
    if (v !== null) out[k] = v;
  }
  return out;
}

function scopeLabel(from, to) {
  if (!from && !to) return '전체 기간';
  if (from && to) return `${from} ~ ${to}`;
  return from ? `${from} 이후` : `${to} 이전`;
}

// --- overview: 매출/손님/객단가/원가/마진 -----------------------------------
async function queryOverview(pool, p) {
  const { rows: [s] } = await pool.query(
    `SELECT COUNT(*)::int                 AS days,
            COUNT(*) FILTER (WHERE is_weekend)::int  AS weekend_days,
            COUNT(*) FILTER (WHERE is_holiday)::int  AS holiday_days,
            -- ⚠️ weekend_days + holiday_days 는 겹치는 날(주말에 걸린 공휴일)을 이중계산한다.
            --    "주말·공휴일이 며칠인가" 는 반드시 아래 family_days 를 쓸 것.
            COUNT(*) FILTER (WHERE is_weekend OR is_holiday)::int       AS family_days,
            COUNT(*) FILTER (WHERE NOT (is_weekend OR is_holiday))::int AS weekday_days,
            SUM(visitors)::int            AS visitors,
            SUM(orders)::int              AS orders,
            SUM(product_revenue)::int     AS product_revenue,
            SUM(membership_revenue)::int  AS membership_revenue,
            SUM(total_revenue)::int       AS total_revenue
       FROM cafe_daily_sales WHERE ${SCOPE}`,
    p
  );
  const { rows: [c] } = await pool.query(
    `SELECT COALESCE(SUM(ms.qty * m.cost), 0)::int AS cogs,
            COALESCE(SUM(ms.qty), 0)::int          AS items
       FROM cafe_menu_sales ms JOIN cafe_menu m ON m.id = ms.menu_id
      WHERE ($1::date IS NULL OR ms.sale_date >= $1) AND ($2::date IS NULL OR ms.sale_date <= $2)`,
    p
  );

  // 평일(작업러) vs 가족일(주말·공휴일) — 주문 행동이 완전히 다르므로 반드시 분리해서 본다
  const { rows: byDayType } = await pool.query(
    `SELECT (is_weekend OR is_holiday) AS is_family_day,
            COUNT(*)::int             AS days,
            SUM(visitors)::int        AS visitors,
            SUM(orders)::int          AS orders,
            SUM(product_revenue)::int AS product_revenue,
            SUM(total_revenue)::int   AS total_revenue
       FROM cafe_daily_sales WHERE ${SCOPE}
      GROUP BY 1 ORDER BY 1`,
    p
  );

  const productRevenue = s.product_revenue ?? 0;
  const cogs = c.cogs;
  const grossMargin = productRevenue - cogs; // 멤버십은 원가가 없으므로 상품 기준 마진

  return {
    days: s.days,
    weekdayDays: s.weekday_days,   // 평일(공휴일 아닌)
    familyDays: s.family_days,     // 주말 ∪ 공휴일 — 합집합. 일수 계산엔 항상 이 값을 쓴다
    familyDayShare: ratio3(s.family_days, s.days),
    // 아래 둘은 참고용 내역. 주말에 걸린 공휴일이 양쪽에 잡히므로 절대 더하지 말 것.
    weekendDays: s.weekend_days,
    holidayDays: s.holiday_days,
    weekendHolidayOverlap: s.weekend_days + s.holiday_days - s.family_days,
    byDayType: byDayType.map((r) => ({
      dayType: r.is_family_day ? '주말·공휴일' : '평일',
      days: r.days,
      visitors: r.visitors,
      orders: r.orders,
      productRevenue: r.product_revenue,
      totalRevenue: r.total_revenue,
      avgOrderValue: r.orders ? Math.round(r.product_revenue / r.orders) : null,
      avgDailyRevenue: r.days ? Math.round(r.total_revenue / r.days) : null,
      ordersPerVisitor: ratio3(r.orders, r.visitors),
    })),
    visitors: s.visitors,
    orders: s.orders,
    itemsSold: c.items,
    productRevenue,
    membershipRevenue: s.membership_revenue ?? 0,
    totalRevenue: s.total_revenue ?? 0,
    cogs,
    grossMargin,
    grossMarginRate: ratio3(grossMargin, productRevenue),   // 상품매출 대비 마진율
    membershipShare: ratio3(s.membership_revenue ?? 0, s.total_revenue ?? 0),
    avgOrderValue: s.orders ? Math.round(productRevenue / s.orders) : null,   // 객단가
    itemsPerOrder: s.orders ? round1(c.items / s.orders) : null,
    orderRate: ratio3(s.orders, s.visitors),                // 손님 중 주문 비율
    avgDailyRevenue: s.days ? Math.round((s.total_revenue ?? 0) / s.days) : null,
    avgDailyVisitors: s.days ? Math.round(s.visitors / s.days) : null,
  };
}

// --- weekday: 요일별 평균 (공휴일 제외) + 공휴일 요약 ------------------------
async function queryWeekday(pool, p) {
  const { rows } = await pool.query(
    `SELECT day_of_week, day_name, is_weekend,
            COUNT(*)::int              AS days,
            AVG(visitors)::float8      AS avg_visitors,
            AVG(orders)::float8        AS avg_orders,
            AVG(total_revenue)::float8 AS avg_revenue,
            SUM(total_revenue)::int    AS total_revenue
       FROM cafe_daily_sales
      WHERE ${SCOPE} AND NOT is_holiday
      GROUP BY day_of_week, day_name, is_weekend
      ORDER BY day_of_week`,
    p
  );
  const { rows: [h] } = await pool.query(
    `SELECT COUNT(*)::int AS days,
            AVG(visitors)::float8      AS avg_visitors,
            AVG(total_revenue)::float8 AS avg_revenue
       FROM cafe_daily_sales WHERE ${SCOPE} AND is_holiday`,
    p
  );
  return {
    byDay: rows.map((r) => ({
      dayOfWeek: r.day_of_week,
      dayName: r.day_name,
      isWeekend: r.is_weekend,
      days: r.days,
      avgVisitors: round1(num(r.avg_visitors)),
      avgOrders: round1(num(r.avg_orders)),
      avgRevenue: Math.round(num(r.avg_revenue)),
      totalRevenue: r.total_revenue,
    })),
    holidays: {
      days: h.days,
      avgVisitors: h.days ? round1(num(h.avg_visitors)) : null,
      avgRevenue: h.days ? Math.round(num(h.avg_revenue)) : null,
    },
  };
}

// --- hourly: 시간대별 평균 손님 ------------------------------------------------
// 영업시간과 손님층이 다르므로 평일(08~20시) / 가족일=주말·공휴일(10~19시)로 나눈다.
async function queryHourly(pool, p) {
  const { rows } = await pool.query(
    `SELECT (d.is_weekend OR d.is_holiday) AS is_family_day, h.hour,
            AVG(h.visitors)::float8 AS avg_visitors,
            SUM(h.visitors)::int    AS total_visitors
       FROM cafe_hourly_traffic h JOIN cafe_daily_sales d ON d.sale_date = h.sale_date
      WHERE ($1::date IS NULL OR h.sale_date >= $1) AND ($2::date IS NULL OR h.sale_date <= $2)
      GROUP BY 1, h.hour
      ORDER BY 1, h.hour`,
    p
  );
  const shape = (family) =>
    rows.filter((r) => r.is_family_day === family).map((r) => ({
      hour: r.hour,
      avgVisitors: round1(num(r.avg_visitors)),
      totalVisitors: r.total_visitors,
    }));
  return { weekday: shape(false), familyDay: shape(true) };
}

// --- trend: 월별 추세 --------------------------------------------------------
// ⚠️ 주말이 평일보다 1.6배 버는 상권이라, 달마다 주말 일수가 다르면 총매출이 착시를 일으킨다.
//    그래서 familyDays / weekdayAvgRevenue / familyAvgRevenue 를 함께 내보내 정규화 비교가 가능하게 한다.
async function queryTrend(pool, p) {
  const { rows } = await pool.query(
    `SELECT to_char(sale_date,'YYYY-MM') AS month,
            COUNT(*)::int                AS days,
            COUNT(*) FILTER (WHERE is_weekend OR is_holiday)::int     AS family_days,
            COUNT(*) FILTER (WHERE NOT (is_weekend OR is_holiday))::int AS weekday_days,
            SUM(visitors)::int           AS visitors,
            SUM(orders)::int             AS orders,
            SUM(product_revenue)::int    AS product_revenue,
            SUM(membership_revenue)::int AS membership_revenue,
            SUM(total_revenue)::int      AS total_revenue,
            AVG(total_revenue) FILTER (WHERE NOT (is_weekend OR is_holiday))::float8 AS weekday_avg,
            AVG(total_revenue) FILTER (WHERE is_weekend OR is_holiday)::float8       AS family_avg
       FROM cafe_daily_sales WHERE ${SCOPE}
      GROUP BY 1 ORDER BY 1`,
    p
  );
  return rows.map((r) => ({
    month: r.month,
    days: r.days,
    weekdayDays: r.weekday_days,
    familyDays: r.family_days,          // 주말 + 공휴일 — 월별 총매출 비교 시 반드시 확인
    visitors: r.visitors,
    orders: r.orders,
    productRevenue: r.product_revenue,
    membershipRevenue: r.membership_revenue,
    totalRevenue: r.total_revenue,
    avgOrderValue: r.orders ? Math.round(r.product_revenue / r.orders) : null,
    avgDailyRevenue: r.days ? Math.round(r.total_revenue / r.days) : null,
    weekdayAvgRevenue: r.weekday_avg === null ? null : Math.round(num(r.weekday_avg)),
    familyAvgRevenue: r.family_avg === null ? null : Math.round(num(r.family_avg)),
  }));
}

// --- menu: 메뉴별 판매량·매출·마진 (안 팔린 메뉴도 0 으로 노출) --------------
async function queryMenu(pool, p) {
  const { rows } = await pool.query(
    `SELECT m.name, m.category, m.price, m.cost, m.is_signature,
            COALESCE(SUM(ms.qty), 0)::int                   AS qty,
            COALESCE(SUM(ms.revenue), 0)::int               AS revenue,
            COALESCE(SUM(ms.qty * (m.price - m.cost)), 0)::int AS margin
       FROM cafe_menu m
       LEFT JOIN cafe_menu_sales ms
              ON ms.menu_id = m.id
             AND ($1::date IS NULL OR ms.sale_date >= $1)
             AND ($2::date IS NULL OR ms.sale_date <= $2)
      GROUP BY m.id, m.name, m.category, m.price, m.cost, m.is_signature
      ORDER BY revenue DESC`,
    p
  );
  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
  const totalMargin = rows.reduce((s, r) => s + r.margin, 0);
  return rows.map((r) => ({
    name: r.name,
    category: r.category,
    price: r.price,
    cost: r.cost,
    isSignature: r.is_signature,
    qty: r.qty,
    revenue: r.revenue,
    margin: r.margin,
    marginRate: ratio3(r.margin, r.revenue),        // 이 메뉴 매출 대비 마진율
    revenueShare: ratio3(r.revenue, totalRevenue),  // 상품매출 내 비중
    marginShare: ratio3(r.margin, totalMargin),     // 총마진 기여 비중
  }));
}

// --- category: 카테고리 믹스 -------------------------------------------------
async function queryCategory(pool, p) {
  const { rows } = await pool.query(
    `SELECT m.category,
            SUM(ms.qty)::int                        AS qty,
            SUM(ms.revenue)::int                    AS revenue,
            SUM(ms.qty * (m.price - m.cost))::int   AS margin
       FROM cafe_menu_sales ms JOIN cafe_menu m ON m.id = ms.menu_id
      WHERE ($1::date IS NULL OR ms.sale_date >= $1) AND ($2::date IS NULL OR ms.sale_date <= $2)
      GROUP BY m.category ORDER BY revenue DESC`,
    p
  );
  const total = rows.reduce((s, r) => s + r.revenue, 0);
  return rows.map((r) => ({
    category: r.category,
    qty: r.qty,
    revenue: r.revenue,
    margin: r.margin,
    marginRate: ratio3(r.margin, r.revenue),
    revenueShare: ratio3(r.revenue, total),
  }));
}

// --- reviews: 별점 분포 / 채널 / 메뉴 / 멤버여부 / 저평점 원문 ---------------
async function queryReviews(pool, p) {
  const R = `($1::date IS NULL OR review_date >= $1) AND ($2::date IS NULL OR review_date <= $2)`;

  const { rows: [sum] } = await pool.query(
    `SELECT COUNT(*)::int AS n, AVG(rating)::float8 AS avg_rating,
            COUNT(*) FILTER (WHERE rating <= 2)::int AS low_n
       FROM cafe_reviews WHERE ${R}`, p);

  const { rows: dist } = await pool.query(
    `SELECT rating, COUNT(*)::int AS n FROM cafe_reviews WHERE ${R}
      GROUP BY rating ORDER BY rating DESC`, p);

  const { rows: byChannel } = await pool.query(
    `SELECT channel, COUNT(*)::int AS n, AVG(rating)::float8 AS avg_rating
       FROM cafe_reviews WHERE ${R} GROUP BY channel ORDER BY n DESC`, p);

  const { rows: byMember } = await pool.query(
    `SELECT is_member, COUNT(*)::int AS n, AVG(rating)::float8 AS avg_rating
       FROM cafe_reviews WHERE ${R} GROUP BY is_member ORDER BY is_member`, p);

  // 평일(작업러) vs 가족일(주말·공휴일) 별점 — 좌석 충돌이 드러나는 핵심 지표
  const { rows: byDayType } = await pool.query(
    `SELECT (d.is_weekend OR d.is_holiday) AS is_family_day,
            COUNT(*)::int AS n, AVG(r.rating)::float8 AS avg_rating,
            COUNT(*) FILTER (WHERE r.rating <= 2)::int AS low_n
       FROM cafe_reviews r JOIN cafe_daily_sales d ON d.sale_date = r.review_date
      WHERE ($1::date IS NULL OR r.review_date >= $1) AND ($2::date IS NULL OR r.review_date <= $2)
      GROUP BY 1 ORDER BY 1`, p);

  const { rows: byMenu } = await pool.query(
    `SELECT m.name, COUNT(*)::int AS n, AVG(r.rating)::float8 AS avg_rating
       FROM cafe_reviews r JOIN cafe_menu m ON m.id = r.menu_id
      WHERE ($1::date IS NULL OR r.review_date >= $1) AND ($2::date IS NULL OR r.review_date <= $2)
      GROUP BY m.name HAVING COUNT(*) >= 2 ORDER BY avg_rating ASC`, p);

  // 저평점(1~2점) 원문 — 불만의 실제 문구를 그대로 본다
  const { rows: low } = await pool.query(
    `SELECT to_char(review_date,'YYYY-MM-DD') AS date, rating, channel, content
       FROM cafe_reviews WHERE ${R} AND rating <= 2
      ORDER BY rating ASC, review_date DESC LIMIT 20`, p);

  // 3점(애매한 불만)도 패턴 파악에 중요 → 내용별 빈도
  const { rows: mid } = await pool.query(
    `SELECT content, COUNT(*)::int AS n, AVG(rating)::float8 AS avg_rating
       FROM cafe_reviews WHERE ${R} AND rating <= 3
      GROUP BY content ORDER BY n DESC LIMIT 10`, p);

  const { rows: monthly } = await pool.query(
    `SELECT to_char(review_date,'YYYY-MM') AS month, COUNT(*)::int AS n,
            AVG(rating)::float8 AS avg_rating
       FROM cafe_reviews WHERE ${R} GROUP BY 1 ORDER BY 1`, p);

  return {
    count: sum.n,
    avgRating: sum.n ? round2(num(sum.avg_rating)) : null,
    lowRatedCount: sum.low_n,
    lowRatedShare: ratio3(sum.low_n, sum.n),
    distribution: dist.map((r) => ({ rating: r.rating, n: r.n, share: ratio3(r.n, sum.n) })),
    byChannel: byChannel.map((r) => ({ channel: r.channel, n: r.n, avgRating: round2(num(r.avg_rating)) })),
    byMember: byMember.map((r) => ({ isMember: r.is_member, n: r.n, avgRating: round2(num(r.avg_rating)) })),
    byDayType: byDayType.map((r) => ({
      dayType: r.is_family_day ? '주말·공휴일' : '평일',
      n: r.n, avgRating: round2(num(r.avg_rating)),
      lowRatedCount: r.low_n, lowRatedShare: ratio3(r.low_n, r.n),
    })),
    byMenu: byMenu.map((r) => ({ menu: r.name, n: r.n, avgRating: round2(num(r.avg_rating)) })),
    lowRated: low,
    complaintsByFrequency: mid.map((r) => ({ content: r.content, n: r.n, avgRating: round2(num(r.avg_rating)) })),
    monthly: monthly.map((r) => ({ month: r.month, n: r.n, avgRating: round2(num(r.avg_rating)) })),
  };
}

// --- inventory: 재고 (기간과 무관한 현재 스냅샷) -----------------------------
async function queryInventory(pool) {
  const { rows } = await pool.query(
    `SELECT item_name, category, unit,
            current_stock::float8 AS current_stock,
            safety_stock::float8  AS safety_stock,
            unit_cost, supplier,
            (current_stock * unit_cost)::float8 AS stock_value
       FROM cafe_inventory
      ORDER BY (current_stock - safety_stock) ASC`
  );
  const items = rows.map((r) => ({
    itemName: r.item_name,
    category: r.category,
    unit: r.unit,
    currentStock: num(r.current_stock),
    safetyStock: num(r.safety_stock),
    shortage: num(r.current_stock) < num(r.safety_stock),
    gap: round1(num(r.current_stock) - num(r.safety_stock)),
    unitCost: r.unit_cost,
    stockValue: Math.round(num(r.stock_value)),
    supplier: r.supplier,
  }));
  return {
    totalStockValue: items.reduce((s, i) => s + i.stockValue, 0),
    shortageCount: items.filter((i) => i.shortage).length,
    shortages: items.filter((i) => i.shortage),
    items,
  };
}

// --- orders: 발주 현황 -------------------------------------------------------
async function queryOrders(pool, p) {
  const O = `($1::date IS NULL OR order_date >= $1) AND ($2::date IS NULL OR order_date <= $2)`;

  const { rows: byStatus } = await pool.query(
    `SELECT status, COUNT(*)::int AS n, SUM(total_cost)::int AS total
       FROM cafe_purchase_orders WHERE ${O} GROUP BY status ORDER BY total DESC NULLS LAST`, p);

  const { rows: bySupplier } = await pool.query(
    `SELECT supplier, COUNT(*)::int AS n, SUM(total_cost)::int AS total
       FROM cafe_purchase_orders WHERE ${O} AND status <> '취소'
      GROUP BY supplier ORDER BY total DESC`, p);

  const { rows: byItem } = await pool.query(
    `SELECT item_name, COUNT(*)::int AS n, SUM(total_cost)::int AS total
       FROM cafe_purchase_orders WHERE ${O} AND status <> '취소'
      GROUP BY item_name ORDER BY total DESC LIMIT 10`, p);

  const { rows: monthly } = await pool.query(
    `SELECT to_char(order_date,'YYYY-MM') AS month, COUNT(*)::int AS n,
            SUM(total_cost) FILTER (WHERE status <> '취소')::int AS total
       FROM cafe_purchase_orders WHERE ${O} GROUP BY 1 ORDER BY 1`, p);

  const { rows: pending } = await pool.query(
    `SELECT to_char(order_date,'YYYY-MM-DD') AS order_date, item_name,
            qty::float8 AS qty, total_cost, supplier, status,
            to_char(expected_date,'YYYY-MM-DD') AS expected_date
       FROM cafe_purchase_orders WHERE ${O} AND status IN ('발주완료','배송중')
      ORDER BY order_date DESC`, p);

  const spend = bySupplier.reduce((s, r) => s + (r.total ?? 0), 0);
  return {
    totalSpend: spend,   // 취소 제외
    byStatus: byStatus.map((r) => ({ status: r.status, n: r.n, total: r.total ?? 0 })),
    bySupplier: bySupplier.map((r) => ({ supplier: r.supplier, n: r.n, total: r.total, share: ratio3(r.total, spend) })),
    topItems: byItem,
    monthly: monthly.map((r) => ({ month: r.month, n: r.n, total: r.total ?? 0 })),
    pending: pending.map((r) => ({ ...r, qty: num(r.qty) })),
  };
}

// --- membership: MRR / 플랜별 / 이탈 / 가입 추세 ------------------------------
async function queryMembership(pool, p) {
  const { rows: byPlan } = await pool.query(
    `SELECT plan, monthly_fee,
            COUNT(*) FILTER (WHERE status='active')::int    AS active,
            COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled,
            (COUNT(*) FILTER (WHERE status='active') * monthly_fee)::int AS mrr
       FROM cafe_memberships
      GROUP BY plan, monthly_fee ORDER BY mrr DESC`
  );
  const { rows: [tot] } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status='active')::int    AS active,
            COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled,
            COALESCE(SUM(monthly_fee) FILTER (WHERE status='active'), 0)::int AS mrr
       FROM cafe_memberships`
  );
  const { rows: joins } = await pool.query(
    `SELECT to_char(joined_date,'YYYY-MM') AS month, COUNT(*)::int AS joined
       FROM cafe_memberships GROUP BY 1 ORDER BY 1`
  );
  const { rows: churns } = await pool.query(
    `SELECT to_char(cancelled_date,'YYYY-MM') AS month, COUNT(*)::int AS cancelled
       FROM cafe_memberships WHERE cancelled_date IS NOT NULL GROUP BY 1 ORDER BY 1`
  );
  // 기간 내 멤버십 인식 매출 (일할)
  const { rows: [rev] } = await pool.query(
    `SELECT COALESCE(SUM(membership_revenue), 0)::int AS revenue
       FROM cafe_daily_sales WHERE ${SCOPE}`, p);

  return {
    totalMembers: tot.total,
    activeMembers: tot.active,
    cancelledMembers: tot.cancelled,
    churnRate: ratio3(tot.cancelled, tot.total),
    mrr: tot.mrr,
    arpu: tot.active ? Math.round(tot.mrr / tot.active) : null,
    revenueInScope: rev.revenue,
    byPlan: byPlan.map((r) => ({
      plan: r.plan, monthlyFee: r.monthly_fee, active: r.active,
      cancelled: r.cancelled, mrr: r.mrr, mrrShare: ratio3(r.mrr, tot.mrr),
    })),
    joinsByMonth: joins,
    churnsByMonth: churns,
  };
}

// --- days: 매출 상·하위 날짜, 공휴일 상세 ------------------------------------
async function queryDays(pool, p) {
  const cols = `to_char(sale_date,'YYYY-MM-DD') AS date, day_name, is_weekend, is_holiday,
                visitors, orders, total_revenue`;
  const { rows: best } = await pool.query(
    `SELECT ${cols} FROM cafe_daily_sales WHERE ${SCOPE} ORDER BY total_revenue DESC LIMIT 5`, p);
  const { rows: worst } = await pool.query(
    `SELECT ${cols} FROM cafe_daily_sales WHERE ${SCOPE} ORDER BY total_revenue ASC LIMIT 5`, p);
  const { rows: holidays } = await pool.query(
    `SELECT ${cols} FROM cafe_daily_sales WHERE ${SCOPE} AND is_holiday ORDER BY sale_date`, p);
  const shape = (r) => ({
    date: r.date, dayName: r.day_name, isWeekend: r.is_weekend, isHoliday: r.is_holiday,
    visitors: r.visitors, orders: r.orders, totalRevenue: r.total_revenue,
  });
  return { best: best.map(shape), worst: worst.map(shape), holidays: holidays.map(shape) };
}

main().catch((err) => {
  logErr('[analyze] 예기치 못한 오류: ' + (err?.message ?? err));
  emit({ error: '분석 도구 실행 중 예기치 못한 오류가 발생했습니다.' });
  process.exit(1);
});
