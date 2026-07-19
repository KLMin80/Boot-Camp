// 업로드 전 다운스케일이 토큰(=비용)을 얼마나 줄이나 실측.
require('dotenv').config();
const fs = require('fs');
const sharp = require('sharp');
const OpenAI = require('openai');
const client = new OpenAI({ apiKey: process.env.OPEN_AI_API });
const dir = 'C:/Users/ADMINI~1/AppData/Local/Temp/claude/D--Boot-Camp/cde68ac6-d911-421e-9db9-d4dbd72df646/scratchpad/ocr/real';

async function ask(buf) {
  const b64 = buf.toString('base64');
  const r = await client.chat.completions.create({
    model: 'gpt-4o-mini', max_tokens: 120,
    messages: [{ role: 'user', content: [
      { type: 'text', text: '이 라벨의 유통기한(또는 소비기한)과 용량만. 안 보이면 null.' },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'high' } },
    ]}],
  });
  return { tok: r.usage.prompt_tokens, txt: r.choices[0].message.content.replace(/\s+/g, ' ').slice(0, 55) };
}

(async () => {
  for (const f of ['05-milk-sbs.jpg', '07-pork-cboard.jpg']) {
    const orig = fs.readFileSync(`${dir}/${f}`);
    const meta = await sharp(orig).metadata();
    const small = await sharp(orig).resize({ width: 1024, height: 1024, fit: 'inside' }).jpeg({ quality: 80 }).toBuffer();

    const a = await ask(orig);
    const b = await ask(small);
    console.log(`\n${f}  (원본 ${meta.width}x${meta.height}, ${Math.round(orig.length/1024)}KB → 1024px, ${Math.round(small.length/1024)}KB)`);
    console.log(`  원본  ${a.tok} tok · ${a.txt}`);
    console.log(`  1024  ${b.tok} tok · ${b.txt}`);
    console.log(`  절감  ${Math.round((1 - b.tok/a.tok)*100)}%`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
