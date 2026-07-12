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
- [ ] **스마트 청산 라이브 배선** — 지정가 주문+체결폴링+취소/리페그+비례 숏청산 실루프 (지금 시뮬만)
- [ ] 실행 직전 재견적 + 엣지 죽으면 자동 중단
- [ ] 빗썸 입금 크레딧 조회 (user_transactions)
- [ ] 체결 정합성 검증(실 체결가 대조) + 슬리피지 재확인
- [ ] **로컬에서 키 넣고 실테스트 → `DRY_RUN=false`** (본인 PC, 실자금)

## 🟠 P1 — 게이트·상태 서명 배선 (키 넣으면 대부분 자동)
- [ ] **빗썸 잔고** — v1 HMAC-SHA512 private (`lib/balances.ts` `bithumb()` 스텁)
- [ ] **빗썸 입금주소** — `lib/deposits.ts` (업비트/바이낸스는 배선됨)
- [ ] **바이낸스 networkList** — 코인별 실제 네트워크·`minConfirm`·출금비로 큐레이션 테이블 대체 (`lib/config.ts` `COIN_NETWORK`)
- [ ] **개인지갑 토큰 보유** — ERC20/SPL 잔고 조회 (`lib/walletBalances.ts`, 지금 네이티브만)

## 🟡 P2 — 전략 확장
- [ ] **cross-cex** — 바이비트/OKX 어댑터 + 전략 (전송 없어 제일 싸게 실전화) `lib/strategies.ts`
- [ ] **funding-basis** — 펀딩 vs 현물 캐시앤캐리
- [ ] **cex-dex** — DEX 라우터 견적 + 온체인 실행

## 🟢 P3 — 안전·리스크
- [ ] 리스크 한도 (최대 노출 / 1회 / 일일 손실)
- [ ] 킬 스위치 (전체 중단 버튼)
- [ ] 주문당 슬리피지 상한 · 스테일 가드 강화

## 🔵 P4 — 운영·기록
- [ ] **알림(텔레그램)** — 임계 순수익 돌파 / 입출금 중단 / 에러
- [ ] **P&L·거래 기록** — 탐지 엣지 vs 실제 포착(새는 정도), 실수수료 대조
- [ ] **갭 히스토리** — 프리미엄 시계열·지속시간·히트율, 코인별 스파크라인
- [ ] **KRW 리패트리에이션** — 오프램프(은행 한도·환전) 추적
- [ ] 모니터 필터/정렬/즐겨찾기 (최소 net·거래량·선물유무, 임계 알림음)

## ⚪ 정리 (자잘)
- [ ] `EXCLUDE`에 누락 스테이블 추가 (USDE/USD1 등) `lib/arbitrage.ts`·`config.ts`
- [ ] 안 쓰는 `app/api/execute` + `lib/execution.ts` 제거 (`exec-step`로 대체됨)
- [ ] EVM 외 잔고 RPC 안정화(공개 RPC 레이트리밋 → env로 교체)
