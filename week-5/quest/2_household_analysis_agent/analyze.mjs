// ============================================================================
// 가계부 소비 분석 — 읽기 전용 CLI 분석 도구 (analyze.mjs)
//   "소비 분석가" 서브에이전트가 `node analyze.mjs --month 2026-06` 식으로 실행해
//   stdout 의 JSON 한 덩어리를 JSON.parse 하여 분석/조언에 사용한다.
//
//   ★★ 읽기 전용(READ-ONLY) ★★
//   - 오직 SELECT 만 한다. INSERT/UPDATE/DELETE/CREATE/DROP/ALTER/TRUNCATE 절대 없음.
//   - 가계부 앱(week-5/quest/1_household)이 만든 테이블을 그대로 읽기만 한다(생성/변경 안 함).
//   - 테이블이 없으면 graceful 하게 hasData:false 로 보고(종료코드 0).
//   - DB_URL 값은 어떤 stdout/stderr/에러에도 노출하지 않는다.
//
//   데이터 계약(가계부 server.js 와 동일 컨벤션):
//   - txn_date 는 to_char(txn_date,'YYYY-MM-DD') 문자열(타임존 밀림 방지).
//   - 금액/합계는 SUM(...)::float8, COUNT 는 ::int. BIGINT 는 pg 가 문자열로 주므로
//     반드시 Number(...) 로 숫자화(미캐스팅 시 클라가 NaN/문자열로 깨짐).
//   - stdout 에는 유효한 JSON 한 덩어리만. 사람용 로그/진단은 전부 stderr 로.
// ============================================================================

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ===========================================================================
// 1) 카테고리 한글 라벨 맵 — 가계부 앱과 100% 동일. (출력에 label 로 포함)
//    EXPENSE_LABELS 의 키 순서 = 예산대비(budgetVsActual)에서 "지출/예산 없는 카테고리도
//    모두 표현" 하기 위한 EXPENSE 카테고리 전체 목록 역할도 한다.
// ===========================================================================
const EXPENSE_LABELS = {
  food: '식비',
  transport: '교통',
  housing: '주거',
  subscribe: '구독료',
  event: '경조사',
  shopping: '쇼핑/생활',
  medical: '의료/건강',
  culture: '문화/여가',
  etc: '기타',
};
const INCOME_LABELS = {
  salary: '급여',
  bonus: '상여/보너스',
  side: '부수입',
  invest: '금융수입',
  etc: '기타',
};
const EXPENSE_CATEGORIES = Object.keys(EXPENSE_LABELS); // 표준 지출 카테고리 순서

// 카테고리 id → 한글 라벨. 미지의 카테고리(앱이 늘어난 경우)는 id 를 그대로 라벨로 사용.
function expenseLabel(cat) {
  return EXPENSE_LABELS[cat] || cat;
}
function incomeLabel(cat) {
  return INCOME_LABELS[cat] || cat;
}

const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토']; // 0=일 ~ 6=토

// 안전한 비율 계산(분모 0 → null). 소수 3자리 반올림.
function ratio3(num, den) {
  if (!den) return null;
  return Math.round((num / den) * 1000) / 1000;
}

// ===========================================================================
// 2) CLI 인자 파싱
//    --month YYYY-MM  : 특정 월 분석
//    --months N       : monthlyTrend 에 포함할 최근 개월 수(기본 6)
//    인자 없으면 month=null(아래에서 데이터가 있는 가장 최근 월을 자동 선택).
// ===========================================================================
function parseArgs(argv) {
  const out = { month: null, months: 6 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--month') {
      out.month = argv[++i] ?? '';
    } else if (a.startsWith('--month=')) {
      out.month = a.slice('--month='.length);
    } else if (a === '--months') {
      out.months = argv[++i] ?? '';
    } else if (a.startsWith('--months=')) {
      out.months = a.slice('--months='.length);
    }
  }
  return out;
}

const MONTH_RE = /^\d{4}-\d{2}$/;

// stderr 에 진단/에러 출력(절대 stdout 아님). DB_URL 은 여기에도 절대 넣지 않는다.
function logErr(msg) {
  process.stderr.write(String(msg) + '\n');
}

