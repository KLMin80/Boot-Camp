// ☕ 딥로스트 카페 운영 데이터 시딩 (용인 수지구청역 · 구청 뒤 이면도로)
// 2026-04-01 ~ 2026-06-30 (91일) 분량의 가상 운영 데이터를 생성해 Supabase에 적재한다.
// 컨셉(my_cafe.md)을 데이터에 반영:
//   - 주거·학원가 상권 → 주말·공휴일이 성수기, 평일은 재택근무자 위주로 잔잔
//   - 하이브리드 근무 관행 → 평일 안에서도 월·금(재택)이 화·수·목보다 붐빔
//   - 이면도로 → 출근길 8시 테이크아웃 파도 없음. 오전 10~11시, 오후 13~15시가 피크
//   - 평일 20시 마감(학원가 저녁 손님 포기), 주말·공휴일 10~19시
//   - 주말엔 멤버십 지정석 미운영 → 가족 손님 유입. 1건당 여러 잔·디저트(객단가↑, 주문수↓)
//   - 어린이날은 연중 최대 대목
//
// 재실행해도 같은 결과가 나오도록 시드 고정 난수(mulberry32)를 쓴다.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPool } from './db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 시드 고정 난수 ----------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260709);
const jitter = (spread) => 1 + (rnd() * 2 - 1) * spread; // 1±spread
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const randInt = (min, max) => min + Math.floor(rnd() * (max - min + 1));

// ---------- 날짜 유틸 (UTC 고정, 타임존 밀림 방지) ----------
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

const START = new Date(Date.UTC(2026, 3, 1));  // 2026-04-01
const END = new Date(Date.UTC(2026, 5, 30));   // 2026-06-30

// 주거지라 공휴일에 손님이 는다. 평일 공휴일은 아래 배수가 요일 배수를 "대체"한다.
// (주말과 겹치는 공휴일은 원래 주말 배수에 소폭 가산만 한다)
const HOLIDAY_MULT = {
  '2026-05-01': 1.15, // 근로자의 날 (금)
  '2026-05-05': 1.55, // 어린이날 (화) — 연중 최대 대목
  '2026-05-24': 1.05, // 부처님오신날 (일) — 주말과 겹침 → 가산 배수
  '2026-06-03': 1.30, // 지방선거 (수)
  '2026-06-06': 1.05, // 현충일 (토) — 주말과 겹침 → 가산 배수
};

const MEMBERSHIP_OPEN = '2026-05-01';

// ---------- 1) 메뉴 ----------
const MENU = [
  // name,            category,   price, cost, signature, 판매비중(평일), 가족일 가중
  ['아메리카노',       '커피',     4500,  900,  false, 0.24, 0.80],
  ['딥로스트 라떼',    '커피',     6000, 1500,  true,  0.10, 1.05],
  ['카페라떼',         '커피',     5000, 1300,  false, 0.09, 1.10],
  ['콜드브루',         '커피',     5500, 1400,  false, 0.07, 0.95],
  ['에스프레소',       '커피',     3500,  800,  false, 0.02, 0.60],
  ['바닐라 라떼',      '커피',     5500, 1400,  false, 0.05, 1.20],
  ['아이스티',         '논커피',   4500,  700,  false, 0.03, 1.40],
  ['핫초코',           '논커피',   5000, 1200,  false, 0.02, 2.20], // 주말 가족 손님의 아이들
  ['비스코티',         '구움과자', 3000,  900,  false, 0.05, 1.15],
  ['휘낭시에',         '구움과자', 3500, 1100,  false, 0.05, 1.30],
  ['마들렌',           '구움과자', 3200, 1000,  false, 0.04, 1.35],
  ['스콘',             '구움과자', 4000, 1300,  false, 0.04, 1.40],
  ['파운드케이크',     '구움과자', 4500, 1400,  false, 0.03, 1.50],
  ['딥세트',           '세트',     8000, 2200,  true,  0.11, 1.30],
  ['시그니처 세트',    '세트',     8500, 2700,  true,  0.06, 1.35],
];

