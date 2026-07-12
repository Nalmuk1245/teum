// Scanner — prefetch venue tickers once, run every strategy over the shared
// context, merge and rank the opportunities. Optionally inject mock samples so
// the board is meaningful without live/KR data.

import type { Opportunity, ScanContext, TickerMap, Venue } from "./types";
import { CONFIG } from "./config";
import { EXCHANGES } from "./exchanges";
import { STRATEGIES } from "./strategies";
import { fetchTransferStatus } from "./transfers";
import { fetchPerpBases } from "./perps";

async function buildContext(): Promise<ScanContext> {
  const cexAdapters = Object.values(EXCHANGES).filter((a) => a.kind === "cex");
  const [entries, transfers, perps] = await Promise.all([
    Promise.all(
      cexAdapters.map(
        async (a) => [a.venue, await a.fetchTickers()] as [Venue, TickerMap],
      ),
    ),
    fetchTransferStatus(),
    fetchPerpBases(),
  ]);
  const tickers: Partial<Record<Venue, TickerMap>> = {};
  for (const [venue, map] of entries) tickers[venue] = map;
  // Prefer the live USDT/KRW rate from Upbit's own KRW-USDT market — that's the
  // correct denominator for a kimchi premium (apples-to-apples vs the USDT price),
  // and it removes the bias a stale bank USD/KRW fallback would add.
  const usdKrw = tickers.upbit?.get("USDT")?.price ?? CONFIG.USD_KRW;
  return { tickers, usdKrw, transfers, perps };
}

export async function scanAll(): Promise<Opportunity[]> {
  const ctx = await buildContext();
  const batches = await Promise.all(STRATEGIES.map((s) => s.scan(ctx)));
  const opps = batches.flat();
  if (CONFIG.USE_MOCK) opps.push(...MOCK_OPPS());
  if (ctx.perps) for (const o of opps) o.hasPerp = ctx.perps.has(o.base);
  opps.sort((a, b) => b.netPct - a.netPct);
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
