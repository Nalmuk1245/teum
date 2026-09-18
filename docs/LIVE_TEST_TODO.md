# 실사용 테스트 TODO — 테스터용

> 2026-09-16 실사용 감사(`fix/live-audit-2026-09`, TODO.md "🛡 실사용 감사" 섹션)에서 고친 것 중
> **거래소·체인 왕복이 있어야 확인되는 항목**만 모았다. 단위 테스트(`npm test`)로 못 박은 건 여기 없다.
> 각 항목은 **바뀐 것 → 절차 → 기대 결과 → 실패하면 볼 곳** 순서. 체크박스는 통과했을 때만 채운다.

---

## 0. 안전 규칙 — 읽고 시작

1. **전용 계정·전용 지갑.** 주력 자금이 있는 거래소 계정/지갑으로 절대 하지 않는다. 지갑은 새로 만들고 가스용 소액만.
2. **금액은 항목에 적힌 상한을 넘기지 않는다.** 대부분 $15~50. 상한이 없는 항목은 DRY(돈 안 듦)다.
3. **한 번에 하나.** 항목 하나 끝내고 결과 기록한 뒤 다음으로. 병렬로 두 개 돌리지 않는다.
4. **이상하면 킬 스위치.** 헤더 STOP 버튼 또는 `curl -X POST localhost:3100/api/kill -H 'content-type: application/json' -d '{"killed":true}'`. 그다음 거래소 웹에서 직접 포지션·주문을 정리하고, 그 뒤에 원인을 본다.
5. **키·시크릿·`.env.local`·`data/`는 절대 커밋·공유하지 않는다.** 보고서에도 넣지 않는다(끝 4자리만).
6. 라이브(`DRY_RUN=false`) 항목은 **B 섹션부터**고, A 섹션(DRY)을 먼저 전부 끝낸 뒤에만 들어간다.

## 1. 사전 준비

- [ ] `RUNBOOK.md` 0~3절 완료 (KR IP, 텔레그램, 키 입력, `EXEC_TOKEN`, 소액 리스크 한도)
- [ ] 최신 `main` 체크아웃: `git pull && npm ci && npm run build && pm2 restart teum` (또는 `npm start`) — 감사 수정분은 `main`에 병합돼 있다
- [ ] 헬스체크 크론 등록 (RUNBOOK "헬스체크 crontab"). **T4가 이걸 검증한다.**
- [ ] `.env.local`에 아래를 소액으로 잠금:
  ```
  RISK_MAX_PER_TRADE_USD=60
  RISK_MAX_INFLIGHT_USD=120
  RISK_MAX_DAILY_LOSS_USD=30
  ```
- [ ] 라이브 curl용 헤더 준비: `-H "x-exec-token: $EXEC_TOKEN"` (돈이 나가는 라우트는 이게 없으면 403)
- [ ] 로그 보는 법: `pm2 logs teum --lines 200` 또는 `next start` 터미널. 아래에서 "로그"는 이걸 말한다.
- [ ] 영속 상태 위치: `data/state/<섹션>.json` (예: `riskLimits.json`, `annLastId.json`, `sellTriggers.json`)

---

## A. DRY 항목 — 돈이 안 나간다 (`DRY_RUN=true` 유지)

### T1. 킬 스위치가 자동매도 트리거를 죽이지 않고 정지시킨다
**바뀐 것:** 킬이면 트리거가 `error`로 죽어 해제해도 안 살아났다 → 이제 주문만 안 내고 루프는 계속 돈다.
- [ ] 운영 탭 → 자동매도 트리거 등록: 거래소 `upbit`, 코인 아무거나(예: XRP), 모드 `market`, fire `hybrid`
- [ ] 킬 스위치 ON → 트리거 카드 `lastMsg`가 **"킬 스위치 활성 — 대기 (해제되면 재개)"**, 상태는 `waiting` 그대로(`error` 아님)
- [ ] 킬 OFF → 몇 초 안에 `lastMsg`가 다시 바뀜(잔고 조회/대기 메시지). `attempts`나 메시지가 갱신되면 루프가 살아 있는 것
- [ ] 트리거 삭제
**실패하면:** `lib/sellTriggers.ts` `tick()` 맨 위 `isKilled()` 분기, `scheduleLoop()`의 재스케줄 조건.

