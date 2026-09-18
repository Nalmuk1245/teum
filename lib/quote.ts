// Depth quote — the precise, "executable" numbers for one opportunity at a
// given size. Fetches live order books for both legs and computes VWAP fills
// (buy into asks, sell into bids), real per-coin withdrawal fee, and a
// depth-based size cap. This is the accurate counterpart to the board's
// ticker-price estimate; the modal calls it before you confirm.

import type { DepthLadder, Opportunity, Quote, Venue } from "./types";
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
  maxAgeMs = QUOTE_TTL_MS,
): Promise<Book> {
  const key = `${venue}:${symbol}`;
  const hit = QC.books.get(key);
  if (!fresh && hit && Date.now() - hit.ts < maxAgeMs) return hit.v;
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

// ── Book prewarm — 클릭→견적을 캐시 히트로 만든다 ────────────────────────────
// 스캔 상위 기회의 양쪽 오더북(+KR FX)을 TTL보다 짧은 주기로 미리 채워, 실행
// 모달의 첫 견적이 REST 왕복(다리당 수백 ms) 없이 뜨게 한다. 상장 순간엔 이
// 지연이 곧 손실이다. maxAge를 주기보다 살짝 짧게 줘서 틱마다 실제로 갱신된다
// (상위 5기회 ≤10심볼 / 2초 — 어느 거래소 공개 한도에도 한참 못 미친다).
export const PREWARM_MS = 2000;
const PREWARM_TOP = 6;

// ── 깊이 사다리 ───────────────────────────────────────────────────────────────
// "5% 갭"이 최우선호가 한 칸에 $100 있고 1%대에 $2,000이 깔려 있으면, 보드의
// "순수익 5% · 한도 $100"은 반쪽 진실이다. 양쪽 호가를 같은 속도로 걸어 내려가며
// 칸마다 순수익을 구하고, 0 위인 칸까지 규모·이익을 누적한다. 상위 기회만
// (프리웜이 어차피 데워두는 오더북을 재사용 — 추가 요청 0건).
export const LADDER_TIERS = [5, 3, 1, 0];

/**
 * 순수 함수. asks 오름차순 / bids 내림차순, 둘 다 USD 환산.
 * costPct는 비례 비용으로 취급한다(출금 고정비는 보드 기준 규모로 이미 %화돼 있어
 * 작은 규모에선 실제보다 후하고 큰 규모에선 박하다 — 사다리 용도로는 충분).
 */
export function ladderFromBooks(asks: LevelUsd[], bids: LevelUsd[], costPct: number, tiers: number[] = LADDER_TIERS): DepthLadder {
  const tierSize = tiers.map(() => 0);
  let i = 0, j = 0;
  let ra = asks[0]?.size ?? 0, rb = bids[0]?.size ?? 0;
  let maxSizeUsd = 0, profitUsd = 0;
  while (i < asks.length && j < bids.length) {
    const a = asks[i], b = bids[j];
    const q = Math.min(ra, rb);
    if (!(q > 0) || !(a.priceUsd > 0)) break;
    const net = (b.priceUsd / a.priceUsd - 1) * 100 - costPct;
    if (net <= 0) break; // 정렬돼 있으므로 이후 칸은 더 나쁘다
    const usd = q * a.priceUsd;
    maxSizeUsd += usd;
    profitUsd += (usd * net) / 100;
    for (let k = 0; k < tiers.length; k++) if (net >= tiers[k] && (tiers[k] > 0 || net > 0)) tierSize[k] += usd;
    ra -= q; rb -= q;
    if (ra <= 1e-12) { i++; ra = asks[i]?.size ?? 0; }
    if (rb <= 1e-12) { j++; rb = bids[j]?.size ?? 0; }
  }
  return {
    tiers: tiers.map((minNet, k) => ({ minNet, sizeUsd: Math.round(tierSize[k]) })),
    maxSizeUsd: Math.round(maxSizeUsd), profitUsd: Math.round(profitUsd * 100) / 100, ts: Date.now(),
  };
}

const gd = globalThis as unknown as { __arbDepth?: Map<string, DepthLadder> };
gd.__arbDepth ??= new Map();
const DEPTH_FRESH_MS = 15_000;
/** 최근 프리웜이 계산한 사다리. 15초 넘게 낡았으면 없는 것으로. */
export function depthOf(oppId: string): DepthLadder | undefined {
  const d = gd.__arbDepth!.get(oppId);
  return d && Date.now() - d.ts < DEPTH_FRESH_MS ? d : undefined;
}

async function computeDepth(o: Opportunity): Promise<void> {
  const buyLeg = o.legs.find((l) => l.side === "buy");
  const sellLeg = o.legs.find((l) => l.side === "sell");
  if (!buyLeg || !sellLeg || buyLeg.venue === "dex" || sellLeg.venue === "dex") return;
  const buyAd = getAdapter(buyLeg.venue), sellAd = getAdapter(sellLeg.venue);
  if (!buyAd?.fetchOrderBook || !sellAd?.fetchOrderBook) return;
  const krVenue: Venue | null = buyLeg.quote === "KRW" ? buyLeg.venue : sellLeg.quote === "KRW" ? sellLeg.venue : null;
  const [usdKrw, buyBook, sellBook] = await Promise.all([
    krVenue ? cachedFx(krVenue, false) : Promise.resolve(1),
    cachedBook(buyAd.fetchOrderBook.bind(buyAd), buyLeg.venue, buyLeg.symbol, false, PREWARM_MS - 500),
    cachedBook(sellAd.fetchOrderBook.bind(sellAd), sellLeg.venue, sellLeg.symbol, false, PREWARM_MS - 500),
  ]);
  if (!usdKrw) return;
  const asks = buyBook.asks.map((l) => ({ priceUsd: toUsd(l.price, buyLeg.quote, usdKrw), size: l.size })).filter((l) => l.priceUsd > 0).sort((a, b) => a.priceUsd - b.priceUsd);
  const bids = sellBook.bids.map((l) => ({ priceUsd: toUsd(l.price, sellLeg.quote, usdKrw), size: l.size })).filter((l) => l.priceUsd > 0).sort((a, b) => b.priceUsd - a.priceUsd);
  if (!asks.length || !bids.length) return;
  gd.__arbDepth!.set(o.id, ladderFromBooks(asks, bids, o.costPct));
}

export async function prewarmBooks(opps: Opportunity[]): Promise<void> {
  try {
    const top = opps
      .filter((o) => !o.mock && o.kind !== "funding-basis" && o.netPct > 0)
      .sort((a, b) => b.netPct - a.netPct)
      .slice(0, PREWARM_TOP);
    const jobs: Promise<unknown>[] = [];
    const seen = new Set<string>();
    for (const o of top) {
      // 사다리 — 같은 캐시를 읽으므로 아래 개별 프리웜과 요청이 겹치지 않는다.
      jobs.push(computeDepth(o).catch(() => undefined));
      for (const leg of o.legs) {
        if (leg.venue === "dex") continue;
        const ad = getAdapter(leg.venue);
        if (!ad?.fetchOrderBook) continue;
        const key = `${leg.venue}:${leg.symbol}`;
        if (!seen.has(key)) {
          seen.add(key);
          jobs.push(cachedBook(ad.fetchOrderBook.bind(ad), leg.venue, leg.symbol, false, PREWARM_MS - 500).catch(() => undefined));
        }
        if (leg.quote === "KRW" && !seen.has(`fx:${leg.venue}`)) {
          seen.add(`fx:${leg.venue}`);
          jobs.push(cachedFx(leg.venue, false).catch(() => undefined));
        }
      }
    }
    await Promise.all(jobs);
  } catch { /* 프리웜 실패가 다른 것을 깨면 안 된다 — 다음 틱이 다시 채운다 */ }
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
): Promise<{ slipPct: number; filled: boolean; vwap?: number } | null> {
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
    // vwap은 **거래소 표기 통화**(KR이면 KRW) — 모의 체결이 이 값으로 채운다.
    return { slipPct: ((vwap - book.asks[0].price) / book.asks[0].price) * 100, filled: r.filled, vwap };
  }
  const qty = size.baseQty ?? 0;
  if (qty <= 0) return null;
  const r = sellInto(lv(book.bids), qty);
  if (!r.filled && r.proceeds <= 0) return { slipPct: Infinity, filled: false };
  const vwap = r.proceeds / qty; // full qty basis; partial fill drags vwap down (conservative)
  return { slipPct: ((book.bids[0].price - vwap) / book.bids[0].price) * 100, filled: r.filled, vwap };
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

  // cex-dex: dex 다리는 오더북 어댑터가 없다 — OKX 실시간 견적으로 별도 평가.
  // (없으면 재검증이 항상 "재조회 실패"로 죽는다.)
  if (buyLeg.venue === "dex" || sellLeg.venue === "dex") {
    return quoteCexDexLeg(opp, sizeUsd, buyLeg, sellLeg, fresh);
  }

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

// ── cex-dex 재검증 견적 — DEX 다리는 OKX 라우팅 실견적, CEX 다리는 실호가 ──
async function binancePx(symbol: string): Promise<number | null> {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, {
      cache: "no-store", signal: AbortSignal.timeout(4000),
    });
    const j = (await r.json()) as { price?: string };
    return j.price ? Number(j.price) : null;
  } catch { return null; }
}