// ---------- 2) 멤버십 (평일 전용 상품) ----------
const PLANS = [
  ['라이트', 25000, 0.42],
  ['데일리', 45000, 0.38],
  ['프로',   79000, 0.20],
];
function buildMemberships() {
  const members = [];
  // 이면도로라 충동 유입이 없다 → 오픈 러시가 작고 입소문으로 완만히 는다
  const joinSchedule = [
    ['2026-05-01', 7], ['2026-05-04', 3], ['2026-05-11', 2], ['2026-05-18', 3],
    ['2026-05-25', 2], ['2026-06-01', 4], ['2026-06-08', 2], ['2026-06-15', 3],
    ['2026-06-22', 2], ['2026-06-29', 2],
  ];
  let n = 0;
  for (const [date, count] of joinSchedule) {
    for (let i = 0; i < count; i++) {
      const r = rnd();
      let acc = 0, plan = PLANS[0];
      for (const pl of PLANS) { acc += pl[2]; if (r <= acc) { plan = pl; break; } }
      n += 1;
      members.push({
        member_code: `DR-${String(n).padStart(3, '0')}`,
        plan: plan[0], monthly_fee: plan[1],
        joined_date: date, cancelled_date: null, status: 'active',
      });
    }
  }
  // 일부 이탈 (가입 후 30~50일 뒤 해지)
  for (const idx of [3, 9, 14, 21]) {
    const m = members[idx];
    if (!m) continue;
    const c = addDays(new Date(m.joined_date + 'T00:00:00Z'), randInt(30, 50));
    if (ymd(c) <= ymd(END)) { m.cancelled_date = ymd(c); m.status = 'cancelled'; }
  }
  return members;
}

// ---------- 3) 일별 지표 ----------
// 일~토. 월·금은 재택이 몰려 붐비고, 화·수·목은 사무실 출근으로 빠진다. 주말이 정점.
const DOW_MULT = [1.15, 1.05, 0.85, 0.82, 0.85, 1.00, 1.30];

// 이면도로 → 출근길 파도 없음. 오전 10~11시(재택 시작), 오후 13~15시(하루 피크).
const HOURS_WEEKDAY = {
  8: .05, 9: .06, 10: .10, 11: .11, 12: .07, 13: .12, 14: .13,
  15: .12, 16: .09, 17: .07, 18: .04, 19: .03, 20: .01,
};
// 주말·공휴일 10~19시. 가족 손님이 12~16시에 몰린다.
const HOURS_FAMILY = {
  10: .06, 11: .10, 12: .12, 13: .14, 14: .15, 15: .14, 16: .12, 17: .09, 18: .05, 19: .03,
};

// 평일: 1인 1주문에 가깝고 아이템 수가 적다.
// 가족일: 한 건에 여러 잔 + 디저트 → 주문 건수는 적지만 건당 아이템·객단가가 크다.
const ORDER_RATE = { weekday: 0.92, family: 0.48 };
const ITEMS_PER_ORDER = { weekday: 1.30, family: 2.90 };

function membershipRevenueOn(dateStr, members) {
  if (dateStr < MEMBERSHIP_OPEN) return 0;
  const monthlySum = members
    .filter((m) => m.joined_date <= dateStr && (!m.cancelled_date || m.cancelled_date > dateStr))
    .reduce((s, m) => s + m.monthly_fee, 0);
  return Math.round(monthlySum / 30); // 월 구독료를 일할 인식
}

