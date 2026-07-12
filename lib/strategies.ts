// Arbitrage strategies. Each implements the same Strategy interface; the scanner
// runs them all over a shared ScanContext and merges the results.
//
// Only `kimchi` carries real logic today. The other three are structural stubs
// that document their data source and return [] (plus mock samples via the
// scanner when USE_MOCK is on).

import type { Opportunity, ScanContext, StrategyKind, TransferGate, Venue } from "./types";
import {
  CONFIG, FEES, NETWORK_PCT, NETWORK_PCT_DEFAULT,
  TRANSFER_ETA_MIN, TRANSFER_ETA_DEFAULT_MIN,
  COIN_NETWORK, COIN_NETWORK_DEFAULT,
} from "./config";
import { walletStatus } from "./transfers";

export interface Strategy {
  kind: StrategyKind;
  label: string;
  scan(ctx: ScanContext): Promise<Opportunity[]>;
}

const now = () => Date.now();
const id = (kind: string, base: string) => `${kind}:${base}`;

// Top-of-book spread as % of mid — a freshness/thinness signal. A wide spread
// means the last price is unreliable (stale/illiquid). 0 when book is missing
// (don't gate on absent data; liquid venues always have a book here).
function spreadPct(t: { bid?: number; ask?: number }): number {
  if (!t.bid || !t.ask || t.ask <= 0) return 0;
  return ((t.ask - t.bid) / ((t.ask + t.bid) / 2)) * 100;
}

// KR venues evaluated for kimchi, best-net wins per coin.
const KR_VENUES: Venue[] = ["upbit", "bithumb"];

const krSymbol = (venue: Venue, base: string) =>
  venue === "upbit" ? `KRW-${base}` : `${base}_KRW`;

// Global venues eligible as the kimchi USDT leg (best-net wins per coin).
const GLOBAL_VENUES: Venue[] = ["binance", "bybit", "okx"];
const globalSymbol = (venue: Venue, base: string) =>
  venue === "okx" ? `${base}-USDT` : `${base}USDT`;

// Structured, per-coin/per-venue round-trip cost — replaces the flat number.
function kimchiCostPct(base: string, globalVenue: Venue, krVenue: Venue): number {
  const globalFee = FEES.takerPct[globalVenue] ?? 0.1;
  const krFee = FEES.takerPct[krVenue] ?? 0.05;
  const network = NETWORK_PCT[base] ?? NETWORK_PCT_DEFAULT;
  return globalFee + krFee + network + FEES.fxSpreadPct + FEES.slippagePct;
}

