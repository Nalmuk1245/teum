// 손익 캘린더 집계 — 조용히 틀리는 지점에 못을 박는다:
// ① 일 경계가 KST여야 한다 (UTC로 자르면 오전 9시 이전 거래가 전날로 넘어간다)
// ② 모의 손익이 실손익에 절대 섞이면 안 된다 (리허설 숫자가 진짜 돈인 척하게 된다)
// ③ 승수는 "실현 손익이 잡힌 실거래" 기준이다.

import { describe, it, expect } from "vitest";
import { aggregateDaily, tradeDayKey, type TradeRecord } from "@/lib/trades";

const T = (over: Partial<TradeRecord>): TradeRecord => ({
  ts: 0, base: "XRP", kind: "kimchi", route: "Binance → Upbit", sizeUsd: 1000,
  detectedNetPct: 1, realizedNetPct: null, realizedPnlUsd: null,
  hedged: true, dryRun: false, status: "done", ...over,
});

describe("tradeDayKey", () => {
  it("KST 자정 기준으로 자른다", () => {
    // 2026-08-19 15:30 UTC = 2026-08-20 00:30 KST → 20일
    expect(tradeDayKey(Date.UTC(2026, 7, 19, 15, 30), "Asia/Seoul")).toBe("2026-08-20");
    // 2026-08-19 14:59 UTC = 2026-08-19 23:59 KST → 19일
    expect(tradeDayKey(Date.UTC(2026, 7, 19, 14, 59), "Asia/Seoul")).toBe("2026-08-19");
  });
});

describe("aggregateDaily", () => {
  it("같은 KST 날짜로 묶고 실손익·승수를 집계한다", () => {
    const days = aggregateDaily([
      T({ ts: Date.UTC(2026, 7, 19, 15, 30), realizedNetPct: 1.2, realizedPnlUsd: 12 }), // KST 20일
      T({ ts: Date.UTC(2026, 7, 20, 3, 0), realizedNetPct: -0.4, realizedPnlUsd: -4 }),  // KST 20일
      T({ ts: Date.UTC(2026, 7, 19, 10, 0), realizedNetPct: 0.5, realizedPnlUsd: 5 }),   // KST 19일
    ], "Asia/Seoul");
    expect(days.map((d) => d.date)).toEqual(["2026-08-19", "2026-08-20"]); // 오름차순
    const d20 = days[1];
    expect(d20.pnlUsd).toBe(8);
    expect(d20.realCount).toBe(2);
    expect(d20.wins).toBe(1);
  });

  it("모의는 실손익에 섞이지 않고 따로 집계된다", () => {
    const ts = Date.UTC(2026, 7, 20, 3, 0);
    const [d] = aggregateDaily([
      T({ ts, realizedPnlUsd: 10 }),
      T({ ts, dryRun: true, realizedPnlUsd: 99 }), // 모의 정산 — 리허설 손익
      T({ ts, dryRun: true }),
    ], "Asia/Seoul");
    expect(d.pnlUsd).toBe(10);
    expect(d.realCount).toBe(1);
    expect(d.dryCount).toBe(2);
    expect(d.dryPnlUsd).toBe(99);
    expect(d.count).toBe(3);
  });

  it("정산 안 된 실거래는 건수에만 잡히고 승패에서 빠진다", () => {
    const ts = Date.UTC(2026, 7, 20, 3, 0);
    const [d] = aggregateDaily([T({ ts }), T({ ts, realizedPnlUsd: 0 })], "Asia/Seoul");
    expect(d.count).toBe(2);
    expect(d.realCount).toBe(1); // realizedPnlUsd == null은 미정산
    expect(d.wins).toBe(0); // 0은 승이 아니다
  });
});
