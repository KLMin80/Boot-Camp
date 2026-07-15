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

module.exports = { readLabel, normalizeExpiry, hasOCR: () => Boolean(client) };
