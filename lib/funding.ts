// Multi-venue perp funding rates for the funding-basis strategy — rate AND
// settlement timing. Funding pays only at the settlement snapshot, so "when is
// the next one" and "what will it be" matter as much as the headline rate.
//
// Sources (both public, no keys):
// - Lighter funding-rates: lighter+binance+bybit+hyperliquid in one call, all
//   NORMALIZED to an 8h basis (verified vs raw Binance 8h / HL 1h×8). Used as
//   the base rate map (and the only source for Lighter itself).
// - Hyperliquid predictedFundings: PREDICTED next-window rate + nextFundingTime
//   + fundingIntervalHours for BinPerp/HlPerp/BybitPerp. Where available it
//   overrides the Lighter snapshot — the predicted rate is what you can still
//   capture by entering now.

import type { FundingMap, FundingRate, Venue } from "./types";
export type MarkMap = Map<string, Partial<Record<Venue, number>>>;

const LIGHTER_FUNDING = "https://mainnet.zklighter.elliot.ai/api/v1/funding-rates";
const HL_INFO = "https://api.hyperliquid.xyz/info";

// Lighter's exchange labels → our Venue keys.
const VENUE_OF: Record<string, Venue> = {
  lighter: "lighter",
  binance: "binance",
  bybit: "bybit",
  hyperliquid: "hyperliquid",
};
// Hyperliquid predictedFundings venue labels → our Venue keys.
const HL_VENUE_OF: Record<string, Venue> = {
  BinPerp: "binance",
  BybitPerp: "bybit",
  HlPerp: "hyperliquid",
};

// Normalize a Lighter symbol to our base ticker. Lighter uses 1000X and kXXX
// prefixes for low-priced coins (1000PEPE, kSHIB); strip to the plain base so
// it lines up with the spot side elsewhere.
function normBase(sym: string): string {
  let s = sym.toUpperCase();
  if (s.endsWith("USD")) s = s.slice(0, -3);
  if (s.startsWith("1000000")) s = s.slice(7);
  else if (s.startsWith("1000")) s = s.slice(4);
  else if (s.startsWith("K") && s.length > 3) s = s.slice(1);
  return s;
}

const aprFrom8h = (rate8h: number) => rate8h * 3 * 365 * 100; // 3 windows/day

// Fallback settlement boundaries when a venue isn't in predictedFundings:
// CEX funding settles at 00/08/16 UTC; HL & Lighter settle hourly.
function nextBoundary(hours: number): number {
  const ms = hours * 3600_000;
  return (Math.floor(Date.now() / ms) + 1) * ms;
}
const DEFAULT_INTERVAL_H: Partial<Record<Venue, number>> = {
  binance: 8, bybit: 8, hyperliquid: 1, lighter: 1,
};

async function fetchLighter(): Promise<Map<string, Partial<Record<Venue, number>>>> {
  const out = new Map<string, Partial<Record<Venue, number>>>();
  const res = await fetch(LIGHTER_FUNDING, { cache: "no-store", signal: AbortSignal.timeout(6000) });
  const j = (await res.json()) as {
    code: number;
    funding_rates?: Array<{ exchange: string; symbol: string; rate: number }>;
  };
  if (j.code !== 200 || !j.funding_rates) return out;
  for (const r of j.funding_rates) {
    const venue = VENUE_OF[r.exchange];
    if (!venue || typeof r.rate !== "number") continue;
    // Exactly-zero usually means "no real market here" (equity perps,
    // delistings) — a placeholder that would fabricate a phantom leg.
    if (r.rate === 0) continue;
    const base = normBase(r.symbol);
    const entry = out.get(base) ?? {};
    if (entry[venue] === undefined) entry[venue] = r.rate;
    out.set(base, entry);
  }
  return out;
}

type HlPred = { rate8h: number; nextTs: number; intervalH: number };
async function fetchHlPredicted(): Promise<Map<string, Partial<Record<Venue, HlPred>>>> {
  const out = new Map<string, Partial<Record<Venue, HlPred>>>();
  const res = await fetch(HL_INFO, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "predictedFundings" }),
    cache: "no-store",
    signal: AbortSignal.timeout(6000),
  });
  const j = (await res.json()) as Array<
    [string, Array<[string, { fundingRate: string; nextFundingTime: number; fundingIntervalHours?: number } | null]>]
  >;
  for (const [coin, venues] of j) {
    const base = normBase(coin);
    const entry: Partial<Record<Venue, HlPred>> = out.get(base) ?? {};
    for (const [vname, info] of venues) {
      const venue = HL_VENUE_OF[vname];
      if (!venue || !info) continue;
      const ivl = info.fundingIntervalHours ?? DEFAULT_INTERVAL_H[venue] ?? 8;
      const raw = Number(info.fundingRate);
      if (!Number.isFinite(raw) || raw === 0) continue;
      entry[venue] = { rate8h: raw * (8 / ivl), nextTs: info.nextFundingTime, intervalH: ivl };
    }
    if (Object.keys(entry).length) out.set(base, entry);
  }
  return out;
}

