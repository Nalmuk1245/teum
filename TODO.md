# TODO

> 현재 전부 **DRY-RUN**. 아래를 채우면 실전화. 키는 `.env.local`에만.

## 🔴 P0 — 실전화 (실제 자금 이동, 키 필요)
`app/api/exec-step/route.ts` + `lib/orders.ts` (전부 DRY-RUN 게이트, 휴면):
- [x] **실주문** — 바낸 현물 매수/매도, USDT-M 숏/청산, 업비트 매수/매도 (서명 배선) — `lib/orders.ts`
- [x] **실출금** — 바낸 → 개인지갑 (Binance `/capital/withdraw`, 서명)
- [x] **토큰 전송 맵** — 주요 ERC20/TRC20 컨트랙트·decimals (`lib/tokens.ts`), 미확인 코인은 플래그
- [x] **정산** — 순수익% + USD PnL → `settle`
- [x] **빗썸 주문/출금** (v1 HMAC-SHA512 서명) — `lib/orders.ts`
- [x] **업비트 출금** (`/v1/withdraws/coin`, JWT) — 역프 경로용
- [x] **입금 확인 폴링** — 바낸/업비트 크레딧 조회(서명) → `deposit` (빗썸은 아직 sim)
- [x] **부분체결 롤백** — 출금 전 진입 실패 시 buy 되팔기/hedge 청산 자동, 출금 후엔 헷지 유지
- [x] 토큰 컨트랙트 확장 (AAVE/MKR/LDO/CRV/GRT/SAND/MANA/APE…)
- [x] **스마트 청산(UI+시뮬)** — 남은물량 기준 10/25/50/전량 부분청산, 지정가→리페그→바닥/타임아웃, 체결분 비례 숏청산(델타중립), 실시간 잔량·실현손익 (`lib/unwind.ts`, PositionPanel)
- [x] **전체 코드리뷰 반영 (2026-07-12)** — ①태그/메모 필수 코인 강제(TAG_REQUIRED, 태그 없으면 출금/송금 차단) ②라이브 하드페일 원칙(체인미상·주소미확인·토큰미확인·키없음·미배선 = 라이브에서 무조건 실패) ③mock 라이브 실행 거부 + EXEC_TOKEN 인증 ④실행 직전 재견적(매수/출금/매도 전) + 엣지 사망 시 자동 중단 ⑤실행 중 파라미터 스냅샷+컨트롤 잠금 ⑥unmount/모드전환 가드 ⑦승인 더블클릭 가드 ⑧실패 지점부터 재시도(retry) ⑨롤백 결과 캡처(실패 시 수동처리 표시) ⑩LOT_SIZE stepSize 반올림 ⑪실체결량 스레딩(buy 체결량→후속 단계) ⑫입금확인 시작시간 이후 필터 ⑬포지션 패널 buy 후 활성 ⑭WS 재구독 델타만+재연결 리셋 ⑮라이브 갭 방향부호(역전 노출) ⑯FX 폴백 게이트 ⑰스캔 race 가드 ⑱뎁스캡 그리드 시드 ⑲입금주소 태그 반환+서명 인코딩 ⑳죽은코드 삭제(execute/execution.ts/placeOrder/ExecReport)
- [x] **스마트 청산 라이브 배선** — 지정가(바낸/업비트)+체결폴링+취소/리페그(3라운드)+프리미엄 바닥/타임아웃 시장가+라운드별 비례 숏청산. 빗썸 다리는 명시적 실패. /api/unwind에 EXEC_TOKEN·mock 가드
- [x] 빗썸 입금 크레딧 조회 (user_transactions, searchGb=4, 시간필터)
- [x] 실 체결가 기반 정산 (바낸 cummulativeQuoteQty·업비트 주문상세 trades → settle 실현 PnL, KRW는 라이브 환율 환산) + 라이브 시장가 슬리피지 상한(MAX_SLIPPAGE_PCT, 기본 0.5%)
- [x] **page.tsx 컴포넌트 분리** — 1959→444줄. cockpit-ui(공용 프리미티브·상수)·CockpitBoard·ExecuteModal·ControlPanel 4파일로 순수 이동(로직 0변경), tsc·런타임 검증
- [x] 바이낸스 networkList per-network 게이트 (COIN_NETWORK 체인 매칭 엔트리의 withdrawEnable/depositEnable, 미매칭시 코인 단위 폴백)
- [ ] **로컬에서 키 넣고 실테스트 → `DRY_RUN=false`** (본인 PC, 실자금, EXEC_TOKEN 설정)

