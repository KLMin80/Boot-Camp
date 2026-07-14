# 경쟁 서비스 유저 불만 분석 — 「남김없이」

> 조사일: 2026-07-10 · 출처: 구글플레이·앱스토어 리뷰 원문, Reddit(r/homemaking, r/ZeroWaste) 스레드 원문
> 스크린샷: `screenshots/04~08` · 인용문은 모두 **원문 그대로**이며, 각괄호 안은 별점·공감수·작성일

---

## 0. 요약 — 유저들이 실제로 화내는 지점

세 서비스의 리뷰와 레딧 스레드를 읽고 나면, 불만이 흩어져 있는 게 아니라 **네 갈래**로 수렴한다.

| # | 불만 갈래 | 어디서 터지나 | 「남김없이」와의 관계 |
|---|---|---|---|
| A | **입력이 안 끝난다** — 느리고, 틀리고, 고칠 수도 없다 | 유통기한 언제지, NoWaste | 핵심기능 1 (스캔 원터치 입력) |
| B | **개수로만 센다** — 반쯤 쓴 재료를 표현할 수 없다 | 세 서비스 전부 | 핵심기능 5 (용량 기반 잔량 차감) |
| C | **재고·레시피·장보기가 끊겨 있다** | 유통기한 언제지 ↔ 만개의레시피 | 핵심기능 3·4 (레시피 추천, 쿠팡 연동) |
| D | **광고가 사용자를 쫓아낸다** | 만개의레시피 | 수익모델 설계 (쿠팡파트너스) |

그리고 그 아래에 모든 갈래를 관통하는 **한 문장**이 있다:

> *"It pains me that there isn't a solution besides putting in manual effort to track it."*
> (수기로 기록하는 것 말고는 방법이 없다는 게 괴롭다) — r/homemaking 원글, IT 업계 종사자



---

## 1. 유통기한 언제지 (국내) — 별점 3.5

![구글플레이 리뷰](screenshots/04-reviews-ourneeds-googleplay.png)

### 별점 분포 (Google Play, 리뷰 217개 · 다운로드 1만+)

| 별점 | 개수 | 비율 |
|---|---|---|
| ★★★★★ | 86 | 41% |
| ★★★★☆ | 29 | 14% |
| ★★★☆☆ | 31 | 15% |
| ★★☆☆☆ | 25 | 12% |
| ★☆☆☆☆ | 37 | 18% |

**1~2점이 62개(29%)**. 앱스토어에서도 낮은 편이며, 구글플레이 표기는 **'광고 포함'**이다. 리뷰의 온도는 "미워서 1점"이 아니라 **"좋은데 안 굴러가서 1점"** 에 가깝다. 대부분 개선 요구가 구체적이고 길다 — 애정 있는 사용자가 포기 직전에 남기는 종류의 글이다.

### 불만 ①. 등록이 안 끝난다 (갈래 A)

> "아무 사진이나 등록해두면 음식 등록에 시간이 너무 걸리고(**한시간이 넘었는데도 지금도 등록중**이라고 뜨네요) 밑에 리뷰글 보니 유통기한 수정도 안된다고 하더군요."
> — 손하영 [★3 · 공감 6 · 2024.06.12]

> "1) 등록시 **30초~1분 딜레이**가 있고 (등록중으로 뜸) 2) 냉장고 구분은 되나 통합에서 보여주지 않아 각각의 냉장고를 터치해야만 현황을 알수 있고 3) **한번 등록하면 품목명 수정이 안됩니다.**"
> — chani 3 [★? · 공감 2 · 2021.10.11]

개발사 공식 답변이 이 구조를 인정한다:

> "'간편 등록'은 시스템 상에서 정보를 처리한 후 등록되기 때문에 **시간이 조금 소요될 수 있습니다.** '간편 등록'은 등록 후 **품목명 수정이 불가능**하지만, '손으로 입력'은 자유롭게 수정이 가능합니다."
> — (주)니즈 공식 답변 [2021.10.12]

즉 **빠른 길(스캔)과 고칠 수 있는 길(수기)이 갈라져 있고, 사용자는 둘 다 원한다.**

### 불만 ②. 유통기한을 사진으로만 넣을 수 있다 (갈래 A)