### T2. 실행 중인 런에 청산을 누르면 조용히 무시되지 않고 이유가 뜬다
**바뀐 것:** 루프가 busy(입금 대기 등)면 `unwindRun`이 아무 말 없이 return했다 → 이제 409 + 사유.
- [ ] 김프 기회 하나 실행, 자동범위 **전자동**, 헷지 ON. 입금 대기(모의 ETA 카운트다운) 단계에 있을 때
- [ ] 청산 25% 클릭 → **에러 메시지**가 UI에 보여야 함: "실행 루프가 진행 중(…) — 청산 불가 …"
- [ ] curl로도: `curl -X POST localhost:3100/api/runs -H 'content-type: application/json' -d '{"action":"unwind","id":"<run id>","fraction":0.25}'` → HTTP **409**, `error` 필드
- [ ] 런이 끝난(done) 뒤 잔량이 있으면 청산이 정상 동작하는지 한 번
**실패하면:** `lib/runEngine.ts` `unwindRun()` 반환값, `app/api/runs/route.ts` `case "unwind"`.

### T3. 리스크 한도 UI 변경이 재시작 후에도 남는다
**바뀐 것:** 메모리에만 있어서 pm2 재시작이면 env 초기값으로 돌아갔다 → `data/state/riskLimits.json`에 즉시 저장.
- [ ] 운영 탭에서 1회 한도를 **37**로 변경
- [ ] `cat data/state/riskLimits.json` → `maxPerTradeUsd: 37`
- [ ] `pm2 restart teum` → 운영 탭 다시 열어 **37 유지** 확인 (`curl localhost:3100/api/risk`도 37)
- [ ] 되돌리기: 파일 삭제 후 재시작하면 env 값으로 복귀하는지 (`rm data/state/riskLimits.json && pm2 restart teum`)
**실패하면:** `lib/risk.ts` 상단 `persistedLimits`, `setLimits()`의 `flushSection`.
**주의:** 이제 **저장된 값이 env보다 우선**이다. env로 한도를 바꾸려면 이 파일을 지워야 한다 — 이 동작이 헷갈리면 보고서에 적어 달라.

### T4. 탭을 닫고 재시작해도 크론만으로 엔진이 깨어난다
**바뀐 것:** 헬스 크론이 스캔·감시는 켰지만 실행 엔진(`runEngine.boot()`)은 `/api/runs`가 처음 불릴 때만 돌았다 → 이제 함께 로드.
- [ ] 김프 기회 하나 **전자동**으로 실행해 입금 대기 상태로 둔다
- [ ] **브라우저 탭을 전부 닫는다**
- [ ] `pm2 restart teum` — 그리고 브라우저를 열지 않는다. 크론(1분)이 `/api/health`를 치길 기다린다 (최대 2분)
- [ ] 텔레그램에 **"⚠ 서버 재시작 — 진행 중이던 런 1건 중단됨"** 이 도착해야 함 (텔레그램 미설정이면 로그에서 같은 문구)
- [ ] 그 뒤 브라우저를 열면 해당 런이 `error` "서버 재시작으로 실행 루프 중단" 상태
**실패하면:** `lib/scanCache.ts` `getScan()` 초기화 블록의 `import("./runEngine")`, 크론이 실제로 도는지(`grep CRON /var/log/syslog` 또는 `journalctl -u cron`).

### T5. 공지 폴러가 마지막으로 본 공지 id를 저장한다 (KR IP 필요)
**바뀐 것:** 재시작 직후 첫 폴이 보이는 공지를 전부 "이미 본 것"으로 삼켰다 → 마지막 id를 저장하고, 그보다 새 id이면서 **발행 10분 이내**인 공지만 부팅 직후에도 처리.
- [ ] 서버 기동 후 1분 뒤 `cat data/state/annLastId.json` → 숫자(업비트 공지 id)
- [ ] 10분 뒤 다시 확인 → 같거나 커졌음(작아지면 버그)
- [ ] **관찰(재현 불가):** 실제 상장 공지 직후 2분 안에 우연히 재시작이 겹치면, 재시작 후 그 공지가 처리됐는지(텔레그램 📢) 기록
**실패하면:** `lib/listings.ts` `pollAnnouncements()`의 `annLastId`, `isBootFreshNotice()`(단위 테스트 있음: `test/liveAudit.test.ts`).

