# 톡트레이더 (TalkTrader)

텔레그램으로 통제하는 **개인용 규칙기반 주식 자동매매 비서**.
기획·설계 문서는 상위 폴더 참고: `MISSION.md` · `DEV.md` · `research.md` · `AUDIENCES.md` · `주식_자동매매_빌드_프롬프트.md`

> ⚠️ 기본값은 **모의투자**입니다. 실전(진짜 돈)은 모의 검증(실전 전환 게이트)을 통과한 뒤에만.

## 실행 (Phase 0 — 뼈대 확인)

```
pip install -r requirements.txt    # 처음 한 번 (의존성 설치)
cp .env.example .env               # (Windows: copy .env.example .env) — 값은 나중에 채움
python main.py                     # "설정 로드 완료 (모의모드)" 가 나오면 성공
```

> `.env` 를 아직 안 채웠어도 뼈대 확인은 됩니다(비어있는 키 목록만 알려줌).

## 폴더 구조

| 경로 | 역할 |
|---|---|
| `config/settings.py` | `.env` 로드, 모의/실전 토글, 한도값 |
| `broker/kis_client.py` | KIS 인증·조회·주문 (증권사 의존 코드) — *Phase 1~* |
| `telegram_bot/bot.py` | 명령 라우터·알림·chat_id 인증 — *Phase 3~* |
| `safety/guard.py` | 안전장치(한도·쿨다운·화이트리스트·승인) — *Phase 4a* |
| `core/order.py` | 주문 실행기 (반드시 guard 통과 후) — *Phase 4b* |
| `strategy/stoploss.py` | 스탑로스 전략 — *Phase 6-1* |
| `main.py` | 진입점 |

## 다음 단계

1. **(사람)** KIS 모의 앱키/시크릿·텔레그램 봇 발급 → `.env` 채우기 — **단계별 방법: [`SETUP.md`](SETUP.md)**
2. 빌드 문서 **Phase 1(인증)** 프롬프트로 `broker/kis_client.py` 구현
3. Phase 2(조회) → 3(텔레그램) → 4(안전장치·모의주문) → 6-1(스탑로스) 순서로

전체 로드맵과 완료 판정 기준은 상위 `DEV.md` 참고.