async function quoteCexDexLeg(
  opp: Opportunity, sizeUsd: number,
  buyLeg: Opportunity["legs"][number], sellLeg: Opportunity["legs"][number],
  fresh: boolean,
): Promise<Quote | null> {
  const { quoteDex, gasPriceWei, gasCostUsd, QUOTE_STABLES, CEXDEX_CHAINS, allTokens } = await import("./dex");
  const dexLeg = buyLeg.venue === "dex" ? buyLeg : sellLeg;
  const cexLeg = buyLeg.venue === "dex" ? sellLeg : buyLeg;
  const dexBuys = dexLeg.side === "buy";
  const chainKey = dexLeg.symbol.split("@")[1];
  if (!chainKey) return null;
  const uni = CEXDEX_CHAINS.find((u) => u.chain === chainKey);
  const stable = uni?.quote ?? QUOTE_STABLES[chainKey];
  let token = uni?.bases[opp.base];
  if (!token) token = (await allTokens(chainKey)).get(opp.base) ?? undefined;
  if (!stable || !token) return null;

  // CEX 다리 실호가 (뎁스 슬리피지 포함)
  const ad = getAdapter(cexLeg.venue);
  if (!ad?.fetchOrderBook) return null;
  const book = await cachedBook(ad.fetchOrderBook.bind(ad), cexLeg.venue, cexLeg.symbol, fresh);
  const cexLevels: LevelUsd[] = (dexBuys ? book.bids : book.asks)
    .map((l) => ({ priceUsd: l.price, size: l.size }))
    .filter((l) => l.priceUsd > 0);
  if (!cexLevels.length) return null;

  // 가스비 산정용 네이티브 USD — 바낸 공개 시세
  const native = uni?.native ?? "ETH";
  const [gasWei, nativeUsd] = await Promise.all([gasPriceWei(chainKey), binancePx(`${native}USDT`)]);

  let base: number, avgBuyUsd: number, avgSellUsd: number, gasUnits: number;
  if (dexBuys) {
    // DEX에서 sizeUsd 매수 → CEX bids에 매도
    const q = await quoteDex(chainKey, stable, token, sizeUsd);
    if (!q || q.toAmount <= 0) return null;
    base = q.toAmount; avgBuyUsd = sizeUsd / q.toAmount; gasUnits = q.gasUnits;
    const { proceeds } = sellInto(cexLevels.sort((a, b) => b.priceUsd - a.priceUsd), base);
    if (proceeds <= 0) return null;
    avgSellUsd = proceeds / base;
  } else {
    // CEX asks에서 매수 → DEX에 매도
    const { base: b } = buyInto(cexLevels.sort((a, b) => a.priceUsd - b.priceUsd), sizeUsd);
    if (b <= 0) return null;
    base = b; avgBuyUsd = sizeUsd / b;
    const q = await quoteDex(chainKey, token, stable, base);
    if (!q || q.toAmount <= 0) return null;
    avgSellUsd = q.toAmount / base; gasUnits = q.gasUnits;
  }

  const grossPct = (avgSellUsd / avgBuyUsd - 1) * 100;
  const takerPct = FEES.takerPct[cexLeg.venue] ?? 0.1;
  const gasUsd = gasWei && nativeUsd ? gasCostUsd(gasUnits, gasWei, nativeUsd) : 0;
  const sendGasUsd = gasWei && nativeUsd && dexBuys ? gasCostUsd(65_000, gasWei, nativeUsd) : 0;
  const wFeeCoin2 = withdrawFeeCoin(opp.base);
  // 전송 다리: buyDex = 지갑→CEX 전송 가스 / sellDex = CEX 출금 수수료
  const transferPct = dexBuys
    ? ((gasUsd + sendGasUsd) / sizeUsd) * 100
    : (gasUsd / sizeUsd) * 100 + (wFeeCoin2 != null ? ((wFeeCoin2 * avgBuyUsd) / sizeUsd) * 100 : 0.05);
  const feePct = takerPct + transferPct + 0.1; // + MEV/재견적 버퍼
  const netPct = grossPct - feePct;
  return {
    sizeUsd,
    execBuyPriceUsd: avgBuyUsd, execSellPriceUsd: avgSellUsd,
    execGrossPct: grossPct,
    buySlippagePct: 0, sellSlippagePct: 0, // DEX 라우팅 견적에 내재
    takerPct, fxSpreadPct: 0,
    withdrawalPct: transferPct, feePct,
    execNetPct: netPct,
    maxSizeUsd: netPct > 0 ? sizeUsd : 0,
    filledFully: true,
    note: `DEX 실견적(${chainKey}) 기준`,
  };
}

