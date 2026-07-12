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
- [ ] page.tsx 컴포넌트 분리(1300줄), KIND_META/VENUE_LABEL 중복 정리
- [x] 바이낸스 networkList per-network 게이트 (COIN_NETWORK 체인 매칭 엔트리의 withdrawEnable/depositEnable, 미매칭시 코인 단위 폴백)
- [ ] **로컬에서 키 넣고 실테스트 → `DRY_RUN=false`** (본인 PC, 실자금, EXEC_TOKEN 설정)

## 🟠 P1 — 게이트·상태 서명 배선 (키 넣으면 대부분 자동)
- [ ] **빗썸 잔고** — v1 HMAC-SHA512 private (`lib/balances.ts` `bithumb()` 스텁)
- [ ] **빗썸 입금주소** — `lib/deposits.ts` (업비트/바이낸스는 배선됨)
- [ ] **바이낸스 networkList** — 코인별 실제 네트워크·`minConfirm`·출금비로 큐레이션 테이블 대체 (`lib/config.ts` `COIN_NETWORK`)
- [ ] **개인지갑 토큰 보유** — ERC20/SPL 잔고 조회 (`lib/walletBalances.ts`, 지금 네이티브만)

## 🟡 P2 — 전략 확장
- [x] **cross-cex** — 바이비트/OKX 어댑터(티커+오더북) + 실전략 (거래소간 갭, 양다리 USDT, 유동성·새니티 필터, 송금 게이트, 실호가 견적까지 연동)
- [x] **김프 멀티글로벌** — (업비트|빗썸) × (바낸|바이비트|OKX) 조합 중 best-net 선택. 헷지는 코인 기준 Binance perp 유지. 라이브 오버레이도 글로벌 다리 일반화(quote==USDT)
- [ ] 바이비트/OKX 서명 주문·출금·잔고 (지금 글로벌 다리로 채택되면 라이브 하드페일)
- [ ] cross-cex 실주문 배선 (bybit/okx 서명 주문·출금 — 지금 라이브 하드페일)
- [x] **funding-basis** — 크로스벤유 펀딩 차익 (lighter/binance/bybit/hyperliquid, 8h 정규화·예측 레이트·정산 카운트다운·손익분기, 전용 탭) — 모니터링 전용
- [ ] 펀딩 실행 배선 — HL/Lighter 서명 주문 (perp DEX SDK)
- [ ] **cex-dex** — DEX 라우터 견적 + 온체인 실행

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
- [ ] 갭 지속성 점수(②) — 롤링 히스토리로 반짝 스파이크 제거
- [ ] WS 기반 탐지(⑤) — 스캔 유니버스 밖 신규 급등 즉시 포착
- [ ] 전송창 리스크(④) — ETA 동안 프리미엄 변동·헷지 권장

## 🔵 P4 — 운영·기록
- [ ] **알림(텔레그램)** — 임계 순수익 돌파 / 입출금 중단 / 에러
- [ ] **P&L·거래 기록** — 탐지 엣지 vs 실제 포착(새는 정도), 실수수료 대조
- [ ] **갭 히스토리** — 프리미엄 시계열·지속시간·히트율, 코인별 스파크라인
- [ ] **KRW 리패트리에이션** — 오프램프(은행 한도·환전) 추적
- [ ] 모니터 필터/정렬/즐겨찾기 (최소 net·거래량·선물유무, 임계 알림음)
- [x] 실행 타임라인 tx 해시 + 체인 익스플로러 링크 (송금·입금 단계)
- [ ] 출금 단계 조기 tx 표시 (바낸 출금 히스토리 폴링)
- [ ] 펀딩 레이트 지속성 검증 (히스토리 필요 — 갭 히스토리와 함께)

## ⚪ 정리 (자잘)
- [ ] `EXCLUDE`에 누락 스테이블 추가 (USDE/USD1 등) `lib/arbitrage.ts`·`config.ts`
- [x] 안 쓰는 `app/api/execute` + `lib/execution.ts` 제거
- [ ] EVM 외 잔고 RPC 안정화(공개 RPC 레이트리밋 → env로 교체)
