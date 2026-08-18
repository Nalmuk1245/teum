// 실행 플랜 — 비가역 경계와 확인 정지 지점.
//
// 여기서 지키는 불변식: **비가역 경계는 단계 이름이 아니라 `irreversible`
// 플래그에서 나온다.** 예전엔 `findIndex(s => s.id === "withdraw")`로 찾았는데,
// withdraw가 없는 cex-dex buyDex 플랜에서 -1이 나와 롤백과 확인 정지가 통째로
// 새는 구멍이 있었다. 그 회귀를 코드가 아니라 테스트가 막게 한다.

import { describe, it, expect } from "vitest";
import { buildPlan, firstIrreversibleIdx, needsConfirmBeforePublic, REVALIDATE_STEPS } from "@/lib/execPlan";
import type { Opportunity } from "@/lib/types";

const opp = (over: Partial<Opportunity>): Opportunity => ({
  id: "t", kind: "kimchi", base: "XRP",
  legs: [
    { venue: "binance", side: "buy", symbol: "XRPUSDT", price: 1, quote: "USDT" },
    { venue: "upbit", side: "sell", symbol: "KRW-XRP", price: 1400, quote: "KRW" },
  ],
  grossPct: 1, costPct: 0.5, netPct: 0.5,
  notionalCapUsd: null, executable: true, ts: Date.now(),
  ...over,
} as Opportunity);

describe("buildPlan", () => {
  it("김프 플랜에 매수·매도·정산이 있다", () => {
    const ids = buildPlan(opp({}), false).map((s) => s.id);
    expect(ids).toContain("buy");
    expect(ids).toContain("sell");
    expect(ids).toContain("settle");
  });

  it("헷지를 켜면 숏과 청산이 짝으로 들어간다 — 한쪽만 있으면 네이키드다", () => {
    const ids = buildPlan(opp({}), true).map((s) => s.id);
    expect(ids).toContain("hedge");
    expect(ids).toContain("close");
    expect(ids.indexOf("hedge")).toBeLessThan(ids.indexOf("close"));
  });

  it("헷지를 끄면 숏도 청산도 없다", () => {
    const ids = buildPlan(opp({}), false).map((s) => s.id);
    expect(ids).not.toContain("hedge");
    expect(ids).not.toContain("close");
  });

  it("매수는 비가역 단계보다 앞에 온다 — 롤백할 구간이 존재해야 한다", () => {
    const plan = buildPlan(opp({}), true);
    const irr = firstIrreversibleIdx(plan);
    expect(irr).toBeGreaterThan(0);
    expect(plan.findIndex((s) => s.id === "buy")).toBeLessThan(irr);
  });
});

describe("비가역 경계", () => {
  it("모든 플랜에 비가역 단계가 정확히 표시돼 있다", () => {
    for (const hedge of [false, true]) {
      const plan = buildPlan(opp({}), hedge);
      expect(firstIrreversibleIdx(plan)).toBeGreaterThanOrEqual(0);
    }
  });

  it("비가역 단계가 없는 플랜에는 -1을 준다 (매직 인덱스 금지)", () => {
    expect(firstIrreversibleIdx([{ id: "buy", label: "", desc: "" }])).toBe(-1);
  });
});

describe("needsConfirmBefore", () => {
  const irr = { id: "withdraw" as const, label: "", desc: "", irreversible: true };
  const rev = { id: "buy" as const, label: "", desc: "" };

  it("manual은 모든 단계에서 멈춘다", () => {
    expect(needsConfirmBeforePublic(rev, "manual")).toBe(true);
    expect(needsConfirmBeforePublic(irr, "manual")).toBe(true);
  });

  it("auto는 어디서도 안 멈춘다", () => {
    expect(needsConfirmBeforePublic(irr, "auto")).toBe(false);
  });

  it("beforeWithdraw는 이름이 아니라 irreversible 플래그를 본다", () => {
    // 이름이 withdraw가 아니어도 비가역이면 멈춰야 한다 (cex-dex의 transfer/swap).
    const dexIrr = { id: "transfer" as const, label: "", desc: "", irreversible: true };
    expect(needsConfirmBeforePublic(dexIrr, "beforeWithdraw")).toBe(true);
    expect(needsConfirmBeforePublic(rev, "beforeWithdraw")).toBe(false);
  });

  it("beforeSell은 매도 직전에만 멈춘다", () => {
    expect(needsConfirmBeforePublic({ id: "sell", label: "", desc: "" }, "beforeSell")).toBe(true);
    expect(needsConfirmBeforePublic(irr, "beforeSell")).toBe(false);
  });
});

describe("REVALIDATE_STEPS", () => {
  it("자금이 나가는 모든 진입점이 재견적 대상이다", () => {
    for (const s of ["buy", "withdraw", "sell", "swap", "transfer"] as const) {
      expect(REVALIDATE_STEPS.has(s)).toBe(true);
    }
  });

  it("도착 확인·정산은 재견적 대상이 아니다 (엣지 판단이 필요 없다)", () => {
    for (const s of ["deposit", "recv", "settle"] as const) {
      expect(REVALIDATE_STEPS.has(s)).toBe(false);
    }
  });
});
