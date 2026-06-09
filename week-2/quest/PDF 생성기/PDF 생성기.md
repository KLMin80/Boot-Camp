# PDF 생성기 제작 대화 내용

> 작성일: 2026-06-05
> 프로젝트 위치: `D:\Boot Camp\week-2\quest\PDF 생성기\`

---

## 1. 사용자 요청

> PDF 생성기를 만들어줘. 어떠한 파일을 줘도 PDF로 변환할 수 있도록 해줘.
> `week-2\quest\PDF 생성기` 폴더에 파일을 만들어줘.

---

## 2. 진행 방식

- `single-react-dev` 에이전트를 사용해 **단일 `index.html` 파일**로 제작
  (CDN 기반 React 18 + Babel + Tailwind, 빌드 도구 없음)
- 브라우저 전용(서버 없음) 환경이므로, 실제로 변환 가능한 파일 형식을 명확히 구분해 구현

---

## 3. 결과물

**파일 위치:** `D:\Boot Camp\week-2\quest\PDF 생성기\index.html` (단일 파일, 약 55KB)

### 지원하는 변환

| 파일 종류 | 처리 방식 |
|---|---|
| **이미지** (png/jpg/gif/bmp/webp) | 종횡비 유지 페이지 맞춤, 다중 → 다중 페이지 (WebP는 PNG 재인코딩 폴백) |
| **텍스트/코드** (txt/js/py/json/csv 등) | 자동 줄바꿈 + 페이지네이션 + 파일명 헤더/페이지 번호 |
| **마크다운** (.md) | 렌더링 / 원본 선택, 렌더 모드는 marked → html2canvas 멀티페이지 |
| **HTML** | body 캡처 후 PDF 변환 |
| **PDF** | 패스스루(원본 다운로드/병합) |
| **바이너리** (docx/zip/exe 등) | 크래시 없이 메타데이터 + Hex 덤프 PDF 폴백 |

### 주요 기능

- 드래그앤드롭 + 파일 선택, 다중 파일, **하나의 PDF로 병합** 토글
- 파일 종류 자동 판별 후 변환
- 파일별 미리보기(이미지/텍스트/마크다운/HTML iframe)
- 상태 배지(대기/변환 중/완료/실패) + 진행바
- PDF 옵션: 페이지 크기(A4/Letter), 방향(세로/가로), 여백, 글꼴 크기
- 개별 다운로드 + 전체 다운로드
- 파일별 에러 격리(한 파일이 실패해도 배치 유지)
- blob URL 정리(`revokeObjectURL`), 100% 클라이언트 사이드(외부 전송 없음)

### 사용 라이브러리 (CDN)

- **jsPDF** `https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js`
- **html2canvas** `https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js`
- **marked** `https://cdn.jsdelivr.net/npm/marked/marked.min.js`
- React 18 / ReactDOM / Babel standalone / Tailwind CSS

---

## 4. 검증 결과 (실제 Chrome 렌더링)

- React/Babel/Tailwind/jsPDF/html2canvas/marked CDN 정상 로드, 화면 완전 렌더링 확인
- `splitTextToSize` 줄바꿈 동작 확인 (긴 줄 → 7줄로 래핑)
- jsPDF가 유효한 `application/pdf` blob 생성 확인
- 이미지 종횡비 맞춤 계산 정확 (4000×1000 → 515×128.8pt, 페이지 폭 내 수렴)
- marked 마크다운 → HTML 변환 확인
- 멀티페이지 슬라이싱: 캔버스를 페이지 픽셀 높이만큼 잘라 각 페이지에 `addImage`

---

## 5. 실행 방법

- **VS Code Live Server**: `index.html` 우클릭 → "Open with Live Server"
- 또는 터미널에서 해당 폴더로 이동 후 `npx serve .` 실행 후 표시된 주소 접속
- `file://`로 직접 열어도 동작하지만, CDN 로드를 위해 **인터넷 연결 필요**
- 라우팅 미사용 → 별도 경로(`/#/...`) 없음

---

## 6. 브라우저 한계 안내

`.docx` / `.xlsx` 같은 오피스 포맷의 *내용*을 그대로 PDF로 변환하는 것은
서버나 전용 라이브러리 없이는 불가능하므로, 이 경우 **파일 정보 + Hex 미리보기**로
안전하게 폴백합니다. 정식 변환(docx → PDF 등)이 필요하면 별도 방식
(라이브러리 추가 또는 서버 변환) 검토가 필요합니다.
