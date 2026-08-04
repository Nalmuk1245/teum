# 병렬 실행 안전성 감사 — 2026-08-04

> 배경: "기능들을 병렬로 실행해도 문제없나?" 김프 홉·자동매도·상장 감시가 한
> 프로세스에서 동시에 돈다. 공유 자원(잔고·거래소 rate·매도 대상) 경합을 감사.

## 핵심 결함: 공유 조율 부재
매도 뮤텍스도, 공유 rate limiter도 없었다. `activeSellForVenue`가 유일한
조율인데 tick 맨 위 한 번만 보는 advisory read라 TOCTOU 창이 열려 있었다.

## 수정 (구조 2개가 대부분을 닫음)

| # | 등급 | 결함 | 수정 |
|---|---|---|---|
| 1 | 심각 | 트리거·런이 같은 코인·거래소 동시 매도 → 하나 거절, 하필 런이면 비가역 출금 뒤라 네이키드 숏 | lib/sellLock.ts 뮤텍스 + startRun/createTrigger 양방향 공존 거부 |
| 2 | 높음 | BACKOFF_MS 죽은 코드·공유 rate limiter 없음 → hammer가 초당 ~8 거절주문, abuse 정지 위험 | lib/rateLimiter.ts 거래소별 토큰버킷(전 주문 통과) + nonFill 지수 백오프 배선 |
| 3 | 높음 | 같은 코인·거래소 트리거 2개 등록 가능 → 이중 매도 | createTrigger 중복 거부(409) |
| 4 | 중간 | hammer가 체결 후 예상수량 전량 재던짐 · finalize가 balance-lag에 재발화 | 체결분 expectQty 차감 · finalize를 soldQty 기준으로 |
| 5 | 중높 | 수동 매도 라우트가 조율 우회 | listing-sell을 매도 락으로 감쌈 |
| 6 | 안전 | 킬 스위치는 전 액터 커버(진행 중 주문만 완료) | — |
| 7 | 낮음 | persist 동기/비동기 writer가 같은 .tmp → ENOENT 경합(파일은 안 깨짐) | 고유 tmp 이름 |

## 남은 것 (설계상 수용)
- 이미 브로드캐스트된 주문은 킬 후에도 완료 — 회수 불가라 정상.
- rate limiter 수치(upbit 5·binance 7·bithumb 2 /s)는 문서값 ~70% 추정 —
  KR 박스 실측으로 조정. hammer 첫 가동 시 attempts·거절률 로그 확인 필수.
