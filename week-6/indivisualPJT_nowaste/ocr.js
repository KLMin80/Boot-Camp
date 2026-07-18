// 라벨 사진 → 구조화 (GPT-4o-mini 비전, detail:high)
// 실측 결론(ocr-accuracy-test.png): Tesseract 0/7, GPT 6/7 → GPT 채택.
// 실측이 드러낸 것: 한국 날짜 도장은 연도 없이 월.일만인 경우가 많다 → 연도 추론 필수.

const OpenAI = require('openai');
const apiKey = process.env.OPEN_AI_API || process.env.OPENAI_API_KEY;
const client = apiKey ? new OpenAI({ apiKey }) : null;

const pad = (n) => String(n).padStart(2, '0');
const kstToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()); // YYYY-MM-DD

// GPT가 준 날짜를 정규화. 연도가 없으면 추론(월.일이 오늘보다 과거면 내년 = 유통기한은 미래).
function normalizeExpiry(raw) {
  if (!raw) return null;
  const s = String(raw).trim().replace(/[./]/g, '-').replace(/\s+/g, '');
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); // 연도 있음
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{2})-(\d{1,2})-(\d{1,2})$/); // YY-MM-DD
  if (m) return `20${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})-(\d{1,2})$/); // 월-일 (연도 없음)
  if (m) {
    const mo = +m[1], d = +m[2];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const [ty, tm, td] = kstToday().split('-').map(Number);
    let y = ty;
    const cand = Date.UTC(y, mo - 1, d), today = Date.UTC(ty, tm - 1, td);
    if (cand < today) y += 1; // 이미 지난 월.일이면 내년치 유통기한
    return `${y}-${pad(mo)}-${pad(d)}`;
  }
  return null;
}

const PROMPT = [
  '이 식품 라벨/포장 사진에서 정보를 읽어라.',
  '- name: 제품명 (예: "서울우유 1A 흰우유")',
  '- ingredient: 핵심 재료명 한두 단어 (예: 우유, 두부, 돼지고기, 달걀). 요리 매칭용.',
  '- capacity: 내용량 숫자만 (예: 900). unit: g / ml / 개 중 하나.',
  '- expiry: 유통기한 또는 소비기한. **제조일과 둘 다 있으면 더 나중 날짜(유통기한)를 골라라.**',
  '  연도가 보이면 YYYY-MM-DD, 연도가 안 보이면 MM-DD 형식으로.',
  '- price: 가격 숫자만 (원). 없으면 null.',
  '- raw_text: 사진에서 읽은 글자 원문(짧게).',
  '안 보이는 값은 반드시 null. 억지로 지어내지 마라.',
].join('\n');

const SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'label', strict: true,
    schema: {
      type: 'object', additionalProperties: false,
      required: ['name', 'ingredient', 'capacity', 'unit', 'expiry', 'price', 'raw_text'],
      properties: {
        name: { type: ['string', 'null'] },
        ingredient: { type: ['string', 'null'] },
        capacity: { type: ['number', 'null'] },
        unit: { type: ['string', 'null'], enum: ['g', 'ml', '개', null] },
        expiry: { type: ['string', 'null'] },
        price: { type: ['number', 'null'] },
        raw_text: { type: ['string', 'null'] },
      },
    },
  },
};

async function readLabel(image) {
  if (!client) throw new Error('OCR이 설정되지 않았습니다 (.env의 OPEN_AI_API).');
  const url = image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`;

  const r = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 400,
    messages: [{ role: 'user', content: [
      { type: 'text', text: PROMPT },
      { type: 'image_url', image_url: { url, detail: 'high' } }, // detail:low는 작은 라벨서 날짜 지어냄(실측)
    ]}],
    response_format: SCHEMA,
  });

  const p = JSON.parse(r.choices[0].message.content);
  return {
    name: p.name || null,
    ingredient: p.ingredient || p.name || null,
    capacity: p.capacity && p.capacity > 0 ? p.capacity : null,
    unit: p.unit || null,
    expiry: normalizeExpiry(p.expiry),   // 연도 추론된 YYYY-MM-DD 또는 null
    expiry_raw: p.expiry || null,
    price: p.price != null ? Math.round(p.price) : null,
    ocr_text: p.raw_text || null,
    tokens: r.usage?.prompt_tokens ?? null,
  };
}

// ── 영수증 → 품목·가격 여러 건 ──
// 영수증엔 유통기한이 없다. 여기선 제품명·재료·가격·수량만 뽑고, 유통기한은 앱이 뒤에서 보충한다.
const RECEIPT_PROMPT = [
  '이 영수증(또는 영수증 캡처) 사진에서 "식료품·식자재" 항목만 뽑아라.',
  '- 각 항목: name(영수증에 적힌 상품명 그대로), ingredient(핵심 재료명 한두 단어 — 우유/두부/돼지고기/달걀/양파 등, 요리 매칭용. 모르면 상품명에서 추정),',
  '  price(그 줄의 결제금액, 원, 정수), qty(수량, 안 보이면 1).',
  '- 비닐봉투·종량제봉투·할인·포인트적립·부가세·합계·거스름돈처럼 냉장고에 안 들어가는 건 제외.',
  '- 애매하면 빼라. 확실한 식료품만.',
  '항목이 하나도 없으면 items를 빈 배열로.',
].join('\n');

const RECEIPT_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'receipt', strict: true,
    schema: {
      type: 'object', additionalProperties: false, required: ['items'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            required: ['name', 'ingredient', 'price', 'qty'],
            properties: {
              name: { type: 'string' },
              ingredient: { type: 'string' },
              price: { type: ['integer', 'null'] },
              qty: { type: ['integer', 'null'] },
            },
          },
        },
      },
    },
  },
};

async function readReceipt(image) {
  if (!client) throw new Error('OCR이 설정되지 않았습니다 (.env의 OPEN_AI_API).');
  const url = image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`;

  const r = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 1500, // 영수증은 항목이 많다
    messages: [{ role: 'user', content: [
      { type: 'text', text: RECEIPT_PROMPT },
      { type: 'image_url', image_url: { url, detail: 'high' } },
    ]}],
    response_format: RECEIPT_SCHEMA,
  });

  const p = JSON.parse(r.choices[0].message.content);
  const items = (p.items || [])
    .map((it) => ({
      name: (it.name || '').trim() || null,
      ingredient: (it.ingredient || it.name || '').trim() || null,
      price: it.price != null && it.price >= 0 ? Math.round(it.price) : null,
      qty: it.qty && it.qty > 0 ? Math.round(it.qty) : 1,
    }))
    .filter((it) => it.name);
  return { items, tokens: r.usage?.prompt_tokens ?? null };
}

module.exports = { readLabel, readReceipt, normalizeExpiry, hasOCR: () => Boolean(client) };
