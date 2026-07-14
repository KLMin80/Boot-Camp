"""
strategy/stoploss.py — 전략 ①: 스탑로스(손절)  [Phase 6-1 에서 구현 — v1 첫 전략]

보유 종목이 매입가 대비 STOPLOSS_PCT(예: -3%) 이하로 떨어지면
core.order 를 통해(=safety.guard 통과) 자동 매도하고 텔레그램으로 통보한다.
웹소켓 없이 WATCH_INTERVAL_SECONDS 마다 주기 조회로 감시 → v1 MVP에 적합.
"""
import config.settings as cfg
from strategy.base import Strategy


class StopLoss(Strategy):
    name = "스탑로스"

    def __init__(self):
        self.threshold_pct = cfg.STOPLOSS_PCT       # 손절선 (음수)
        self.interval = cfg.WATCH_INTERVAL_SECONDS  # 감시 주기(초)

    def on_tick(self):
        """보유종목 손익률을 조회해 손절선 도달 종목을 매도."""
        raise NotImplementedError("Phase 6-1(스탑로스)에서 구현")