> "영수증으로 등록하면 **유통기한도 이미지로만 등록**을 해야 한다는 것이 불편하고 아무 이미지로 대신해서 우선 등록을 하고 수정을 하려고 해도 **이미지로 등록한 유통기한은 수정이 안되네요.** 바코드나 직접입력 처럼 유통기한을 달력에서 선택할 수 있으면 좋겠습니다."
> — Neo S [★5 · 공감 10 · 2023.11.25]

> "유통기한 날짜를 **직접 적을 수 있게** 해주세요. 일일이 달력 넘겨가면서 찾기 힘듭니다."
> — toddlf 0423 [★? · 공감 21 · 2022.02.20]

### 불만 ③. 온라인 장보기를 못 받아준다 (갈래 C) ★가장 중요★

> "저는 장을 볼 때 **온라인으로(컬리, 쿠팡 프레쉬 등)** 보다보니 영수증 대신 결제 캡쳐본으로 기록합니다. (…) **유통기한 기록은 아직 주문 후 받아보지 않은 상태라서 사진으로 기록할 수가 없습니다.**"
> — 손하영 [★3 · 공감 6 · 2024.06.12]

> "저는 **직접 장을봐서 명세표가 따로 없는데** 명세표를 촬영해야한다고 하더라구요. 자동 기능 같은 다른 방법은 없나요?"
> — 이재윤 [★? · 공감 4 · 2020.10.26]

이 앱의 등록 방식은 **"물건이 손에 있다"** 를 전제한다. 온라인 장보기가 표준이 된 시장에서 이 전제는 깨졌다.

### 불만 ④. 수량을 깎을 수 없다 (갈래 B)

> "한 번 등록한 식품들은 유통기한이 지나면 그냥 삭제해야하나요? **다 먹었다고 표시를 할 수 있거나 하나 사용할 때마다 -체크해서 몇개중에 몇개 남았다** 이런 게 보였으면 좋겠어요;; **앱은 좋은데 활용도가 너무 낮아요.**"
> — Lia [★5 · 공감 1 · 2021.09.28]

> "단위를 1개 말고 **1박스, 1통, 1봉지** 요런식으로 다양하게 만들어주세요. 음식 먹으면 개수 수정하기 쉽게 - 1 + 이 수량버튼 크게 만들어주세요."
> — toddlf 0423 [★? · 공감 21 · 2022.02.20]

> "더 바라는 기능은 냉장고에서 물건을 뺄때 **수량을 간단하게 줄이는 것**이예요. (…) 채소와 같은건 냉장고에 있다 없다 정도로 알수있게 따로 유통기한 설정없이 목록에 넣을수 있었음 좋겠습니다."
> — 안주영 [★? · 공감 12 · 2021.09.05]

개발사는 2021년 9월에 *"식품 수량조절 버튼 기능이 10월 중 반영될 예정"* 이라 답했으나, 2022년 리뷰에도 같은 요구가 공감 21개로 다시 올라온다.

### 불만 ⑤. 재고를 알아도 뭘 해먹을지는 모른다 (갈래 C)

> "냉장고 식자재로 **어떤 요리를 해먹을지 간단하게 메모를 할 수 있는 공간**도 있으면 좋겠어요. 그러면 다른 메모 어플을 따로 사용하지 않아도 되고 완전 실용도 있는 냉장고 정리 어플로 잘 쓸 수 있을 것 같습니다."
> — 손하영 [★3 · 공감 6 · 2024.06.12]

사용자가 레시피 기능을 요구한 게 아니라, **레시피 기능이 없어서 메모장이라도 달라고** 하고 있다.

### 그 밖의 마찰

- **통합 뷰 없음**: *"냉장고 구분은 되나 통합에서 보여주지 않아 각각의 냉장고를 터치해야만"* (chani 3)
- **로딩**: *"주인 외 다른 멤버들은 로딩시간이 김. 너무김 너무너무 길어짐"* (최건휘 [2024.01.30])
- **초대 마찰**: *"가족들은 안깔려있는데 번거롭게 설명하고 가입도 시켜드려야하고ㅠㅠ"* (Lia)
- **중복 등록 확인 불가**: *"제품이 많을때 같은 날짜의 유통기한을 등록한건지 아닌지 찾기가 너무 힘듭니다."* (OJ [공감 8])



---

## 2. NoWaste (해외) — 앱스토어 4.2 / 746개

![App Store](screenshots/02-nowaste-03-pricing-appstore.png)

