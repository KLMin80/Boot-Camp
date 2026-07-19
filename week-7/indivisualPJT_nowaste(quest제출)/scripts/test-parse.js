// /api/label/parse를 실제 라벨 사진으로 검증 (서버 실행 중이어야 함).
const fs = require('fs');
const BASE = 'http://localhost:3000';
const OCR = 'C:/Users/ADMINI~1/AppData/Local/Temp/claude/D--Boot-Camp/cde68ac6-d911-421e-9db9-d4dbd72df646/scratchpad/ocr/real';

const call = (m, u, { token, body } = {}) =>
  fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

(async () => {
  const email = `parse${Date.now()}@test.com`;
  const { data: auth } = await call('POST', '/api/auth/signup', { body: { email, password: 'pw123456' } });
  const token = auth.token;

  const kstToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  console.log('오늘(KST):', kstToday, '\n');

  for (const f of ['05-milk-sbs.jpg', '01-milk-kin.jpg', '07-pork-cboard.jpg']) {
    const b64 = fs.readFileSync(`${OCR}/${f}`).toString('base64');
    const t0 = Date.now();
    const { status, data } = await call('POST', '/api/label/parse', {
      token, body: { image: `data:image/jpeg;base64,${b64}`, storage: 'fridge' },
    });
    if (status !== 201) { console.log(`${f}: 실패 ${status}`, data); continue; }
    const it = data.item, rd = data.read;
    console.log(`${f}  (${Date.now() - t0}ms)`);
    console.log(`  제품명: ${it.name}`);
    console.log(`  재료:   ${it.ingredient}`);
    console.log(`  용량:   ${it.capacity}${it.unit}${it.price ? ` · ${it.price}원` : ''}`);
    console.log(`  유통기한: ${it.expiry_date} (D-${it.days_left}) · 출처 ${it.expiry_source}`);
    console.log(`  status: ${it.status}${rd.expiry_raw ? ` · GPT원본날짜 "${rd.expiry_raw}"` : ''}\n`);
  }

  // 확인 대기 목록에 3장 다 있는지
  const { data: pend } = await call('GET', '/api/items?status=pending', { token });
  console.log(`확인 대기: ${pend.items.length}건 (사진 3장이 pending으로 들어갔나)`);

  // 홈(confirmed)에는 안 보여야
  const { data: conf } = await call('GET', '/api/items?status=confirmed', { token });
  console.log(`냉장고(confirmed): ${conf.items.length}건 (확인 전이라 0이어야)`);
})().catch((e) => { console.error(e.message); process.exit(1); });
