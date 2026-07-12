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
- [ ] **스마트 청산 라이브 배선** — 지정가 주문+체결폴링+취소/리페그+비례 숏청산 실루프 (지금 시뮬만, 라이브 하드블록)
- [ ] 빗썸 입금 크레딧 조회 (user_transactions)
- [ ] 실 체결가 기반 정산(지금 추정치 표기) + 슬리피지 상한
- [ ] page.tsx 컴포넌트 분리(1300줄), KIND_META/VENUE_LABEL 중복 정리
- [ ] 바이낸스 networkList per-network 게이트(코인 단위→체인 단위)
- [ ] **로컬에서 키 넣고 실테스트 → `DRY_RUN=false`** (본인 PC, 실자금, EXEC_TOKEN 설정)

## 🟠 P1 — 게이트·상태 서명 배선 (키 넣으면 대부분 자동)
- [ ] **빗썸 잔고** — v1 HMAC-SHA512 private (`lib/balances.ts` `bithumb()` 스텁)
- [ ] **빗썸 입금주소** — `lib/deposits.ts` (업비트/바이낸스는 배선됨)
- [ ] **바이낸스 networkList** — 코인별 실제 네트워크·`minConfirm`·출금비로 큐레이션 테이블 대체 (`lib/config.ts` `COIN_NETWORK`)
- [ ] **개인지갑 토큰 보유** — ERC20/SPL 잔고 조회 (`lib/walletBalances.ts`, 지금 네이티브만)

## 🟡 P2 — 전략 확장
- [x] **cross-cex** — 바이비트/OKX 어댑터(티커+오더북) + 실전략 (거래소간 갭, 양다리 USDT, 유동성·새니티 필터, 송금 게이트, 실호가 견적까지 연동)
- [ ] cross-cex 실주문 배선 (bybit/okx 서명 주문·출금 — 지금 라이브 하드페일)
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
