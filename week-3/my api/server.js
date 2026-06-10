const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// --- Helpers ---------------------------------------------------------------

// Korea local time (UTC+9) ISO-8601 string, e.g. 2026-06-09T13:45:12.000+09:00
function nowKoreaISO() {
  const KST_OFFSET_MIN = 9 * 60; // +09:00
  const now = new Date();
  // Shift the wall clock to KST, then format as if it were UTC and append +09:00
  const shifted = new Date(now.getTime() + KST_OFFSET_MIN * 60 * 1000);
  return shifted.toISOString().replace('Z', '+09:00');
}

// Consistent CORS headers so a separately-served React app can call this API.
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(res, fileName) {
  const filePath = path.join(__dirname, fileName);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// --- Server ----------------------------------------------------------------

const server = http.createServer((req, res) => {
  const { method } = req;
  const url = req.url.split('?')[0];

  // Preflight support for CORS
  if (method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  // API: GET /api/greeting -> { greeting, time }
  if (url === '/api/greeting' && method === 'GET') {
    const body = {
      greeting: '안녕하세요! 만나서 반가워요 👋',
      time: nowKoreaISO(),
    };
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
    });
    res.end(JSON.stringify(body));
    return;
  }

  // Static files
  if (url === '/' || url === '/index.html') {
    serveStatic(res, 'index.html');
    return;
  }
  if (url === '/client.js') {
    serveStatic(res, 'client.js');
    return;
  }

  // Fallback
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`API endpoint:     http://localhost:${PORT}/api/greeting`);
});
