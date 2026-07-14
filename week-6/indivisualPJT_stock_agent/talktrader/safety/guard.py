"""
safety/guard.py — 안전장치(검문소)  [Phase 4a 에서 구현 — 주문 코드보다 먼저!]

주문이 증권사로 나가기 전 반드시 통과해야 하는 검문소.
- 일일 주문 횟수/총매수금액 한도, 종목당 최대 매수금액
- 쿨다운(같은 종목 재주문 금지), 화이트리스트
- (실전 IS_REAL=true) 주문 직전 텔레그램 승인
하나라도 걸리면 주문을 막고 "왜 막혔는지" 사유를 돌려준다.
"""
import config.settings as cfg


class OrderRejected(Exception):
    """안전장치에 걸려 주문이 거부됨."""


def check_order(code: str, qty: int, side: str, price: int) -> None:
    """
    통과하면 아무것도 안 하고(정상), 걸리면 OrderRejected 를 raise.
    검사 항목: 화이트리스트 → 종목당 한도 → 일일 횟수/금액 한도 → 쿨다운 → (실전)승인.
    """
    raise NotImplementedError("Phase 4a(안전장치)에서 구현")
