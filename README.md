# arb-cockpit

개인용 **반자동 아비트라지 콕핏**. 여러 종류의 차익거래 기회를 하나의 랭킹 보드로 모아 실시간 감시하고, 고른 기회를 **원클릭(반자동)으로 실행**한다. 코인 감시 터미널(coin-tracker)의 실행 담당 짝으로, 별개의 Next.js 앱이다.

- **포트 `:3100`** (`npm run dev`) — coin-tracker(:3000)와 안 겹침
- 단일 사용자 · 인증 없음 · 한글 UI · 리퀴드 글래스 디자인(다크/라이트)
- **실행 타깃 = 한국 로컬 서버** — 업비트/빗썸 API·WS가 네이티브로 되고(비KR IP는 403), 거래소·체인과 지연이 짧다

> ⚠️ **DRY-RUN이 기본.** 실주문·실전송은 키를 넣고 `DRY_RUN=false`로 바꿔야만 나간다. 자금 이동 키(개인지갑·EXEC_TOKEN)는 절대 커밋 금지.

---

## 전략

| 종류 | 상태 | 내용 |
|------|------|------|
| **kimchi** (김프) | ✅ 실배선 | 업비트/빗썸 KRW vs 바낸/바이빗/OKX USDT 프리미엄. 실시간 USDT/KRW(테더 프리미엄) 환산, 코인별 출금비·헷지비·자동 보정 반영, 입출금 게이트로 실행 가부 판정 |
| **cex-dex** | ✅ 전송형 배선 | OKX DEX 애그리게이터 실행가능 견적 vs 바낸 톱오브북. 싼 쪽에서 사서 코인을 옮겨 비싼 쪽에 판다. 온체인 컨트랙트 검증 + 입출금 체인 일치 게이트 |
| **funding-basis** (펀딩) | 👁 감시 | 거래소 간 펀딩비 차이(캐시앤캐리). 감쇠 모델·APR 표기. 실행 미배선 |
| **cross-cex** (거래소간) | 🚧 스텁 | 해외 CEX 간 현물 가격차. 전송 게이트 모델만 |

`USE_MOCK`(기본 켜짐)은 **라이브 데이터가 없는 전략의 빈자리만** 데모 기회로 채운다 — 실측 행과 가짜 행이 섞이지 않는다.

## 탭 구성 (`app/page.tsx`)

- **대시보드** — 라이브 전환 체크리스트, 리스크 여유 게이지, KPI, 자금 배분
- **갭** — 실시간 갭 보드 + 갭 검사창(양다리 차트·비용 분해·전송)
- **펀딩** — 펀딩비 차익(감시)
- **상장** — 상장따리: 신규 상장 감지·상세·DEX 원클릭 매수·핫월렛 물량
- **운영** — 진행 중 실행·거래 기록·손익 시각화·게이트·킬 스위치
- **자산** — 잔고·브릿지·지갑 tx 히스토리

## 상장따리 (`lib/listings.ts`, `app/components/ListingPanel.tsx`)

신규 상장을 자동 감지(마켓 diff + 공지 파싱 + 텔레그램 채널)하고, 상세를 **풀스크린**으로 연다:

- **신호 스트립** — 가격·시총·24h 볼륨·김프·즉시유입/24h·24h 피크
- **차트** — TradingView(CEX 5종) + DexScreener + 네이티브 캔들 탭
- **통합 매수·매도 표** — CEX + DEX 한 표. DEX 행엔 **스왑 미리보기**(예상 수령·최소 수령·슬리피지·가격 임팩트·수수료·가스·라우팅 + 허니팟·전송세 경고)와 **유동성 등급**(깊이 프로브)
- **거래소 핫월렛 잔고** — 거래소별 핫/콜드 물량 + 핫 유입 Δ/분(덤프 경계)
- **스왑 tx 상태 추적** — 매수 후 온체인 확정/실패 폴링(OKX orders)
- **자동매수** — 이중 옵트인 + fail-closed 가드(CG 미등록/저시총/기펌핑 스킵)

## 온체인 (OKX Web3 / OnchainOS, `lib/dex.ts`)

OKX DEX API **V6**로 견적·스왑·전송 빌드·조회를 한다. **서명·방송은 항상 로컬**(ethers / solana web3) — 프라이빗 키는 서버 파일에만.

- **28체인** 지갑 잔고·tx 조회, **21체인** DEX 스왑(체인별 기준 스테이블은 실견적 검증)
- 전송 tx 빌드(`sign-info`: 가스·논스, OKX 프로젝트 ID 필요) → 로컬 서명 → 로컬 RPC 방송(OKX 브로드캐스트는 키/리전 차단이라 RPC 폴백)
- 스왑 서명은 OKX가 반환한 라우터 주소로만(화이트리스트), 전송 토큰 컨트랙트는 큐레이션 → 지갑 실보유 → 토큰리스트 순 자동 해석(모호하면 차단)
- cex-dex 후보 컨트랙트 검증은 **온체인 `symbol()`**(CoinGecko 레이트리밋 예산을 상장 순간을 위해 보존)

