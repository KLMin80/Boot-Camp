# D-day 카운터 제작 대화 기록

> 날짜: 2026-06-02

---

## 1. 사용자 요청

> `@single-react-dev` 목표 날짜까지 남은 일수 계산 할 수 있는 D-day 카운터를 만들어줘. `week-2\07-goblin` 폴더에 파일을 넣어줘

---

## 2. 작업 내용

`single-react-dev` 에이전트를 사용해 단일 `index.html` 파일로 D-day 카운터 웹 앱을 제작했습니다.

- **기술 스택**: CDN 기반 React + Tailwind CSS (빌드 도구 없음)
- **생성 파일**: `C:\Boot Camp\week-2\07-goblin\index.html`
- 기존의 색상 팔레트 생성기 파일을 D-day 카운터로 전체 교체

---

## 3. 구현된 기능

| 기능 | 설명 |
| --- | --- |
| 목표 날짜 선택 | 네이티브 `type="date"` 입력 필드 |
| 제목/라벨 입력 | 각 D-day에 이름 지정 (예: 수능, 프로젝트 마감, 여행) |
| D-day 계산 | 자정 기준 일수 차이를 `D-30` / `D-DAY` / `D+5` 형태로 표시 |
| 목록 관리 | 여러 D-day 추가/삭제, 임박순·추가순·제목순 정렬 |
| localStorage 저장 | `dday-counter-items` 키로 자동 저장, 새로고침해도 유지 |
| 임박도 강조 | 남은 일수에 따라 5단계 시각 구분 |
| 헤더 요약 | 가장 임박한 미래 일정을 상단에 자동 표시 |
| 반응형/접근성 | 모바일~데스크톱 그리드 대응, `aria-label`, 시맨틱 HTML, 빈 상태 처리 |

### 임박도 5단계

- **오늘(`today`)**: 로즈색 + 펄스 글로우 애니메이션 + "오늘!" 배지
- **임박 7일 이내(`urgent`)**: 로즈색 강조
- **한 달 이내(`soon`)**: 앰버색
- **여유(`far`)**: 인디고색
- **지난 날짜(`past`)**: 회색 처리 후 목록 하단 배치

---

## 4. 실행 방법

```powershell
cd "C:\Boot Camp\week-2\07-goblin"
npx serve .
```

또는 VS Code의 Live Server 확장으로 `index.html` 열기.

---

## 5. 생성된 파일

- `C:\Boot Camp\week-2\07-goblin\index.html` — D-day 카운터 (단일 파일 앱)
- `C:\Boot Camp\week-2\07-goblin\dday-conversation.md` — 본 대화 기록

---

## 참고

- 단일 화면이라 라우팅은 사용하지 않음
- 외부 API 호출이 없어 `API_BASE_URL`/`useFetch` 미포함
- 모든 코드는 단일 `index.html` 한 파일에 포함