---

### T22. 체인 코드 매핑이 빈틈없다 (돈 안 나감 · 키만 필요)
**바뀐 것 (2026-09-17):** 코인당 체인 하나로 고정하고 거래소 표기가 안 맞으면 "아무 체인이나 열림"으로 완화하던 게이트를, 거래소 표기를 정규화(`lib/netcodes.ts canonChain`)해 기회마다 양쪽이 같이 연 체인을 고르는 방식(`lib/transfers.ts routeFor`)으로 바꿨다. 출금·입금주소 조회도 그 거래소의 원문 코드(`venueNetCode`)를 쓴다. **매핑 안 된 코드는 미확인(null)으로 남아 라이브 실행을 막는다** — 그래서 이 항목은 "막히는 게 없나"를 보는 것이다. 정규화 표는 API 문서 기준으로 만들었고 **실제 응답으로 검증된 적이 없다.**
- [ ] 거래소 키(업비트·바낸·바이비트·OKX) 등록 후 1분 뒤: `curl -s localhost:3100/api/gate-networks?coin=USDT | jq .unmapped` → `[]`
- [ ] 같은 확인을 XRP · ETH · SOL · BTC · 상장따리 후보 알트 3개에 반복. `unmapped`에 뜨는 `{venue, net}`을 **전부** 기록해 보고서에
- [ ] `jq .networks.upbit` 로 업비트 행의 `net`(원문)과 `chainKey`(정규화)를 나란히 보고, 업비트 웹 입금 화면의 네트워크 이름과 맞는지 코인 3개 대조
- [ ] 뜬 코드가 있으면 `lib/netcodes.ts`의 `EXACT` 표에 추가 (어느 체인인지는 거래소 입금 화면으로 확인) → 재시작 → 다시 `[]`
**실패하면:** `lib/netcodes.ts` `canonChain`/`EXACT`, `lib/transfers.ts` `putNets`(원문 코드 보존)·`routeFor`. 단위 테스트 `test/netcodes.test.ts`.

### T23. 기회마다 고른 전송 체인이 실제 거래소 화면과 같다 (돈 안 나감)
**바뀐 것:** 전송 체인이 코인당 고정이 아니라 기회마다 "매수 거래소 출금 + 매도 거래소 입금이 같은 체인에서 둘 다 열린 후보 중 ETA 최단"으로 결정된다. 기회 JSON의 `transfer.network`에 `chain`(라벨)·`chainKey`·`alternatives`(양쪽 열린 다른 체인 수)·`reason`(선택/차단 사유)이 실린다.
- [ ] `curl -s localhost:3100/api/scan | jq '[.opportunities[] | select(.kind=="kimchi" and .mock!=true) | {base, legs:[.legs[].venue], net:.transfer.network, w:.transfer.withdraw.enabled, d:.transfer.deposit.enabled}] | .[:10]'`
- [ ] USDT·XRP·SOL처럼 멀티체인 코인 3개: `reason`이 "양쪽 열림 N개 중 ETA 최단"이고 고른 체인이 **매수 거래소 출금 화면과 매도 거래소 입금 화면 양쪽에 실제로 있는지** 대조
- [ ] 키가 있는데도 `w`/`d`가 `null`인 코인이 있으면 그 코인의 `unmapped`(T22)를 확인 — null은 "표기를 못 맞췄다"는 뜻이어야 하고, 매핑됐는데 null이면 버그
- [ ] **관찰:** 특정 체인 입출금이 실제로 막힌 코인이 생기면(거래소 공지) 그 코인의 `reason`이 다른 열린 체인으로 바뀌는지, 없으면 "출금 막힘/입금 막힘"으로 뜨는지 기록
**실패하면:** `lib/netcodes.ts` `pickRoute`(후보·정렬), `lib/transfers.ts` `routeFor`(기본 체인 키 — 레지스트리 밖 체인은 `native:TICKER`).

