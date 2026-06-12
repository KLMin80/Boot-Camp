// ========================================
// 📦 모듈 가져오기 (Node.js 내장 모듈만 사용 — npm 설치 불필요)
// ========================================
const http = require("http");   // HTTP 서버를 만드는 내장 모듈
const fs = require("fs");        // 파일(index.html)을 읽기 위한 내장 모듈
const path = require("path");    // 파일 경로를 안전하게 다루는 내장 모듈

// 서버가 사용할 포트 번호 (환경변수가 있으면 사용, 없으면 3000)
const PORT = process.env.PORT || 3000;

// ========================================
// 🕐 유틸 함수: 시간대별 인사말 만들기 (서버에서 계산!)
// ========================================
// 현재 '시(hour)'를 받아서 상황에 맞는 한국어 인사말을 돌려줍니다.
// 원래 index.html에 있던 로직을 그대로 서버로 옮겨왔습니다.
function getGreeting(hour) {
  if (hour >= 5 && hour < 12) return "좋은 아침이에요 ☀️";   // 오전 5시 ~ 11시
  if (hour >= 12 && hour < 18) return "좋은 점심예요 🌤️";    // 낮 12시 ~ 17시
  if (hour >= 18 && hour < 22) return "좋은 저녁이에요 🌆";   // 저녁 6시 ~ 21시
  return "안녕하세요, 늦은 시간이네요 🌙";                    // 밤/새벽
}

// ========================================
// 🌐 HTTP 서버 만들기
// ========================================
// 요청(req)이 들어올 때마다 아래 함수가 실행됩니다.
const server = http.createServer((req, res) => {

  // ----------------------------------------
  // ① API 엔드포인트: GET /api/greeting
  // ----------------------------------------
  // 클라이언트(index.html)가 fetch로 호출하면 인사말 + 시간을 JSON으로 돌려줍니다.
  if (req.url === "/api/greeting" && req.method === "GET") {
    const now = new Date();                          // 요청이 들어온 '바로 그 순간'의 시간
    const hour = now.getHours();                     // 0 ~ 23 사이의 '시'
    const greeting = getGreeting(hour);              // 시간대별 인사말
    const time = now.toLocaleTimeString("ko-KR");    // 예: 오후 3:42:10 (한국어 형식)

    // 응답 데이터를 객체로 만든 뒤 JSON 문자열로 변환해서 보냅니다.
    const data = { greeting, time, hour };

    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
    return; // 응답을 보냈으니 여기서 함수 종료
  }

  // ----------------------------------------
  // ② 정적 파일: GET / → index.html 보여주기
  // ----------------------------------------
  if (req.url === "/" && req.method === "GET") {
    const filePath = path.join(__dirname, "index.html"); // server.js와 같은 폴더의 index.html

    // index.html 파일을 읽어서 그대로 응답으로 내려줍니다.
    fs.readFile(filePath, (err, content) => {
      if (err) {
        // 파일을 못 읽으면 500 에러
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("서버 오류: index.html을 찾을 수 없습니다.");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(content);
    });
    return;
  }

  // ----------------------------------------
  // ③ 그 외 주소: 404 Not Found
  // ----------------------------------------
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("404 - 페이지를 찾을 수 없습니다.");
});

// ========================================
// 🚀 서버 시작
// ========================================
server.listen(PORT, () => {
  console.log(`✅ 서버 실행 중! 브라우저에서 http://localhost:${PORT} 를 열어보세요.`);
});