> 표본 주의: 구글플레이(5만+ 다운로드) 페이지는 국내에서 **태블릿 리뷰 6개(2.8점)** 만 노출된다. 표본이 너무 작아 대표값으로 쓰지 않고, **앱스토어 미국 4.2 / 746개**를 기준으로 삼았다. 인용은 모두 앱스토어 원문(영문)이며 한국어는 옮긴 것이다.

### 불만 ①. 바코드는 읽히는데 **내용이 틀린다** (갈래 A)

> "once in a while when you scan the barcode, **the wrong expiration date pops up.** There are still other times where it doesn't recognize the type of food, and when you try to enter it manually, it doesn't let you put an expiration date… **For this to be useful, the expiration dates have to be accurate.**"
> (가끔 바코드를 찍으면 엉뚱한 유통기한이 뜬다. 음식 종류를 인식 못 할 때도 있고, 수동 입력하려 하면 유통기한을 넣지 못하게 한다. 쓸모 있으려면 유통기한이 정확해야 한다.)
> — willyxzcygjj [2019.07.18]

> "This app keeps putting my dry beans in my fridge for some reason. **Who stores dry beans in their fridge?** … **I can't get it to read receipts.** … **Can it just get ONE expiration date right?**"
> (말린 콩을 자꾸 냉장고 칸에 넣는다. 말린 콩을 냉장고에 보관하는 사람이 어디 있나? 영수증 인식은 아예 안 된다. 유통기한 하나라도 제대로 맞힐 순 없나?)
> — JinxKitty [2019.11.22]

**시사점:** 유통기한은 바코드에 들어 있지 않다. 상품 DB에서 '추정'하는 순간 사용자는 앱 전체를 불신한다. 「남김없이」의 미해결 질문(*"바코드 스캔만으로 유통기한이 실제로 확보되는가"*)에 대해 경쟁자가 이미 내놓은 답은 **"안 된다, 그리고 틀리면 앱이 죽는다"** 이다.

### 불만 ②. 등록 도중 앱이 죽고, 20분 작업이 사라진다 (갈래 A)

> "I scanned about 20 items in my pantry, went through and edited categories and amounts, and then clicked 'add all' and **the app crashed and none of the stuff I added saved.** … it was tedious and **I was too frustrated to do it again.**"
> (20개를 스캔하고 카테고리·수량을 다 편집한 뒤 '전체 추가'를 눌렀더니 앱이 죽었고 아무것도 저장되지 않았다. 다시 할 마음이 안 든다.)
> — ageagainstthemachine [2020.02.28]

초기 등록(온보딩)에서 죽으면 그 사용자는 돌아오지 않는다. **첫 장바구니 등록이 곧 리텐션 분기점.**

### 불만 ③. 낱개 단위뿐 — 부분 낭비를 기록할 수 없다 (갈래 B) ★핵심★

> "The Waste feature. Sure, sometimes an entire container of something expires and it has to go out. But **most of the time it's partial**… if you didn't finish the entire container of hummus for instance. **Being able to track portions of wasted food would make this feature far more accurate.**"
> (통째로 버리는 경우도 있지만, 대부분은 부분적이다 — 후무스를 다 못 먹는 식으로. 버린 '양'을 기록할 수 있어야 이 기능이 훨씬 정확해진다.)
> — Amlynn84 [2020.04.04]

이 한 문장이 「남김없이」 핵심기능 5번(**용량 기반 잔량 자동 차감**)의 존재 이유를 경쟁자 사용자의 입으로 증명한다. 같은 리뷰어는 **음성 입력**도 요구한다:

> "It would also be amazing if you could **add items by voice**… much easier to say it out loud then go through step by step."

> ※ MISSION.md는 음성 입력을 안티스코프로 명시했다. 이 요구는 "음성을 만들어라"가 아니라 **"단계별 입력이 지겹다"**는 신호로 읽는 게 맞다. 우리 답은 음성이 아니라 결제 연동이다.

### 불만 ④. 카테고리·분류 체계가 현실을 못 담는다

> "expanded categories. Seriously, **why is honey its only category but not 'sugar' or 'sweetener'?**" — Amlynn84
> "there isn't an icon for oils. **I use oils.**" — ageagainstthemachine

### 긍정 리뷰가 알려주는 것 — 성공하면 사용자가 뭐라고 말하는가