// stdout 에 JSON 한 덩어리만 출력하고 끝낸다.
function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

// ===========================================================================
// 3) 환경변수 로드 — process.loadEnvFile(.env). DB_URL.trim(). 없으면 비정상 종료.
//    (가계부 server.js 와 동일: __dirname 기준, try/catch 로 이미 주입된 경우 무시)
// ===========================================================================
function loadDbUrl() {
  try {
    process.loadEnvFile(path.join(__dirname, '.env'));
  } catch (_) {
    // .env 가 없거나 이미 환경에 주입된 경우 → 무시(아래에서 DB_URL 유무로 판단)
  }
  return (process.env.DB_URL || '').trim(); // trailing newline/CR 방지
}

// ===========================================================================
// 4) 메인
// ===========================================================================
async function main() {
  const args = parseArgs(process.argv.slice(2));

  // --- --month 형식 검증(지정된 경우에만) ---
  let month = null;
  if (args.month !== null && args.month !== '') {
    if (!MONTH_RE.test(args.month)) {
      logErr('[analyze] --month 는 YYYY-MM 형식이어야 합니다. (예: --month 2026-06)');
      process.exit(1);
    }
    const mm = Number(args.month.slice(5, 7));
    if (mm < 1 || mm > 12) {
      logErr('[analyze] --month 의 월(月)이 올바르지 않습니다.');
      process.exit(1);
    }
    month = args.month;
  }

  // --- --months 정규화(양의 정수, 1~36 클램프, 기본 6) ---
  let months = Number(args.months);
  if (!Number.isFinite(months) || !Number.isInteger(months) || months < 1) {
    months = 6;
  }
  if (months > 36) months = 36;

  // --- DB_URL 로드 ---
  const DB_URL = loadDbUrl();
  if (!DB_URL) {
    logErr('[analyze] .env 의 DB_URL 이 설정되지 않았습니다.');
    process.exit(1);
  }

  // --- PG 풀 (Supabase 풀러는 SSL 필수, 분석 도구라 작게 max:3) ---
  const pool = new Pool({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
    max: 3,
  });
  // 유휴 클라이언트 오류로 프로세스가 죽지 않도록 흡수(URL 비노출).
  pool.on('error', (err) => logErr('[analyze][pg pool] idle error: ' + err.message));

  try {
    const result = await analyze(pool, { month, months });
    emit(result);
  } catch (err) {
    // 테이블 부재(42P01)는 "데이터 없음" 으로 graceful 처리(종료코드 0).
    if (err && err.code === '42P01') {
      emit(emptyResult({ month, reason: 'no-table' }));
      return; // finally 에서 pool.end()
    }
    // 그 외(연결 실패 등) → stdout 에 한글 에러 + 종료코드 1 (DB_URL 비노출).
    logErr('[analyze] 분석 실패: ' + (err && err.message ? err.message : err));
    emit({ error: '데이터베이스에 연결하거나 분석하는 중 오류가 발생했습니다.' });
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

// ===========================================================================
// 5) 데이터 없음(빈) 결과 — 테이블 부재 또는 행 0건일 때 공통으로 사용.
//    meta.hasData=false + 빈 배열들 + 안내 message, 종료코드 0.
// ===========================================================================
function scopeLabel(month) {
  if (!month) return '전체';
  return `${month.slice(0, 4)}년 ${Number(month.slice(5, 7))}월`;
}

function emptyResult({ month, reason }) {
  const message =
    reason === 'no-table'
      ? '아직 가계부 데이터가 없습니다. (테이블이 생성되지 않았어요 — 가계부 앱에서 내역을 먼저 추가해 주세요.)'
      : '아직 가계부에 기록된 내역이 없습니다. 첫 거래를 추가하면 분석을 시작할 수 있어요.';
  return {
    meta: {
      generatedAt: new Date().toISOString(),
      scope: { month: month || null, label: scopeLabel(month) },
      hasData: false,
      message,
    },
    overview: {
      txnCount: 0,
      firstDate: null,
      lastDate: null,
      totalIncome: 0,
      totalExpense: 0,
      net: 0,
      savingsRate: null,
      expenseTxnCount: 0,
      avgExpensePerTxn: 0,
      daysInScope: 0,
      avgDailyExpense: 0,
    },
    expenseByCategory: [],
    incomeByCategory: [],
    monthlyTrend: [],
    budgetVsActual: [],
    topExpenses: [],
    recentTransactions: [],
    weekdayExpense: [],
  };
}

// ===========================================================================
// 6) 분석 본체 — 모든 쿼리는 SELECT 전용.
//    month 가 null 이면 자동으로 "데이터가 있는 가장 최근 월" 을 선택한다.
//    스코프(scopedMonth)로 overview/카테고리/예산/topExpenses/recent/weekday 를 필터하고,
//    monthlyTrend 만 항상 최근 N개월(월 무관 추세)로 계산한다.
// ===========================================================================
async function analyze(pool, { month, months }) {
  // (a) 전체 데이터 존재 여부 + 자동 월 선택용으로 가장 최근 월을 먼저 조사.
  //     테이블이 없으면 여기서 42P01 이 던져져 상위에서 graceful 처리됨.
  const latest = await pool.query(
    `SELECT to_char(MAX(txn_date), 'YYYY-MM') AS latest_month,
            COUNT(*)::int                     AS total_count
       FROM transactions`
  );
  const totalCount = latest.rows[0]?.total_count ?? 0;
  const latestMonth = latest.rows[0]?.latest_month ?? null;

  // 데이터가 전혀 없으면 빈 결과(종료코드 0).
  if (totalCount === 0) {
    return emptyResult({ month, reason: 'no-rows' });
  }

  // 인자 없으면(month=null) 데이터가 있는 가장 최근 월을 스코프로 사용.
  const scopedMonth = month || latestMonth;

  // (b) 스코프 월 범위로 각 섹션을 병렬 조회(각자 독립 커넥션 → Promise.all 안전).
  const [
    overview,
    expenseByCategory,
    incomeByCategory,
    monthlyTrend,
    budgetVsActual,
    topExpenses,
    recentTransactions,
    weekdayExpense,
  ] = await Promise.all([
    queryOverview(pool, scopedMonth),
    queryExpenseByCategory(pool, scopedMonth),
    queryIncomeByCategory(pool, scopedMonth),
    queryMonthlyTrend(pool, months),
    queryBudgetVsActual(pool, scopedMonth),
    queryTopExpenses(pool, scopedMonth),
    queryRecentTransactions(pool, scopedMonth),
    queryWeekdayExpense(pool, scopedMonth),
  ]);

  // 스코프 월에 데이터가 0건일 수도 있음(예: 사용자가 데이터 없는 미래 월을 --month 로 지정).
  // 이 경우에도 전체에는 데이터가 있으므로 hasData=true 로 두되, overview 가 0 임을 그대로 보고.
  return {
    meta: {
      generatedAt: new Date().toISOString(),
      scope: {
        month: scopedMonth,
        label: scopeLabel(scopedMonth),
      },
      // month 인자가 없었고 자동 선택한 경우 표시 + 전체 건수 참고치
      autoSelectedMonth: month ? false : true,
      totalTransactions: totalCount,
      hasData: true,
    },
    overview,
    expenseByCategory,
    incomeByCategory,
    monthlyTrend,
    budgetVsActual,
    topExpenses,
    recentTransactions,
    weekdayExpense,
  };
}

// ===========================================================================
// 7) overview — 스코프 월의 합계/건수/저축률/일평균. (SELECT only)
//    income/expense 합계는 ::float8, 건수는 ::int. 날짜는 to_char 문자열.
//    daysInScope: 해당 월의 실제 거래가 걸친 일수가 아니라, 분석에 의미 있는
//      "일평균 지출" 산출을 위해 (월 지정 시) 그 달의 일수, (전체 시) 첫~마지막 거래일 간 일수.
// ===========================================================================
async function queryOverview(pool, month) {
  // 합계/건수/최초·최종일을 한 번에.
  const { rows } = await pool.query(
    `SELECT
        COUNT(*)::int                                                    AS txn_count,
        to_char(MIN(txn_date), 'YYYY-MM-DD')                             AS first_date,
        to_char(MAX(txn_date), 'YYYY-MM-DD')                             AS last_date,
        COALESCE(SUM(amount) FILTER (WHERE type='income'), 0)::float8    AS total_income,
        COALESCE(SUM(amount) FILTER (WHERE type='expense'), 0)::float8   AS total_expense,
        COUNT(*) FILTER (WHERE type='expense')::int                      AS expense_txn_count
       FROM transactions
      WHERE ($1::text IS NULL OR to_char(txn_date, 'YYYY-MM') = $1)`,
    [month]
  );
  const r = rows[0];
  const txnCount = r.txn_count;
  const totalIncome = Number(r.total_income);
  const totalExpense = Number(r.total_expense);
  const net = totalIncome - totalExpense;
  const expenseTxnCount = r.expense_txn_count;
  const firstDate = r.first_date;
  const lastDate = r.last_date;

  // 저축률: net/totalIncome. income 0 이면 null.
  const savingsRate = totalIncome ? ratio3(net, totalIncome) : null;

  // 건당 평균 지출(반올림 정수).
  const avgExpensePerTxn = expenseTxnCount
    ? Math.round(totalExpense / expenseTxnCount)
    : 0;

  // 일수 산정:
  //   - 특정 월: 그 달의 달력상 일수(예: 6월=30).
  //   - 전체: 첫~마지막 거래일 포함 일수(둘 다 있을 때), 없으면 0.
  let daysInScope = 0;
  if (month) {
    const y = Number(month.slice(0, 4));
    const mo = Number(month.slice(5, 7));
    daysInScope = new Date(Date.UTC(y, mo, 0)).getUTCDate(); // 해당 월 말일 = 일수
  } else if (firstDate && lastDate) {
    const a = Date.UTC(
      Number(firstDate.slice(0, 4)),
      Number(firstDate.slice(5, 7)) - 1,
      Number(firstDate.slice(8, 10))
    );
    const b = Date.UTC(
      Number(lastDate.slice(0, 4)),
      Number(lastDate.slice(5, 7)) - 1,
      Number(lastDate.slice(8, 10))
    );
    daysInScope = Math.floor((b - a) / 86400000) + 1; // 양 끝 포함
  }

  const avgDailyExpense = daysInScope
    ? Math.round(totalExpense / daysInScope)
    : 0;

  return {
    txnCount,
    firstDate,
    lastDate,
    totalIncome,
    totalExpense,
    net,
    savingsRate,
    expenseTxnCount,
    avgExpensePerTxn,
    daysInScope,
    avgDailyExpense,
  };
}

// ===========================================================================
// 8) expenseByCategory — 지출 카테고리별 합계(내림차순) + share.
//    SUM::float8, COUNT::int. share = total / 전체 지출합(0 분모 → null).
// ===========================================================================
async function queryExpenseByCategory(pool, month) {
  const { rows } = await pool.query(
    `SELECT category,
            SUM(amount)::float8 AS total,
            COUNT(*)::int       AS count
       FROM transactions
      WHERE type = 'expense'
        AND ($1::text IS NULL OR to_char(txn_date, 'YYYY-MM') = $1)
      GROUP BY category
      ORDER BY total DESC`,
    [month]
  );
  const totals = rows.map((r) => ({
    category: r.category,
    total: Number(r.total),
    count: r.count,
  }));
  const grand = totals.reduce((s, r) => s + r.total, 0);
  return totals.map((r) => ({
    category: r.category,
    label: expenseLabel(r.category),
    total: r.total,
    count: r.count,
    share: ratio3(r.total, grand),
  }));
}

// ===========================================================================
// 9) incomeByCategory — 수입 카테고리별 합계(내림차순) + share.
// ===========================================================================
async function queryIncomeByCategory(pool, month) {
  const { rows } = await pool.query(
    `SELECT category,
            SUM(amount)::float8 AS total,
            COUNT(*)::int       AS count
       FROM transactions
      WHERE type = 'income'
        AND ($1::text IS NULL OR to_char(txn_date, 'YYYY-MM') = $1)
      GROUP BY category
      ORDER BY total DESC`,
    [month]
  );
  const totals = rows.map((r) => ({
    category: r.category,
    total: Number(r.total),
    count: r.count,
  }));
  const grand = totals.reduce((s, r) => s + r.total, 0);
  return totals.map((r) => ({
    category: r.category,
    label: incomeLabel(r.category),
    total: r.total,
    count: r.count,
    share: ratio3(r.total, grand),
  }));
}

// ===========================================================================
// 10) monthlyTrend — 항상 최근 N개월(월 무관 추세). 오름차순.
//     to_char(txn_date,'YYYY-MM') 로 그룹핑한 뒤, 최근 N개월만 잘라 오름차순 정렬.
//     income/expense 는 FILTER 합계(::float8), net = income - expense.
// ===========================================================================
async function queryMonthlyTrend(pool, months) {
  const { rows } = await pool.query(
    `SELECT to_char(txn_date, 'YYYY-MM') AS month,
            COALESCE(SUM(amount) FILTER (WHERE type='income'), 0)::float8  AS income,
            COALESCE(SUM(amount) FILTER (WHERE type='expense'), 0)::float8 AS expense
       FROM transactions
      GROUP BY to_char(txn_date, 'YYYY-MM')
      ORDER BY month DESC
      LIMIT $1`,
    [months]
  );
  // DESC 로 최근 N개월을 받은 뒤, 출력은 오름차순으로 뒤집는다.
  return rows
    .map((r) => {
      const income = Number(r.income);
      const expense = Number(r.expense);
      return { month: r.month, income, expense, net: income - expense };
    })
    .reverse();
}

// ===========================================================================
// 11) budgetVsActual — budgets(예산) 와 스코프 월 지출합을 category 로 머지.
//     EXPENSE 카테고리 전체가 나오도록(예산만 있고 지출 0 / 지출만 있고 예산 없음 모두 표현).
//     status: over(>1.0) / warning(>=0.8) / ok(<0.8) / unset(예산 없음).
//     예산 없으면 budget:null, ratio:null, status:'unset'.
//     ※ budgets/transactions 두 SELECT 결과를 코드에서 머지(앱 스키마 변경 없음).
// ===========================================================================
async function queryBudgetVsActual(pool, month) {
  // (a) 예산: EXPENSE 화이트리스트만.
  const budgetRes = await pool.query(
    `SELECT category, amount
       FROM budgets
      WHERE category = ANY($1)`,
    [EXPENSE_CATEGORIES]
  );
  const budgetMap = new Map(
    budgetRes.rows.map((r) => [r.category, Number(r.amount)])
  );

  // (b) 스코프 월의 지출합(카테고리별).
  const spentRes = await pool.query(
    `SELECT category, SUM(amount)::float8 AS spent
       FROM transactions
      WHERE type = 'expense'
        AND ($1::text IS NULL OR to_char(txn_date, 'YYYY-MM') = $1)
      GROUP BY category`,
    [month]
  );
  const spentMap = new Map(
    spentRes.rows.map((r) => [r.category, Number(r.spent)])
  );

  // (c) 표준 EXPENSE 카테고리 ∪ 실제 등장한 카테고리(앱이 늘어났을 수 있음) 를 합집합으로.
  const cats = new Set(EXPENSE_CATEGORIES);
  for (const c of budgetMap.keys()) cats.add(c);
  for (const c of spentMap.keys()) cats.add(c);

  const rows = [];
  for (const category of cats) {
    const spent = spentMap.get(category) || 0;
    // 예산 행이 없거나 0원이면 "미설정"으로 취급한다.
    //   앱에서 예산 저장 시 빈 칸이 0 으로 들어오므로, 0원을 '예산 초과'로 보면
    //   사용자가 잡지도 않은 항목을 초과했다고 오해하게 된다 → status:'unset' 으로.
    const rawBudget = budgetMap.has(category) ? budgetMap.get(category) : null;
    const hasBudget = rawBudget !== null && rawBudget > 0;
    const budget = hasBudget ? rawBudget : null;

    let ratio = null;
    let status = 'unset';
    let remaining = null;
    if (hasBudget) {
      remaining = budget - spent; // 음수면 초과
      ratio = ratio3(spent, budget);
      if (ratio > 1.0) status = 'over';
      else if (ratio >= 0.8) status = 'warning';
      else status = 'ok';
    }

    rows.push({
      category,
      label: expenseLabel(category),
      budget,
      spent,
      remaining,
      ratio,
      status,
    });
  }

  // 보기 좋게: 지출 큰 순 → 같으면 표준 카테고리 순서.
  const order = new Map(EXPENSE_CATEGORIES.map((c, i) => [c, i]));
  rows.sort((a, b) => {
    if (b.spent !== a.spent) return b.spent - a.spent;
    return (order.get(a.category) ?? 999) - (order.get(b.category) ?? 999);
  });
  return rows;
}

// ===========================================================================
// 12) topExpenses — 스코프 월 지출 중 금액 내림차순 상위 10.
//     date 는 to_char 문자열, amount 는 Number.
// ===========================================================================
async function queryTopExpenses(pool, month) {
  const { rows } = await pool.query(
    `SELECT to_char(txn_date, 'YYYY-MM-DD') AS date,
            category,
            amount,
            memo
       FROM transactions
      WHERE type = 'expense'
        AND ($1::text IS NULL OR to_char(txn_date, 'YYYY-MM') = $1)
      ORDER BY amount DESC, txn_date DESC, id DESC
      LIMIT 10`,
    [month]
  );
  return rows.map((r) => ({
    date: r.date,
    category: r.category,
    label: expenseLabel(r.category),
    amount: Number(r.amount),
    memo: r.memo,
  }));
}

// ===========================================================================
// 13) recentTransactions — 스코프 월 최근 15건(txn_date DESC, id DESC).
//     수입/지출 모두 포함. type 에 맞는 라벨맵으로 label.
// ===========================================================================
async function queryRecentTransactions(pool, month) {
  const { rows } = await pool.query(
    `SELECT to_char(txn_date, 'YYYY-MM-DD') AS date,
            type,
            category,
            amount,
            memo
       FROM transactions
      WHERE ($1::text IS NULL OR to_char(txn_date, 'YYYY-MM') = $1)
      ORDER BY txn_date DESC, id DESC
      LIMIT 15`,
    [month]
  );
  return rows.map((r) => ({
    date: r.date,
    type: r.type,
    category: r.category,
    label: r.type === 'income' ? incomeLabel(r.category) : expenseLabel(r.category),
    amount: Number(r.amount),
    memo: r.memo,
  }));
}

// ===========================================================================
// 14) weekdayExpense — 요일별 지출 합계/건수(지출만). 0=일 ~ 6=토, 오름차순.
//     EXTRACT(DOW FROM txn_date)::int 로 그룹핑. 거래 없는 요일도 0 으로 채운다.
// ===========================================================================
async function queryWeekdayExpense(pool, month) {
  const { rows } = await pool.query(
    `SELECT EXTRACT(DOW FROM txn_date)::int AS weekday,
            SUM(amount)::float8            AS total,
            COUNT(*)::int                  AS count
       FROM transactions
      WHERE type = 'expense'
        AND ($1::text IS NULL OR to_char(txn_date, 'YYYY-MM') = $1)
      GROUP BY EXTRACT(DOW FROM txn_date)`,
    [month]
  );
  const byDow = new Map(
    rows.map((r) => [r.weekday, { total: Number(r.total), count: r.count }])
  );
  // 0~6 전부 채워서 항상 7개(없는 요일은 0).
  const out = [];
  for (let d = 0; d < 7; d++) {
    const hit = byDow.get(d);
    out.push({
      weekday: d,
      label: WEEKDAY_LABELS[d],
      total: hit ? hit.total : 0,
      count: hit ? hit.count : 0,
    });
  }
  return out;
}

// ===========================================================================
// 15) 진입점
// ===========================================================================
main().catch((err) => {
  // 최후의 안전망 — 위에서 못 잡은 예외(DB_URL 비노출).
  logErr('[analyze] 예기치 못한 오류: ' + (err && err.message ? err.message : err));
  emit({ error: '분석 도구 실행 중 예기치 못한 오류가 발생했습니다.' });
  process.exit(1);
});
