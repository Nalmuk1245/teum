// 보드 산식 — 유동성 한도와 제외 목록.
//
// notionalCapUsd가 null이던 시절에는 $100이든 $50,000이든 보드 net이 같아
// 보였다. 그리고 EXCLUDE에 빠진 스테이블은 디페그를 "김프"로 올려보낸다.
// 둘 다 조용히 틀리는 종류라 테스트로 못을 박는다.

import { describe, it, expect } from "vitest";
import { CONFIG } from "@/lib/config";
import { topOfBookCapUsdForTest as cap } from "@/lib/strategies";

describe("topOfBookCapUsd", () => {
  it("두 다리 중 작은 쪽이 한도다", () => {
    // 매수: ask 2.0 × 100개 = $200 / 매도: bid 2.1 × 1000개 = $2100
    expect(cap({ ask: 2, askSize: 100 }, { bid: 2.1, bidSize: 1000 })).toBeCloseTo(200);
    expect(cap({ ask: 2, askSize: 1000 }, { bid: 2.1, bidSize: 100 })).toBeCloseTo(210);
  });

  it("호가통화가 원화면 환산해서 비교한다", () => {
    // KR 매도 다리: 1400원 × 10개 = 14,000원, fx 1400 → $10
    expect(cap({ ask: 1, askSize: 1000 }, { bid: 1400, bidSize: 10 }, 1, 1400)).toBeCloseTo(10);
  });

  it("물량을 모르면 null — 모르는 걸 큰 값으로 꾸미지 않는다", () => {
    expect(cap({ ask: 2 }, { bid: 2.1, bidSize: 100 })).toBeNull();
    expect(cap({ ask: 2, askSize: 100 }, { bid: 2.1 })).toBeNull();
    expect(cap(undefined, { bid: 2.1, bidSize: 100 })).toBeNull();
  });

  it("0 물량은 한도가 아니라 미상이다", () => {
    expect(cap({ ask: 2, askSize: 0 }, { bid: 2.1, bidSize: 100 })).toBeNull();
  });
});

describe("EXCLUDE", () => {
  it("주요 스테이블이 전부 제외돼 있다 — 스테이블 프리미엄은 엣지가 아니라 디페그다", () => {
    for (const s of ["USDT", "USDC", "DAI", "USDE", "USD1", "USDS", "PYUSD", "RLUSD"]) {
      expect(CONFIG.EXCLUDE.has(s)).toBe(true);
    }
  });

  it("래핑 자산도 제외돼 있다 — 같은 자산의 두 표현 사이 가격차는 arb가 아니다", () => {
    for (const s of ["WBTC", "WETH", "STETH"]) {
      expect(CONFIG.EXCLUDE.has(s)).toBe(true);
    }
  });

  it("진짜 거래 대상은 제외되지 않았다", () => {
    for (const s of ["BTC", "ETH", "XRP", "SOL"]) {
      expect(CONFIG.EXCLUDE.has(s)).toBe(false);
    }
  });
});
