"""
main.py — 톡트레이더 진입점 (Phase 0: 뼈대 확인용)

지금은 "설정이 제대로 로드되는지"만 확인합니다.
Phase 1부터 여기에 인증 → 텔레그램 봇 시작 → 스탑로스 감시 루프를 붙여나갑니다.

실행:  python main.py   (또는  py main.py)
"""
import sys

# Windows(cp949) 콘솔에서 한글·이모지 출력 시 UnicodeEncodeError 방지 → UTF-8 강제
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import config.settings as cfg


def main():
    print("=" * 54)
    print("  🤖 톡트레이더(TalkTrader) — 설정 점검 (Phase 0)")
    print("=" * 54)
    print(cfg.summary())
    print("-" * 54)

    missing = cfg.missing_keys()
    if missing:
        print("⚠️  아직 비어있는 비밀값(.env):")
        for k in missing:
            print(f"      - {k}")
        print("   → Phase 1(인증) 전에 .env 를 채워주세요. (지금은 뼈대 확인이라 없어도 OK)")
    else:
        print("✅ 모든 비밀값이 채워져 있습니다. Phase 1(인증)로 진행 가능!")

    if cfg.IS_REAL:
        print("\n🚨 경고: 실전(REAL) 모드입니다. 모의 검증(실전 전환 게이트)을 통과했나요?")

    print("-" * 54)
    print("✅ 설정 로드 완료 (모의모드)" if not cfg.IS_REAL else "설정 로드 완료 (실전모드)")


if __name__ == "__main__":
    main()
