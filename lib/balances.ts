// Cross-venue balances / inventory. The bottari model keeps dry powder on BOTH
// sides (USDT on Binance, KRW on Upbit/Bithumb) and nets trades rather than
// transferring each time — so the key signal is the global-vs-KR capital skew.
//
// Signed reads (Binance HMAC, Upbit JWT) are FULLY WIRED but dormant: no keys
// → the venue reports connected:false ("키 필요"). With USE_MOCK on, a demo
// portfolio renders so the panel is usable pre-keys. Server-only (node crypto).
// TODO: Bithumb balance uses its v1 private HMAC-SHA512 signing — stubbed here.

import crypto from "crypto";
import type { CoinBal, Portfolio, VenueBalance } from "./types";
import { CONFIG } from "./config";
import { fetchWalletBalance, mockWalletBalance } from "./walletBalances";

const STABLE = new Set(["USDT", "USDC", "BUSD", "FDUSD", "DAI", "TUSD"]);

async function priceMap(): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  try {
    const r = await fetch("https://api.binance.com/api/v3/ticker/price", {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    const rows = (await r.json()) as Array<{ symbol: string; price: string }>;
    if (Array.isArray(rows)) {
      for (const x of rows) {
        if (x.symbol.endsWith("USDT")) m.set(x.symbol.slice(0, -4), Number(x.price));
      }
    }
  } catch {
    /* network */
  }
  return m;
}
const usdOf = (asset: string, amt: number, px: Map<string, number>) =>
  STABLE.has(asset) ? amt : (px.get(asset) ?? 0) * amt;

function b64url(b: Buffer | string) {
  return Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function upbitJwt(key: string, secret: string) {
  const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64url(JSON.stringify({ access_key: key, nonce: crypto.randomUUID() }));
  const s = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest();
  return `${h}.${p}.${b64url(s)}`;
}
const coinList = (coins: CoinBal[]) => coins.filter((c) => c.usdValue >= 1).sort((a, b) => b.usdValue - a.usdValue);

// ── Binance spot (+ futures USDT margin folded in) ────────────────────────────
async function binance(px: Map<string, number>): Promise<VenueBalance | null> {
  const key = process.env.BINANCE_KEY, secret = process.env.BINANCE_SECRET;
  if (!key || !secret) return null;
  try {
    const q = `recvWindow=5000&timestamp=${Date.now()}`;
    const sig = crypto.createHmac("sha256", secret).update(q).digest("hex");
    const r = await fetch(`https://api.binance.com/api/v3/account?${q}&signature=${sig}`, {
      headers: { "X-MBX-APIKEY": key }, cache: "no-store",
    });
    const j = (await r.json()) as { balances?: Array<{ asset: string; free: string; locked: string }> };
    if (!j.balances) return null;
    let cash = 0;
    const coins: CoinBal[] = [];
    for (const b of j.balances) {
      const amt = Number(b.free) + Number(b.locked);
      if (amt <= 0) continue;
      if (STABLE.has(b.asset)) cash += amt;
      else coins.push({ asset: b.asset, amount: amt, usdValue: usdOf(b.asset, amt, px) });
    }
    // Futures wallet USDT (hedge collateral) — best-effort.
    try {
      const q2 = `recvWindow=5000&timestamp=${Date.now()}`;
      const s2 = crypto.createHmac("sha256", secret).update(q2).digest("hex");
      const rf = await fetch(`https://fapi.binance.com/fapi/v2/balance?${q2}&signature=${s2}`, {
        headers: { "X-MBX-APIKEY": key }, cache: "no-store", signal: AbortSignal.timeout(5000),
      });
      const fj = (await rf.json()) as Array<{ asset: string; balance: string }>;
      if (Array.isArray(fj)) for (const f of fj) if (f.asset === "USDT") cash += Number(f.balance);
    } catch {
      /* futures optional */
    }
    const c = coinList(coins);
    return {
      venue: "binance", connected: true, cashLabel: "USDT",
      cashRaw: cash, cashUsd: cash, coins: c,
      totalUsd: cash + c.reduce((s, x) => s + x.usdValue, 0),
    };
  } catch {
    return null;
  }
}

// ── Upbit (JWT) ───────────────────────────────────────────────────────────────
async function upbit(px: Map<string, number>, usdKrw: number): Promise<VenueBalance | null> {
  const key = process.env.UPBIT_KEY, secret = process.env.UPBIT_SECRET;
  if (!key || !secret) return null;
  try {
    const r = await fetch("https://api.upbit.com/v1/accounts", {
      headers: { Authorization: `Bearer ${upbitJwt(key, secret)}` }, cache: "no-store",
    });
    const rows = (await r.json()) as Array<{ currency: string; balance: string; locked: string; avg_buy_price: string }>;
    if (!Array.isArray(rows)) return null;
    let cashKrw = 0;
    const coins: CoinBal[] = [];
    for (const a of rows) {
      const amt = Number(a.balance) + Number(a.locked);
      if (amt <= 0) continue;
      if (a.currency === "KRW") cashKrw += amt;
      else {
        // Value via global USDT price; fall back to Upbit avg buy price (KRW→USD).
        const usd = px.get(a.currency)
          ? px.get(a.currency)! * amt
          : (Number(a.avg_buy_price) * amt) / usdKrw;
        coins.push({ asset: a.currency, amount: amt, usdValue: usd });
      }
    }
    const c = coinList(coins);
    return {
      venue: "upbit", connected: true, cashLabel: "KRW",
      cashRaw: cashKrw, cashUsd: cashKrw / usdKrw, coins: c,
      totalUsd: cashKrw / usdKrw + c.reduce((s, x) => s + x.usdValue, 0),
    };
  } catch {
    return null;
  }
}

// Bithumb private balance = v1 HMAC-SHA512 signing. TODO: wire like transfers.
async function bithumb(): Promise<VenueBalance | null> {
  return null;
}

function disconnected(venue: VenueBalance["venue"], cashLabel: string): VenueBalance {
  return { venue, connected: false, cashLabel, cashRaw: 0, cashUsd: 0, coins: [], totalUsd: 0 };
}

async function liveUsdKrw(): Promise<number> {
  try {
    const r = await fetch("https://api.upbit.com/v1/ticker?markets=KRW-USDT", {
      cache: "no-store", signal: AbortSignal.timeout(4000),
    });
    const j = (await r.json()) as Array<{ trade_price: number }>;
    return j[0]?.trade_price ?? CONFIG.USD_KRW;
  } catch {
    return CONFIG.USD_KRW;
  }
}

export async function fetchPortfolio(): Promise<Portfolio> {
  const usdKrw = await liveUsdKrw();
  const px = await priceMap();
  const [bn, up, bt, wallet] = await Promise.all([
    binance(px), upbit(px, usdKrw), bithumb(), fetchWalletBalance(px),
  ]);

  const anyLive = !!(bn || up || bt || wallet);
  if (!anyLive && CONFIG.USE_MOCK) return mockPortfolio(usdKrw);

  const venues: VenueBalance[] = [
    bn ?? disconnected("binance", "USDT"),
    up ?? disconnected("upbit", "KRW"),
    bt ?? disconnected("bithumb", "KRW"),
  ];
  const globalUsd = venues.filter((v) => v.venue === "binance").reduce((s, v) => s + v.totalUsd, 0);
  const krUsd = venues.filter((v) => v.venue !== "binance").reduce((s, v) => s + v.totalUsd, 0);
  const walletUsd = wallet?.totalUsd ?? 0;
  const exch = globalUsd + krUsd;
  return {
    venues, wallet: wallet ?? undefined,
    globalUsd, krUsd, totalUsd: exch + walletUsd,
    skewPct: exch > 0 ? (globalUsd / exch) * 100 : 50, // exchange skew (wallet = in-transit, excluded)
    usdKrw, mock: false,
  };
}

// Demo portfolio so the panel is meaningful before keys are added.
function mockPortfolio(usdKrw: number): Portfolio {
  const bnCoins: CoinBal[] = [
    { asset: "BTC", amount: 0.05, usdValue: 3200 },
    { asset: "XRP", amount: 4000, usdValue: 9640 },
  ];
  const upCoins: CoinBal[] = [{ asset: "SOL", amount: 22, usdValue: 3740 }];
  const bn: VenueBalance = {
    venue: "binance", connected: true, cashLabel: "USDT",
    cashRaw: 12400, cashUsd: 12400, coins: bnCoins,
    totalUsd: 12400 + bnCoins.reduce((s, c) => s + c.usdValue, 0),
  };
  const upKrw = 7_800_000;
  const up: VenueBalance = {
    venue: "upbit", connected: true, cashLabel: "KRW",
    cashRaw: upKrw, cashUsd: upKrw / usdKrw, coins: upCoins,
    totalUsd: upKrw / usdKrw + upCoins.reduce((s, c) => s + c.usdValue, 0),
  };
  const btKrw = 2_600_000;
  const bt: VenueBalance = {
    venue: "bithumb", connected: true, cashLabel: "KRW",
    cashRaw: btKrw, cashUsd: btKrw / usdKrw, coins: [],
    totalUsd: btKrw / usdKrw,
  };
  const wallet = mockWalletBalance();
  const globalUsd = bn.totalUsd;
  const krUsd = up.totalUsd + bt.totalUsd;
  const exch = globalUsd + krUsd;
  return {
    venues: [bn, up, bt], wallet,
    globalUsd, krUsd, totalUsd: exch + wallet.totalUsd,
    skewPct: (globalUsd / exch) * 100, usdKrw, mock: true,
  };
}