/**
 * Per-coin funding across perp venues: 8h-normalized rate, next settlement
 * time, interval, and whether the rate is the predicted next window. Empty on
 * total failure; degrades to snapshot-only if HL is unreachable.
 */
export async function fetchFundingRates(): Promise<FundingMap> {
  const map: FundingMap = new Map();
  const [lighter, hl] = await Promise.all([
    fetchLighter().catch(() => new Map<string, Partial<Record<Venue, number>>>()),
    fetchHlPredicted().catch(() => new Map<string, Partial<Record<Venue, HlPred>>>()),
  ]);
  if (lighter.size === 0 && hl.size === 0) return map;

  const bases = new Set<string>([...lighter.keys(), ...hl.keys()]);
  for (const base of bases) {
    const snap = lighter.get(base) ?? {};
    const pred = hl.get(base) ?? {};
    const rates: FundingRate[] = [];
    const venues = new Set<Venue>([...Object.keys(snap), ...Object.keys(pred)] as Venue[]);
    for (const venue of venues) {
      const p = pred[venue];
      const s = snap[venue];
      if (p) {
        // Predicted next-window rate + real settlement time — the actionable
        // pair. HL sometimes returns an already-passed nextFundingTime; roll it
        // forward by the interval until it's in the future.
        let nextTs = p.nextTs;
        const ivlMs = p.intervalH * 3600_000;
        while (nextTs <= Date.now()) nextTs += ivlMs;
        rates.push({ venue, rate8h: p.rate8h, aprPct: aprFrom8h(p.rate8h), nextTs, intervalH: p.intervalH, predicted: true });
      } else if (s !== undefined) {
        const ivl = DEFAULT_INTERVAL_H[venue] ?? 8;
        rates.push({ venue, rate8h: s, aprPct: aprFrom8h(s), nextTs: nextBoundary(ivl), intervalH: ivl, predicted: false });
      }
    }
    if (rates.length) map.set(base, rates);
  }
  return map;
}

// ── Perp mark prices per venue (for entry-basis) ──────────────────────────────
// Bulk sources: HL metaAndAssetCtxs, Lighter orderBookDetails, Binance
// premiumIndex, Bybit linear tickers — one call each. The entry basis (mark
// spread between the two perp legs) is routinely bigger than the funding spread
// captured, so the funding strategy must price it.
export async function fetchMarks(): Promise<MarkMap> {
  const m: MarkMap = new Map();
  const put = (base: string, venue: Venue, px: number) => {
    if (!(px > 0)) return;
    const e = m.get(base) ?? {};
    e[venue] = px;
    m.set(base, e);
  };
  const timeout = { cache: "no-store" as const, signal: AbortSignal.timeout(6000) };

  const [hl, lighter, binance, bybit] = await Promise.allSettled([
    fetch(HL_INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "metaAndAssetCtxs" }), ...timeout }).then((r) => r.json()),
    fetch("https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails", timeout).then((r) => r.json()),
    fetch("https://fapi.binance.com/fapi/v1/premiumIndex", timeout).then((r) => r.json()),
    fetch("https://api.bybit.com/v5/market/tickers?category=linear", timeout).then((r) => r.json()),
  ]);

  if (hl.status === "fulfilled" && Array.isArray(hl.value)) {
    const [meta, ctxs] = hl.value as [{ universe?: { name: string }[] }, { markPx?: string }[]];
    meta?.universe?.forEach((u, i) => put(normBase(u.name), "hyperliquid", Number(ctxs?.[i]?.markPx)));
  }
  if (lighter.status === "fulfilled") {
    for (const o of (lighter.value?.order_book_details ?? []) as { symbol: string; mark_price?: string }[]) {
      put(normBase(o.symbol), "lighter", Number(o.mark_price));
    }
  }
  if (binance.status === "fulfilled" && Array.isArray(binance.value)) {
    for (const r of binance.value as { symbol: string; markPrice?: string }[]) {
      if (r.symbol.endsWith("USDT")) put(r.symbol.slice(0, -4), "binance", Number(r.markPrice));
    }
  }
  if (bybit.status === "fulfilled") {
    for (const r of (bybit.value?.result?.list ?? []) as { symbol: string; markPrice?: string }[]) {
      if (r.symbol.endsWith("USDT")) put(r.symbol.slice(0, -4), "bybit", Number(r.markPrice));
    }
  }
  return m;
}