// ── KIMCHI — KR won premium vs global USDT ─────────────────────────────────────
// Best combo of (Upbit|Bithumb) × (Binance|Bybit|OKX) per coin. The hedge is
// still the Binance USDT-M perp regardless of which global venue holds the spot
// leg — it's a price hedge, not an inventory hedge.
const kimchi: Strategy = {
  kind: "kimchi",
  label: "KIMCHI",
  async scan(ctx) {
    // Union of coins listed on any KR venue.
    const bases = new Set<string>();
    for (const v of KR_VENUES) {
      const m = ctx.tickers[v];
      if (m) for (const b of m.keys()) bases.add(b);
    }

    const out: Opportunity[] = [];
    for (const base of bases) {
      if (CONFIG.EXCLUDE.has(base)) continue;

      // Evaluate every KR × global combo; keep the best net edge. Prices are the
      // EXECUTABLE top-of-book (buy at ask, sell at bid) — not the optimistic
      // last trade — so the board net reflects what you'd actually capture.
      let best:
        | { kv: Venue; gv: Venue; krPrice: number; gPrice: number; premiumPct: number; cost: number; net: number; execGross: number }
        | null = null;
      for (const kv of KR_VENUES) {
        const km = ctx.tickers[kv];
        const kr = km?.get(base);
        if (!kr) continue;
        // KR-leg liquidity gate — quoteVolumeUsd holds KRW for KR venues.
        if (kr.quoteVolumeUsd < CONFIG.MIN_KR_VOLUME_KRW) continue;
        if (spreadPct(kr) > CONFIG.MAX_SPREAD_PCT) continue; // thin/stale KR book
        // Per-venue USDT/KRW; a live cross-venue rate is acceptable, but a bank
        // fallback rate fabricates 1-3% premiums — skip rather than mislead.
        const fx = km?.get("USDT")?.price ?? (ctx.fxLive ? ctx.usdKrw : null);
        if (!fx) continue;
        for (const gv of GLOBAL_VENUES) {
          const g = ctx.tickers[gv]?.get(base);
          if (!g || !g.price) continue;
          if (g.quoteVolumeUsd < CONFIG.MIN_VOLUME_USD) continue;
          if (spreadPct(g) > CONFIG.MAX_SPREAD_PCT) continue; // thin/stale global book
          const midPremium = ((kr.price / fx - g.price) / g.price) * 100;
          if (Math.abs(midPremium) > CONFIG.MAX_ABS_PREMIUM_PCT) continue; // bad data
          // Executable gross: cross both spreads in the profitable direction.
          const gAsk = g.ask ?? g.price, gBid = g.bid ?? g.price;
          const kAsk = kr.ask ?? kr.price, kBid = kr.bid ?? kr.price;
          const execGross = midPremium >= 0
            ? ((kBid / fx - gAsk) / gAsk) * 100      // buy global ask → sell KR bid
            : ((gBid - kAsk / fx) / (kAsk / fx)) * 100; // buy KR ask → sell global bid
          const cost = kimchiCostPct(base, gv, kv);
          const net = execGross - cost;
          if (!best || net > best.net)
            best = { kv, gv, krPrice: kr.price, gPrice: g.price, premiumPct: midPremium, cost, net, execGross };
        }
      }
      if (!best) continue;
      const execGross = best.execGross;

      const buyGlobal = best.premiumPct >= 0; // KR expensive → buy global, sell KR

      // Settlement gate: you WITHDRAW the coin from the buy venue and DEPOSIT it
      // to the sell venue. If either is disabled, the edge can't be captured.
      const buyVenue: Venue = buyGlobal ? best.gv : best.kv;
      const sellVenue: Venue = buyGlobal ? best.kv : best.gv;
      const wStat = walletStatus(ctx.transfers, buyVenue, base);
      const dStat = walletStatus(ctx.transfers, sellVenue, base);
      const transfer: TransferGate = {
        withdraw: { venue: buyVenue, enabled: wStat ? wStat.withdraw : null },
        deposit: { venue: sellVenue, enabled: dStat ? dStat.deposit : null },
        etaMin: TRANSFER_ETA_MIN[base] ?? TRANSFER_ETA_DEFAULT_MIN,
        blocked: false,
        network: COIN_NETWORK[base] ?? COIN_NETWORK_DEFAULT,
      };
      transfer.blocked =
        transfer.withdraw.enabled === false || transfer.deposit.enabled === false;

      const gLeg = { venue: best.gv, symbol: globalSymbol(best.gv, base), price: best.gPrice, quote: "USDT" as const };
      const kLeg = { venue: best.kv, symbol: krSymbol(best.kv, base), price: best.krPrice, quote: "KRW" as const };
      out.push({
        id: id("kimchi", base),
        kind: "kimchi",
        base,
        legs: buyGlobal
          ? [{ ...gLeg, side: "buy" }, { ...kLeg, side: "sell" }]
          : [{ ...kLeg, side: "buy" }, { ...gLeg, side: "sell" }],
        grossPct: execGross, // executable (spread-crossed), not mid-price
        costPct: best.cost,
        netPct: best.net,
        notionalCapUsd: null, // TODO: from order-book depth
        executable: best.net > 0 && !transfer.blocked,
        transfer,
        ts: now(),
      });
    }
    return out;
  },
};

