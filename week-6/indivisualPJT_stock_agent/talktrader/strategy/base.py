"""
strategy/base.py — 전략 공통 인터페이스  [Phase 6-0 에서 구현]

모든 전략(스탑로스·트레일링·분할·그리드…)이 공유하는 뼈대.
전략은 '감시 → 조건 충족 → core.order(=guard 통과) → 통보' 흐름만 따른다.
전략은 절대 broker 를 직접 부르지 않는다.
"""


class Strategy:
    name = "base"
    enabled = False

    def on_tick(self):
        """주기적으로 호출됨(보유종목/시세 확인 → 조건 충족 시 주문)."""
        raise NotImplementedError("각 전략에서 구현")