function buildDaily(members) {
  const days = [];
  const totalDays = Math.round((END - START) / 86400000);
  for (let i = 0; i <= totalDays; i++) {
    const d = addDays(START, i);
    const date = ymd(d);
    const dow = d.getUTCDay();
    const isWeekend = dow === 0 || dow === 6;
    const isHoliday = Object.hasOwn(HOLIDAY_MULT, date);

    // 3개월간 완만한 성장(+12%) — 이면도로라 입소문·멤버십으로만 는다
    const growth = 1 + 0.12 * (i / totalDays);

    // 평일 공휴일은 요일 배수를 대체하고, 주말 공휴일은 주말 배수에 가산한다.
    let mult = DOW_MULT[dow];
    if (isHoliday) mult = isWeekend ? DOW_MULT[dow] * HOLIDAY_MULT[date] : HOLIDAY_MULT[date];

    const visitors = Math.max(12, Math.round(105 * mult * growth * jitter(0.08)));

    // 주말·공휴일은 '가족일' — 주문 행동이 다르다
    const isFamilyDay = isWeekend || isHoliday;
    const orderRate = isFamilyDay ? ORDER_RATE.family : ORDER_RATE.weekday;
    const orders = Math.max(6, Math.round(visitors * orderRate * jitter(0.04)));

    days.push({
      sale_date: date, day_of_week: dow, day_name: DAY_NAMES[dow],
      is_weekend: isWeekend, is_holiday: isHoliday, isFamilyDay,
      visitors, orders,
      membership_revenue: membershipRevenueOn(date, members),
    });
  }
  return days;
}

function buildMenuSales(days) {
  const rows = [];
  for (const day of days) {
    const totalQty = Math.round(day.orders * (day.isFamilyDay ? ITEMS_PER_ORDER.family : ITEMS_PER_ORDER.weekday));

    // 가족일 가중치를 반영해 비중 재정규화
    const weights = MENU.map(([, , , , , w, familyW]) => w * (day.isFamilyDay ? familyW : 1));
    const wSum = weights.reduce((a, b) => a + b, 0);

    let revenue = 0;
    MENU.forEach(([name, , price], idx) => {
      const qty = Math.max(0, Math.round((totalQty * weights[idx]) / wSum * jitter(0.12)));
      if (qty === 0) return;
      const rev = qty * price;
      revenue += rev;
      rows.push({ sale_date: day.sale_date, menu_name: name, qty, revenue: rev });
    });
    day.product_revenue = revenue;
  }
  return rows;
}

function buildHourly(days) {
  const rows = [];
  for (const day of days) {
    const dist = day.isFamilyDay ? HOURS_FAMILY : HOURS_WEEKDAY;
    const hours = Object.keys(dist).map(Number);

    // 지터를 준 뒤 재정규화 → 실수 몫을 구하고, 최대잉여법으로 정수 배분한다.
    // (마지막 시간대에 잔여를 몰아주면 앞에서 초과 배분됐을 때 합계가 틀어진다)
    const weights = hours.map((h) => dist[h] * jitter(0.15));
    const wSum = weights.reduce((a, b) => a + b, 0);
    const exact = weights.map((w) => (day.visitors * w) / wSum);

    const counts = exact.map(Math.floor);
    const remainder = day.visitors - counts.reduce((a, b) => a + b, 0);
    exact
      .map((v, i) => ({ i, frac: v - Math.floor(v) }))
      .sort((a, b) => b.frac - a.frac)
      .slice(0, remainder)
      .forEach(({ i }) => counts[i]++);

    hours.forEach((h, i) => rows.push({ sale_date: day.sale_date, hour: h, visitors: counts[i] }));
  }
  return rows;
}

