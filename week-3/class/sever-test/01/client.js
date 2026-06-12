document.getElementById('fetchBtn').addEventListener('click', async () => {
    const responseDiv = document.getElementById('response');
    responseDiv.textContent = '요청 중...';
  
    try {
      const response = await fetch('/api/hello');
      const data = await response.json();
      responseDiv.innerHTML = `
        <strong>메시지:</strong> ${data.message}<br>
        <strong>시간:</strong> ${data.time}
      `;
    } catch (error) {
      responseDiv.textContent = '오류 발생: ' + error.message;
    }
  });
  