### T24. 모르는 코인의 기본 체인(ERC20 가정)이 바낸 networkList로 대체된다 (돈 안 나감 · 바낸 키)
**바뀐 것 없음 — 남은 구멍이라 확인만:** 큐레이션 표(`lib/config.ts COIN_NETWORK`)에 없는 코인은 **Ethereum (ERC20)** 으로 가정한다. 바낸 키가 있으면 `/sapi/v1/capital/config/getall`의 기본 네트워크가 이를 덮어쓴다. 키 없이 돌리면 솔라나 코인(예: TRUMP)이 Ethereum으로 뜬다 — 이건 버그가 아니라 키 부재다.
- [ ] 바낸 키 없이: `jq '.opportunities[] | select(.base=="TRUMP") | .transfer.network'` → Ethereum (기대되는 잘못된 값)
- [ ] 바낸 키 등록 + 1분 뒤 같은 명령 → 바낸이 부르는 체인(Solana)으로 바뀜, `confirms`가 바낸 `minConfirm` 값
- [ ] 큐레이션에 없는 KR 상장 알트 5개를 골라 같은 확인. 여전히 Ethereum인데 실제로는 다른 체인인 코인이 있으면 **보고** (바낸이 그 코인을 상장 안 했거나 networkList가 비어 있는 경우)
**실패하면:** `lib/transfers.ts` `fetchBinance()`의 `setLiveNetwork`, `lib/networks.ts` `coinNetwork()`.

## B. 라이브 항목 — `DRY_RUN=false`, 소액

> B로 넘어가기 전: A 전부 통과, `EXEC_TOKEN` 설정, 리스크 한도 소액 잠금 확인. 항목 순서를 지킨다 — 뒤로 갈수록 위험하다.

### T6. BINANCE_SECRET만 빼면 "결과 불명"이 아니라 "키 없음"으로 실패한다 (돈 안 나감)
**바뀐 것:** key만 보고 진행해서 secret 없는 서명이 throw → "결과 불명(전송 후 오류)"로 오분류돼 재시도·롤백이 막히고 폰이 울렸다.
- [ ] 설정창에서 `BINANCE_SECRET`을 **비운다** (`BINANCE_KEY`는 둔다). `DRY_RUN=false` 재시작
- [ ] 바낸 매수 다리 기회를 $15로 실행 → 매수 단계가 **즉시** 실패, 메시지 **"실행 불가 — … (키 없음)"**. "결과 불명"·"전송 후 오류" 문구가 **없어야** 함. 텔레그램 ❓ 알림도 없어야 함
- [ ] 런은 롤백 없이 error. `BINANCE_SECRET` 원복
**실패하면:** `lib/orders.ts` `bnReady()`와 각 `binance*` 함수 첫 줄.

### T7. 바이낸스 잔고 조회가 실제 값을 돌려준다 → hybrid 트리거가 반응한다 (실주문 등록, 체결 없음)
**바뀐 것:** 잔고 조회가 POST로 나가 **항상 0**이었다 → hybrid 트리거가 영원히 대기. GET으로 수정.
**준비:** 바낸 현물에 소액 코인 보유(예: XRP $10어치). 현재가를 확인해 둔다.
- [ ] 트리거 등록(curl, 토큰 필요):
  ```bash
  curl -X POST localhost:3100/api/sell-trigger -H 'content-type: application/json' -H "x-exec-token: $EXEC_TOKEN" \
    -d '{"venue":"binance","base":"XRP","mode":"limit","fire":"hybrid","targetPrice":<현재가의 3배>}'
  ```
- [ ] 5초 안에 `curl localhost:3100/api/sell-trigger` → 해당 트리거 `status: "working"`, **`openOrderId`에 값** 있음, `lastMsg` "지정가 등록 @…". 바낸 웹 미체결 주문에 같은 주문이 보임
  - 예전 버그면 여기서 영원히 `waiting` + "잔고 조회 실패" 또는 아무 반응 없음
- [ ] **T9로 이어간다** (지정가를 그대로 둔다). T9까지 끝나면 `curl -X DELETE "localhost:3100/api/sell-trigger?id=<id>" -H "x-exec-token: $EXEC_TOKEN"` → 바낸 웹에서 주문이 **취소**됐는지 확인
**실패하면:** `lib/orders.ts` `coinBalance()` binance 분기 (`binanceSignedGet("/api/v3/account")`), 응답에 `balances` 배열이 오는지 로그로.

