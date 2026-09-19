// 김프 조합 선택 — 게이트를 먼저 본다.
//
// "빗썸 +4% (입금 닫힘) / 업비트 +1.2% (열림)"에서 예전엔 빗썸 하나만 뽑혀 🔒로
// 내려가고 업비트 경로는 사라졌다. 이제 메인은 열린 업비트, 닫힌 빗썸은 별도 행.

import { describe, it, expect } from "vitest";
import { STRATEGIES } from "@/lib/strategies";
import type { ScanContext, TickerMap, WalletStatus } from "@/lib/types";

const kimchi = STRATEGIES.find((s) => s.kind === "kimchi")!;
const FX = 1400;
const tick = (price: number, quote: "KRW" | "USDT", vol: number) =>
  ({ price, quote, quoteVolumeUsd: vol, bid: price * 0.999, ask: price * 1.001, bidSize: 1000, askSize: 1000 });

function ctxWith(gates: { bithumb: WalletStatus; upbit: WalletStatus; binance: WalletStatus }): ScanContext {
  const usd = 1.0; // 글로벌 $1
  const bithumb: TickerMap = new Map([["XYZ", tick(usd * FX * 1.06, "KRW", 5e9)], ["USDT", tick(FX, "KRW", 5e9)]]); // +6% 프리미엄
  const upbit: TickerMap = new Map([["XYZ", tick(usd * FX * 1.03, "KRW", 5e9)], ["USDT", tick(FX, "KRW", 5e9)]]);   // +3%
  const binance: TickerMap = new Map([["XYZ", tick(usd, "USDT", 1e8)]]);
  return {
    tickers: { bithumb, upbit, binance },
    usdKrw: FX, fxLive: true,
    transfers: { byVenue: {
      bithumb: new Map([["XYZ", gates.bithumb]]),
      upbit: new Map([["XYZ", gates.upbit]]),
      binance: new Map([["XYZ", gates.binance]]),
    } },
  };
}
const open = { deposit: true, withdraw: true };

describe("kimchi — 게이트 우선 조합 선택", () => {
  it("빗썸이 더 커도 입금이 닫혀 있으면 열린 업비트가 메인, 빗썸은 🔒 별도 행", async () => {
    const opps = await kimchi.scan(ctxWith({ bithumb: { deposit: false, withdraw: true }, upbit: open, binance: open }));
    const rows = opps.filter((o) => o.base === "XYZ");
    expect(rows.length).toBe(2);
    const main = rows.find((o) => o.id === "kimchi:XYZ")!;
    const locked = rows.find((o) => o.id === "kimchi:XYZ:locked")!;
    expect(main.legs.find((l) => l.side === "sell")!.venue).toBe("upbit");
    expect(main.transfer!.blocked).toBe(false);
    expect(main.executable).toBe(true);
    expect(locked.legs.find((l) => l.side === "sell")!.venue).toBe("bithumb");
    expect(locked.transfer!.blocked).toBe(true);
    expect(locked.executable).toBe(false);
    expect(locked.netPct).toBeGreaterThan(main.netPct);
    expect(main.note).toMatch(/Bithumb/);
    expect(locked.note).toMatch(/닫힘/);
  });

  it("둘 다 열려 있으면 순수익 큰 빗썸이 메인이고 별도 행은 없다", async () => {
    const opps = await kimchi.scan(ctxWith({ bithumb: open, upbit: open, binance: open }));
    const rows = opps.filter((o) => o.base === "XYZ");
    expect(rows.length).toBe(1);
    expect(rows[0].legs.find((l) => l.side === "sell")!.venue).toBe("bithumb");
    expect(rows[0].id).toBe("kimchi:XYZ");
  });

  it("전부 닫혀 있으면 메인 하나만 닫힘으로 남고 별도 행은 없다", async () => {
    const closed = { deposit: false, withdraw: true };
    const opps = await kimchi.scan(ctxWith({ bithumb: closed, upbit: closed, binance: open }));
    const rows = opps.filter((o) => o.base === "XYZ");
    expect(rows.length).toBe(1);
    expect(rows[0].transfer!.blocked).toBe(true);
    expect(rows[0].legs.find((l) => l.side === "sell")!.venue).toBe("bithumb"); // 닫힌 것끼리는 순수익 순
  });

  it("미확인(키 없음)은 열림 다음, 닫힘보다 앞", async () => {
    const opps = await kimchi.scan(ctxWith({ bithumb: { deposit: false, withdraw: true }, upbit: open, binance: open }));
    // 업비트 게이트를 통째로 모르게 만들면 (byVenue에서 제거) 미확인이 메인
    const ctx = ctxWith({ bithumb: { deposit: false, withdraw: true }, upbit: open, binance: open });
    delete ctx.transfers!.byVenue.upbit;
    const opps2 = await kimchi.scan(ctx);
    const main = opps2.find((o) => o.id === "kimchi:XYZ")!;
    expect(main.legs.find((l) => l.side === "sell")!.venue).toBe("upbit");
    expect(main.transfer!.deposit.enabled).toBeNull();
    expect(opps.length).toBeGreaterThan(0);
  });
});