> "Your app is **LIFE CHANGING.** … my waste has decreased dramatically. However, what it contributes to my monthly meal planning, storage and organization, and ability to consistently create quality lunches and dinners (translated: **bonding time**) for my family is well beyond what you may have ever imagined. The NO WASTE concept extends beyond food to **time, money, mental energy** — basically all of the resources that so many busy parents struggle with."
> — Ann Marie (랜딩 페이지 대표 후기)

주목: 이 사용자는 **'절약'이 아니라 '가족과 보낼 시간'** 을 성과로 말한다. 「남김없이」의 v1 타깃(아이 식사와 가족 건강을 챙기는 주 요리 담당자)과 정확히 겹치는 언어다. 마케팅 메시지를 **"식비 10% 절감"** 이 아니라 **"저녁 준비에 쓰는 머릿속 부담을 줄인다"** 로 잡을 근거가 여기 있다.



---

## 3. 만개의레시피 (인접) — 4.8 / 14.7만개인데도 터지는 불만

![구글플레이 리뷰](screenshots/08-reviews-10000recipe-googleplay.png)

평점은 높다(구글플레이 4.8, 앱스토어 4.4). 그런데 **낮은 별점의 내용이 한 곳에 몰려 있다: 광고, 그리고 검색 품질.**

### 불만 ①. 광고가 사용자를 쿠팡으로 튕겨 보낸다 (갈래 D) ★우리 수익모델에 직결★

> "근래에 광고도 너무 많고 **쿠팡 광고로 자동으로 넘어가서 뒤로 가기해도 다시 쿠팡 접속..다시 자동 쿠팡 연결..이걸 3,4번 뒤로 가기 해야 화면으로 복귀..** 사용자들이 올려 놓은 레시피로 **너무 광고 장사 하지 마세요.** 요즘 같으면 별 1개도 아까움"
> — Changgyun Jung [★1 · 공감 17 · 2024.07.19]

> "분명히 **'오늘 광고 제거'라고 써있음에도 다시 실행하면 광고가 뜨네요.** 하루에 어플을 한번만 실행하라는 뜻으로 받아들이면 되나요?"
> — 서은비 [★3 · 공감 24 · 2023.06.08]

> "광고중에 **좀벌레 광고**는 좀 없애주시면 좋을것 같아요ㅋㅋㅜ 넘 클로즈업해서 보여줘서... 지우기도 없고ㅜ"
> — 정다혜 [★5 · 공감 36 · 2023.08.06]

> "엄청 만족합니다. **앱실행시 광고로드시간이 길다.**" — 모오런 [2024.01.08]

**이건 우리에게 경고이자 기회다.** 「남김없이」의 수익모델도 쿠팡이다. 차이는 **맥락**에 있어야 한다 — 만개의레시피의 쿠팡은 *사용자가 원하지 않은 순간에 튀어나오는 광고*이고, 「남김없이」의 쿠팡은 *"이 레시피에 양파가 없는데 주문할까요?"* 라는 **사용자가 이미 원하던 행동의 완성**이다. 이 선을 넘는 순간(예: 재고에 있는데도 사라 하기, 전면 광고 삽입) 우리도 똑같이 별 1점을 받는다.

### 불만 ②. 재료 검색이 AND가 아니라 OR로 동작한다 (갈래 C) ★냉장고 파먹기 정확도★

> "검색조건이 and조건이 아니라 **or조건으로 검색되는거 같아요.** '치즈(띄어쓰기)감자'이런식으로 검색하면 오지치즈후라이 같은 '치즈+감자' 관련된 요리가 검색되어야 하는데, **'치즈버거' '치즈불닭' '감자전' 등 관련없는 요리들이 조회됩니다.** 여기 개발자분들은 이 앱으로 검색해서 요리 안해드시나봐요..."
> — suin hwang [★3 · 공감 7 · 2020.06.28]

직접 확인해 봤다. `돼지고기 양파 감자` → **결과 509건**. 상위에 고추장찌개(44) 카레(44) 짜장밥(30)이 뜬다. *"뭘 해먹지"* 를 풀어주는 게 아니라 **선택 피로를 새로 만든다.**

### 불만 ③. 정렬을 신뢰할 수 없다