### T8. 바이낸스 트리거 두 개를 10분 돌려도 rate 한도에 안 걸린다
**바뀐 것:** hybrid 잔고 폴이 250ms × weight 20 = 한도의 80%였다 → 바낸은 2초 주기.
- [ ] T7 트리거가 살아 있는 상태에서 다른 코인으로 하나 더 등록(같은 방식, 목표가 3배)
- [ ] 10분 대기. 로그에 `-1003`, `429`, `Too many requests`, `IP banned`가 **없어야** 함
- [ ] `curl localhost:3100/api/sell-trigger`의 `attempts`가 10분에 **~300 이하**(2초 주기면 300) — 2,400 근처면 주기 수정이 안 먹은 것
- [ ] 두 번째 트리거 DELETE(주문 취소 확인)
**실패하면:** `lib/sellTriggers.ts` `BAL_POLL_MS`, `pollMsFor()`.

### T9. 재시작해도 미체결 지정가를 잊지 않는다
**바뀐 것:** 재시작 시 `working`→`waiting`으로 돌리며 주문 id를 버려서, 거래소의 살아있는 지정가가 고아가 됐다.
- [ ] T7 트리거(working, openOrderId 있음)가 살아 있는 상태에서 `pm2 restart teum`
- [ ] 기동 후 `curl localhost:3100/api/sell-trigger` → 같은 트리거가 **`working` + 같은 `openOrderId`**. 바낸 웹에도 주문 그대로
- [ ] DELETE → 바낸 웹에서 주문 취소 확인(여기서 T7 마무리)
**실패하면:** `lib/sellTriggers.ts` `store()`의 복원 로직.

### T10. 선물 가용 마진 조회가 숫자를 돌려준다 (헷지 게이트가 실제로 검사한다)
**바뀐 것:** 선물 API를 `api.binance.com`에 쳐서 **항상 null**이었고 게이트는 fail-open이라 한 번도 검사한 적이 없었다 → 호스트 수정 + 조회 실패면 헷지 차단.
**준비:** 바낸 키에 **선물 권한**, 선물 지갑에 USDT $30+.
- [ ] `curl "localhost:3100/api/hedge-health?notional=100"` → `{"ok":true,"free":<숫자>,"ratio":…}`. `free: null`이면 실패
- [ ] 선물 지갑 USDT를 **$5 미만**으로 줄인 뒤(현물로 이체) 헷지 ON $50 김프 런 실행 → 헷지 단계가 **"선물 가용 마진 부족 …"** 으로 차단, 매수는 롤백됨. USDT 원복
- [ ] 선물 USDT $30+ 상태로 헷지 ON $30 런 → 헷지 단계 통과, 바낸 선물에 숏 포지션 확인. **런은 출금 전 단계에서 취소(force)하고 현물·숏을 거래소에서 수동 정리**
**실패하면:** `lib/orders.ts` `binanceFuturesFree()` → `binanceSignedGet(…, "fapi.binance.com")`. 키에 선물 권한이 없으면 `free: null`이 정상 — 보고서에 키 권한을 적을 것.

### T11. 상장 매수(원클릭·자동)에 슬리피지 상한이 걸린다
**바뀐 것:** 무인으로 나가는 두 경로만 `MAX_SLIPPAGE_PCT`(기본 0.5%) 게이트가 없었다.
- [ ] 얇은 코인으로 차단 확인 — 바이비트 현물 거래량 하위 코인 하나 고른다(바이비트 웹에서 24h 거래량 $100K 이하). **$200**으로:
  ```bash
  curl -X POST localhost:3100/api/listing-buy -H 'content-type: application/json' -H "x-exec-token: $EXEC_TOKEN" \
    -d '{"base":"<코인>","sizeUsd":200,"venue":"bybit"}'
  ```
  → HTTP **409**, `message`에 "슬리피지 게이트 — 매수 슬리피지 X% > 상한" 또는 "호가 깊이 부족". **매수가 나가면 안 됨** (거래소 웹 확인). (1회 한도 60이라 리스크 게이트가 먼저 걸리면 `RISK_MAX_PER_TRADE_USD=250`으로 잠깐 올렸다 원복)