## 실행 엔진 (`lib/runEngine.ts`)

실행 상태머신을 **서버 모듈**이 소유한다 — 시작하면 브라우저 탭을 닫아도 완주한다. UI(`lib/runStore.ts`)는 `/api/runs`를 폴링하는 미러.

- 단계: 매수 → (헷지 숏) → 출금 → (지갑 경유 전송) → 입금 확인 → 매도 → (헷지 청산) → 정산
- 자동화 레벨: 전수동 / 출금 전 정지 / 매도 전 정지 / 전자동
- 매수·출금·매도·스왑 직전 **엣지 재검증**(소멸 시 중단), 비가역 출금 전 실패는 **진입 롤백**(롤백도 슬리피지 가드 → 초과 시 보류 + 텔레그램)
- 런 스냅샷 즉시 persist — 재시작 시 중단 런을 경고와 함께 복원(자동 재개 안 함)

## 리스크·안전장치

- **`DRY_RUN=true`(기본)** — 실행은 `DRY_RUN=false` + 해당 키가 있어야만. 전환은 의도적으로 설정창에서 제외(`.env.local` + 재시작만)
- **라이브 실행 인증** — 돈이 움직이는 액션은 `EXEC_TOKEN`(x-exec-token). 킬 스위치·취소는 무인증(비상 정지를 막지 않음)
- **개인지갑 키는 자금 이동 권한** — `data/secrets.json`(0600) 또는 `.env.local`만, 절대 커밋 금지, 전용 새 지갑만
- 노출·일손실 한도, 슬리피지 상한, 최소 출금 수량 게이트, 헷지 증거금 워치
- 손익분기 규모 표시 + 달러 기준 알림 하한, 비용 자동 보정(실거래 leak 평균)
- 키 원문은 서버가 클라이언트에 절대 반환 안 함(끝 4자리 힌트만)
- 크래시 훅(uncaughtException → 텔레그램), `/api/health`(스캔 60s 정지 시 503, pm2용)

## 아키텍처

```
lib/
  strategies.ts     전략 4종 (kimchi·cex-dex 실배선)
  scanner.ts        컨텍스트 선조회 → 전략 실행 → 병합·랭킹·리스크
  dex.ts            OKX Web3 V6 (견적·스왑·전송빌드·토큰리스트·미리보기·tx상태)
  runEngine.ts      서버 실행 상태머신 (탭 무관)  ← execStep.ts / execPlan.ts
  quote.ts          실호가 뎁스 견적 (cex-dex 재검증 포함)
  transfers.ts      입출금 게이트 · deposits.ts 입금주소
  wallet.ts         멀티체인 서명·전송 (EVM/XRP/TRON/Solana)
  chains.ts         28체인 레지스트리 · tokens.ts 컨트랙트 해석
  listings.ts       상장 감지·자동매수 · listingDetail.ts 상세 · holdings.ts 핫월렛
  tokenResolve.ts   CoinGecko 심볼→메타 (레이트리밋 방어 캐시)
  secrets.ts        설정창 키 저장(0600) · calibration.ts 비용 보정
app/
  page.tsx          6탭 콕핏
  components/        DashboardPanel · ListingPanel · ControlPanel · InventoryPanel · SettingsModal
  api/              scan · runs · exec-step · quote · listing-* · swap-preview · tx-status · health …
```

## 실행

```bash
npm install
cp .env.example .env.local     # 키 채우기 (없어도 DRY-RUN/데모로 돎)
npm run dev                    # http://localhost:3100
npm run typecheck              # tsc --noEmit
```

키는 앱의 **⚙ 설정**(톱니바퀴)에서 넣을 수도 있다 — 거래소·OKX Web3·개인지갑·알림·상장따리·EXEC_TOKEN을 그룹별로. 저장 시 `data/secrets.json`(0600)에 쓰고 즉시 반영된다. 운영 배포·헬스체크·pm2는 `RUNBOOK.md` 참고.

## 남은 것 (실전화 TODO)

1. cross-cex(바이비트/OKX 어댑터) 실배선 — 전송 없어 제일 싸게 실전화
2. funding-basis 실행 배선(HL/Lighter), SPL/TRC20 전송 배선(현재 EVM만)
3. 빗썸 잔고·입금 서명(v1 HMAC-SHA512)
4. 실전 소액 테스트 후 `DRY_RUN=false` 전환
