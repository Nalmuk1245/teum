// Depth quote — the precise, "executable" numbers for one opportunity at a
// given size. Fetches live order books for both legs and computes VWAP fills
// (buy into asks, sell into bids), real per-coin withdrawal fee, and a
// depth-based size cap. This is the accurate counterpart to the board's
// ticker-price estimate; the modal calls it before you confirm.

import type { Opportunity, Quote, Venue } from "./types";
import {
  FEES,
  NETWORK_PCT,
  NETWORK_PCT_DEFAULT,
} from "./config";
import { withdrawFeeCoin } from "./networks";
import { getAdapter, fetchUsdKrw } from "./exchanges";

type LevelUsd = { priceUsd: number; size: number };

// ── Micro-cache (books + fx) ──────────────────────────────────────────────────
// A quote is 3 REST calls; size tweaks and the 5s modal auto-refresh would
// re-fetch identical books. 2.5s TTL keeps repeat quotes ~instant while staying
// fresher than the 3s scan. Live-money revalidation passes fresh=true to bypass
// reads (it still populates the cache).
type Book = { bids: { price: number; size: number }[]; asks: { price: number; size: number }[] };
const g = globalThis as unknown as {
  __arbQuoteCache?: { books: Map<string, { ts: number; v: Book }>; fx: Map<string, { ts: number; v: number | null }> };
};
g.__arbQuoteCache ??= { books: new Map(), fx: new Map() };
const QC = g.__arbQuoteCache;
const QUOTE_TTL_MS = 2500;

async function cachedBook(
  fetcher: (symbol: string) => Promise<Book>,
  venue: Venue,
  symbol: string,
  fresh: boolean,
): Promise<Book> {
  const key = `${venue}:${symbol}`;
  const hit = QC.books.get(key);
  if (!fresh && hit && Date.now() - hit.ts < QUOTE_TTL_MS) return hit.v;
  const v = await fetcher(symbol);
  if (v.bids.length || v.asks.length) QC.books.set(key, { ts: Date.now(), v });
  return v;
}

async function cachedFx(venue: Venue, fresh: boolean): Promise<number | null> {
  const hit = QC.fx.get(venue);
  if (!fresh && hit && Date.now() - hit.ts < QUOTE_TTL_MS) return hit.v;
  const v = await fetchUsdKrw(venue);
  if (v != null) QC.fx.set(venue, { ts: Date.now(), v });
  return v;
}

const toUsd = (price: number, quote: string, usdKrw: number) =>
  quote === "KRW" ? price / usdKrw : price; // USDT/USD ≈ 1

// Spend `targetUsd` walking asks (ascending) → base acquired.
function buyInto(asks: LevelUsd[], targetUsd: number) {
  let spent = 0, base = 0;
  for (const lv of asks) {
    const cap = lv.priceUsd * lv.size;
    if (spent + cap >= targetUsd) {
      base += (targetUsd - spent) / lv.priceUsd;
      return { base, filled: true };
    }
    spent += cap; base += lv.size;
  }
  return { base, filled: false }; // book exhausted
}

// Sell `baseAmount` walking bids (descending) → USD proceeds.
function sellInto(bids: LevelUsd[], baseAmount: number) {
  let left = baseAmount, proceeds = 0;
  for (const lv of bids) {
    const take = Math.min(left, lv.size);
    proceeds += take * lv.priceUsd; left -= take;
    if (left <= 1e-12) return { proceeds, filled: true };
  }
  return { proceeds, filled: false };
}

/**
 * Pre-trade slippage estimate for ONE leg from its live book — used as the
 * last-line market-order gate (CONFIG.MAX_SLIPPAGE_PCT). Currency-agnostic:
 * walks the raw book, so KRW books work unchanged. null = book unavailable.
 */
export async function estimateLegSlippage(
  venue: Venue,
  symbol: string,
  side: "buy" | "sell",
  size: { quoteAmount?: number; baseQty?: number },
): Promise<{ slipPct: number; filled: boolean } | null> {
  const ad = getAdapter(venue);
  if (!ad?.fetchOrderBook) return null;
  const book = await ad.fetchOrderBook(symbol);
  if (!book.bids.length || !book.asks.length) return null;
  const lv = (rows: { price: number; size: number }[]) =>
    rows.map((r) => ({ priceUsd: r.price, size: r.size }));
  if (side === "buy") {
    const target = size.quoteAmount ?? (size.baseQty ?? 0) * book.asks[0].price;
    if (target <= 0) return null;
    const r = buyInto(lv(book.asks), target);
    if (r.base <= 0) return { slipPct: Infinity, filled: false };
    const vwap = target / r.base;
    return { slipPct: ((vwap - book.asks[0].price) / book.asks[0].price) * 100, filled: r.filled };
  }
  const qty = size.baseQty ?? 0;
  if (qty <= 0) return null;
  const r = sellInto(lv(book.bids), qty);
  if (!r.filled && r.proceeds <= 0) return { slipPct: Infinity, filled: false };
  const vwap = r.proceeds / qty; // full qty basis; partial fill drags vwap down (conservative)
  return { slipPct: ((book.bids[0].price - vwap) / book.bids[0].price) * 100, filled: r.filled };
}