- [ ] 두터운 코인으로 통과 확인 — `{"base":"BTC","sizeUsd":15,"venue":"binance"}` → `ok: true`, **실제 $15 매수됨**. 상장 탭 플레이에 기록. 매수한 BTC는 수동 매도
- [ ] 자동매수 경로: 상장 탭에서 자동매수 ON($15) + `LISTING_AUTO_LIVE=true` → 상장 드릴 `curl -X POST localhost:3100/api/listing-drill -d '{"base":"BTC"}' -H 'content-type: application/json'` — **드릴은 라이브에서 자동매수를 안 하는 게 정상**(가드). 텔레그램 🥁만 오고 매수 없음. 실제 공지에서의 게이트 동작은 **관찰 항목(T16)**
**실패하면:** `lib/listings.ts` `listingSlipGate()`, `app/api/listing-buy/route.ts`. 심볼 형식(OKX는 `BASE-USDT`) 확인.

### T12. 온체인 전송 컨펌 대기에 상한이 있다 (해시를 잃지 않는다)
**바뀐 것:** ethers `wait()`가 무한 대기라 tx가 멤풀에 걸리면 런이 영영 busy였다 → `WALLET_TX_WAIT_MS`(기본 15분). 시간이 차면 **"브로드캐스트됨(컨펌 확인 실패)"** + 해시로 사람에게 넘긴다.
**준비:** 개인지갑(EVM)에 가스 ETH + 소액 ERC20(예: USDC $10). `.env.local`에 **`WALLET_TX_WAIT_MS=3000`** (3초 — 12컨펌이 절대 안 끝나는 값) 후 재시작.
- [ ] 개인지갑 홉 경로(바낸→지갑→업비트) 김프 런 **$15**, 자동범위 **출금 전까지**. 출금·수신 확인까지 승인
- [ ] `송금` 단계 승인 → 몇 초 뒤 단계가 **error**, 메시지에 **"브로드캐스트됨(컨펌 확인 실패) — 재전송 금지"** 와 tx 해시 칩(익스플로러 링크)
- [ ] 익스플로러에서 그 tx가 **실제로 컨펌**되는지 확인(몇 분)
- [ ] 런에서 **재시도** 클릭 → **"결과 불명 단계 — 거래소 내역을 먼저 확인"** 으로 **거부**돼야 함 (두 번 보내면 안 됨). 익스플로러에 tx가 **1개**뿐인지
- [ ] `WALLET_TX_WAIT_MS` 삭제(기본 15분) 후 재시작. 업비트에 도착한 코인은 수동 매도·정리
**실패하면:** `lib/wallet.ts` `sendEvm()`·`sendRawEvmTx()`의 `wait(…, WAIT_TIMEOUT_MS)`, `lib/execStep.ts` `transfer` 케이스의 `ambiguous`.

### T13. 부분 청산 뒤 이어가도 헷지 청산이 거절되지 않는다
**바뀐 것:** 청산으로 숏을 일부 닫아도 엔진의 헷지 수량이 그대로라, 이후 `close`가 원래 수량으로 reduceOnly → 바낸 `-2022` 거절.
**준비:** 선물 USDT $30+, 바낸 현물 소액.
- [ ] 헷지 ON **$30** 김프 런, 자동범위 **매도 전까지**. 입금 확인까지 자동 진행 후 매도 직전 일시정지
- [ ] 이 상태에서 청산 **25%** → 로그에 "숏 … 비례 청산"(체결량 숫자), 바낸 선물 포지션이 **25% 줄었는지**
- [ ] 런 **승인**(매도 진행) → 매도 → `선물 청산` 단계가 **성공**, 메시지에 `-2022`/`ReduceOnly … rejected` **없음**. 바낸 선물 포지션 **0**
**실패하면:** `lib/runEngine.ts` `unwindRun()`의 `eng.hedgeQty` 차감, `lib/unwind.ts` `closeHedge()`(체결량 기준).

