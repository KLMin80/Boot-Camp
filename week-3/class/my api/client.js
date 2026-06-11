// Calls GET /api/greeting and renders the greeting + current server time.
(function () {
  const btn = document.getElementById('greetBtn');
  const result = document.getElementById('result');

  // Same-origin call. If you serve index.html from elsewhere, change this to
  // an absolute URL like 'http://localhost:3000/api/greeting' (CORS is enabled).
  const API_URL = '/api/greeting';

  async function fetchGreeting() {
    btn.disabled = true;
    result.innerHTML = '<span class="time">불러오는 중…</span>';

    try {
      const res = await fetch(API_URL);
      if (!res.ok) throw new Error('HTTP ' + res.status);

      const data = await res.json();
      const pretty = new Date(data.time).toLocaleString('ko-KR');

      result.innerHTML =
        '<div class="greeting">' + data.greeting + '</div>' +
        '<div class="time">서버 시각: ' + pretty + '<br>(' + data.time + ')</div>';
    } catch (err) {
      result.innerHTML =
        '<div class="error">요청 실패: ' + err.message + '</div>';
    } finally {
      btn.disabled = false;
    }
  }

  btn.addEventListener('click', fetchGreeting);
})();
