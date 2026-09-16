# TODO

> 현재 전부 **DRY-RUN**. 아래를 채우면 실전화. 키는 `.env.local`에만.

## 🛡 보안·안전 감사 (2026-08-18) — 완료
- [x] **루프백 전용 바인딩** — dev/start/pm2 전부 `-H 127.0.0.1`. Next 기본값(0.0.0.0/::)이라 로그인 없는 콘솔이 LAN에 열려 있었다. LAN 노출은 `*:lan` 스크립트로 명시적 옵트인
- [x] **출처 확인 미들웨어** — 상태를 바꾸는 모든 `/api` 요청에 Origin 검사(`middleware.ts` + `lib/originGuard.ts`). 로컬 전용이라 LAN 위협은 낮지만, **루프백이 못 막는 호출자가 브라우저다** — 웹서핑 중 아무 페이지나 localhost로 POST를 쏠 수 있고 실측으로 1회 한도가 999,999로 바뀌었다. Origin 없는 요청(curl·크론·pm2)은 통과, Host가 공인 도메인이면 거부(DNS 리바인딩). 처음엔 이 문제를 `/api/risk`·`/api/listing-auto`의 EXEC_TOKEN으로 막으려 했는데, 토큰은 라이브에서만 걸려 DRY에서 그대로 뚫렸고 라우트마다 빠뜨릴 수 있어 미들웨어로 바꿨다
- [x] **매도 뮤텍스 양방향** — 엔진 sell 단계와 unwind도 `acquireSell`을 잡는다. 트리거 쪽만 잡고 있어서, 락이 막으려던 시나리오(엔진 vs 트리거 → 네이키드 숏)가 정확히 안 막혔다. 여러 라운드 도는 청산은 `renewSell`로 갱신
- [x] **rate limiter 누락 보강** — `binancePerp`(헷지)·`bybitOrder`·`okxOrder`. 버킷에 bybit/okx 항목 자체가 없었다
- [x] **Windows 키 파일 권한** — chmod가 무동작이라 `data/secrets.json`이 상속 ACL 그대로였다. icacls로 소유자 전용, 실패 시 경고
- [x] **서킷 브레이커 분류** — 한글 메시지 정규식 → `defensive` 플래그. 거래소 영어 원문·문구 변경에 오분류되던 것
- [x] **테스트·CI 도입** — vitest 43개(락·한도·플랜·rate limiter·인증·산식) + GitHub Actions(typecheck/test/check). 테스트는 임시 cwd에서 돈다(영속 계층이 운영 data/를 덮어쓰지 않게)

