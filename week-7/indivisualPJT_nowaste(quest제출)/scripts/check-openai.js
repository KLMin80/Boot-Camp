// OpenAI 키가 실제로 되는지 + structured output(enum 강제)이 되는지 최소 확인.
require('dotenv').config();
const OpenAI = require('openai');

const key = process.env.OPEN_AI_API || process.env.OPENAI_API_KEY;
if (!key) { console.error('.env에 OPEN_AI_API가 없습니다.'); process.exit(1); }

const client = new OpenAI({ apiKey: key });
const VOCAB = ['양파', '대파', '두부', '달걀', '돼지고기'];

(async () => {
  const r = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: '한국 가정식 요리사. 주어진 재료로 만들 요리 1개를 제안한다.' },
      { role: 'user', content: `보유 재료: 대파, 두부. 이걸 최대한 소진하는 요리 하나.` },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'recipe',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'uses'],
          properties: {
            title: { type: 'string' },
            uses: {
              type: 'array',
              items: { type: 'string', enum: VOCAB }, // ← 어휘 밖 재료는 원천 차단
            },
          },
        },
      },
    },
    max_tokens: 200,
  });

  const out = JSON.parse(r.choices[0].message.content);
  console.log('✓ 키 OK · 모델 gpt-4o-mini');
  console.log('  응답:', JSON.stringify(out));
  const bad = out.uses.filter((x) => !VOCAB.includes(x));
  console.log(bad.length ? `  ✗ 어휘 밖 재료: ${bad}` : '  ✓ 재료가 전부 허용 어휘 안');
  console.log('  토큰:', r.usage.prompt_tokens, '+', r.usage.completion_tokens);
})().catch((e) => {
  console.error('실패:', e.status || '', e.message);
  process.exit(1);
});
