// OCR 정확도 실험실 (Phase 3 검증 기록, 앱 코드 아님)
// 같은 라벨 사진에 Tesseract.js(무료·온디바이스 후보) vs GPT-4o-mini 비전(유료)을
// 나란히 돌려 날짜·용량을 뽑아 비교했다.
//
// 결론(2026-07): 실제 사용자 사진서 Tesseract 날짜 0/7, GPT 6/7 → GPT-4o-mini 채택.
//   근거: ../ocr-accuracy-test.png, 상세: ../DEV.md > Open Questions
// Tesseract 부분을 돌리려면: npm install tesseract.js --no-save (채택 안 해 package.json에 없음)
// extractFields()·gptVision()은 실제 /api/label/parse 구현에 재사용된다.
require('dotenv').config();
const fs = require('fs');
const OpenAI = require('openai');

const apiKey = process.env.OPEN_AI_API || process.env.OPENAI_API_KEY;
const openai = apiKey ? new OpenAI({ apiKey }) : null;

/* ── 라벨 텍스트에서 필드 추출 (DEV.md의 정규식) ── */
function extractFields(text) {
  const t = (text || '').replace(/[Oo]/g, (m) => m); // 자리표시(추후 O→0 보정 가능)

  // 날짜: 여러 표기를 잡고, 가장 가까운 미래(=유통기한, 제조일 아님)를 고른다
  const dateRe = /(20\d{2}|\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/g;
  const dates = [];
  let m;
  while ((m = dateRe.exec(t))) {
    let [, y, mo, d] = m;
    y = y.length === 2 ? 2000 + Number(y) : Number(y);
    mo = Number(mo); d = Number(d);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      dates.push(`${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
  }
  // YYYYMMDD 8자리도
  const compact = t.match(/\b(20\d{2})(\d{2})(\d{2})\b/g) || [];
  for (const c of compact) dates.push(`${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}`);

  const uniqDates = [...new Set(dates)].sort();
  const expiry = uniqDates.length ? uniqDates[uniqDates.length - 1] : null; // 가장 늦은 = 유통기한

  // 용량: 500g / 1.8kg / 900ml / 1L
  const capRe = /(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l|리터|리)\b/gi;
  const caps = [];
  while ((m = capRe.exec(t))) {
    let n = parseFloat(m[1].replace(',', '.'));
    const u = m[2].toLowerCase();
    if (u === 'kg') { n *= 1000; caps.push(`${n}g`); }
    else if (u === 'l' || u === '리터' || u === '리') { n *= 1000; caps.push(`${n}ml`); }
    else caps.push(`${n}${u}`);
  }
  const capacity = caps[0] || null;

  return { expiry, capacity, allDates: uniqDates };
}

/* ── Tesseract.js ── */
let _worker = null;
async function tesseract(imgPath) {
  const { createWorker } = require('tesseract.js');
  if (!_worker) {
    _worker = await createWorker(['kor', 'eng']);
  }
  const t0 = Date.now();
  const { data } = await _worker.recognize(imgPath);
  return { text: data.text, confidence: Math.round(data.confidence), ms: Date.now() - t0 };
}

/* ── GPT-4o-mini 비전 ── */
async function gptVision(imgPath) {
  if (!openai) return null;
  const b64 = fs.readFileSync(imgPath).toString('base64');
  const ext = imgPath.split('.').pop().toLowerCase();
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
  const t0 = Date.now();
  const r = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '이 식품 라벨/포장 사진에서 제품명, 용량(내용량), 유통기한(또는 소비기한)을 읽어줘. 제조일과 유통기한이 둘 다 있으면 유통기한(더 나중 날짜)을 골라줘. 안 보이면 null.' },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
      ],
    }],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'label', strict: true,
        schema: {
          type: 'object', additionalProperties: false,
          required: ['name', 'capacity', 'expiry'],
          properties: {
            name: { type: ['string', 'null'] },
            capacity: { type: ['string', 'null'] },
            expiry: { type: ['string', 'null'] }, // YYYY-MM-DD
          },
        },
      },
    },
  });
  return { ...JSON.parse(r.choices[0].message.content), ms: Date.now() - t0,
           tokens: r.usage.prompt_tokens + r.usage.completion_tokens };
}

module.exports = { extractFields, tesseract, gptVision, closeWorker: async () => { if (_worker) await _worker.terminate(); } };