### T14. 빗썸 출금이 net_type을 받는다 ⚠️ 가장 위험 — 맨 마지막, 반드시 두 단계로
**바뀐 것:** 빗썸 출금 요청에 `net_type`이 빠져 있었다(입금주소 조회에는 있었음). 멀티체인 코인은 거래소가 체인을 골랐다.
**주의:** 파라미터명이 빗썸 API가 받는 이름인지 **코드가 아니라 빗썸 문서/고객센터로 먼저 확인**한다. 거절되면 안전(돈 안 나감), 무시되면 위험(체인 어긋남). 그래서 단일 체인 코인부터.
- [ ] **1단계 — 단일 체인 코인**: 빗썸에서 BTC(또는 체인이 하나뿐인 코인) **최소 출금 수량**을 본인 바낸 입금주소로. 역프 경로가 아니라면 이 단계는 **빗썸 웹 API 테스트로 대체 가능**: `lib/orders.ts` `bithumbWithdraw()`가 보내는 파라미터(`currency, net_type, address, units[, destination]`)를 빗썸 API 도구로 그대로 보내 **거절 사유가 "잘못된 파라미터"가 아닌지** 확인
- [ ] **2단계 — 멀티체인 코인**: USDT를 **본인이 통제하는 TRX 지갑 주소**로 최소액. 출금 요청이 접수되고, 도착한 체인이 **TRX(TRC20)** 인지 익스플로러로 확인. ERC20으로 왔거나 다른 체인이면 **즉시 보고**(코드 `NET_LABEL`/`BINANCE_NET` 매핑이 빗썸 표기와 다른 것)
**2026-09-17 추가:** 다른 거래소는 이제 스윕이 저장한 **그 거래소의 원문 코드**로 출금하지만, 빗썸은 체인별 상태 API가 없어 **여전히 바낸 코드(`BINANCE_NET`)를 net_type으로 넘긴다** (`lib/transfers.ts venueNetCode`의 bithumb 폴백). 그래서 이 항목이 유일한 검증 수단이다.
- [ ] **0단계 (돈 안 나감, 빗썸 키):** 입금주소 조회가 같은 코드를 쓰므로 먼저 이걸로 코드 수용 여부를 본다 — `lib/deposits.ts bithumbDeposit()`이 보내는 `net_type`으로 USDT(`TRX`)·USDT(`ETH`)·XRP(`XRP`) 조회. 주소가 오면 그 코드는 빗썸이 받는 것. 오류/빈 응답이면 그 코드를 기록 (T22 보고서에 같이)
**실패하면:** `lib/orders.ts` `bithumbWithdraw()`, `lib/execStep.ts` `withdraw` 케이스의 `netCodeFor()`, `lib/transfers.ts` `venueNetCode()` bithumb 분기, `lib/chains.ts` `BINANCE_NET`. 빗썸 표기가 다르면 `venueNetCode`에 **빗썸 전용 표**를 넣는다(업비트처럼 스윕에서 배울 데이터가 없으므로 정적 표).

---

## C. 관찰 항목 — 일부러 재현하기 어렵다. 실사용 중 **발생하면** 기록

| ID | 무엇을 보나 | 기대 동작 | 실패 신호 |
|---|---|---|---|
| T15 | 매도 단계에서 거래소가 체결량을 안 주는 경우 | 단계가 **ambiguous**로 서고 "매도는 성공했지만 체결량을 확인할 수 없습니다" + 헷지 유지. 텔레그램 ❓ | 정산이 "추정치"로 찍히고 런이 done으로 끝남 (예전 동작) |
| T16 | 실제 상장 공지 + 자동매수 ON 상태 | 얇은 호가면 텔레그램 "⏸ 자동매수 차단 — 매수 슬리피지 …" 또는 "호가 조회 실패 … 차단". 두터우면 매수 | 슬리피지 5%+ 먹은 채 매수됨 |
| T17 | 롤백·청산 시장가 직전에 거래소 오더북 API가 죽은 경우 | "롤백 보류: 호가 조회 실패 — 수동 처리" / "시장가 보류 — 호가 조회 실패" + 텔레그램. **주문 안 나감** | 시장가가 나감 |
| T18 | 출금 직전 지갑 RPC 조회가 실패한 경우 | 수신 확인 메시지에 "잔고(기준치 없음)". 다음 송금 수량이 **기대 수량 이하** | 지갑에 원래 있던 같은 코인까지 송금됨 |
| T19 | 텔레그램이 끊긴 상태에서 알림이 나갈 때 | 로그에 `[telegram] 발송 실패 …` 한 줄 | 아무 흔적 없음 |
| T20 | 헷지 열린 런이 있는데 바낸 키 만료/선물 API 장애 | 텔레그램 "⚠️ 헷지 증거금 조회 실패 — …" (5분 쿨다운) | 경보 없이 조용 |
| T21 | 업비트 매도 직후 | 매도 메시지에 체결량 숫자. "체결량 미확인"이 **드물어야** 함 (조회 1회→4회) | 자주 미확인 |