## 🟠 P1 — 게이트·상태 서명 배선 (키 넣으면 대부분 자동)
- [x] **빗썸 잔고** — /info/balance (HMAC-SHA512), 자산 탭 편입
- [x] **빗썸 입금주소** — /info/wallet_address (태그 분리)
- [x] **바이낸스 networkList 실데이터화** — getall에서 체인명·minConfirm·withdrawFee 추출 → lib/networks.ts 게터(라이브 우선, 큐레이션 폴백), 전략·견적이 참조
- [ ] **개인지갑 토큰 보유** — ERC20/SPL 잔고 조회 (`lib/walletBalances.ts`, 지금 네이티브만)

## 🟡 P2 — 전략 확장
- [x] **cross-cex** — 바이비트/OKX 어댑터(티커+오더북) + 실전략 (거래소간 갭, 양다리 USDT, 유동성·새니티 필터, 송금 게이트, 실호가 견적까지 연동)
- [x] **김프 멀티글로벌** — (업비트|빗썸) × (바낸|바이비트|OKX) 조합 중 best-net 선택. 헷지는 코인 기준 Binance perp 유지. 라이브 오버레이도 글로벌 다리 일반화(quote==USDT)
- [x] **바이비트/OKX 서명** — v5 주문(현물 시장가)·출금·잔고·입금주소 배선. exec-step 매수/매도/출금 라우팅, balances 글로벌 다리로 편입, deposits 입금주소. 키(BYBIT_*/OKX_*) 없으면 휴면

- [x] **funding-basis** — 크로스벤유 펀딩 차익 (lighter/binance/bybit/hyperliquid, 8h 정규화·예측 레이트·정산 카운트다운·손익분기, 전용 탭) — 모니터링 전용
- [ ] 펀딩 실행 배선 — HL/Lighter 서명 주문 (perp DEX SDK)
- [x] **cex-dex 탐지 (OKX DEX API)** — OKX 어그리게이터 견적(멀티DEX 최적라우팅, 실행가 amountOut)을 CEX bid/ask와 양방향 비교, 실가스(eth_gasPrice×견적 gas×ETH가) + 테이커 + MEV버퍼 반영 net. 유니버스 9코인(tokens.ts∩바낸), 60s TTL(레이트리밋), 코인당 최적 방향만. OKX_WEB3_* 키 없으면 휴면 — 모니터링 전용
- [ ] cex-dex 실행 — OKX /swap 캘리데이터 서명(라우터 화이트리스트·minOut 검증) + CEX 동시발사 (재고형)

## 🟢 P3 — 안전·리스크
- [x] **리스크 한도** — 1회 규모/일일 손실(서버 authoritative, buy 게이트+settle 집계) + 총 in-flight(클라 startRun 차단). 관제 탭에서 UI로 편집 가능(/api/risk POST, globalThis). RISK_* env는 초기값
- [x] **킬 스위치** — globalThis 서버 플래그 + /api/kill, buy·withdraw·unwind 거부, 헤더 STOP 버튼(전체 런 중단+신규 차단)
- [x] 주문당 슬리피지 상한(MAX_SLIPPAGE_PCT) — 이미 배선. 스테일 가드=실행 직전 재견적

## 🟢 P3.5 — 백그라운드 실행
- [x] **백그라운드 런 스토어** — 러너를 모달 밖 모듈 스토어(globalThis)로 이동, 모달 닫아도 지속. 여러 런 동시, 루프·재견적·롤백·fills·tx·스마트청산 전부 스토어 소유 (`lib/runStore.ts`)
- [x] **입출금 게이트 조회 도구** — /api/gates(코인별 거래소 입금/출금 상태, 빗썸 공개·업비트/바낸 키필요), 관제 탭 검색 테이블
- [x] **관제 탭 신설** — 킬스위치 카드, 리스크 한도 편집 + 총노출/일일손실 게이지, 실행 현황 대시보드(진행바·현단계·상태·실현PnL·재오픈·완료정리), 추천 도구 목록. 관제 탭 활성 배지, 실행 탭엔 관제로 가는 넛지