## 🛡 실사용 감사 (2026-09-16) — 완료
전 경로 코드 리뷰(엔진·스텝·주문·지갑·청산·자동매도·상장감시·부팅). "원칙은 세워뒀는데 한 경로만 빠진" 유형이 대부분.
- [x] **바이낸스 잔고 조회가 항상 0** — `coinBalance("binance")`가 POST 고정 `binanceSigned`를 써서 에러 JSON → 폴백 0(null 아님). hybrid 자동매도가 영원히 waiting. `binanceSignedGet`으로 교체 + 에러 응답은 null. 고치면 드러나는 다음 문제(250ms × weight 20 = 한도 80%)는 거래소별 잔고 폴 주기(`BAL_POLL_MS`, 바낸 2s)로
- [x] **상장 자동매수·원클릭에 슬리피지 게이트 없음** — 무인으로 나가는 경로만 `MAX_SLIPPAGE_PCT`가 빠져 있었다. `listingSlipGate`(호가 조회 실패도 차단)를 autoBuy·/api/listing-buy 둘 다에
- [x] **EVM 전송 `wait()` 무한 대기** — 런이 영구 busy, cancel·unwind 불가. `WALLET_TX_WAIT_MS`(기본 15분) 타임아웃 → 기존 "브로드캐스트됨(컨펌 미확인)" 경로로
- [x] **서킷 브레이커 → 자동매도 트리거 전멸** — 킬이면 status=error로 루프가 죽고 해제해도 안 살아났다(다른 코인 실패로도). 킬은 정지: 주문만 안 내고 루프는 유지
- [x] **헷지 마진 게이트 fail-open** — `binanceFuturesFree()` null이면 통과했다. 차단으로. 마진 워치도 null이면 "조회 실패" 경보. 고치면서 드러난 것: 그 함수가 `api.binance.com`에 `/fapi/v2/balance`를 쳐서 **라이브에서 항상 null**이었다(선물은 `fapi.binance.com`) — 게이트가 실제로 검사한 적이 없었다. `binanceSignedGet`에 host 인자
- [x] **매도 체결량 미확인 → 일일손실 한도 눈멂** — 매수엔 있던 ambiguous 가드가 매도엔 없어 settle이 추정 경로로 빠지고 recordPnl 미호출. 같은 가드 + 업비트 주문상세 조회 1회→4회
- [x] **빗썸 출금 net_type 누락** — 입금주소 조회는 넘기면서 출금만 빠져 멀티체인 코인은 거래소가 체인을 골랐다
- [x] **부팅** — health 크론이 스캔·감시는 깨우지만 `runEngine.boot()`(중단 런 표시·헷지 마진 워치)는 /api/runs 로드 때만 돌았다. scanCache 초기화에서 엔진도 로드. 첫 공지 폴이 재시작 창의 공지를 baseline으로 삼키던 것은 `annLastId` 영속 + 발행 10분 이내만 처리(`isBootFreshNotice`, 테스트)
- [x] **리스크 한도 UI 변경 미영속** — 재시작하면 env 초기값 복귀. `riskLimits` flush(테스트)
- [x] **롤백·청산 시장가의 슬리피지 게이트 fail-open** — `.catch(() => null)`로 호가 조회 실패 시 덤프. 진입과 같이 fail-closed(보류 + 텔레그램)
- [x] **재시작 시 지정가 고아** — working→waiting하며 `openOrderId`를 버려 거래소의 살아있는 주문을 잊었다. id 있는 working은 그대로 복원해 trackOpenOrder가 이어받는다
- [x] **부분 청산 후 `eng.hedgeQty` 미갱신** — 재개 시 close가 원래 수량 reduceOnly → -2022 거절. 청산분만큼 차감. unwind의 closeHedge도 요청량이 아니라 체결량만 인정
- [x] **BINANCE_SECRET 누락이 "결과 불명"** — key만 보고 진행 → createHmac throw → inflightFail(ambiguous). `bnReady()`로 둘 다 확인
- [x] **`/api/exec-step` 삭제** — 아무도 안 부르는데 살아 있던 자금 이동 라우트. 엔진의 중복 포지션·노출 한도·재검증·replay 방어를 전부 우회했다. idem 캐시도 함께 제거
- [x] **`unwindRun` busy면 무응답** — 거절 사유를 돌려주고 라우트가 409로 올린다
- [x] 자잘 — 지갑 수신 기준치 없을 때 절대잔고 대신 `min(잔고, 기대수량)`(기존 보유분 송금 방지) · CoinGecko null 알림 문구에 "레이트리밋" 명시 · 텔레그램 발송 실패 console.error

## 🔴 P0 — 실전화 (실제 자금 이동, 키 필요)
`lib/execStep.ts` + `lib/orders.ts` (전부 DRY-RUN 게이트, 휴면):
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
- [x] **개인지갑 토큰 보유** — RPC 폴백에 ERC20(큐레이션+수동등록)/TRC20(계정조회 동봉)/SPL(전 계정 1콜) 잔고 편입, 스테이블 $1 평가 (`lib/walletBalances.ts`)
- [ ] **업비트↔바이낸스 네트워크 코드 매핑** (키 필요 · 2026-07-25 논의)
      현재 전송 체인은 바이낸스 networkList(또는 큐레이션 `COIN_NETWORK`)에서 고르고,
      **그 바이낸스 코드를 업비트 `net_type`으로 그대로 넘긴다**(`NET_LABEL = BINANCE_NET`).
      두 거래소 표기가 항상 같지 않다(바이낸스는 `ARBITRUM`/`AVAXC`/`OPTIMISM` 식).
      안전 쪽으로 실패하긴 한다 — 업비트가 모르는 코드면 입금주소 조회가 null →
      execStep이 "입금주소 미확인 — 차단"으로 하드 실패. 하지만 **보드에서 수익으로
      잡히고 출금 단계에서 죽는 경로**가 생긴다.
      할 일: ①읽기 전용(자산조회) 업비트 키로 `/v1/status/wallet` 덤프 →
      통화별 `net_type` 확보 ②바이낸스 networkList와 대조해 불일치 코인만 추출
      ③매핑 테이블 + 업비트 미지원 네트워크는 스캔 단계에서 제외.
      주의: 업비트 Open API는 IP 화이트리스트가 필요하므로 **KR 박스에서 실행**해야 한다
      (샌드박스에서는 IP 불일치로 거부). 스크립트로 만들어 두면 키가 대화를 거치지 않는다.

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
- [x] **알림(텔레그램)** — 임계 순수익 돌파 / 입출금 중단 / 에러 (scanCache.alertOnScan + watchdog)
- [x] **P&L·거래 기록** — 정산 시 data/trades.jsonl 기록(탐지net vs 실현net·규모·경로·모의여부), /api/trades 집계(실현손익·히트율·평균누수), 관제 탭 거래·손익 카드(지표3+최근8건)
- [x] **갭 히스토리** — 보드 행별 30분 스파크라인(스캔 응답 탑재) + 검사창 차트 재설계(극성 면채움·축·호버). 지속시간·히트율은 PersistChip·복기가 담당
- [ ] **KRW 리패트리에이션** — 오프램프(은행 한도·환전) 추적
- [ ] 모니터 필터/정렬/즐겨찾기 (최소 net·거래량·선물유무, 임계 알림음)
- [x] 실행 타임라인 tx 해시 + 체인 익스플로러 링크 (송금·입금 단계)
- [ ] 출금 단계 조기 tx 표시 (바낸 출금 히스토리 폴링)
- [ ] 펀딩 레이트 지속성 검증 (히스토리 필요 — 갭 히스토리와 함께)

