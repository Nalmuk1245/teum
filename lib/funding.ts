// Multi-venue perp funding rates for the funding-basis strategy.
//
// Source: Lighter's public funding-rates endpoint aggregates funding for
// lighter + binance + bybit + hyperliquid in ONE call, all NORMALIZED to an
// 8-hour basis (verified: its "binance" value == Binance's raw 8h rate, its
// "hyperliquid" value == HL's 1h rate × 8), so the venues are directly
// comparable. That's exactly what a cross-venue funding arb needs.

import type { FundingMap, FundingRate, Venue } from "./types";

const LIGHTER_FUNDING = "https://mainnet.zklighter.elliot.ai/api/v1/funding-rates";

// Lighter's exchange labels → our Venue keys.
const VENUE_OF: Record<string, Venue> = {
  lighter: "lighter",
  binance: "binance",
  bybit: "bybit",
  hyperliquid: "hyperliquid",
};

// Normalize a Lighter symbol to our base ticker. Lighter uses 1000X and kXXX
// prefixes for low-priced coins (1000PEPE, 1000SHIB); strip to the plain base
// so it lines up with the spot side elsewhere.
function normBase(sym: string): string {
  let s = sym.toUpperCase();
  if (s.endsWith("USD")) s = s.slice(0, -3);
  if (s.startsWith("1000000")) s = s.slice(7);
  else if (s.startsWith("1000")) s = s.slice(4);
  else if (s.startsWith("K") && s.length > 3) s = s.slice(1);
  return s;
}

const aprFrom8h = (rate8h: number) => rate8h * 3 * 365 * 100; // 3 funding windows/day

/** Fetch normalized funding (8h basis) per coin across perp venues. Empty on failure. */
export async function fetchFundingRates(): Promise<FundingMap> {
  const map: FundingMap = new Map();
  try {
    const res = await fetch(LIGHTER_FUNDING, { cache: "no-store", signal: AbortSignal.timeout(6000) });
    const j = (await res.json()) as {
      code: number;
      funding_rates?: Array<{ exchange: string; symbol: string; rate: number }>;
    };
    if (j.code !== 200 || !j.funding_rates) return map;
    for (const r of j.funding_rates) {
      const venue = VENUE_OF[r.exchange];
      if (!venue || typeof r.rate !== "number") continue;
      // Exactly-zero usually means "this venue has no real market for this coin"
      // (equity perps, delistings) → a placeholder that would fabricate a phantom
      // leg. A genuine funding rate is essentially never exactly 0.
      if (r.rate === 0) continue;
      const base = normBase(r.symbol);
      const entry: FundingRate = { venue, rate8h: r.rate, aprPct: aprFrom8h(r.rate) };
      const arr = map.get(base);
      if (arr) {
        // Keep one rate per venue (first wins; Lighter lists each once anyway).
        if (!arr.some((x) => x.venue === venue)) arr.push(entry);
      } else {
        map.set(base, [entry]);
      }
    }
  } catch {
    /* network — funding strategy just yields nothing */
  }
  return map;
}
