"""
broker/kis_client.py — 한국투자증권(KIS) API 클라이언트  [Phase 1~2, 4b 에서 구현]

증권사에 의존하는 모든 코드(인증·조회·주문)를 여기 한곳에 가둔다.
→ 나중에 키움/토스로 갈아끼울 때 이 파일만 바꾸면 되도록.

⚠️ 엔드포인트·TR코드·파라미터명은 기억이 아니라 KIS 공식 문서를 근거로 구현할 것.
"""
import config.settings as cfg


class KISClient:
    def __init__(self):
        self.base_url = cfg.BASE_URL
        self.app_key = cfg.KIS_APP_KEY
        self.app_secret = cfg.KIS_APP_SECRET
        self._token = None
        self._token_expires_at = None

    # ── Phase 1: 인증 ─────────────────────────────
    def get_access_token(self):
        """앱키/시크릿으로 접근토큰 발급. 만료 전 자동 재발급."""
        raise NotImplementedError("Phase 1(인증)에서 구현")

    # ── Phase 2: 조회 ─────────────────────────────
    def get_price(self, code: str):
        """현재가 조회 (종목코드 → 현재가·등락률 등)."""
        raise NotImplementedError("Phase 2(조회)에서 구현")

    def get_balance(self):
        """계좌 잔고 조회 (보유종목·평단·평가손익·주문가능금액)."""
        raise NotImplementedError("Phase 2(조회)에서 구현")

    # ── Phase 4b: 주문 (반드시 core/order → safety/guard 통과 후 호출) ──
    def send_order(self, code: str, qty: int, side: str, price=None):
        """모의 주문 실행. side: 'buy'(매수) / 'sell'(매도)."""
        raise NotImplementedError("Phase 4b(모의 주문)에서 구현")
