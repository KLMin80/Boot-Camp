// ============================================================================
// My Midjourney - 로컬 정적 웹서버 (의존성 0, Node 내장 모듈만 사용)
// ----------------------------------------------------------------------------
// 실행:   node server.js            (기본 포트 8080)
//         node server.js 8090       (포트 직접 지정)
//         PORT=9000 node server.js  (환경변수로 지정)
// 접속:   콘솔에 출력되는 http://localhost:<PORT>/ 주소
// 정지:   이 창에서 Ctrl + C
//
// 127.0.0.1 에만 바인딩하므로 같은 PC에서만 접속됩니다(외부/LAN 노출 안 됨).
// → index.html 에 박혀 있는 API 키가 네트워크로 새어 나가지 않습니다.
// ============================================================================

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname; // 이 server.js 가 있는 폴더(=프로젝트 폴더)를 그대로 서빙
const PORT = parseInt(process.argv[2] || process.env.PORT || "8080", 10);

// 확장자 → Content-Type
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
};

const server = http.createServer((req, res) => {
  // 쿼리스트링 제거 + URL 디코드
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split("?")[0]);
  } catch (e) {
    urlPath = req.url.split("?")[0];
  }
  if (urlPath === "/" || urlPath === "") urlPath = "/index.html";

  // 경로 정규화 + 상위 디렉터리 탈출(../) 차단
  const safePath = path
    .normalize(urlPath)
    .replace(/^(\.\.[\\/])+/, "")
    .replace(/^[\\/]+/, "");
  const filePath = path.join(ROOT, safePath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("403 Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 Not Found: " + safePath);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`✗ 포트 ${PORT} 가 이미 사용 중이에요. 다른 포트로: node server.js 8090`);
  } else {
    console.error("✗ 서버 오류:", err.message);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("============================================");
  console.log("  My Midjourney 로컬 서버 실행 중");
  console.log("  주소:  http://localhost:" + PORT + "/");
  console.log("  폴더:  " + ROOT);
  console.log("  정지:  Ctrl + C");
  console.log("============================================");
});
