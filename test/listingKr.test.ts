// 상장 국내 매도 경로 — 합성 기회 모양과 매도 승인 판단.

import { describe, it, expect } from "vitest";
import { buildListingOpp, shouldReleaseSell } from "@/lib/listingKr";

describe("buildListingOpp", () => {
  it("해외 매수 → 국내 매도 김프 기회, listingRun 표시, 국내 가격은 0(개장 전)", () => {
    const o = buildListingOpp({ base: "NEW", krVenue: "upbit", globalVenue: "bybit", globalPrice: 1.23, announcedAt: 1, hasPerp: false });
    expect(o.kind).toBe("kimchi");
    expect(o.legs.map((l) => [l.side, l.venue, l.symbol])).toEqual([["buy", "bybit", "NEWUSDT"], ["sell", "upbit", "KRW-NEW"]]);
    expect(o.listingRun).toEqual({ krVenue: "upbit", announcedAt: 1 });
    expect(o.legs[1].price).toBe(0);
    expect(o.transfer?.withdraw.enabled).toBeNull(); // 키 없음 = 미확인
  });
  it("빗썸·OKX 심볼 형식", () => {
    const o = buildListingOpp({ base: "NEW", krVenue: "bithumb", globalVenue: "okx", globalPrice: 1, announcedAt: 1, hasPerp: true });
    expect(o.legs.map((l) => l.symbol)).toEqual(["NEW-USDT", "NEW_KRW"]);
    expect(o.hasPerp).toBe(true);
  });
});

describe("shouldReleaseSell", () => {
  it("개장됐고 매도 직전에 멈춰 있을 때만, 한 번만", () => {
    expect(shouldReleaseSell({ opened: true, phase: "paused", pausedStepId: "sell" })).toBe(true);
    expect(shouldReleaseSell({ opened: false, phase: "paused", pausedStepId: "sell" })).toBe(false);
    expect(shouldReleaseSell({ opened: true, phase: "running", pausedStepId: "sell" })).toBe(false); // 아직 입금 중
    expect(shouldReleaseSell({ opened: true, phase: "paused", pausedStepId: "withdraw" })).toBe(false);
    expect(shouldReleaseSell({ opened: true, released: true, phase: "paused", pausedStepId: "sell" })).toBe(false);
  });
});
