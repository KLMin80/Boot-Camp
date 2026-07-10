// Supabase(Postgres) 연결 헬퍼
// - pg 모듈은 이 폴더에 없으므로 형제 프로젝트의 node_modules에서 절대경로로 가져온다.
//   (한 곳이 지워져도 동작하도록 후보를 순회한다)
// - 비밀번호에 특수문자(@, !, / 등)가 있으면 connectionString이 authority를 잘못 파싱하므로
//   URL을 직접 분해해 host/port/user/password/database를 개별 필드로 넘긴다.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PG_HOSTS = [
  __dirname,
  'D:/Boot Camp/week-6/quest/1_shoping_mall/',
  'D:/Boot Camp/week-5/quest/2_household_analysis_agent/',
  'D:/Boot Camp/week-4/quest/4_bulletin_board/',
];

function loadPg() {
  const tried = [];
  for (const base of PG_HOSTS) {
    try {
      return createRequire(path.join(base, 'noop.js'))('pg');
    } catch (e) {
      tried.push(base);
    }
  }
  throw new Error(
    'pg 모듈을 찾지 못했습니다. 다음 위치를 확인했습니다:\n  ' + tried.join('\n  ') +
    '\n이 폴더에서 `npm install pg` 를 실행하세요.'
  );
}

const { Pool } = loadPg();

function loadEnv() {
  const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i === -1) continue;
    env[trimmed.slice(0, i).trim()] = trimmed.slice(i + 1).trim();
  }
  return env;
}

export function createPool() {
  const url = loadEnv().SUPABASE_DB_URL;
  if (!url) throw new Error('.env 에 SUPABASE_DB_URL 이 없습니다.');

  const m = url.match(/^postgres(?:ql)?:\/\/([^:]+):(.+)@([^:@]+):(\d+)\/(.+)$/);
  if (!m) throw new Error('SUPABASE_DB_URL 형식을 해석할 수 없습니다.');
  const [, user, password, host, port, database] = m;

  // 퍼센트 인코딩된 비밀번호면 디코딩하고, 아니면 원문 그대로 쓴다.
  let pw = password;
  try { pw = decodeURIComponent(password); } catch { /* 리터럴 % 포함 → 원문 사용 */ }

  return new Pool({
    user,
    password: pw,
    host,
    port: Number(port),
    database,
    ssl: { rejectUnauthorized: false },
    max: 4,
  });
}