// ---------- 4) 리뷰 ----------
// 컨셉의 핵심 긴장(평일 작업러 ↔ 주말 가족)이 별점으로 드러나도록 구성했다.
const REVIEW_TEMPLATES = {
  5: [
    ['구청 뒤 골목이라 조용해요. 노트북 켜고 세 시간 앉아 있었는데 아무도 눈치 안 줍니다.', null],
    ['재택하는 날마다 옵니다. 집보다 일이 훨씬 잘 돼요.', null],
    ['딥로스트 라떼 진짜 맛있어요. 수지에서 이 정도 커피를 마실 줄 몰랐네요.', '딥로스트 라떼'],
    ['전 좌석 콘센트에 와이파이도 빨라요. 강남까지 안 나가도 되니 살 것 같습니다.', null],
    ['평일 멤버십 끊었는데 지정석이 보장되니 출근하는 기분으로 옵니다.', null],
    ['주말에 아이랑 왔는데 핫초코를 정말 좋아하네요. 자리도 넓고 좋았어요.', '핫초코'],
    ['갓 구운 스콘 냄새에 홀려서 세트로 시켰습니다. 후회 없음.', '스콘'],
    ['학원가 쪽이 아니라 저녁에도 조용해요. 대로변 카페들과 완전히 다릅니다.', null],
    ['비스코티를 커피에 찍어 먹는 조합 강추. 부스러기도 안 날려서 키보드 안전.', '비스코티'],
    ['원두를 직접 볶는 게 느껴지는 맛. 동네 카페 수준이 아니에요.', '콜드브루'],
  ],
  4: [
    ['큰길에서 좀 들어와야 해서 처음엔 못 찾았어요. 찾고 나면 조용해서 좋습니다.', null],
    ['주말엔 가족 손님이 많아 북적입니다. 작업하러 갈 거면 평일을 추천해요.', null],
    ['맛있지만 동네 카페치고는 가격대가 있는 편. 그래도 세트는 괜찮아요.', '시그니처 세트'],
    ['휘낭시에 겉바속촉. 한 손에 쏙 들어와서 작업하면서 먹기 좋아요.', '휘낭시에'],
    ['오후 늦게 가면 구움과자가 자주 품절이에요.', '마들렌'],
    ['주차가 애매해요. 골목이라 갓길에 대야 합니다.', null],
  ],
  3: [
    ['주말 오후엔 자리가 거의 없어요. 아이들도 많아서 집중은 어렵습니다.', null],
    ['평일 저녁 8시에 문을 닫아서 퇴근 후에 들르기가 어렵네요.', null],
    ['바닐라 라떼가 생각보다 달아요. 시럽 조절 가능한지 물어봐야 할 듯.', '바닐라 라떼'],
    ['주말엔 멤버십 지정석이 없어져서 늘 앉던 자리에 못 앉았어요.', null],
    ['대로변에서 걸어 들어오는 길이 어두워요. 밤에는 조금 무섭습니다.', null],
  ],
  2: [
    ['주말에 노트북 하러 갔다가 자리가 없어 그냥 나왔습니다.', null],
    ['가격 대비 아메리카노 양이 적은 것 같아요.', '아메리카노'],
    ['옆 테이블 아이가 계속 뛰어다녀서 통화도 못 했어요.', null],
  ],
  1: [
    ['작업하러 갔는데 주말이라 가족 손님뿐이었습니다. 컨셉이 뭔지 모르겠어요.', null],
    ['주문한 스콘이 식어서 나왔습니다. 갓 구운 거라더니 아쉽네요.', '스콘'],
  ],
};
const CHANNELS = ['네이버', '카카오맵', '구글', '인스타그램', '매장설문'];
const RATING_DIST = [[5, 0.45], [4, 0.30], [3, 0.13], [2, 0.08], [1, 0.04]];

function buildReviews(days) {
  const rows = [];
  const target = 124;
  for (let i = 0; i < target; i++) {
    const day = days[Math.floor(rnd() * days.length)];
    // 멤버십은 평일 전용 상품 → 멤버 리뷰는 평일에서만 나온다
    const isMember = !day.isFamilyDay && day.sale_date >= MEMBERSHIP_OPEN && rnd() < 0.30;

    let r = rnd();
    if (day.isFamilyDay) r = Math.min(0.999, r + 0.15); // 가족일엔 작업러 불만이 섞여 별점이 내려간다
    if (isMember && r > 0.75) r = rnd() * 0.75;          // 멤버는 만족도가 높은 편

    let acc = 0, rating = 5;
    for (const [val, prob] of RATING_DIST) { acc += prob; if (r <= acc) { rating = val; break; } }

    const [content, menuName] = pick(REVIEW_TEMPLATES[rating]);
    rows.push({
      review_date: day.sale_date, rating, channel: pick(CHANNELS),
      menu_name: menuName, is_member: isMember, content,
    });
  }
  return rows.sort((a, b) => a.review_date.localeCompare(b.review_date));
}

