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

// Structured, per-coin/per-venue round-trip cost — replaces the flat number.
function kimchiCostPct(base: string, krVenue: Venue): number {
  const globalFee = FEES.takerPct.binance ?? 0.1;
  const krFee = FEES.takerPct[krVenue] ?? 0.05;
  const network = NETWORK_PCT[base] ?? NETWORK_PCT_DEFAULT;
  return globalFee + krFee + network + FEES.fxSpreadPct + FEES.slippagePct;
}

// ── KIMCHI — KR won premium vs global USDT (best of Upbit / Bithumb) ───────────
const kimchi: Strategy = {
  kind: "kimchi",
  label: "KIMCHI",
  async scan(ctx) {
    const bnb = ctx.tickers.binance;
    if (!bnb) return [];

    // Union of coins listed on any KR venue.
    const bases = new Set<string>();
    for (const v of KR_VENUES) {
      const m = ctx.tickers[v];
      if (m) for (const b of m.keys()) bases.add(b);
    }

    const out: Opportunity[] = [];
    for (const base of bases) {
      if (CONFIG.EXCLUDE.has(base)) continue;
      const g = bnb.get(base);
      if (!g) continue;
      if (g.quoteVolumeUsd < CONFIG.MIN_VOLUME_USD) continue;

      // Evaluate each KR venue with its OWN USDT/KRW rate and its own fees;
      // keep whichever gives the best net edge.
      let best:
        | { venue: Venue; krPrice: number; premiumPct: number; cost: number; net: number }
        | null = null;
      for (const v of KR_VENUES) {
        const m = ctx.tickers[v];
        const kr = m?.get(base);
        if (!kr) continue;
        // KR-leg liquidity gate — quoteVolumeUsd holds KRW for KR venues.
        if (kr.quoteVolumeUsd < CONFIG.MIN_KR_VOLUME_KRW) continue;
        // Per-venue USDT/KRW; a live cross-venue rate is acceptable, but a bank
        // fallback rate fabricates 1-3% premiums — skip rather than mislead.
        const fx = m?.get("USDT")?.price ?? (ctx.fxLive ? ctx.usdKrw : null);
        if (!fx) continue;
        const premiumPct = ((kr.price / fx - g.price) / g.price) * 100;
        if (Math.abs(premiumPct) > CONFIG.MAX_ABS_PREMIUM_PCT) continue; // bad data
        const cost = kimchiCostPct(base, v);
        const net = Math.abs(premiumPct) - cost;
        if (!best || net > best.net)
          best = { venue: v, krPrice: kr.price, premiumPct, cost, net };
      }
      if (!best) continue;

      const buyGlobal = best.premiumPct >= 0; // KR expensive → buy global, sell KR

      // Settlement gate: you WITHDRAW the coin from the buy venue and DEPOSIT it
      // to the sell venue. If either is disabled, the edge can't be captured.
      const buyVenue: Venue = buyGlobal ? "binance" : best.venue;
      const sellVenue: Venue = buyGlobal ? best.venue : "binance";
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

      out.push({
        id: id("kimchi", base),
        kind: "kimchi",
        base,
        legs: [
          buyGlobal
            ? { venue: "binance", side: "buy", symbol: `${base}USDT`, price: g.price, quote: "USDT" }
            : { venue: best.venue, side: "buy", symbol: krSymbol(best.venue, base), price: best.krPrice, quote: "KRW" },
          buyGlobal
            ? { venue: best.venue, side: "sell", symbol: krSymbol(best.venue, base), price: best.krPrice, quote: "KRW" }
            : { venue: "binance", side: "sell", symbol: `${base}USDT`, price: g.price, quote: "USDT" },
        ],
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

// ── CROSS-CEX — same coin, price gap between two CEXes ─────────────────────────
const crossCex: Strategy = {
  kind: "cross-cex",
  label: "CROSS-CEX",
  async scan() {
    // TODO: diff base prices across binance/bybit/okx tickers; net = gap −
    // (taker×2 + withdrawal fee). Needs bybit/okx adapters + transfer status.
    return [];
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
