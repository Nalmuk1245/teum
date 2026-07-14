// Scanner — prefetch venue tickers once, run every strategy over the shared
// context, merge and rank the opportunities. Optionally inject mock samples so
// the board is meaningful without live/KR data.

import type { Opportunity, ScanContext, TickerMap, Venue } from "./types";
import { CONFIG, FEES } from "./config";
import { EXCHANGES } from "./exchanges";
import { STRATEGIES } from "./strategies";
import { fetchTransferStatus } from "./transfers";
import { fetchPerpBases } from "./perps";
import { fetchFundingRates } from "./funding";
import { recordGap, pruneHistory, confidence } from "./history";

// Slow-moving inputs don't need a fresh fetch every scan tick — gates/funding
// change on the minutes scale, the perp list on the days scale. TTL-cache them
// (globalThis so all route bundles share) and only tickers stay per-scan fresh.
type TtlEntry = { v: unknown; ts: number };
const gc = globalThis as unknown as { __arbTtl?: Map<string, TtlEntry> };
gc.__arbTtl ??= new Map();
async function ttl<T>(key: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const hit = gc.__arbTtl!.get(key);
  if (hit && Date.now() - hit.ts < ms) return hit.v as T;
  const v = await fn();
  gc.__arbTtl!.set(key, { v, ts: Date.now() });
  return v;
}

async function buildContext(): Promise<ScanContext> {
  const cexAdapters = Object.values(EXCHANGES).filter((a) => a.kind === "cex");
  const [entries, transfers, perps, funding] = await Promise.all([
    Promise.all(
      cexAdapters.map(
        async (a) => [a.venue, await a.fetchTickers()] as [Venue, TickerMap],
      ),
    ),
    ttl("transfers", 60_000, fetchTransferStatus),
    // Perp listings change on the days scale — worst case a brand-new perp's
    // hedge toggle lags by up to the TTL, so keep it at 1h (not longer).
    ttl("perps", 60 * 60_000, fetchPerpBases),
    // Funding settles every 1–8h; the countdown is computed from nextTs
    // client-side, so a 2min rate refresh loses nothing visible.
    ttl("funding", 2 * 60_000, fetchFundingRates),
  ]);
  const tickers: Partial<Record<Venue, TickerMap>> = {};
  for (const [venue, map] of entries) tickers[venue] = map;
  // Prefer a live USDT/KRW rate from a KR venue's own USDT market — that's the
  // correct denominator for a kimchi premium. The env fallback is a stale bank
  // rate that can inflate every premium by 1-3%, so flag it (fxLive=false) and
  // let strategies refuse to fabricate premiums from it.
  const liveFx = tickers.upbit?.get("USDT")?.price ?? tickers.bithumb?.get("USDT")?.price ?? null;
  return { tickers, usdKrw: liveFx ?? CONFIG.USD_KRW, fxLive: liveFx != null, transfers, perps, funding };
}

export async function scanAll(): Promise<Opportunity[]> {
  const ctx = await buildContext();
  const batches = await Promise.all(STRATEGIES.map((s) => s.scan(ctx)));
  const opps = batches.flat();
  if (CONFIG.USE_MOCK) opps.push(...MOCK_OPPS());
  if (ctx.perps) for (const o of opps) o.hasPerp = ctx.perps.has(o.base);

  // Hedge round-trip cost (perp taker open+close) — charged once hasPerp is
  // known. The recommended kimchi flow hedges whenever possible, so the board
  // net assumes it; unhedged coins skip the fee but carry the (bigger) price
  // risk shown by transferRisk instead.
  const hedgeRt = (FEES.perpTakerPct.binance ?? 0.045) * 2;
  for (const o of opps) {
    if (o.mock || o.kind !== "kimchi" || !o.hasPerp) continue;
    o.costPct += hedgeRt;
    o.netPct -= hedgeRt;
    if (o.netPct <= 0) o.executable = false;
  }

  // Persistence: record each live opp's net into rolling history and attach the
  // held-duration / hit-rate. Rank by a confidence-weighted score so fresh
  // one-scan spikes sink below sustained edges of similar size (not hidden).
  const ts = Date.now();
  const seen = new Set<string>();
  for (const o of opps) {
    if (o.mock) continue;
    seen.add(o.id);
    o.persistence = recordGap(o.id, o.netPct, o.grossPct, ts);
    // Transfer-window risk: the premium you actually capture is at SELL time,
    // ETA minutes after buy. Model the expected drift as σ_per_min × √ETA
    // (random-walk). If that swamps the edge, a hedge (short perp during the
    // transfer) is advised. Funding/cross legs settle instantly → no window.
    if (o.transfer && o.kind === "kimchi") {
      const etaMin = o.transfer.etaMin;
      const drift = (o.persistence?.volPctPerMin ?? 0) * Math.sqrt(Math.max(1, etaMin));
      o.transferRisk = {
        etaMin,
        driftPct: drift,
        hedgeAdvised: !!o.hasPerp && drift > o.netPct, // risk exceeds the edge
      };
    }
  }
  pruneHistory(seen, ts);
  const score = (o: Opportunity) => (o.mock ? o.netPct : o.netPct * confidence(o.persistence));
  opps.sort((a, b) => score(b) - score(a));
  return opps;
}

// Sample opportunities across all four kinds — clearly flagged `mock:true`.
// Lets the UI + execution flow be exercised end-to-end before live data/keys.
function MOCK_OPPS(): Opportunity[] {
  const ts = Date.now();
  return [
    {
      id: "mock:kimchi:XRP", kind: "kimchi", base: "XRP",
      legs: [
        { venue: "binance", side: "buy", symbol: "XRPUSDT", price: 2.41, quote: "USDT" },
        { venue: "upbit", side: "sell", symbol: "KRW-XRP", price: 3450, quote: "KRW" },
      ],
      grossPct: 1.82, costPct: 0.55, netPct: 1.27,
      notionalCapUsd: 42000, executable: true, mock: true, ts,
    },
    {
      id: "mock:cross-cex:SOL", kind: "cross-cex", base: "SOL",
      legs: [
        { venue: "bybit", side: "buy", symbol: "SOLUSDT", price: 172.1, quote: "USDT" },
        { venue: "binance", side: "sell", symbol: "SOLUSDT", price: 173.4, quote: "USDT" },
      ],
      grossPct: 0.75, costPct: 0.3, netPct: 0.45,
      notionalCapUsd: 88000, executable: true, mock: true, ts,
    },
    {
      id: "mock:funding-basis:BTC", kind: "funding-basis", base: "BTC",
      legs: [
        { venue: "binance", side: "buy", symbol: "BTCUSDT", price: 62700, quote: "USDT" },
        { venue: "binance", side: "sell", symbol: "BTCUSDT-PERP", price: 62740, quote: "USDT" },
      ],
      grossPct: 0.38, costPct: 0.15, netPct: 0.23,
      notionalCapUsd: 250000, executable: true, mock: true,
      note: "funding +0.038%/8h → ~34% APR carry", ts,
    },
    {
      id: "mock:cex-dex:PEPE", kind: "cex-dex", base: "PEPE",
      legs: [
        { venue: "uniswap", side: "buy", symbol: "PEPE/WETH", price: 0.0000102, quote: "USD" },
        { venue: "binance", side: "sell", symbol: "PEPEUSDT", price: 0.0000109, quote: "USDT" },
      ],
      grossPct: 6.86, costPct: 0.5, netPct: 6.36,
      notionalCapUsd: 3000, executable: false, mock: true,
      note: "gate: gas + bridge time; small size only", ts,
    },
  ];
}
