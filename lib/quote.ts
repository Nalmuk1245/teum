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
  WITHDRAW_FEE_COIN,
} from "./config";
import { getAdapter, fetchUsdKrw } from "./exchanges";

type LevelUsd = { priceUsd: number; size: number };

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

export async function quoteOpportunity(
  opp: Opportunity,
  sizeUsd: number,
): Promise<Quote | null> {
  const buyLeg = opp.legs.find((l) => l.side === "buy");
  const sellLeg = opp.legs.find((l) => l.side === "sell");
  if (!buyLeg || !sellLeg) return null;

  const buyAd = getAdapter(buyLeg.venue);
  const sellAd = getAdapter(sellLeg.venue);
  if (!buyAd?.fetchOrderBook || !sellAd?.fetchOrderBook) return null; // unwired (mock)

  // FX from whichever leg is KRW-quoted, from that venue.
  const krVenue: Venue | null =
    buyLeg.quote === "KRW" ? buyLeg.venue : sellLeg.quote === "KRW" ? sellLeg.venue : null;
  const usdKrw = krVenue ? await fetchUsdKrw(krVenue) : 1;
  if (!usdKrw) return null;

  const [buyBook, sellBook] = await Promise.all([
    buyAd.fetchOrderBook(buyLeg.symbol),
    sellAd.fetchOrderBook(sellLeg.symbol),
  ]);
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
  const wFeeCoin = WITHDRAW_FEE_COIN[opp.base];

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

  // Depth cap — largest fillable size that still nets positive.
  let maxSizeUsd = 0;
  for (const c of [500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000]) {
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
