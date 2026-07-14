"""
core/order.py — 주문 실행기  [Phase 4b 에서 구현]

⭐ 주문으로 가는 유일한 통로. strategy 와 telegram_bot 은 broker.send_order 를
직접 부르지 않고, 반드시 이 함수를 통한다 → 여기서 safety.guard 검문을 강제한다.

⚠️ 매수(buy)/매도(sell) 방향을 절대 헷갈리지 말 것. 파라미터에 한글 주석 필수.
"""
import config.settings as cfg
from safety import guard
# from broker.kis_client import KISClient  # Phase 4b에서 연결


def place_order(code: str, qty: int, side: str, price: int = None):
    """
    side='buy'  → 매수 주문
    side='sell' → 매도 주문
    반드시 guard.check_order 를 먼저 통과한 뒤에만 broker 주문을 호출한다.
    """
    raise NotImplementedError("Phase 4b(모의 주문)에서 구현")
