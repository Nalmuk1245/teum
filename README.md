# arb-cockpit

개인용 **반자동 아비트라지 콕핏** — coin-tracker와 별개인 Next.js 앱. 4종 아비트라지 전략을 하나의 랭킹 보드로 모아 실시간 감시하고, 고른 기회를 **원클릭(반자동)으로 실행**한다. 김프(보따리) 실행 흐름 — 매수 → 헷지 → 개인지갑 출금 → 개인지갑 → 거래소 자동 송금 → 매도 → 청산 — 을 상태머신으로 돌린다.

**포트 :3100** (`npm run dev`) — coin-tracker(:3000)와 안 겹침.

> ⚠️ **전부 DRY-RUN이 기본.** 실주문/실전송은 `.env.local`에 키를 넣고 `DRY_RUN=false`로 바꿔야만 나간다. 키는 절대 커밋 금지.

---

## 두 가지 모드
상단 토글로 전환한다.
- **📈 갭 모니터** (기본) — 보기 전용. 실행 버튼 없이 갭만 실시간으로 본다.
- **⚡ 실행** — 원클릭 실행. 기회 선택 → 실호가 견적 + 송금 게이트 + 실행 상태머신.

## 전략 (`lib/strategies.ts`)
| 종류 | 상태 | 소스 |
|------|------|------|
| `kimchi` (김프) | ✅ 실데이터 | 업비트 KRW vs 바이낸스 USDT 프리미엄 (÷ 업비트 USDT/KRW). 업비트/빗썸 중 net 큰 쪽 자동 선택 |
| `cross-cex` (거래소간) | 🚧 스텁 | 바낸/바이비트/OKX 현물 가격차 |
| `funding-basis` (펀딩) | 🚧 스텁 | 무기한 펀딩 vs 현물 (캐시앤캐리) |
| `cex-dex` | 🚧 스텁 | CEX vs DEX 라우터 견적 |

`USE_MOCK=true`면 종류별 데모 기회를 하나씩 주입해 데이터/키 없이도 보드·실행 흐름이 돈다.

## 주요 기능
- **실시간 웹소켓** (`lib/useLivePrices.ts`) — 바낸/업비트/빗썸 티커 WS로 프리미엄·순수익을 600ms마다 갱신 (8초 스캔은 종목/비용/게이트만 담당하는 하이브리드).
- **실호가 견적** (`lib/quote.ts`) — 종목 선택 시 양쪽 실호가 조회 → VWAP 체결가, 슬리피지, 실출금비, 호가 한도(depth cap), 실행가능 순수익 + USD PnL.
- **송금·정산 게이트** (`lib/transfers.ts`, `lib/deposits.ts`) — 코인별 입출금 상태(빗썸 공개 / 업비트·바이낸스 서명), 다리별 네트워크 + 컨펌수, 전송 ETA, 출금 화이트리스트, 목적지 입금주소 조회.
- **선물/헷지** (`lib/perps.ts`) — 바낸 USDT-M 무기한 유무 표시. 있으면 매수와 동시에 숏(진입가 잠금)으로 전송 중 가격 노출 제거.
- **실행 상태머신** (`lib/executionPlan.ts`) — 자동 실행 범위(수동 / 출금 전까지 / 전자동), 되돌릴 수 없는 출금 직전 정지, 단계별 서버 실행(`/api/exec-step`).
- **멀티체인 개인지갑** (`lib/wallet.ts`, `lib/chains.ts`) — 툴이 키를 보유하고 서명·전송. EVM 7종 + XRP/TRON/Solana 네이티브 전송 배선(휴면).
- **잔고·재고** (`lib/balances.ts`, `lib/walletBalances.ts`) — 글로벌(USDT) vs KR(원화) 자본 편중 바 + 리밸런싱 경고, 개인지갑 온체인 자산(멀티체인, 주소만으로 읽기).
- 모던 다크 UI · 한글 · 모바일 대응.

## 아키텍처
```
lib/
  types.ts          도메인 타입 (Opportunity/TransferGate/Portfolio/…)
  config.ts         스위치·수수료·네트워크·전송비 테이블
  exchanges.ts      거래소 어댑터 (공개 티커/오더북, 주문 스텁)
  strategies.ts     4종 전략 (김프 실배선)
  scanner.ts        티커·게이트·선물 선조회 → 전략 실행 → 병합·랭킹
  useLivePrices.ts  클라이언트 WS 실시간 갭
  quote.ts          실호가 뎁스 견적
  transfers.ts      입출금 상태 (서명, 휴면)
  deposits.ts       입금주소 조회 (서명, 휴면)
  perps.ts          선물 유무 (바낸 fapi)
  executionPlan.ts  실행 플랜 + 러너 훅
  wallet.ts         멀티체인 개인지갑 전송 (휴면)
  chains.ts         체인 레지스트리
  balances.ts       거래소 잔고 + 포트폴리오
  walletBalances.ts 개인지갑 온체인 잔고
app/
  page.tsx          콕핏 대시보드 (보드·모드·실행 모달)
  components/InventoryPanel.tsx  잔고·재고 패널
  api/scan · quote · exec-step · balances  REST 엔드포인트
```

## 안전장치
- **`DRY_RUN=true` (기본)** — 주문/전송을 전부 시뮬레이션만. 실행은 `DRY_RUN=false` + 해당 키가 있어야만.
- **개인지갑 키는 자금 이동 권한** — `.env.local`에만, 절대 커밋 금지, 로컬 PC 한정.
- 키는 서버(API 라우트)에서만 사용 — 클라이언트로 절대 안 감.
- `.env.example`을 `.env.local`로 복사해 채운다.
- 로컬 한국 PC 실행 권장 — 업비트/빗썸 API·WS가 네이티브로 되고(비KR IP는 403), 바이낸스 WS도 정상.

## 실행
```bash
npm install
cp .env.example .env.local   # 키 채우기 (없어도 DRY-RUN/데모로 돎)
npm run dev                  # http://localhost:3100
```

## 남은 것 (실전화 TODO)
1. 토큰 전송 컨트랙트/mint 맵 (ERC20/TRC20/SPL) — 지금은 네이티브만.
2. 빗썸 잔고·입금 서명(v1 HMAC-SHA512), 업비트/바이낸스 실주문·출금 API 배선.
3. 개인지갑 ERC20 보유 조회(토큰 리스트).
4. cross-cex(바이비트/OKX 어댑터) — 전송 없어 제일 싸게 실전화.
5. 알림(텔레그램), P&L/거래 기록, 리스크 한도·킬 스위치.