// ---------- 5) 재고 & 발주 ----------
const INVENTORY = [
  // item_name, category, unit, current, safety, unit_cost, supplier
  ['에티오피아 예가체프 생두', '원두',       'kg', 12.5,  10, 24000, '커피빈트레이더스'],
  ['브라질 산토스 생두',       '원두',       'kg', 28.0,  15, 15000, '커피빈트레이더스'],
  ['케냐 AA 생두',             '원두',       'kg',  6.5,   8, 31000, '커피빈트레이더스'],
  ['콜롬비아 수프리모 생두',   '원두',       'kg', 18.0,  12, 18000, '커피빈트레이더스'],
  ['우유 1L',                  '유제품',     'ea', 42.0,  40,  2400, '서울우유대리점'],
  ['오트밀크 1L',              '유제품',     'ea', 15.0,  12,  3800, '서울우유대리점'],
  ['무염버터',                 '베이킹',     'kg',  4.2,   5, 12500, '베이킹마트'],
  ['박력분',                   '베이킹',     'kg', 11.0,   8,  2800, '베이킹마트'],
  ['설탕',                     '베이킹',     'kg',  9.5,   6,  2200, '베이킹마트'],
  ['계란(30구)',               '베이킹',     'ea',  6.0,   5,  9000, '베이킹마트'],
  ['아몬드가루',               '베이킹',     'kg',  2.8,   3, 18000, '베이킹마트'],
  ['다크초콜릿',               '베이킹',     'kg',  3.5,   2, 16000, '베이킹마트'],
  ['바닐라시럽 1L',            '음료부재료', 'ea',  4.0,   3,  8500, '베이킹마트'],
  ['핫초코 파우더',            '음료부재료', 'kg',  2.2,   3, 14000, '베이킹마트'],
  ['테이크아웃컵(핫)',         '부자재',     'ea', 520.0, 300,   90, '패키지코리아'],
  ['테이크아웃컵(아이스)',     '부자재',     'ea', 280.0, 300,  110, '패키지코리아'],
  ['컵홀더',                   '부자재',     'ea', 610.0, 400,   35, '패키지코리아'],
  ['빨대',                     '부자재',     'ea', 900.0, 500,   15, '패키지코리아'],
  ['냅킨',                     '부자재',     'ea', 1200.0, 800,  10, '패키지코리아'],
];

function buildPurchaseOrders() {
  const rows = [];
  const orderable = INVENTORY.filter((i) => i[1] !== '부자재' || rnd() < 0.6);
  // 매주 월요일 발주 (일부 품목만)
  for (let d = new Date(START); d <= END; d = addDays(d, 7)) {
    const monday = addDays(d, (8 - d.getUTCDay()) % 7); // 그 주 월요일
    if (monday > END) break;
    const orderDate = ymd(monday);

    const count = randInt(3, 6);
    const picked = new Set();
    for (let i = 0; i < count; i++) {
      const item = orderable[Math.floor(rnd() * orderable.length)];
      if (picked.has(item[0])) continue;
      picked.add(item[0]);

      const [name, , unit, , safety, unitCost, supplier] = item;
      const qty = unit === 'ea' && safety > 100
        ? randInt(5, 12) * 100
        : Number((safety * (1 + rnd())).toFixed(1));
      const expected = ymd(addDays(monday, randInt(2, 4)));

      // 최근 2주 발주는 아직 입고 전일 수 있다
      const daysAgo = Math.round((END - monday) / 86400000);
      let status = '입고완료';
      if (daysAgo < 4) status = '발주완료';
      else if (daysAgo < 10) status = pick(['배송중', '입고완료']);
      if (rnd() < 0.03) status = '취소';

      rows.push({
        order_date: orderDate, item_name: name, qty,
        unit_price: unitCost, total_cost: Math.round(qty * unitCost),
        supplier, status, expected_date: expected,
      });
    }
  }
  return rows;
}

