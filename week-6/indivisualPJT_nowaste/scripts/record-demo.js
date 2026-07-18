// 30초 이내 데모 영상. 실제 배포 앱과 동일한 화면(localhost:3300)을 실제 데이터로 촬영한다.
// 로그인 상태로 부팅(토큰 주입) → 냉장고 → 요리 → 리포트 → 담기 순회. 커서·자막 오버레이 포함.
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:3300';
const OUTDIR = path.resolve(__dirname, '..', 'demo-video');
const { token } = require('./.demo-token.json');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 402, height: 848 },
    deviceScaleFactor: 2,
    recordVideo: { dir: OUTDIR, size: { width: 402, height: 848 } }, // 뷰포트와 일치시켜야 화면이 꽉 참
  });
  // 앱 부팅 전에 토큰을 심어 바로 홈(냉장고)으로 들어가게
  await ctx.addInitScript((t) => localStorage.setItem('nowaste.token', t), token);

  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  // 오버레이(커서 + 자막) 주입
  await page.evaluate(() => {
    const c = document.createElement('div');
    c.id = '_cur';
    c.style.cssText = 'position:fixed;left:200px;top:430px;width:26px;height:26px;border-radius:50%;' +
      'background:rgba(22,25,26,.28);border:2.5px solid #16191A;z-index:99998;pointer-events:none;' +
      'transform:translate(-50%,-50%);transition:left .55s cubic-bezier(.22,.61,.36,1),top .55s cubic-bezier(.22,.61,.36,1);' +
      'box-shadow:0 2px 10px rgba(0,0,0,.25)';
    document.body.appendChild(c);
    const cap = document.createElement('div');
    cap.id = '_cap';
    cap.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:99999;' +
      'background:rgba(22,25,26,.92);color:#fff;font-family:Pretendard,sans-serif;font-weight:700;' +
      'font-size:14px;letter-spacing:-.01em;padding:9px 16px;border-radius:999px;white-space:nowrap;' +
      'opacity:0;transition:opacity .4s;box-shadow:0 6px 20px rgba(0,0,0,.25)';
    document.body.appendChild(cap);
    window.__say = (t) => { cap.textContent = t; cap.style.opacity = t ? '1' : '0'; };
    window.__cur = (x, y) => { const e = document.getElementById('_cur'); e.style.left = x + 'px'; e.style.top = y + 'px'; };
    window.__click = () => {
      const e = document.getElementById('_cur');
      e.animate([{ transform: 'translate(-50%,-50%) scale(1)' }, { transform: 'translate(-50%,-50%) scale(.6)' },
        { transform: 'translate(-50%,-50%) scale(1)' }], { duration: 260 });
    };
    // 스크롤 가능한 실제 컨테이너 찾기
    window.__scroller = () => {
      let best = document.scrollingElement, bh = best ? best.scrollHeight - best.clientHeight : 0;
      document.querySelectorAll('*').forEach((el) => {
        const oy = getComputedStyle(el).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight - el.clientHeight > bh) { best = el; bh = el.scrollHeight - el.clientHeight; }
      });
      return best;
    };
    window.__scroll = (dy, ms) => new Promise((res) => {
      const el = window.__scroller(); if (!el) return res();
      const s = el.scrollTop, t0 = performance.now();
      (function step(t) {
        const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3);
        el.scrollTop = s + dy * e;
        k < 1 ? requestAnimationFrame(step) : res();
      })(t0);
    });
  });

  const say = (t) => page.evaluate((x) => window.__say(x), t);
  const scroll = (dy, ms) => page.evaluate(([d, m]) => window.__scroll(d, m), [dy, ms]).then(() => wait(ms + 40));
  async function moveTo(sel) {
    const box = await page.locator(sel).first().boundingBox();
    if (box) await page.evaluate(([x, y]) => window.__cur(x, y), [box.x + box.width / 2, box.y + box.height / 2]);
    await wait(600);
  }
  async function tapNav(label, caption) {
    const sel = `nav button:has-text("${label}")`;
    await moveTo(sel);
    await page.evaluate(() => window.__click());
    await wait(180);
    await page.locator(sel).first().click();
    if (caption) await say(caption);
  }

  // ── 타임라인 (≈24초, 부팅 여백은 후처리에서 잘라냄) ──
  await page.waitForSelector('text=오늘 안 쓰면 버려요', { timeout: 15000 });
  await wait(600);
  await say('냉장고를 열면 — 급한 게 빨갛게 먼저');
  await wait(2100);
  await scroll(250, 1000);         // 아래로: 이번 주 목록(D-스탬프)
  await wait(1300);
  await scroll(-250, 650);
  await wait(300);

  await tapNav('요리', '오늘 뭐 먹지 — 급한 재료부터 쓰는 레시피');
  await page.waitForSelector('text=오늘 뭐 먹지', { timeout: 10000 });
  await wait(2100);
  await scroll(300, 1100);
  await wait(1500);
  await scroll(-300, 650);

  await tapNav('리포트', '버린 돈이 줄어드는 게 보여요');
  await page.waitForSelector('text=버린 돈이', { timeout: 10000 });
  await wait(3500);

  await tapNav('담기', '사진 한 장, 또는 두 번의 탭');
  await wait(2200);

  await tapNav('냉장고', '남김없이 — 다 쓰는 그날까지');
  await wait(1900);
  await say('');
  await wait(300);

  const video = page.video();
  await ctx.close(); // 영상 flush
  const raw = await video.path();
  const dest = path.join(OUTDIR, 'raw.webm');
  fs.copyFileSync(raw, dest);
  await browser.close();
  console.log('WEBM:', dest);
})().catch((e) => { console.error(e); process.exit(1); });