> "최근에 업데이트 하니까 왜 서치 결과가 **추천순으로 되어 있어도 듣보 레시피들이 위로 뜨고** 정작 추천 많은 건 아래나 중간쯤에 있냐?"
> — jaeyeon Bang [★1 · 공감 7 · 2023.08.28]

개발사 답변이 의도된 동작임을 밝힌다:

> "현재 추천순은 요리 후기수순은 아니며 **이용자에게 새로운 레시피를 경험하실 수 있도록 제공**되고 있습니다."
> — 만개의레시피 공식 답변

**시사점:** 플랫폼의 이익(신규 레시피 노출)과 사용자의 이익(검증된 레시피)이 충돌하면 사용자는 눈치챈다.

### 불만 ④. 정보 과잉 — 20만 개가 축복이 아니다

> "너무 정보가 많은데.. **정리는 안되어있어서 좀 골라쓰기가 불편해요.** (…) 너무 방대하게 쏟아져서ㅠ"
> — Google 사용자 [★3 · 2019.08.18]

### 사용자가 먼저 요구한 기능 — '내 재료로 추천해달라'

> "**재료들을 선택하고 그 재료들로 만들 수 있는 음식들을 추천해주는 기능**이 있었으면 좋겠습니다. (…) 냉장고에 꼬막과 쪽파가 있는데 이걸로 뭘 할 수 있을지 검색했을때 꼬막무침이 추천된다던지 (…) **요리초보들에게 그리고 냉장고파먹을때 너무너무 좋을 것 같아요**"
> — 하보 [★5 · **공감 744명** · 2021.02.18]

**744명 공감.** 이 문서 전체에서 가장 많은 공감을 받은 리뷰이며, 개발사는 2025년 9월에야 *"냉장고파먹기 기능이 추가됐습니다"* 라고 답했다. **수요는 압도적으로 검증되어 있고, 아직 제대로 채워지지 않았다.**



---

## 4. Reddit — 특정 앱이 아니라 **카테고리 전체**에 대한 불만

앱스토어 리뷰가 "이 앱의 이 기능이 별로다"라면, 레딧은 **"이런 앱 자체를 결국 안 쓰게 된다"** 를 말한다. 이쪽이 더 아프고 더 중요하다.

![r/homemaking](screenshots/06-reddit-homemaking-pantry-tracking.png)

### 4-1. r/homemaking — "Is There an Easier Way to Track Pantry Inventory?"

원글(IT 업계 종사자, 요리 담당):

> "I'm basically **fighting a losing battle with my pantry inventory!** I constantly seem to buy duplicates or forget items until they expire.
> Putting it in a spreadsheet is a bit tedious and manual and **it works for 1 - 2 days but nothing really sticks** or feels easy to maintain accurately.
> **It pains me that there isn't a solution besides putting in manual effort to track it.** My day job is in tech and I'm able to basically automate everything…"

(팬트리 재고와의 싸움에서 지고 있다. 중복 구매하거나 잊어버려 유통기한을 넘긴다. 스프레드시트는 번거롭고 **1~2일은 가지만 아무것도 몸에 남지 않는다.** 수기 노력 말고는 해법이 없다는 게 괴롭다. 본업이 IT라 웬만한 건 다 자동화하는데도.)

**댓글에서 사람들이 실제로 쓰는 것:**

| 방법 | 인용 |
|---|---|
| 집 안에 '가게'를 차림 | *"I have a store at home for all non-perishables… Once something runs out, I go out to my store in the garage and grab a new one, **as if shopping.**"* (공감 21) |
| 주 1회 종이 계획 | *"I have a day each week (Thursday) where I sit down and meal plan… Throughout the week my husband and I **write on a piece of paper** we keep in the same place in the kitchen when something runs out."* (공감 17) |
| 직접 만든 스프레드시트 | *"I worked in tech and in data analytics… **so I built a meal planning spreadsheet.**"* |
| 페인터 테이프 + 유성펜 | *"I use 1\" thick light green painter's tape & a black Sharpie to label anything that comes into my house… `PUR-16APR2025`. **ZERO confusion.**"* |
| 화이트보드 / 냉장고 메모 | *"I keep a whiteboard on my fridge for my grocery list."* |

**결론: 이 카테고리의 진짜 경쟁자는 다른 앱이 아니라 종이·테이프·엑셀이다.** 그리고 그것들이 이기고 있다.

