// 티커 충돌 방어 — 상장따리 자동매수가 엉뚱한 토큰을 사지 않게.

import { describe, it, expect } from "vitest";
import { priceConsensus } from "@/lib/priceConsensus";

describe("priceConsensus", () => {
  it("LIT 사례 — 바이낸스만 튀면 바이낸스가 의심, 바이비트·OKX가 합의", () => {
    const c = priceConsensus([{ venue: "binance", price: 0.743 }, { venue: "bybit", price: 5.154 }, { venue: "okx", price: 5.1558 }]);
    expect(c.agreed).toEqual(["bybit", "okx"]);
    expect(c.outliers).toEqual(["binance"]);
    expect(c.ambiguous).toBe(false);
  });
  it("모두 가까우면 전부 합의 (상장 펌프로 20% 벌어진 것도 같은 토큰)", () => {
    const c = priceConsensus([{ venue: "binance", price: 1.0 }, { venue: "bybit", price: 1.2 }, { venue: "okx", price: 1.1 }]);
    expect(c.agreed).toEqual(["binance", "bybit", "okx"]);
    expect(c.outliers).toEqual([]);
  });
  it("둘뿐인데 서로 다르면 판단 불가 — 무인 매수 금지 신호", () => {
    const c = priceConsensus([{ venue: "binance", price: 0.74 }, { venue: "bybit", price: 5.15 }]);
    expect(c.ambiguous).toBe(true);
    expect(c.agreed).toEqual([]);
  });
  it("한 곳뿐이면 대조 불가로 표시하고 그대로 쓴다", () => {
    const c = priceConsensus([{ venue: "okx", price: 3 }]);
    expect(c.single).toBe(true);
    expect(c.agreed).toEqual(["okx"]);
  });
  it("0·비정상 가격은 무시", () => {
    const c = priceConsensus([{ venue: "binance", price: 0 }, { venue: "bybit", price: NaN }, { venue: "okx", price: 2 }]);
    expect(c.single).toBe(true);
    expect(c.agreed).toEqual(["okx"]);
  });
});