## 🟣 갭탐지 고도화
- [x] **보드 실행가 반영(①)** — 스캔이 티커 마지막가 대신 top-of-book(매수 ask/매도 bid)으로 net 계산. bid/ask는 바낸 24hr·바이비트·OKX 티커에 포함(추가호출0), 업비트 orderbook 멀티마켓·빗썸 ALL_KRW 1콜씩. 김프·크로스 둘 다
- [x] **신선도/스프레드 게이트(③)** — top-of-book 스프레드가 MAX_SPREAD_PCT(1.5%) 초과면 얇음/스테일로 스킵. 빗썸 롱테일 유령 프리미엄 제거
- [ ] 라이브 오버레이도 스프레드 크로스 (지금 600ms 오버레이는 last-price라 약간 낙관적 — WS 오더북 필요, ⑤와 함께). 실행 시 모달 재견적·재검증이 최종 안전망
- [x] **갭 지속성 점수(②)** — 서버 롤링 히스토리(globalThis, 5분창)로 코인별 net 기록 → heldSec(연속 양수 유지초)·hitRate. confidence(0.5~1)로 신규 스파이크 하향 랭킹(숨김X). 보드에 "지속 Xs/신규" 칩(24s+ 초록·미만 앰버)
- [x] **실시간 스파이크 탐지(⑤)** — 보드가 600ms 라이브 net 기준 재정렬(스파이크 즉시 최상단), 임계(+0.5%) 상향 돌파 시 행 플래시 + 알림음(WebAudio) + 브라우저 알림. 보드 헤더 알림 ON/OFF(로컬 저장). 스캔 유니버스 커버는 기존 오버레이가 전 종목 담당
- [x] **전송창 리스크(④)** — history에 프리미엄 σ(분당) 추가 → ETA×√σ 랜덤워크로 전송 중 변동 ±X% 산정, 변동>net이면 헷지권장 배지(보드·모달), 스캔캐시 HMR 스테일 루프 수정

## 🔵 P4 — 운영·기록
- [ ] **알림(텔레그램)** — 임계 순수익 돌파 / 입출금 중단 / 에러
- [x] **P&L·거래 기록** — 정산 시 data/trades.jsonl 기록(탐지net vs 실현net·규모·경로·모의여부), /api/trades 집계(실현손익·히트율·평균누수), 관제 탭 거래·손익 카드(지표3+최근8건)
- [ ] **갭 히스토리** — 프리미엄 시계열·지속시간·히트율, 코인별 스파크라인
- [ ] **KRW 리패트리에이션** — 오프램프(은행 한도·환전) 추적
- [ ] 모니터 필터/정렬/즐겨찾기 (최소 net·거래량·선물유무, 임계 알림음)
- [x] 실행 타임라인 tx 해시 + 체인 익스플로러 링크 (송금·입금 단계)
- [ ] 출금 단계 조기 tx 표시 (바낸 출금 히스토리 폴링)
- [ ] 펀딩 레이트 지속성 검증 (히스토리 필요 — 갭 히스토리와 함께)

## 🔵 도메인 감사 반영 (2026-07)
- [x] **P1 모델 정직화** — 게이트 fail-closed(null=차단, 역선택 방어), 전송비 정액출금비×가격/기준사이즈, 슬리피지 다리당×2, 헷지왕복비 net 차감, 리패트리에이션 0.2% 상시, 빗썸 0.25% 기본, 펀딩 감쇠(반감1.5일)+라운드트립 차감, 언와인드 플로어=cost+버퍼(하회시 청산중단·헷지유지)
- [x] **P2 헷지 1급 시민화** — settle에 perp PnL 합산(일일손실한도 스팟+선물), 헷지=도착수량(출금비 차감), 마진 게이트(가용≥노티널×60%), 입금확인이 크레딧 실수량 스레딩
- [x] **P3 리스크 정밀화** — transferRisk를 가격 log-return σ+점프항으로 재설계, USDT/KRW 변동 표기(헷지 미적용), 역프 ETA 60m+경고, 스큐 목표 동적화(정프장세 글로벌65% 목표, 50:50 아님)
- [x] **펀딩 진입 베이시스** — fetchMarks(HL/Lighter/바낸/바이비트 mark 벌크) → 숏/롱 mark 스프레드를 라운드트립 비용에 반영, note에 표기
- [x] **cex-dex 스테일 라벨** — note에 "견적 최대 60s 지연(블록당 소멸, 참고용)"
- [x] **라이브 오버레이 스프레드 앵커** — 스캔 실행가 net에 라이브 가격변화 델타만 적용(last-price 낙관 제거, 스캔과 일관)
- [ ] perp 헷지 바낸외 거래소(바이비트/HL perp 실행 배선 선행 필요 — union만 하면 false signal)
- [ ] cex-dex 리밸런스비(실행 배선 시)

## ⚡ 성능
- [x] **스캔 서버 캐시 + 백그라운드 루프** — /api/scan이 warm 스냅샷 즉시 응답(~0.2s, 이전 3~10s+), 서버가 8초마다 백그라운드 갱신(첫 요청만 대기, stale-while-revalidate). 게이트 60s·펀딩 30s·perp 10분 TTL 분리, balances 10s·gates 60s SWR

## ⚪ 정리 (자잘)
- [ ] `EXCLUDE`에 누락 스테이블 추가 (USDE/USD1 등) `lib/arbitrage.ts`·`config.ts`
- [x] 안 쓰는 `app/api/execute` + `lib/execution.ts` 제거
- [ ] EVM 외 잔고 RPC 안정화(공개 RPC 레이트리밋 → env로 교체)