댓글에서 언급된 앱은 **Paprika**(일회성 결제, 팬트리+유통기한 정렬), **Pantry Check**(바코드 스캔, 250개까지 무료), **Supercook**(재료→레시피, 무료)이며, 특히 이 조합이 호평받는다:

> "I use the **pantry check app**. You scan products by the bar code… and then it sends alerts when things are expiring soon. Using that **in conjunction with the supercook app** has helped us save money and cut down on waste!"

→ 사용자는 **'재고 앱 + 레시피 앱'을 손으로 이어 붙여 쓰고 있다.** 「남김없이」가 하나로 합치려는 바로 그 고리다.

![r/ZeroWaste](screenshots/07-reddit-zerowaste-why-not-use.png)

### 4-2. r/ZeroWaste — "What app are you using…? **OR Why you don't use it?**"

이 스레드가 가장 잔인하다. 질문이 "왜 안 쓰냐"인데, **대다수 답변이 "앱을 안 쓴다"** 이다.

> "**'Inventory' seems too stressful to me. I can't be bothered to pull out my phone every time I eat to update what I used up.**"
> (인벤토리는 너무 스트레스다. **뭘 먹을 때마다 폰을 꺼내 소비량을 갱신할 순 없다.**)
> — FuckingaFuck [공감 4]

> "I don't use an app, **I imagine I would fall off using it.** We do try to use a white board."
> (앱은 안 쓴다. **결국 안 하게 될 것 같아서.**)
> — zerowastecityliving

> "I don't have an inventory because I regularly clear out my fridge, freezer and pantry."
> — KittyKatWombat

> "Just a google spreadsheet… it works just fine" — Kotomir
> "I just use the notes app on my phone paired with meal planning" — Brooke-Cole

한 명은 "눈(my eyes)"이라고 답했고 그게 공감을 받았다.

**이 스레드의 교훈은 「남김없이」 핵심기능 5번에 대한 직접적인 경고다.**
용량 기반 잔량 차감은 경쟁자에게 없는 강점이지만, **그 차감을 사용자가 손으로 하게 만드는 순간 우리도 "먹을 때마다 폰 꺼내는 앱"이 되어 똑같이 버려진다.** 차감은 반드시 *"이 레시피 완료"* 버튼 하나로 레시피에 적힌 분량이 통째로 빠지는 방식이어야 한다.



---

## 5. 불만 → 「남김없이」 기능 매핑

| 유저 불만 (근거) | 강도 | 우리 대응 | MISSION.md |
|---|---|---|---|
| 등록에 30초~1시간, 등록 후 수정 불가 | ★★★ | 결제 시점 자동 등록 → 사용자는 확인만 | 핵심기능 1 |
| 온라인 장보기(컬리·쿠팡프레시)는 영수증이 없다 | ★★★ | **쿠팡 구매내역 연동** — 경쟁자 전원 미대응 | 핵심기능 1·4 |
| 바코드로 읽은 유통기한이 **틀린다** | ★★★ | 추정값은 '추정'으로 표시 + 1탭 보정. 틀린 값을 확정처럼 보여주지 않기 | 열린 질문 |
| 반쯤 쓴 재료를 기록할 방법이 없다 | ★★★ | **용량(g/ml) 기반 자동 차감** — 경쟁자 전원 미대응 | 핵심기능 5 |
| "먹을 때마다 폰 꺼낼 순 없다" | ★★★ | 차감은 '요리 완료' 1탭. 품목별 수기 차감 금지 | 핵심기능 5 (설계 제약) |
| 재고는 아는데 뭘 해먹을지 모른다 | ★★☆ | 유통기한 임박 재료 **우선 소진** 레시피 추천 | 핵심기능 3 |
| 재료 검색이 OR로 동작, 결과 509건 | ★★☆ | 재고 기반 AND 매칭 + **3개 이내** 제안 | 핵심기능 3 |
| 등록 도중 앱이 죽어 20개가 날아감 | ★★☆ | 장바구니 등록은 낙관적 저장 + 실패 복구 | 핵심기능 1 |
| 광고가 쿠팡으로 튕겨 보낸다 | ★★☆ | 커머스는 **부족분 주문 맥락에서만.** 전면 광고 없음 | 수익모델 |
| 여러 냉장고 통합 뷰가 없다 | ★☆☆ | 기본 화면은 전체 재고, 위치는 필터 | — |
| 단위가 '개'뿐 (박스/통/봉지 없음) | ★☆☆ | 구매 단위(팩) + 소비 단위(g) 분리 | 핵심기능 5 |



