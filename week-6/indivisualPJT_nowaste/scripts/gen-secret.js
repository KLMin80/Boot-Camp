// JWT_SECRET이 없으면 만들어 .env에 덧붙인다. 이미 있으면 건드리지 않는다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const envPath = path.join(__dirname, '..', '.env');
const raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

if (/^JWT_SECRET=.+/m.test(raw)) {
  console.log('JWT_SECRET 이미 있음 — 건너뜀');
  process.exit(0);
}

const secret = crypto.randomBytes(32).toString('hex');
const sep = raw.length && !raw.endsWith('\n') ? '\n' : '';
fs.appendFileSync(envPath, `${sep}JWT_SECRET=${secret}\n`);
console.log('JWT_SECRET 생성해 .env에 추가했습니다 (값은 출력하지 않음)');