// ── CROSS-CEX — same coin, price gap between two global CEXes ──────────────────
// Both legs are USDT so there's no FX; cost = taker×2 + on-chain transfer +
// slippage. Majors rarely gap >0.1% — the tail (new listings, depegs) is where
// this fires.
const CROSS_VENUES: Venue[] = ["binance", "bybit", "okx"];
const CROSS_MIN_GROSS = 0.1; // % — below this it's noise, not an edge
const crossSymbol = (venue: Venue, base: string) =>
  venue === "okx" ? `${base}-USDT` : `${base}USDT`;

const crossCex: Strategy = {
  kind: "cross-cex",
  label: "CROSS-CEX",
  async scan(ctx) {
    const out: Opportunity[] = [];
    const maps = CROSS_VENUES
      .map((v) => ({ v, m: ctx.tickers[v] }))
      .filter((x): x is { v: Venue; m: NonNullable<typeof x.m> } => !!x.m && x.m.size > 0);
    if (maps.length < 2) return out;

    // Union of bases seen on at least two venues, with executable bid/ask.
    const bases = new Map<string, { v: Venue; ask: number; bid: number }[]>();
    for (const { v, m } of maps) {
      for (const [base, t] of m) {
        if (CONFIG.EXCLUDE.has(base)) continue;
        if (t.quoteVolumeUsd < CONFIG.MIN_VOLUME_USD) continue; // both legs must be liquid
        if (!t.price) continue;
        if (spreadPct(t) > CONFIG.MAX_SPREAD_PCT) continue; // thin/stale book
        const arr = bases.get(base) ?? [];
        arr.push({ v, ask: t.ask ?? t.price, bid: t.bid ?? t.price });
        bases.set(base, arr);
      }
    }

    for (const [base, quotes] of bases) {
      if (quotes.length < 2) continue;
      // Buy at the cheapest ASK, sell into the richest BID — the executable arb.
      let lo = quotes[0], hi = quotes[0];
      for (const q of quotes) {
        if (q.ask < lo.ask) lo = q;
        if (q.bid > hi.bid) hi = q;
      }
      if (lo.v === hi.v) continue;
      const gross = ((hi.bid - lo.ask) / lo.ask) * 100;
      if (gross < CROSS_MIN_GROSS) continue;
      if (gross > CONFIG.MAX_ABS_PREMIUM_PCT) continue; // stale/broken feed

      const cost =
        (FEES.takerPct[lo.v] ?? 0.1) + (FEES.takerPct[hi.v] ?? 0.1) +
        (NETWORK_PCT[base] ?? NETWORK_PCT_DEFAULT) + FEES.slippagePct;
      const net = gross - cost;

      const transfer: TransferGate = {
        // Wallet status for bybit/okx isn't wired → null (unknown).
        withdraw: { venue: lo.v, enabled: walletStatus(ctx.transfers, lo.v, base)?.withdraw ?? null },
        deposit: { venue: hi.v, enabled: walletStatus(ctx.transfers, hi.v, base)?.deposit ?? null },
        etaMin: TRANSFER_ETA_MIN[base] ?? TRANSFER_ETA_DEFAULT_MIN,
        blocked: false,
        network: COIN_NETWORK[base] ?? COIN_NETWORK_DEFAULT,
      };
      transfer.blocked =
        transfer.withdraw.enabled === false || transfer.deposit.enabled === false;

      out.push({
        id: id("cross-cex", base),
        kind: "cross-cex",
        base,
        legs: [
          { venue: lo.v, side: "buy", symbol: crossSymbol(lo.v, base), price: lo.ask, quote: "USDT" },
          { venue: hi.v, side: "sell", symbol: crossSymbol(hi.v, base), price: hi.bid, quote: "USDT" },
        ],
        grossPct: gross,
        costPct: cost,
        netPct: net,
        notionalCapUsd: null,
        executable: net > 0 && !transfer.blocked,
        transfer,
        ts: now(),
      });
    }
    // Keep the tail from flooding the board.
    out.sort((a, b) => b.netPct - a.netPct);
    return out.slice(0, 20);
  },
};

