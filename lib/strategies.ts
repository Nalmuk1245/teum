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

      // Evaluate every KR × global combo; keep the best net edge.
      let best:
        | { kv: Venue; gv: Venue; krPrice: number; gPrice: number; premiumPct: number; cost: number; net: number }
        | null = null;
      for (const kv of KR_VENUES) {
        const km = ctx.tickers[kv];
        const kr = km?.get(base);
        if (!kr) continue;
        // KR-leg liquidity gate — quoteVolumeUsd holds KRW for KR venues.
        if (kr.quoteVolumeUsd < CONFIG.MIN_KR_VOLUME_KRW) continue;
        // Per-venue USDT/KRW; a live cross-venue rate is acceptable, but a bank
        // fallback rate fabricates 1-3% premiums — skip rather than mislead.
        const fx = km?.get("USDT")?.price ?? (ctx.fxLive ? ctx.usdKrw : null);
        if (!fx) continue;
        for (const gv of GLOBAL_VENUES) {
          const g = ctx.tickers[gv]?.get(base);
          if (!g || !g.price) continue;
          if (g.quoteVolumeUsd < CONFIG.MIN_VOLUME_USD) continue;
          const premiumPct = ((kr.price / fx - g.price) / g.price) * 100;
          if (Math.abs(premiumPct) > CONFIG.MAX_ABS_PREMIUM_PCT) continue; // bad data
          const cost = kimchiCostPct(base, gv, kv);
          const net = Math.abs(premiumPct) - cost;
          if (!best || net > best.net)
            best = { kv, gv, krPrice: kr.price, gPrice: g.price, premiumPct, cost, net };
        }
      }
      if (!best) continue;

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
        grossPct: Math.abs(best.premiumPct),
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

    // Union of bases seen on at least two venues.
    const bases = new Map<string, { v: Venue; price: number; vol: number }[]>();
    for (const { v, m } of maps) {
      for (const [base, t] of m) {
        if (CONFIG.EXCLUDE.has(base)) continue;
        if (t.quoteVolumeUsd < CONFIG.MIN_VOLUME_USD) continue; // both legs must be liquid
        if (!t.price) continue;
        const arr = bases.get(base) ?? [];
        arr.push({ v, price: t.price, vol: t.quoteVolumeUsd });
        bases.set(base, arr);
      }
    }

    for (const [base, quotes] of bases) {
      if (quotes.length < 2) continue;
      let lo = quotes[0], hi = quotes[0];
      for (const q of quotes) {
        if (q.price < lo.price) lo = q;
        if (q.price > hi.price) hi = q;
      }
      const gross = ((hi.price - lo.price) / lo.price) * 100;
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
          { venue: lo.v, side: "buy", symbol: crossSymbol(lo.v, base), price: lo.price, quote: "USDT" },
          { venue: hi.v, side: "sell", symbol: crossSymbol(hi.v, base), price: hi.price, quote: "USDT" },
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

// ── FUNDING-BASIS — perp funding vs spot (cash-and-carry) ──────────────────────
const fundingBasis: Strategy = {
  kind: "funding-basis",
  label: "FUNDING",
  async scan() {
    // TODO: pull perp funding + spot; net APR = funding − borrow − fees. Long
    // spot / short perp when funding is richly positive.
    return [];
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