---

## 6. 가장 무서운 발견 — 세 문장

1. **"스프레드시트는 1~2일은 가는데 아무것도 몸에 남지 않는다."**
   → 이 카테고리는 기능 부족으로 실패한 게 아니라 **습관 형성에 실패**해 왔다. 「남김없이」의 진짜 경쟁자는 유통기한 언제지가 아니라 **냉장고에 붙은 화이트보드**다.

2. **"인벤토리는 너무 스트레스다. 먹을 때마다 폰을 꺼낼 순 없다."**
   → 우리의 최대 차별점(용량 차감)이 그대로 **최대 이탈 원인**이 될 수 있다. 입력을 30초로 줄여도, **차감이 수기면 3일 만에 버려진다.**

3. **"유통기한 하나라도 제대로 맞힐 순 없나?"**
   → 유통기한은 바코드에도 영수증에도 없다. 경쟁자들은 (a) 사진 강제(느림·수정불가), (b) DB 추정(부정확)으로 풀었고 **둘 다 실패했다.** MISSION.md가 열린 질문으로 남겨둔 이 항목은 「남김없이」의 **가장 큰 미검증 리스크이자 유일한 진짜 해자**다.

---

## 7. 다음 액션 제안

1. **쿠팡 구매내역에서 용량·유통기한이 실제로 넘어오는지 먼저 검증한다.** 안 넘어오면 차별점 ①이 통째로 무너진다. 개발보다 이게 먼저다.
2. **차감 UX를 종이 프로토타입으로 5명에게 테스트한다.** "요리 완료 1탭"이 진짜 1탭인지, 사용자가 g을 손대야 하는 순간이 있는지 확인한다.
3. **유통기한 정책을 결정한다.** 품목별 표준 보관기간 테이블 + 구매일 기준 추정 + "추정입니다" 명시 + 1탭 보정. 정확한 척하지 않는 것이 신뢰를 지킨다.
4. **레시피 결과는 3개로 자른다.** 509건은 답이 아니다. "오늘 상하는 애호박부터 쓰는 3개"가 답이다.
5. 베이스라인 측정: MISSION.md의 *"버리는 재료의 금액 기준선"* — 앱 첫 2주는 폐기 기록만 받아 절감률의 출발점을 만든다.

---

## 출처

**앱스토어 / 구글플레이**
- [유통기한 언제지 — Google Play (별점 3.5 · 리뷰 217개)](https://play.google.com/store/apps/details?id=kr.co.ourneeds.app&hl=ko) → `screenshots/04-reviews-ourneeds-googleplay.png`
- [NoWaste — App Store (4.2 · 746 ratings)](https://apps.apple.com/us/app/nowaste-food-inventory-list/id926211004) → `screenshots/02-nowaste-03-pricing-appstore.png`
- [NoWaste — Google Play (50K+ downloads)](https://play.google.com/store/apps/details?id=com.khcreations.nowaste&hl=en_US) → `screenshots/05-reviews-nowaste-googleplay.png`
- [만개의레시피 — Google Play (4.8 · 리뷰 14.7만개)](https://play.google.com/store/apps/details?id=com.ezhld.recipe&hl=ko) → `screenshots/08-reviews-10000recipe-googleplay.png`
- [만개의레시피 — App Store (4.4 · 7천개)](https://apps.apple.com/kr/app/id494190282) → `screenshots/03-10000recipe-04-pricing-appstore.png`

**Reddit**
- [r/homemaking — Is There an Easier Way to Track Pantry Inventory? What Do You Use?](https://old.reddit.com/r/homemaking/comments/1jzjdsg/is_there_an_easier_way_to_track_pantry_inventory/) → `screenshots/06-reddit-homemaking-pantry-tracking.png`
- [r/ZeroWaste — What app are you using to manage food inventory? OR Why you don't use it?](https://old.reddit.com/r/ZeroWaste/comments/wqz71d/what_app_are_you_using_to_manage_food_inventory/) → `screenshots/07-reddit-zerowaste-why-not-use.png`

**관련 문서**: [`research.md`](research.md) · [`MISSION.md`](MISSION.md)
