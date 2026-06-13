// ========================================
// 🌤️ 기온별 옷차림 추천 — Express 백엔드 서버
// ----------------------------------------
// 흐름:  브라우저 → (우리 서버) /recommend → OpenWeather API → 기온 가공 → 응답
//   - 프런트엔드는 우리 서버의 /recommend 만 호출한다 (OpenWeather 를 직접 부르지 않음)
//   - OpenWeather API 키는 .env 에서만 읽고, 절대 클라이언트로 내려보내지 않는다
//   - '기온 구간 → 옷차림' 매핑표(OUTFIT_TABLE)를 데이터로 분리 → 추가/수정이 쉬움
//
// 실행:  npm install  (최초 1회)  →  npm start
//        (= node --env-file=.env server.js,  Node 20.6+ 내장 --env-file 사용)
// ========================================

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// .env 의 키 이름이 바뀌어도 견디도록 두 이름 모두 허용 (현재 표준: OPENWEATHER_API_KEY)
const API_KEY = (process.env.OPENWEATHER_API_KEY || process.env.OPEN_WETHER_API || "").trim();
const OWM_URL = "https://api.openweathermap.org/data/2.5/weather";

// ========================================
// 📋 기온 구간 → 옷차림 매핑표  (여기만 고치면 추천 결과가 바뀜)
// ----------------------------------------
// - 각 구간: min(이상, ℃) ~ max(미만, ℃).  min/max 가 null 이면 "제한 없음(±무한대)".
// - 구간은 서로 겹치지 않고 연속되게 유지하세요 (틈이 생기면 그 온도는 추천이 안 됨).
// - 각 구간 필드:
//     phrase   : 화면에 크게 뜨는 '핵심 한 줄 문구' (예: "패딩 필수", "반팔 OK")
//     headline : phrase 아래에 붙는 친근한 보조 설명
//     label    : 구간 이름(표에 표시),  items : 추천 아이템 칩
// - 항목 추가/변경 방법:
//     1) 객체 하나를 배열에 넣거나 기존 값을 수정한다 (min/max/phrase/headline/items ...).
//     2) id 는 프런트엔드 색상 테마 매칭에 쓰이니 고유하게.
//     3) 서버만 재시작하면 끝 (npm start). 매핑표는 GET /outfit-table 로도 노출됨.
// ----------------------------------------
const OUTFIT_TABLE = [
  {
    id: "hot",
    min: 28, max: null,
    label: "한여름",
    emoji: "🥵",
    phrase: "민소매 OK",
    headline: "한여름! 최대한 시원하게 입어요",
    items: ["민소매", "반팔", "반바지", "린넨 셔츠", "원피스"],
  },
  {
    id: "summer",
    min: 23, max: 28,
    label: "여름",
    emoji: "😎",
    phrase: "반팔 OK",
    headline: "가볍게 입기 좋은 날이에요",
    items: ["반팔", "얇은 셔츠", "반바지", "면바지"],
  },
  {
    id: "earlySummer",
    min: 20, max: 23,
    label: "초여름",
    emoji: "🙂",
    phrase: "긴팔 OK",
    headline: "활동하기 딱 좋은 날씨예요",
    items: ["얇은 가디건", "긴팔 티", "면바지", "청바지"],
  },
  {
    id: "mild",
    min: 17, max: 20,
    label: "선선",
    emoji: "🍃",
    phrase: "얇은 겉옷 OK",
    headline: "겉옷 하나면 충분해요",
    items: ["얇은 니트", "맨투맨", "가디건", "후드티"],
  },
  {
    id: "cool",
    min: 12, max: 17,
    label: "쌀쌀",
    emoji: "🍂",
    phrase: "자켓 추천",
    headline: "자켓이 필요한 날이에요",
    items: ["자켓", "가디건", "맨투맨", "청바지", "스타킹"],
  },
  {
    id: "chilly",
    min: 9, max: 12,
    label: "추움",
    emoji: "🧥",
    phrase: "겉옷 필수",
    headline: "도톰한 겉옷을 챙기세요",
    items: ["트렌치코트", "야상", "점퍼", "니트", "기모 바지"],
  },
  {
    id: "cold",
    min: 5, max: 9,
    label: "많이 추움",
    emoji: "🧣",
    phrase: "코트 필수",
    headline: "단단히 껴입어야 해요",
    items: ["코트", "가죽자켓", "히트텍", "두꺼운 니트", "목도리"],
  },
  {
    id: "freezing",
    min: null, max: 5,
    label: "한겨울",
    emoji: "🥶",
    phrase: "패딩 필수",
    headline: "꽁꽁 싸매고 나가세요",
    items: ["패딩", "두꺼운 코트", "목도리", "장갑", "기모 안감"],
  },
];

// 기온(℃) → 매핑표에서 해당 구간을 찾아 반환. (min 이상 && max 미만)
function pickOutfit(temp) {
  const found = OUTFIT_TABLE.find(
    (r) => (r.min == null || temp >= r.min) && (r.max == null || temp < r.max)
  );
  // 어떤 구간에도 안 걸리면(이론상 없음) 가장 추운 구간으로 폴백
  return found || OUTFIT_TABLE[OUTFIT_TABLE.length - 1];
}