// ── FUNDING-BASIS — cross-venue funding-rate arbitrage (perp vs perp) ──────────
// Same coin, funding differs across perp venues. SHORT the high-funding venue
// (receive funding), LONG the low-funding venue (pay least / receive if
// negative) → delta-neutral, no on-chain transfer, capture the funding SPREAD
// every 8h. Hyperliquid & Lighter often diverge sharply from the CEX cluster,
// which is where the real edge lives. Headline is APR (held ongoing).
const FUNDING_MIN_APR = 8; // % — below this the spread doesn't clear fees/risk
const perpSymbol = (venue: Venue, base: string) =>
  venue === "okx" ? `${base}-USDT-SWAP`
  : venue === "hyperliquid" || venue === "lighter" ? base
  : `${base}USDT`;

const fundingBasis: Strategy = {
  kind: "funding-basis",
  label: "FUNDING",
  async scan(ctx) {
    const fmap = ctx.funding;
    if (!fmap || fmap.size === 0) return [];
    const out: Opportunity[] = [];

    for (const [base, rates] of fmap) {
      if (CONFIG.EXCLUDE.has(base)) continue;
      if (rates.length < 2) continue; // need at least two venues to spread

      let hi = rates[0], lo = rates[0];
      for (const r of rates) {
        if (r.aprPct > hi.aprPct) hi = r;
        if (r.aprPct < lo.aprPct) lo = r;
      }
      if (hi.venue === lo.venue) continue;

      const grossApr = hi.aprPct - lo.aprPct; // annualized funding spread captured
      if (grossApr < FUNDING_MIN_APR) continue;

      // One-time round trip: taker to open + close on BOTH legs (4 fills).
      const pf = FEES.perpTakerPct;
      const roundTripPct =
        2 * ((pf[hi.venue] ?? 0.05) + (pf[lo.venue] ?? 0.05));
      // Break-even: spread must out-earn the entry cost. Days to break even.
      const dailyPct = grossApr / 365;
      const breakEvenDays = dailyPct > 0 ? roundTripPct / dailyPct : Infinity;

      out.push({
        id: id("funding-basis", base),
        kind: "funding-basis",
        base,
        legs: [
          // "buy" = long the low-funding venue, "sell" = short the high one.
          { venue: lo.venue, side: "buy", symbol: perpSymbol(lo.venue, base), price: 0, quote: "USDT" },
          { venue: hi.venue, side: "sell", symbol: perpSymbol(hi.venue, base), price: 0, quote: "USDT" },
        ],
        grossPct: grossApr,
        costPct: roundTripPct,
        netPct: grossApr, // ongoing yield; round trip is a one-time drag (see note)
        notionalCapUsd: null,
        executable: false, // perp-DEX / cross-venue order routing not wired yet
        rateBasis: "apr",
        // Funding pays only at the settlement snapshot — surface the SHORT
        // leg's next one + both intervals so entries can be timed.
        fundingMeta: { nextTs: hi.nextTs, shortIntervalH: hi.intervalH, longIntervalH: lo.intervalH },
        note: `숏 ${hi.venue}(${hi.intervalH ?? "?"}h${hi.predicted ? "·예측" : ""}) / 롱 ${lo.venue}(${lo.intervalH ?? "?"}h) · 진입 ${roundTripPct.toFixed(2)}% · 손익분기 ${breakEvenDays < 99 ? breakEvenDays.toFixed(1) + "일" : "—"}`,
        ts: now(),
      });
    }
    out.sort((a, b) => b.netPct - a.netPct);
    return out.slice(0, 20);
  },
};

// ── CEX-DEX — centralized vs on-chain DEX ─────────────────────────────────────
const cexDex: Strategy = {
  kind: "cex-dex",
  label: "CEX-DEX",
  async scan() {
    // TODO: compare CEX price vs DEX quote (uniswap router). net = gap − gas −
    // bridge − slippage. Needs an RPC + router quoting + wallet for execution.
    return [];
  },
};

export const STRATEGIES: Strategy[] = [kimchi, crossCex, fundingBasis, cexDex];
