# 🌤️ 기온별 옷차림 추천 (Express + OpenWeather)

브라우저는 **우리 서버의 `/recommend` 만** 호출하고, 서버가 OpenWeather API를 대신 불러
현재 기온을 받아 **기온 구간 → 옷차림 문구**로 가공해 응답합니다.
OpenWeather API 키는 서버의 `.env` 에만 보관되고 클라이언트로 절대 내려가지 않습니다.

```
브라우저 ──/recommend──▶ 우리 서버(Express) ──appid=키──▶ OpenWeather
   ▲                          │  기온 → OUTFIT_TABLE 매핑
   └──────── JSON(날씨+추천) ◀─┘
```

## 실행 방법

```bash
npm install      # 최초 1회 (express 설치)
npm start        # http://localhost:3000  열기
```

> `npm start` = `node --env-file=.env server.js` — Node 20.6+ 내장 `--env-file` 로 `.env` 를 읽습니다.
> 코드 수정 시 자동 재시작은 `npm run dev` (`--watch`).

### `.env` 설정
```
OPENWEATHER_API_KEY=발급받은_키
```
키 발급: https://openweathermap.org/api → 로그인 → **My API keys**
(가입 직후엔 활성화까지 최대 1~2시간 걸릴 수 있어요.)

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/recommend?city=Seoul` | 도시명으로 추천 |
| GET | `/recommend?lat=37.56&lon=126.97` | 좌표로 추천 (프런트의 "📍 내 위치") |
| GET | `/outfit-table` | 매핑표 전체 (화면의 표가 이걸로 그려짐) |

응답 예시(`/recommend`):
```json
{
  "success": true,
  "location": { "name": "Seoul", "country": "KR" },
  "weather": { "temp": 12.3, "feelsLike": 10.1, "description": "맑음", "icon": "01d", "humidity": 53, "windSpeed": 2.1 },
  "recommendation": { "id": "cool", "label": "쌀쌀", "emoji": "🍂", "headline": "자켓이 필요한 날",
                      "min": 12, "max": 17, "items": ["자켓","가디건","맨투맨","청바지"], "extras": ["☔ 우산을 챙기세요"] }
}
```

## 🛠️ 옷차림 매핑표 수정하기 (가장 자주 바꾸는 곳)

`server.js` 상단의 **`OUTFIT_TABLE`** 배열만 고치면 됩니다. 서버 재시작하면 화면 표까지 자동 반영돼요.

```js
{
  id: "cool",          // 고유 id (프런트 색상 테마와 매칭)
  min: 12, max: 17,    // 12℃ 이상 ~ 17℃ 미만  (null = 제한 없음/±무한대)
  label: "쌀쌀",
  emoji: "🍂",
  headline: "자켓이 필요한 날",
  items: ["자켓", "가디건", "맨투맨", "청바지"],
},
```

- **구간 추가**: 객체 하나를 배열에 추가 (구간이 서로 겹치거나 비지 않게 연속 유지)
- **문구/아이템 변경**: `headline`, `items` 만 수정
- **경계 조정**: `min` / `max` 숫자만 변경

## 🔒 보안 메모
- `.env` 는 `.gitignore` 로 커밋에서 제외됩니다. (키 노출 금지)
- 서버는 폴더 전체를 정적 서빙하지 않고 **`index.html` 만** 명시적으로 내보냅니다
  → `GET /.env`, `GET /server.js` 는 404 (키·소스 노출 차단).
