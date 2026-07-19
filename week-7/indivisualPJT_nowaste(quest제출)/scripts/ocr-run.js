// 이미지 폴더를 받아 두 엔진으로 OCR → 필드 추출 → 비교 결과를 JSON으로.
const fs = require('fs');
const path = require('path');
const { extractFields, tesseract, gptVision, closeWorker } = require('./ocr-lab');

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) { console.error('사용법: node ocr-run.js <이미지폴더>'); process.exit(1); }

const imgs = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();

(async () => {
  const out = [];
  for (const f of imgs) {
    const p = path.join(dir, f);
    process.stderr.write(`  OCR: ${f} … `);
    const row = { file: f };

    try {
      const tes = await tesseract(p);
      row.tesseract = { ...extractFields(tes.text), confidence: tes.confidence, ms: tes.ms, raw: tes.text.replace(/\s+/g, ' ').trim().slice(0, 200) };
    } catch (e) { row.tesseract = { error: e.message }; }

    try {
      const g = await gptVision(p);
      row.gpt = g;
    } catch (e) { row.gpt = { error: e.status + ' ' + e.message }; }

    process.stderr.write('done\n');
    out.push(row);
  }
  await closeWorker();
  fs.writeFileSync(path.join(dir, '_results.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})();
