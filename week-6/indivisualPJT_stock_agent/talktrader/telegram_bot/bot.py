"""
telegram_bot/bot.py — 텔레그램 원격 명령·알림  [Phase 3 에서 구현]

내 chat_id 에서 온 메시지만 처리한다(타인 차단).
명령(/잔고·/현재가·/매수…)을 조회/주문 기능에 연결하고, 알림을 톡으로 보낸다.
"""
import config.settings as cfg


def is_authorized(chat_id) -> bool:
    """등록된 내 chat_id 만 허용."""
    return str(chat_id) == str(cfg.TELEGRAM_CHAT_ID)


def notify(text: str):
    """프로그램 → 나에게 톡 알림 (가동/에러/체결/손절 통보)."""
    raise NotImplementedError("Phase 3(텔레그램)에서 구현")


def run_bot():
    """봇 시작: 명령 라우터 등록(/도움말·/잔고·/현재가 …) 후 폴링."""
    raise NotImplementedError("Phase 3(텔레그램)에서 구현")