---

## 2. 보고 양식

항목마다 아래로. 통과도 적는다(통과 근거가 곧 회귀 테스트 자료다).

```
### T7 — 통과 / 실패 / 부분
- 환경: 날짜, 커밋 해시(git rev-parse --short HEAD), DRY_RUN 값, 거래소·코인·금액
- 절차 중 실제로 한 것 (문서와 다르게 한 게 있으면 그것)
- 관찰: 화면 메시지 원문, curl 응답 원문, 로그 발췌(키는 가린다), 텔레그램 원문
- 거래소 웹에서 확인한 것 (주문/포지션/잔고 스크린샷 가능)
- 실패면: 어디서 멈췄나, 수동으로 어떻게 정리했나, 돈 영향(있으면 금액)
```

## 3. 고칠 때 규칙

- `main`에서 브랜치를 따서 고치고 PR. `main` 직접 커밋 금지
- 고친 뒤 `npm run typecheck && npm test && npm run build` 통과 필수. 순수 로직이면 `test/liveAudit.test.ts`에 케이스 추가
- 이 문서의 체크박스와 TODO.md 감사 섹션을 같이 갱신
- **자금이 움직이는 경로를 고칠 땐** 롤백·ambiguous·킬스위치 분기를 건드리지 않았는지 diff에서 한 번 더 본다. 원칙은 코드 주석에 다 적혀 있다 — 특히 `lib/execStep.ts` 상단, `lib/orders.ts` `OrderResult` 타입, `lib/runEngine.ts` 헤더

## 4. 항목 ↔ 코드 위치

| ID | 파일 · 함수 |
|---|---|
| T1 | `lib/sellTriggers.ts` `tick()`, `scheduleLoop()` |
| T2 | `lib/runEngine.ts` `unwindRun()` · `app/api/runs/route.ts` |
| T3 | `lib/risk.ts` `setLimits()`, 상단 `persistedLimits` |
| T4 | `lib/scanCache.ts` `getScan()` 초기화 · `lib/runEngine.ts` `boot()` |
| T5 | `lib/listings.ts` `pollAnnouncements()`, `isBootFreshNotice()` |
| T6 | `lib/orders.ts` `bnReady()` |
| T7·T8·T9 | `lib/orders.ts` `coinBalance()` · `lib/sellTriggers.ts` `BAL_POLL_MS`, `store()` |
| T10 | `lib/orders.ts` `binanceFuturesFree()`, `binanceSignedGet()` · `lib/execStep.ts` `hedge` |
| T11 | `lib/listings.ts` `listingSlipGate()`, `autoBuy()` · `app/api/listing-buy/route.ts` |
| T12 | `lib/wallet.ts` `WAIT_TIMEOUT_MS`, `sendEvm()`, `sendRawEvmTx()` |
| T13 | `lib/runEngine.ts` `unwindRun()` · `lib/unwind.ts` `closeHedge()` |
| T14 | `lib/orders.ts` `bithumbWithdraw()` · `lib/execStep.ts` `withdraw` `netCodeFor()` · `lib/transfers.ts` `venueNetCode()` |
| T15 | `lib/execStep.ts` `sell` 케이스 끝 |
| T17 | `lib/execStep.ts` `undoStep()` · `lib/unwind.ts` 시장가 폴백 |
| T18 | `lib/execStep.ts` `walletArrival()` |
| T19 | `lib/telegram.ts` `send()` |
| T20 | `lib/runEngine.ts` 헷지 마진 워치(파일 끝) |
| T22 | `lib/netcodes.ts` `canonChain`, `EXACT` · `lib/transfers.ts` `putNets()`, `unmappedNetCodes()` · `app/api/gate-networks/route.ts` |
| T23 | `lib/netcodes.ts` `pickRoute()` · `lib/transfers.ts` `routeFor()` · `lib/strategies.ts` kimchi/cross-cex `route` |
| T24 | `lib/transfers.ts` `fetchBinance()` `setLiveNetwork` · `lib/networks.ts` `coinNetwork()` · `lib/config.ts` `COIN_NETWORK_DEFAULT` |
