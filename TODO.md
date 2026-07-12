# TODO

> 현재 전부 **DRY-RUN**. 아래를 채우면 실전화. 키는 `.env.local`에만.

## 🔴 P0 — 실전화 (실제 자금 이동, 키 필요)
`app/api/exec-step/route.ts`의 스텁을 실제 API로:
- [ ] **실주문** — 바낸 현물 매수/매도(서명), USDT-M 숏/청산(서명), 업비트 매도(JWT) → `buy`/`sell`/`hedge`/`close`
- [ ] **실출금** — 바낸 → 개인지갑 (Binance `/sapi/v1/capital/withdraw`, 서명, 화이트리스트) → `withdraw`
- [ ] **토큰 전송 맵** — ERC20/TRC20/SPL 컨트랙트·decimals 매핑 (`lib/wallet.ts`, 지금 네이티브만)
- [ ] **입금 확인 폴링** — 목적지 거래소 입금 크레딧 확인(서명) → `deposit`
- [ ] **정산** — 실제 체결가 기반 P&L(실현) → `settle`
- [ ] 비EVM(XRP/TRON/SOL) 전송 로컬 실테스트 후 `DRY_RUN=false`
- [ ] **부분체결 롤백** — 한 다리만 체결 시 자동 원복/헷지 유지, 체결 정합성 검증

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