// ---------- 적재 ----------
async function insertBatch(client, table, columns, rows, mapRow) {
  if (!rows.length) return;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const placeholders = chunk.map((row, r) => {
      const vals = mapRow(row);
      vals.forEach((v) => values.push(v));
      return `(${vals.map((_, c) => `$${r * vals.length + c + 1}`).join(',')})`;
    });
    await client.query(
      `insert into ${table} (${columns.join(',')}) values ${placeholders.join(',')}`,
      values
    );
  }
}

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    console.log('1) 스키마 생성...');
    await client.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

    console.log('2) 기존 cafe_* 데이터 비우기 (재실행 대비)...');
    await client.query(`truncate table
      cafe_menu_sales, cafe_hourly_traffic, cafe_reviews,
      cafe_purchase_orders, cafe_daily_sales, cafe_inventory,
      cafe_memberships, cafe_menu
      restart identity cascade`);

    await client.query('begin');

    console.log('3) 메뉴...');
    await insertBatch(client, 'cafe_menu', ['name', 'category', 'price', 'cost', 'is_signature'],
      MENU, (m) => [m[0], m[1], m[2], m[3], m[4]]);
    const menuIds = Object.fromEntries(
      (await client.query('select id, name from cafe_menu')).rows.map((r) => [r.name, r.id])
    );

    console.log('4) 멤버십...');
    const members = buildMemberships();
    await insertBatch(client, 'cafe_memberships',
      ['member_code', 'plan', 'monthly_fee', 'joined_date', 'cancelled_date', 'status'],
      members, (m) => [m.member_code, m.plan, m.monthly_fee, m.joined_date, m.cancelled_date, m.status]);

    console.log('5) 일별 매출 + 메뉴별 판매량...');
    const days = buildDaily(members);
    const menuSales = buildMenuSales(days); // day.product_revenue 를 채운다
    await insertBatch(client, 'cafe_daily_sales',
      ['sale_date', 'day_of_week', 'day_name', 'is_weekend', 'is_holiday', 'visitors', 'orders', 'product_revenue', 'membership_revenue'],
      days, (d) => [d.sale_date, d.day_of_week, d.day_name, d.is_weekend, d.is_holiday, d.visitors, d.orders, d.product_revenue, d.membership_revenue]);
    await insertBatch(client, 'cafe_menu_sales', ['sale_date', 'menu_id', 'qty', 'revenue'],
      menuSales, (r) => [r.sale_date, menuIds[r.menu_name], r.qty, r.revenue]);

    console.log('6) 시간대별 손님 수...');
    await insertBatch(client, 'cafe_hourly_traffic', ['sale_date', 'hour', 'visitors'],
      buildHourly(days), (r) => [r.sale_date, r.hour, r.visitors]);

    console.log('7) 리뷰...');
    await insertBatch(client, 'cafe_reviews',
      ['review_date', 'rating', 'channel', 'menu_id', 'is_member', 'content'],
      buildReviews(days),
      (r) => [r.review_date, r.rating, r.channel, r.menu_name ? menuIds[r.menu_name] : null, r.is_member, r.content]);

    console.log('8) 재고...');
    await insertBatch(client, 'cafe_inventory',
      ['item_name', 'category', 'unit', 'current_stock', 'safety_stock', 'unit_cost', 'supplier'],
      INVENTORY, (i) => [i[0], i[1], i[2], i[3], i[4], i[5], i[6]]);

    console.log('9) 발주...');
    await insertBatch(client, 'cafe_purchase_orders',
      ['order_date', 'item_name', 'qty', 'unit_price', 'total_cost', 'supplier', 'status', 'expected_date'],
      buildPurchaseOrders(),
      (r) => [r.order_date, r.item_name, r.qty, r.unit_price, r.total_cost, r.supplier, r.status, r.expected_date]);

    await client.query('commit');
    console.log('\n✅ 시딩 완료');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    console.error('\n❌ 실패:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
