// 깊이 사다리 + 게이트 분류 — 보드가 "잡을 수 있는 돈"과 "지금 잡을 수 있나"를
// 정직하게 말하게 하는 두 순수 함수.

import { describe, it, expect } from "vitest";
import { ladderFromBooks } from "@/lib/quote";
import { classifyGate, isLocked, SUSPECT_GROSS_PCT, SUSPECT_HELD_SEC } from "@/lib/gateState";
import type { TransferGate } from "@/lib/types";

describe("ladderFromBooks", () => {
  it("칸마다 순수익을 구해 0 위인 칸까지 규모·이익을 누적한다", () => {
    // 매수 100에 10개, 101에 10개 / 매도 106에 5개, 103에 10개, 100.5에 100개. 비용 1%.
    const asks = [{ priceUsd: 100, size: 10 }, { priceUsd: 101, size: 10 }];
    const bids = [{ priceUsd: 106, size: 5 }, { priceUsd: 103, size: 10 }, { priceUsd: 100.5, size: 100 }];
    const d = ladderFromBooks(asks, bids, 1);
    // 칸1: 5개 @100→106 = +6%−1 = 5% ($500) / 칸2: 5개 @100→103 = 3%−1 = 2% ($500)
    // 칸3: 5개 @101→103 = 1.98%−1 = 0.98% ($505) / 칸4: 101→100.5 = 음수 → 중단
    expect(d.maxSizeUsd).toBe(1505);
    const size = (t: number) => d.tiers.find((x) => x.minNet === t)!.sizeUsd;
    expect(size(5)).toBe(500);
    expect(size(3)).toBe(500);
    expect(size(1)).toBe(1000);
    expect(size(0)).toBe(1505);
    expect(d.profitUsd).toBeCloseTo(500 * 0.05 + 500 * 0.02 + 505 * 0.0098, 0);
  });

  it("최우선호가부터 적자면 규모 0, 이익 0", () => {
    const d = ladderFromBooks([{ priceUsd: 100, size: 10 }], [{ priceUsd: 100.5, size: 10 }], 1);
    expect(d.maxSizeUsd).toBe(0);
    expect(d.profitUsd).toBe(0);
    expect(d.tiers.every((t) => t.sizeUsd === 0)).toBe(true);
  });

  it("한쪽 호가가 비면 0 (없는 유동성을 만들지 않는다)", () => {
    expect(ladderFromBooks([], [{ priceUsd: 110, size: 1 }], 0).maxSizeUsd).toBe(0);
    expect(ladderFromBooks([{ priceUsd: 100, size: 1 }], [], 0).maxSizeUsd).toBe(0);
  });
});

describe("classifyGate", () => {
  const gate = (w: boolean | null, d: boolean | null, blocked = false): TransferGate =>
    ({ withdraw: { venue: "binance", enabled: w }, deposit: { venue: "upbit", enabled: d }, etaMin: 5, blocked });

  it("양쪽 확인된 열림만 open", () => {
    expect(classifyGate({ transfer: gate(true, true), grossPct: 1 })).toBe("open");
    expect(classifyGate({ transfer: gate(true, null), grossPct: 1 })).toBe("unknown");
  });
  it("확인된 정지는 closed", () => {
    expect(classifyGate({ transfer: gate(false, true, true), grossPct: 30 })).toBe("closed");
  });
  it("확인은 안 됐지만 큰 갭이 오래 버티면 suspect — 지속되는 대형 김프는 대개 입금 정지다", () => {
    const p = { heldSec: SUSPECT_HELD_SEC, hitRatePct: 100, samples: 100, volPctPerMin: 0, jumpPct: 0 };
    expect(classifyGate({ transfer: gate(null, null), grossPct: SUSPECT_GROSS_PCT, persistence: p })).toBe("suspect");
    // 갭이 작거나 짧으면 그냥 unknown
    expect(classifyGate({ transfer: gate(null, null), grossPct: 2, persistence: p })).toBe("unknown");
    expect(classifyGate({ transfer: gate(null, null), grossPct: 49, persistence: { ...p, heldSec: 60 } })).toBe("unknown");
  });
  it("전송 게이트 자체가 없으면 unknown", () => {
    expect(classifyGate({ grossPct: 49 })).toBe("unknown");
  });
  it("isLocked는 closed·suspect만", () => {
    expect(isLocked("closed")).toBe(true); expect(isLocked("suspect")).toBe(true);
    expect(isLocked("open")).toBe(false); expect(isLocked("unknown")).toBe(false); expect(isLocked(undefined)).toBe(false);
  });
});