export async function quoteOpportunity(
  opp: Opportunity,
  sizeUsd: number,
  opts?: { fresh?: boolean },
): Promise<Quote | null> {
  const fresh = opts?.fresh ?? false;
  const buyLeg = opp.legs.find((l) => l.side === "buy");
  const sellLeg = opp.legs.find((l) => l.side === "sell");
  if (!buyLeg || !sellLeg) return null;

  const buyAd = getAdapter(buyLeg.venue);
  const sellAd = getAdapter(sellLeg.venue);
  if (!buyAd?.fetchOrderBook || !sellAd?.fetchOrderBook) return null; // unwired (mock)

  // FX from whichever leg is KRW-quoted, from that venue. All three calls are
  // independent — one round-trip, not two.
  const krVenue: Venue | null =
    buyLeg.quote === "KRW" ? buyLeg.venue : sellLeg.quote === "KRW" ? sellLeg.venue : null;
  const [usdKrw, buyBook, sellBook] = await Promise.all([
    krVenue ? cachedFx(krVenue, fresh) : Promise.resolve(1),
    cachedBook(buyAd.fetchOrderBook.bind(buyAd), buyLeg.venue, buyLeg.symbol, fresh),
    cachedBook(sellAd.fetchOrderBook.bind(sellAd), sellLeg.venue, sellLeg.symbol, fresh),
  ]);
  if (!usdKrw) return null;
  if (!buyBook.asks.length || !sellBook.bids.length) return null;

  const asks: LevelUsd[] = buyBook.asks
    .map((l) => ({ priceUsd: toUsd(l.price, buyLeg.quote, usdKrw), size: l.size }))
    .filter((l) => l.priceUsd > 0)
    .sort((a, b) => a.priceUsd - b.priceUsd);
  const bids: LevelUsd[] = sellBook.bids
    .map((l) => ({ priceUsd: toUsd(l.price, sellLeg.quote, usdKrw), size: l.size }))
    .filter((l) => l.priceUsd > 0)
    .sort((a, b) => b.priceUsd - a.priceUsd);

  const takerPct = (FEES.takerPct[buyLeg.venue] ?? 0.1) + (FEES.takerPct[sellLeg.venue] ?? 0.1);
  const fxSpreadPct = krVenue ? FEES.fxSpreadPct : 0;
  const wFeeCoin = withdrawFeeCoin(opp.base);

  // Net edge for a candidate size using the already-fetched books.
  function evalSize(sz: number) {
    const { base, filled: fb } = buyInto(asks, sz);
    if (base <= 0) return null;
    const { proceeds, filled: fs } = sellInto(bids, base);
    const avgBuyUsd = sz / base;
    const grossPct = (proceeds / sz - 1) * 100; // slippage already baked in
    const withdrawalPct =
      wFeeCoin != null
        ? ((wFeeCoin * avgBuyUsd) / sz) * 100
        : NETWORK_PCT[opp.base] ?? NETWORK_PCT_DEFAULT;
    const feePct = takerPct + fxSpreadPct + withdrawalPct;
    return {
      base, avgBuyUsd, avgSellUsd: proceeds / base,
      grossPct, withdrawalPct, feePct, netPct: grossPct - feePct,
      filled: fb && fs,
    };
  }

  const q = evalSize(sizeUsd);
  if (!q) return null;

  // Depth cap — largest fillable size that still nets positive. Seed the probe
  // grid with small candidates AND the requested size itself, so a thin book
  // doesn't report 0 when e.g. $300 is perfectly fillable.
  let maxSizeUsd = 0;
  const grid = [...new Set([100, 250, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000, Math.round(sizeUsd)])]
    .filter((c) => c > 0)
    .sort((a, b) => a - b);
  for (const c of grid) {
    const r = evalSize(c);
    if (r && r.filled && r.netPct > 0) maxSizeUsd = c;
  }

  const topAsk = asks[0].priceUsd, topBid = bids[0].priceUsd;
  return {
    sizeUsd,
    execBuyPriceUsd: q.avgBuyUsd,
    execSellPriceUsd: q.avgSellUsd,
    execGrossPct: q.grossPct,
    buySlippagePct: ((q.avgBuyUsd - topAsk) / topAsk) * 100,
    sellSlippagePct: ((topBid - q.avgSellUsd) / topBid) * 100,
    takerPct,
    fxSpreadPct,
    withdrawalPct: q.withdrawalPct,
    feePct: q.feePct,
    execNetPct: q.netPct,
    maxSizeUsd,
    filledFully: q.filled,
    note: q.filled ? undefined : "order book too thin for this size",
  };
}
