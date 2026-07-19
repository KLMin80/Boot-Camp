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
    await tap(`nav button:has-text("${label}")`, caption);
  }
  // 일반 요소 탭 (커서 이동 + 클릭 애니메이션 + 클릭)
  async function tap(sel, caption) {
    const loc = page.locator(sel).first();
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await moveTo(sel);
    await page.evaluate(() => window.__click());
    await wait(170);
    await loc.click();
    if (caption != null) await say(caption);
  }

  // ── 타임라인 (≈28초, 부팅 여백은 후처리에서 잘라냄) ──
  await page.waitForSelector('text=오늘 안 쓰면 버려요', { timeout: 15000 });
  await wait(600);
  await say('냉장고를 열면 — 급한 건 빨강, 곧 떨어질 건 미리 알림');
  await wait(2700);                       // 급함카드(빨강) + 곧 떨어져요(주황) 둘 다

  // ① 부분 차감 — 앱 없이 요리했어도 쓴 만큼만
  await scroll(360, 900);                 // 목록 내려 재료 하나 보이게
  await wait(500);
  await tap('text=초란 10구', '앱 없이 요리했어도 — 쓴 만큼만 빼요');
  await page.waitForSelector('button:has-text("조금 썼어요")', { timeout: 5000 });
  await wait(400);
  await tap('button:has-text("조금 썼어요")', null);
  await page.waitForSelector('button:has-text("½")', { timeout: 4000 });
  await wait(350);
  await tap('button:has-text("½")', null);
  await wait(250);
  await tap('button:has-text("빼기")', null);
  await wait(900);

  // ② 요리 → 이걸로 요리 → 재료 자동 차감
  await tapNav('요리', '지금 재료로 만들 요리 — 급한 것부터');
  await page.waitForSelector('article', { timeout: 12000 });
  await wait(1900);
  await tap('article button:has-text("이걸로 요리")', '만들면 재료가 냉장고서 자동으로 빠져요');
  await page.waitForSelector('text=다 만들었어요', { timeout: 6000 });
  await wait(1700);
  await tap('button:has-text("다 만들었어요")', null);
  await wait(1500);

  // ③ 리포트 — 아낀 돈
  await tapNav('리포트', '아낀 돈이 숫자로 보여요');
  await page.waitForSelector('text=버린 돈이', { timeout: 10000 });
  await wait(3100);

  // ④ 담기 — 영수증 한 장이면 한꺼번에
  await tapNav('담기', '영수증 한 장이면 품목·가격 한꺼번에');
  await page.waitForSelector('text=영수증으로 한 번에', { timeout: 6000 });
  await wait(2500);

  await tapNav('냉장고', '남김없이 — 다 쓰는 그날까지');
  await wait(1700);
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
