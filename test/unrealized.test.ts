// 미실현 손익 평가 — 리스크 게이트의 입력이라 못 박는다.

import { describe, it, expect, beforeEach } from "vitest";
import { evaluate, type Position } from "@/lib/unrealized";
import { checkEntry, setLimits, setUnrealized } from "@/lib/risk";

const pos = (o: Partial<Position>): Position => ({ key: "k", base: "A", venue: "binance", notionalUsd: 100, spotQty: 0, spotEntryUsd: null, hedgeQty: 0, hedgeEntryUsd: null, ...o });

describe("evaluate", () => {
  it("현물만: 진입가 대비 손익", () => {
    const u = evaluate([pos({ spotQty: 10, spotEntryUsd: 10 })], () => 8);
    expect(u.pnlUsd).toBe(-20);
    expect(u.lossUsd).toBe(20);
  });
  it("헷지가 현물 손실을 상쇄한다 (같은 수량이면 가격 변동 0)", () => {
    const u = evaluate([pos({ spotQty: 10, spotEntryUsd: 10, hedgeQty: 10, hedgeEntryUsd: 10 })], () => 7);
    expect(u.pnlUsd).toBe(0);
    expect(u.lossUsd).toBe(0);
  });
  it("포지션 간에는 이익으로 손실을 상쇄하지 않는다", () => {
    const u = evaluate([pos({ key: "a", spotQty: 10, spotEntryUsd: 10 }), pos({ key: "b", base: "B", spotQty: 10, spotEntryUsd: 10 })], (p) => (p.base === "A" ? 13 : 6));
    expect(u.pnlUsd).toBe(-10); // +30 −40
    expect(u.lossUsd).toBe(40);
  });
  it("가격 못 받은 포지션은 손실 0, 개수만 센다", () => {
    const u = evaluate([pos({ spotQty: 10, spotEntryUsd: 10 })], () => null);
    expect(u.lossUsd).toBe(0);
    expect(u.unpriced).toBe(1);
  });
});

describe("checkEntry — 미실현 손실 합산", () => {
  beforeEach(() => { setLimits({ maxPerTradeUsd: 1000, maxDailyLossUsd: 500, maxInFlightUsd: 2000 }); });
  it("미실현 손실만으로도 일일 한도에 걸린다", () => {
    setUnrealized({ pnlUsd: -450, lossUsd: 450, openNotionalUsd: 500, runsNotionalUsd: 500, positions: 1, unpriced: 0, at: Date.now() });
    expect(checkEntry(100)).toBeNull(); // 450 < 500
    setUnrealized({ pnlUsd: -520, lossUsd: 520, openNotionalUsd: 500, runsNotionalUsd: 500, positions: 1, unpriced: 0, at: Date.now() });
    expect(checkEntry(100)).toMatch(/미실현/);
  });
  it("낡은 스냅샷(5분 초과)은 무시한다 — 루프가 죽어도 영원히 막지 않게", () => {
    setUnrealized({ pnlUsd: -999, lossUsd: 999, openNotionalUsd: 0, runsNotionalUsd: 0, positions: 1, unpriced: 0, at: Date.now() - 6 * 60_000 });
    expect(checkEntry(100)).toBeNull();
  });
  it("상장 매수는 노출 한도도 본다", () => {
    setUnrealized({ pnlUsd: 0, lossUsd: 0, openNotionalUsd: 1950, runsNotionalUsd: 1950, positions: 1, unpriced: 0, at: Date.now() });
    expect(checkEntry(100)).toBeNull();
    expect(checkEntry(100, { listing: true })).toMatch(/노출/);
  });
});
