// 백테스트 규칙 — 진입(지속 조건)·청산(ETA 후 순수익)·규모 상한.

import { describe, it, expect } from "vitest";
import { simulateOne, runBacktest, type BtEpisode, type BtParams } from "@/lib/backtest";

const MIN = 60_000;
const ep = (curve: [number, number][], o: Partial<BtEpisode> = {}): BtEpisode => ({
  kind: "kimchi", base: "A", buy: "binance", sell: "upbit", startTs: curve[0]?.[0] ?? 0, endTs: curve[curve.length - 1]?.[0] ?? 0,
  curve, capUsd: null, etaMin: 5, executable: true, ...o,
});
const p: BtParams = { minNet: 1, minHeldSec: 60, sizeUsd: 1000, kinds: ["kimchi"], executableOnly: false };

describe("simulateOne", () => {
  it("기준 이상이 minHeld 동안 이어진 순간 진입, ETA 뒤 순수익으로 청산", () => {
    const t = simulateOne(ep([[0, 1.2], [30_000, 1.5], [60_000, 1.4], [6 * MIN, 0.8], [7 * MIN, 0.2]]), p)!;
    expect(t.entryTs).toBe(60_000);
    expect(t.entryNet).toBe(1.4);
    expect(t.exitNet).toBe(0.8); // 1분 + 5분 = 6분 시점
    expect(t.profitUsd).toBe(8);
    expect(t.estimated).toBe(false);
  });
  it("중간에 기준 아래로 떨어지면 지속 시간이 다시 0부터", () => {
    expect(simulateOne(ep([[0, 1.2], [40_000, 0.5], [80_000, 1.2], [120_000, 1.3]]), p)).toBeNull();
  });
  it("도착 시점이 곡선 밖이면 마지막 값으로 추정 표시", () => {
    const t = simulateOne(ep([[0, 2], [60_000, 2], [120_000, -0.1]]), p)!;
    expect(t.exitNet).toBe(-0.1);
    expect(t.estimated).toBe(true);
  });
  it("규모는 잡을 수 있던 한도로 자른다", () => {
    const t = simulateOne(ep([[0, 2], [60_000, 2], [6 * MIN, 2]], { capUsd: 150 }), p)!;
    expect(t.sizeUsd).toBe(150);
    expect(t.profitUsd).toBe(3);
  });
});

describe("runBacktest", () => {
  it("전략·실행가능 필터와 집계", () => {
    const eps = [
      ep([[0, 2], [60_000, 2], [6 * MIN, 1]]),
      ep([[0, 2], [60_000, 2], [6 * MIN, -1]], { base: "B" }),
      ep([[0, 5], [60_000, 5], [6 * MIN, 5]], { kind: "cex-dex" }),
      ep([[0, 5], [60_000, 5], [6 * MIN, 5]], { base: "C", executable: false }),
    ];
    const r = runBacktest(eps, { ...p, executableOnly: true });
    expect(r.eligible).toBe(2);
    expect(r.trades).toBe(2);
    expect(r.wins).toBe(1);
    expect(r.totalUsd).toBe(0); // +10 −10
    expect(r.byKind.kimchi.trades).toBe(2);
  });
});

describe("대형 갭 제외", () => {
  it("진입 순수익이 기준 이상이면 거래로 치지 않고 excluded로 센다", () => {
    const eps = [ep([[0, 30], [60_000, 30], [6 * MIN, 30]]), ep([[0, 2], [60_000, 2], [6 * MIN, 1]], { base: "B" })];
    const r = runBacktest(eps, { ...p, excludeAbovePct: 10 });
    expect(r.trades).toBe(1);
    expect(r.excluded).toBe(1);
  });
});

import { sweep } from "@/lib/backtest";
describe("sweep", () => {
  it("격자 전체를 돌리고, 20건 미만 칸은 추천하지 않는다", () => {
    const eps = [ep([[0, 2], [60_000, 2], [6 * MIN, 1]])];
    const r = sweep(eps, { sizeUsd: 100, kinds: ["kimchi"], executableOnly: false });
    expect(r.cells.length).toBe(35);
    expect(r.best).toBeNull();
  });
  it("지속 0초·중앙 청산 ≤0 칸은 추천하지 않는다", () => {
    // 25건: 0초 지속이면 진입(청산 −0.1), 30초 이상 지속은 못 채움 → 추천 없음
    const eps = Array.from({ length: 25 }, (_, i) => ep([[0, 2], [6 * MIN, -0.1]], { base: `B${i}` }));
    expect(sweep(eps, { sizeUsd: 100, kinds: ["kimchi"], executableOnly: false }).best).toBeNull();
    const good = Array.from({ length: 25 }, (_, i) => ep([[0, 2], [60_000, 2], [7 * MIN, 0.5]], { base: `G${i}` }));
    const b = sweep(good, { sizeUsd: 100, kinds: ["kimchi"], executableOnly: false }).best!;
    expect(b.minHeldSec).toBeGreaterThan(0);
  });
});
