// 주문 rate limiter — 거절 주문도 abuse로 세는 거래소에서 IP가 정지되면
// arb 중 좌초다. 버킷이 실제로 페이싱을 하는지, 그리고 **모든 거래소가 버킷을
// 가지는지**(빠진 거래소는 무제한이 된다)를 확인한다.

import { describe, it, expect } from "vitest";
import { acquireOrderSlot } from "@/lib/rateLimiter";

describe("acquireOrderSlot", () => {
  it("버스트 안에서는 즉시 통과한다", async () => {
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) expect(await acquireOrderSlot("binance")).toBe(true);
    expect(Date.now() - t0).toBeLessThan(300); // 대기 없이
  });

  it("버스트를 넘으면 대기시킨다 — 통과는 하되 즉시는 아니다", async () => {
    // 알려지지 않은 거래소는 기본 3/s 버킷으로 떨어진다.
    const venue = "testvenue";
    for (let i = 0; i < 3; i++) await acquireOrderSlot(venue);
    const t0 = Date.now();
    expect(await acquireOrderSlot(venue)).toBe(true);
    expect(Date.now() - t0).toBeGreaterThan(100); // 토큰이 찰 때까지 기다렸다
  });

  it("설정된 거래소 전부에 버킷이 있다", async () => {
    // 여기 빠진 거래소는 페이싱 없이 주문을 쏜다. bybit/okx가 실제로 빠져
    // 있었고, 선물(binancePerp)은 현물과 같은 binance 버킷을 공유해야 한다.
    for (const v of ["binance", "upbit", "bithumb", "bybit", "okx"]) {
      expect(await acquireOrderSlot(v)).toBe(true);
    }
  });
});
