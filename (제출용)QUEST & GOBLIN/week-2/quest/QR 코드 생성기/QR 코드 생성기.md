# QR코드 생성기 제작 대화 기록

> 작성일: 2026-06-05
> 결과물: `week-2/quest/QR 코드 생성기/index.html` (단일 파일 React 앱)

---

## 1. QR코드 생성기 만들기

**사용자:** QR코드 생성기를 만들어줘.

**작업 내용:** `single-react-dev` 에이전트를 사용해 단일 `index.html` 파일로 CDN 기반 React + Tailwind QR코드 생성기를 제작.

### 구현 기능
- **실시간 생성** — 텍스트/URL 입력 시 즉시 QR코드 렌더링
- **PNG 다운로드** + **이미지 클립보드 복사**
- **커스터마이징** — 전경/배경 색상, 크기, 여백, 오류 복원 수준(L·M·Q·H)
- **Empty state** — 입력이 비었을 때 안내 표시
- **반응형 + 한국어 UI**, Tailwind 기반 모던 디자인

### 기술 구성
- CDN: `qrcode-generator@1.4.4` (버전 고정)로 QR 데이터 계산 → `<canvas>`에 직접 그려 색상 제어와 PNG 변환 처리
- 디자인 시스템 컴포넌트 분리: `Button`, `Card`, `Textarea`, `ColorField`, `Slider`, `SelectGroup`, `EmptyState`

### 실행 방법
- VS Code **Live Server**로 `index.html` 열기, 또는 폴더에서 `npx serve .`
- 더블클릭으로 열어도 다운로드는 동작하지만, **이미지 복사 기능**은 보안 컨텍스트(localhost)가 필요

---

## 2. 폴더로 정리

**사용자:** 이 파일을 `week-2\quest\QR 코드 생성기` 폴더에 넣어줘.

**작업 내용:** `index.html`을 `D:\Boot Camp\week-2\quest\QR 코드 생성기\` 폴더로 이동.

- 이전: `D:\Boot Camp\week-2\quest\index.html`
- 현재: `D:\Boot Camp\week-2\quest\QR 코드 생성기\index.html`

---

## 3. 회사 로고(KL Company) 삽입

**사용자:** QR코드 란에 QR코드 인식에 문제가 없도록 회사의 상호(KL Company)를 스포티한 느낌의 로고로 표현해서 넣어줘.

**작업 내용:** QR코드 중앙에 스포티한 "KL Company" 로고를 canvas에 직접 렌더링하여 삽입.

### 추가/변경된 내용
1. **스포티한 로고 (canvas 직접 렌더링)** — `drawKLLogo()` / `roundRect()` 유틸 추가
   - 둥근 사각형 배지 + "KL"을 헤비/블랙(`italic 900 Arial Black`) 이탤릭으로 크게
   - "COMPANY"는 자간 강조로 작게(악센트 색)
   - 우상단 대각선 스피드라인 3줄 + 하단 악센트 바로 스포티함 강조
   - 로고 뒤에 둥근 사각형 흰색(배경색) 패딩을 깔아 겹치는 QR 모듈을 가림
2. **인식 안정성 (오류 복원 H 강제)** — 로고가 켜지면 자동으로 H(30%)로 고정, 안내 문구 표시. 로고를 끄면 L/M/Q/H 자유 선택
3. **로고 크기 ~18%** — 여백 제외 QR 코드 영역 한 변의 18%로 작게 유지해 인식률 보호
4. **로고 토글 옵션** (기본 켜짐) + `Toggle` 디자인 시스템 컴포넌트 추가, 로고 강조 색상 선택
5. **PNG 다운로드/클립보드 복사** — 로고가 canvas에 함께 그려져 자동 포함
6. **옵션 초기화** — 로고 기본값까지 함께 초기화

### 권장 사항
- 실제 휴대폰 카메라로 스캔이 잘 되는지 확인 권장
- 인식이 안 되면 로고 크기를 줄이거나 텍스트 대비 조정 필요

---

## 최종 산출물

```
week-2/quest/QR 코드 생성기/
├── index.html        # QR코드 생성기 (단일 파일 React 앱)
└── 대화내용.md        # 본 문서
```

### 사용한 주요 기술
| 항목 | 내용 |
|------|------|
| 프레임워크 | React 18 (CDN, Babel standalone) |
| 스타일 | Tailwind CSS (CDN) |
| QR 라이브러리 | qrcode-generator@1.4.4 |
| 렌더링 | HTML5 Canvas (QR + 로고 직접 그리기) |
| 언어 | 한국어 UI |
