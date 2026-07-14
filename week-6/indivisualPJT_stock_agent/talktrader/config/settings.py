"""
config/settings.py — 톡트레이더 설정 로더

.env 의 값을 읽어 프로그램 전체가 쓰는 설정을 한곳에 모읍니다.
- 비밀값(앱키/시크릿/봇토큰)은 여기서 "읽기만" 하고, 절대 코드에 하드코딩하지 않습니다.
- IS_REAL 로 모의/실전을 토글합니다. 기본은 모의(안전).

Phase 0: 아직 .env 를 안 채웠거나 라이브러리를 안 깔았어도, 이 파일과 main.py 는 에러 없이 돕니다.
"""
import os

# python-dotenv 가 아직 설치 안 됐어도 죽지 않게 (뼈대 단계 편의)
try:
    from dotenv import load_dotenv
    load_dotenv()  # 같은 폴더의 .env 를 환경변수로 로드
    DOTENV_LOADED = True
except ImportError:
    DOTENV_LOADED = False


def _get(key, default=""):
    return os.getenv(key, default).strip()

def _get_int(key, default=0):
    try:
        return int(_get(key) or default)
    except ValueError:
        return default

def _get_float(key, default=0.0):
    try:
        return float(_get(key) or default)
    except ValueError:
        return default


# ── 모의 / 실전 토글 ───────────────────────────────
IS_REAL = _get("IS_REAL", "false").lower() == "true"

# KIS REST 도메인 (⚠️ 값은 KIS 공식 문서에서 최신으로 재확인 권장)
#   모의투자 : https://openapivts.koreainvestment.com:29443
#   실전투자 : https://openapi.koreainvestment.com:9443
BASE_URL = (
    "https://openapi.koreainvestment.com:9443"
    if IS_REAL
    else "https://openapivts.koreainvestment.com:29443"
)

# ── 증권사(KIS) 비밀값 ─────────────────────────────
KIS_APP_KEY = _get("KIS_APP_KEY")
KIS_APP_SECRET = _get("KIS_APP_SECRET")
KIS_ACCOUNT_NO = _get("KIS_ACCOUNT_NO")

# ── 텔레그램 ───────────────────────────────────────
TELEGRAM_BOT_TOKEN = _get("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = _get("TELEGRAM_CHAT_ID")

# ── 안전장치 한도 ──────────────────────────────────
DAILY_MAX_ORDERS = _get_int("DAILY_MAX_ORDERS", 10)
DAILY_MAX_BUY_AMOUNT = _get_int("DAILY_MAX_BUY_AMOUNT", 1_000_000)
PER_STOCK_MAX_BUY = _get_int("PER_STOCK_MAX_BUY", 300_000)
COOLDOWN_SECONDS = _get_int("COOLDOWN_SECONDS", 60)
WHITELIST = [s.strip() for s in _get("WHITELIST").split(",") if s.strip()]

# ── 스탑로스 ───────────────────────────────────────
STOPLOSS_PCT = _get_float("STOPLOSS_PCT", -3.0)
WATCH_INTERVAL_SECONDS = _get_int("WATCH_INTERVAL_SECONDS", 30)


def _mask(v):
    if not v:
        return "(미설정)"
    return (v[:4] + "…" + v[-2:]) if len(v) > 6 else "****"


def summary():
    """민감정보는 가려서 현재 설정을 문자열로 반환."""
    mode = "🔴 실전(REAL)" if IS_REAL else "🟢 모의(MOCK)"
    lines = [
        f"모드          : {mode}",
        f"BASE_URL      : {BASE_URL}",
        f"KIS_APP_KEY   : {_mask(KIS_APP_KEY)}",
        f"KIS_APP_SECRET: {_mask(KIS_APP_SECRET)}",
        f"KIS_ACCOUNT_NO: {KIS_ACCOUNT_NO or '(미설정)'}",
        f"텔레그램 봇   : {_mask(TELEGRAM_BOT_TOKEN)}   chat_id: {TELEGRAM_CHAT_ID or '(미설정)'}",
        f"안전장치      : 일일주문 {DAILY_MAX_ORDERS}회 / 일일매수 {DAILY_MAX_BUY_AMOUNT:,}원 / 종목당 {PER_STOCK_MAX_BUY:,}원 / 쿨다운 {COOLDOWN_SECONDS}초",
        f"화이트리스트  : {WHITELIST or '(비어있음)'}",
        f"스탑로스      : {STOPLOSS_PCT}% / 감시 {WATCH_INTERVAL_SECONDS}초",
        f"dotenv 로드   : {'예' if DOTENV_LOADED else '아니오(pip install 전)'}",
    ]
    return "\n".join(lines)


def missing_keys():
    """Phase 1 전에 반드시 채워야 하는 비밀값 중 빈 것 목록."""
    need = {
        "KIS_APP_KEY": KIS_APP_KEY,
        "KIS_APP_SECRET": KIS_APP_SECRET,
        "KIS_ACCOUNT_NO": KIS_ACCOUNT_NO,
        "TELEGRAM_BOT_TOKEN": TELEGRAM_BOT_TOKEN,
        "TELEGRAM_CHAT_ID": TELEGRAM_CHAT_ID,
    }
    return [k for k, v in need.items() if not v]