## 🟢 티어1·2 (2026-07-18)
- [x] A. 상장따리 견고화 — t.me/s 채널 스크레이프 폴백(CF무관)+원클릭 해외 매수(/api/listing-buy, 게이트 완비)
- [x] B. 운영 워치독 — 스캔정지·피드다운 텔레그램 경고+일일 하트비트
- [x] C. 상태 영속화 — data/state.json (히스토리·상장 플레이·일일 PnL 재시작 내성)
- [x] D. RUNBOOK.md — 실전화 단계별 가이드
- [x] E. 조건부 자동 진입 — opt-in 무장, net·지속·규모 조건, beforeWithdraw 정지, 동시1·쿨다운30m
- [x] F. exec-step 멱등키 — 성공 캐시 10m, 재시도 이중발사 차단
- [x] G. 거래 기록 단계별 실소요 — durationsSec (ETA 보정 데이터)
- [x] H. 오버레이 실행가화 — 업비트 orderbook WS+바낸 b/a 실 bid/ask 크로스, 빗썸 앵커 폴백

## 🟠 상장따리 (신규 상장 캐치)
- [x] **상장 공지 기반 감지** — 업비트 공지 API 2.5s 폴링(KR IP 동작, 제목에서 상장키워드+티커 파싱), 공지 뜬 즉시 해외 매수처(바낸/바이비트/OKX 최저) 판정+텔레그램. 마켓 diff는 "거래개시" 확인 신호로. 보드 공지/개시 배지·최상단, 관제 카드(해외 매수처·가격)
- [ ] 신규 상장 원클릭 해외 매수 실행(공지→즉시 글로벌 BUY)
- [ ] 공지 API 폴백(비KR): 텔레그램 채널/RSS 스크레이프

## 🔵 도메인 감사 반영 (2026-07)
- [x] **보드 유동성 한도** — kimchi·cross-cex의 notionalCapUsd가 null이라 $100이든 $50,000이든 보드 net이 같아 보였다. 티커가 이미 싣고 오는 최우선호가 물량(bidSize/askSize)으로 보수적 하한을 계산해 표시(정확한 상한은 모달 뎁스 견적이 계속 담당)
- [x] **cross-cex 출금비 출처 정정** — 출금 다리가 bybit/OKX여도 바이낸스 networkList 수수료를 쓰고 있었다. 바낸 다리일 때만 정액값, 그 외에는 코인별 티어로 폴백
- [x] **최소 출금 게이트 전 거래소** — `buy.venue === "binance"`일 때만 돌아서, 다른 거래소 매수 경로는 방어 없이 출금 API 에러로 죽었다(그 시점엔 이미 헷지가 열려 있다). 롤백 가능 지점에서 막는 쪽이 싸다
- [x] **정산 손익이 런에 실린다** — settle 실현 손익이 trades.jsonl에만 남고 run.pnlUsd는 청산 경로만 채워서, 운영 탭·모달의 "실현" 배지가 정산 완료 런에서 항상 0이었다
- [x] **거래기록 hedged 정직화** — `opp.hasPerp`(퍼프 존재 여부)가 아니라 hedge 단계가 실제로 done인지로 기록
- [x] **지갑 자산 체인 표기** — RPC 폴백 경로가 EVM 4체인 네이티브를 구분 없는 "ETH" 여러 줄로 보여줬다 (OKX 경로와 같은 `ETH·arbitrum` 규칙 적용)
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
- [x] `EXCLUDE`에 누락 스테이블 추가 (USDE/USD1/USDS/PYUSD/RLUSD/USDG/USDY/EURC/USDF) `config.ts`
- [x] 안 쓰는 `app/api/execute` + `lib/execution.ts` 제거
- [ ] EVM 외 잔고 RPC 안정화(공개 RPC 레이트리밋 → env로 교체)