// 날씨 상태(비/눈/바람)에 따른 보조 팁 — 기온과 별개로 덧붙임
function weatherExtras({ main, windSpeed }) {
  const extras = [];
  const m = (main || "").toLowerCase();
  if (["rain", "drizzle", "thunderstorm"].includes(m)) extras.push("☔ 우산을 챙기세요");
  if (m === "snow") extras.push("❄️ 눈길 미끄럼에 주의하세요");
  if (typeof windSpeed === "number" && windSpeed >= 8) extras.push("💨 바람이 강하니 바람막이를 추천해요");
  return extras;
}

// ========================================
// 🌐 OpenWeather 호출 (도시명 또는 위경도)
// ----------------------------------------
async function fetchWeather({ city, lat, lon }) {
  if (!API_KEY) {
    const err = new Error("서버에 OpenWeather API 키가 설정되지 않았습니다. (.env 의 OPENWEATHER_API_KEY 확인)");
    err.code = "NO_KEY";
    throw err;
  }

  // 쿼리스트링 안전하게 구성 (한글 도시명도 자동 인코딩)
  const params = new URLSearchParams({ appid: API_KEY, units: "metric", lang: "kr" });
  if (lat != null && lon != null) {
    params.set("lat", String(lat));
    params.set("lon", String(lon));
  } else {
    params.set("q", city || "Seoul");
  }

  // 10초 타임아웃 (네트워크 지연 시 무한 대기 방지)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  let resp;
  try {
    resp = await fetch(`${OWM_URL}?${params.toString()}`, { signal: controller.signal });
  } catch (e) {
    const err = new Error(
      e.name === "AbortError" ? "날씨 서버 응답이 시간 초과되었습니다." : "날씨 서버에 연결하지 못했습니다."
    );
    err.code = "NETWORK";
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    // OpenWeather 의 대표적인 오류를 사용자 친화적으로 변환
    let detail = "";
    try { detail = (await resp.json())?.message || ""; } catch { /* ignore */ }
    const err = new Error(detail || `날씨 API 오류 (${resp.status})`);
    err.status = resp.status;
    err.code =
      resp.status === 401 ? "BAD_KEY" :
      resp.status === 404 ? "CITY_NOT_FOUND" :
      resp.status === 429 ? "RATE_LIMIT" : "API_ERROR";
    throw err;
  }

  return resp.json();
}

// OpenWeather 원본 응답 → 우리가 쓰는 깔끔한 형태로 정리
function normalizeWeather(data) {
  return {
    temp: Math.round((data?.main?.temp ?? 0) * 10) / 10,
    feelsLike: Math.round((data?.main?.feels_like ?? 0) * 10) / 10,
    tempMin: Math.round((data?.main?.temp_min ?? 0) * 10) / 10,
    tempMax: Math.round((data?.main?.temp_max ?? 0) * 10) / 10,
    humidity: data?.main?.humidity ?? null,
    windSpeed: data?.wind?.speed ?? null,
    main: data?.weather?.[0]?.main ?? "",
    description: data?.weather?.[0]?.description ?? "",
    icon: data?.weather?.[0]?.icon ?? "01d",
  };
}

// ========================================
// 🛣️  라우트
// ========================================
app.use(express.json());

// (1) 매핑표 전체 — 프런트엔드가 표를 그릴 때 사용 (단일 출처: 표를 고치면 화면도 바뀜)
app.get("/outfit-table", (req, res) => {
  res.json({ success: true, table: OUTFIT_TABLE });
});

// (2) 핵심 엔드포인트: 현재 날씨 → 기온 구간 → 옷차림 추천
//     호출 예) /recommend?city=Seoul   또는   /recommend?lat=37.56&lon=126.97
app.get("/recommend", async (req, res) => {
  try {
    const { city, lat, lon } = req.query;
    const raw = await fetchWeather({
      city: typeof city === "string" && city.trim() ? city.trim() : undefined,
      lat: lat != null && lat !== "" ? Number(lat) : null,
      lon: lon != null && lon !== "" ? Number(lon) : null,
    });

    const weather = normalizeWeather(raw);
    const tier = pickOutfit(weather.temp);

    res.json({
      success: true,
      location: { name: raw?.name || city || "알 수 없음", country: raw?.sys?.country || "" },
      weather,
      recommendation: {
        id: tier.id,
        label: tier.label,
        emoji: tier.emoji,
        phrase: tier.phrase,
        headline: tier.headline,
        min: tier.min,
        max: tier.max,
        items: tier.items,
        extras: weatherExtras(weather),
      },
      measuredAt: new Date().toISOString(),
    });
  } catch (e) {
    const status =
      e.code === "NO_KEY" ? 500 :
      e.code === "BAD_KEY" ? 502 :
      e.code === "CITY_NOT_FOUND" ? 404 :
      e.code === "RATE_LIMIT" ? 429 :
      e.code === "NETWORK" ? 504 :
      e.status === 400 ? 400 : 502;
    console.error("[/recommend] 오류:", e.code || "", e.message);
    res.status(status).json({
      success: false,
      code: e.code || "UNKNOWN",
      message: e.message || "추천을 가져오지 못했습니다.",
    });
  }
});

// (3) 프런트엔드: index.html 만 명시적으로 서빙.
//     ⚠️ 폴더 전체를 정적 서빙(express.static)하지 않음 → .env / server.js 가 노출될 위험 차단
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// 안전망: 처리되지 않은 거부가 서버를 죽이지 않도록
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

app.listen(PORT, () => {
  console.log(`✅ 옷차림 추천 서버 실행 중 → http://localhost:${PORT}`);
  console.log(`   OpenWeather API 키 ${API_KEY ? "감지됨 ✓" : "없음 ✗ (.env 확인 필요)"}`);
});
