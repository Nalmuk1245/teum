// Exchange adapters — public market data (tickers + L2 order books) per venue.
// Signed calls (orders/withdrawals/deposits) live in lib/orders.ts & lib/deposits.ts.

import type {
  OrderBook,
  TickerMap,
  Venue,
  VenueKind,
} from "./types";

export interface ExchangeAdapter {
  venue: Venue;
  kind: VenueKind;
  /** Public 24h tickers keyed by base symbol. Returns empty on failure. */
  fetchTickers(): Promise<TickerMap>;
  /** Live L2 order book for one symbol (best-first). Undefined = not wired. */
  fetchOrderBook?(symbol: string): Promise<OrderBook>;
}

const EMPTY_BOOK: OrderBook = { bids: [], asks: [] };

// EVERY fetch in this file runs on the 3s scan tick. A request without a
// deadline can hang indefinitely (undici will wait out a silent socket), and a
// hung tick leaves scanCache's `refreshing` latch set → the whole board freezes
// on a stale snapshot until restart. So: no bare fetch in this module.
const TICK_MS = 2500; // per-request budget on the scan path
const BOOK_MS = 4000; // order books are fetched off-tick (quote/revalidate)
const jfetch = async <T>(url: string, ms: number): Promise<T | null> => {
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(ms) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null; // timeout / network / geo block / bad JSON — caller degrades
  }
};

// 24h quote volumes, refreshed off the scan tick. `type=MINI` drops the fields
// we never read (price change, bid/ask, counts) — the full payload is ~1.8MB.
const gv = globalThis as unknown as {
  __bnVol?: { ts: number; vol: Map<string, number> };
  __bnVolBusy?: boolean;
};
async function refreshBinanceVolumes(): Promise<void> {
  if (gv.__bnVolBusy) return; // one in flight is enough
  gv.__bnVolBusy = true;
  try {
    const rows = await jfetch<Array<{ symbol: string; quoteVolume: string }>>(
      "https://api.binance.com/api/v3/ticker/24hr?type=MINI",
      8000, // off-tick, so it may take longer than a tick budget
    );
    if (!Array.isArray(rows)) return;
    const vol = new Map<string, number>();
    for (const r of rows) {
      if (r.symbol.endsWith("USDT")) vol.set(r.symbol.slice(0, -4), Number(r.quoteVolume));
    }
    gv.__bnVol = { ts: Date.now(), vol };
  } finally {
    gv.__bnVolBusy = false;
  }
}

// ── Binance (global CEX, USDT quote) ──────────────────────────────────────────
const binance: ExchangeAdapter = {
  venue: "binance",
  kind: "cex",
  async fetchTickers() {
    const out: TickerMap = new Map();
    try {
      // Fast path every scan: bookTicker (weight 2, ~0.7s) gives live best
      // bid/ask for every symbol. The heavy 24hr endpoint (weight 80, ~1.4s)
      // only supplies volumes, which move slowly — cache it for 60s.
      const g = globalThis as unknown as { __bnVol?: { ts: number; vol: Map<string, number> } };
      const volStale = !g.__bnVol || Date.now() - g.__bnVol.ts > 60_000;
      // Volume refresh runs OFF the tick (fire-and-forget): the full 24hr payload
      // is ~1.8MB and its JSON.parse alone blocks ~250ms. Volumes move on the
      // hour, so serving the previous generation costs nothing — but making the
      // tick wait for it does. First scan has no volumes; the gate treats 0 as
      // "unknown" and MIN_VOLUME_USD filters it, which self-corrects in ~1s.
      if (volStale) void refreshBinanceVolumes();
      const vols = g.__bnVol?.vol;
      const books = await jfetch<Array<{
        symbol: string; bidPrice: string; askPrice: string; bidQty: string; askQty: string;
      }>>("https://api.binance.com/api/v3/ticker/bookTicker", TICK_MS);
      if (!Array.isArray(books)) return out;
      for (const r of books) {
        if (!r.symbol.endsWith("USDT")) continue;
        const base = r.symbol.slice(0, -4);
        const bid = Number(r.bidPrice), ask = Number(r.askPrice);
        if (!(bid > 0) || !(ask > 0)) continue;
        out.set(base, {
          price: (bid + ask) / 2,
          quote: "USDT",
          quoteVolumeUsd: vols?.get(base) ?? 0,
          bid, ask,
          bidSize: Number(r.bidQty) || undefined, askSize: Number(r.askQty) || undefined,
        });
      }
    } catch {
      /* network / geo block — return what we have */
    }
    return out;
  },
  async fetchOrderBook(symbol) {
    const j = await jfetch<{ bids: [string, string][]; asks: [string, string][] }>(
      `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=100`,
      BOOK_MS,
    );
    if (!j?.bids || !j?.asks) return EMPTY_BOOK;
    const map = (rows: [string, string][]) =>
      rows.map(([p, q]) => ({ price: Number(p), size: Number(q) }));
    return { bids: map(j.bids), asks: map(j.asks) };
  },
};

// Upbit's KRW market list, TTL-cached. It was being fetched every 3s here AND
// every 3s by the listing watcher (same URL, ~61KB, ~1s) — the single biggest
// item on the tick's critical path. The listing watcher owns *detecting* new
// markets, so it invalidates this cache when it sees one (see `bustUpbitMarkets`)
// rather than both loops polling independently.
const UPBIT_MARKETS_TTL = 60_000;
const gm = globalThis as unknown as { __upMarkets?: { ts: number; krw: string[] } };
export async function upbitKrwMarkets(): Promise<string[]> {
  const hit = gm.__upMarkets;
  if (hit && Date.now() - hit.ts < UPBIT_MARKETS_TTL) return hit.krw;
  const markets = await jfetch<Array<{ market: string }>>(
    "https://api.upbit.com/v1/market/all", TICK_MS,
  );
  if (!Array.isArray(markets)) return hit?.krw ?? []; // serve stale over nothing
  const krw = markets.map((m) => m.market).filter((m) => m.startsWith("KRW-"));
  gm.__upMarkets = { ts: Date.now(), krw };
  return krw;
}
/** Force the next `upbitKrwMarkets()` to refetch — called when the listing
 *  watcher detects a new market, so a fresh listing never waits out the TTL. */
export function bustUpbitMarkets(): void {
  gm.__upMarkets = undefined;
}

// ── Upbit (KR CEX, KRW quote) ─────────────────────────────────────────────────
// NOTE: Upbit's CDN 403s non-Korean IPs — from a non-KR host fetchTickers will
// return empty. Deploy to a KR region (or relay) for live kimchi data.
const upbit: ExchangeAdapter = {
  venue: "upbit",
  kind: "cex",
  async fetchTickers() {
    const out: TickerMap = new Map();
    const krw = await upbitKrwMarkets();
    if (!krw.length) return out;
    // Upbit caps the query length → chunk. Chunks are INDEPENDENT, so fetch them
    // in parallel (3 chunks serial cost ~550ms of the tick). Upbit's quotation
    // cap is 10 req/s; ticker+orderbook chunks together stay well under it.
    const chunk = (arr: string[]) => {
      const cs: string[] = [];
      for (let i = 0; i < arr.length; i += 100) cs.push(arr.slice(i, i + 100).join(","));
      return cs;
    };
    const tickChunks = chunk(krw);
    const tickLists = await Promise.all(
      tickChunks.map((c) =>
        jfetch<Array<{ market: string; trade_price: number; acc_trade_price_24h: number }>>(
          `https://api.upbit.com/v1/ticker?markets=${c}`, TICK_MS,
        ),
      ),
    );
    for (const rows of tickLists) {
      if (!Array.isArray(rows)) continue;
      for (const r of rows) {
        out.set(r.market.replace("KRW-", ""), {
          price: r.trade_price,
          quote: "KRW",
          quoteVolumeUsd: r.acc_trade_price_24h, // KRW; approx, refine later
        });
      }
    }
    if (!out.size) return out;
    // Merge best bid/ask from bulk orderbook calls (chunked, parallel).
    const obLists = await Promise.all(
      chunk([...out.keys()].map((b) => `KRW-${b}`)).map((c) =>
        jfetch<Array<{ market: string; orderbook_units: Array<{ ask_price: number; bid_price: number; ask_size: number; bid_size: number }> }>>(
          `https://api.upbit.com/v1/orderbook?markets=${c}`, TICK_MS,
        ),
      ),
    );
    for (const obs of obLists) {
      if (!Array.isArray(obs)) continue;
      for (const ob of obs) {
        const u = ob.orderbook_units?.[0];
        const e = out.get(ob.market.replace("KRW-", ""));
        if (u && e) { e.bid = u.bid_price; e.ask = u.ask_price; e.bidSize = u.bid_size; e.askSize = u.ask_size; }
      }
    }
    return out;
  },
  async fetchOrderBook(symbol) {
    const j = await jfetch<Array<{
      orderbook_units: Array<{ ask_price: number; bid_price: number; ask_size: number; bid_size: number }>;
    }>>(`https://api.upbit.com/v1/orderbook?markets=${symbol}`, BOOK_MS);
    const units = j?.[0]?.orderbook_units ?? [];
    return {
      bids: units.map((u) => ({ price: u.bid_price, size: u.bid_size })),
      asks: units.map((u) => ({ price: u.ask_price, size: u.ask_size })),
    };
  },
};

// ── Bithumb (KR CEX, KRW quote) ───────────────────────────────────────────────
const bithumb: ExchangeAdapter = {
  venue: "bithumb",
  kind: "cex",
  async fetchTickers() {
    const out: TickerMap = new Map();
    // Ticker and orderbook are independent endpoints — fetch both at once
    // (they were serial: ~560ms + ~420ms of the tick for no reason).
    const [j, ob] = await Promise.all([
      jfetch<{
        status: string;
        data: Record<string, { closing_price: string; acc_trade_value_24H: string }>;
      }>("https://api.bithumb.com/public/ticker/ALL_KRW", TICK_MS),
      jfetch<{
        status: string;
        data?: Record<string, { bids?: Array<{ price: string; quantity: string }>; asks?: Array<{ price: string; quantity: string }> }>;
      }>("https://api.bithumb.com/public/orderbook/ALL_KRW", TICK_MS),
    ]);
    if (j?.status !== "0000" || !j.data) return out;
    for (const [base, v] of Object.entries(j.data)) {
      if (base === "date") continue; // sentinel field, not a coin
      out.set(base, {
        price: Number(v.closing_price),
        quote: "KRW",
        quoteVolumeUsd: Number(v.acc_trade_value_24H), // KRW; approx
      });
    }
    if (ob?.status === "0000" && ob.data) {
      for (const [base, d] of Object.entries(ob.data)) {
        const e = out.get(base);
        const bid = d.bids?.[0], ask = d.asks?.[0];
        if (e && bid && ask) { e.bid = Number(bid.price); e.ask = Number(ask.price); e.bidSize = Number(bid.quantity); e.askSize = Number(ask.quantity); }
      }
    }
    return out;
  },
  async fetchOrderBook(symbol) {
    // symbol arrives as BASE_KRW → Bithumb path is /public/orderbook/BASE_KRW
    const j = await jfetch<{
      status: string;
      data?: {
        bids: Array<{ price: string; quantity: string }>;
        asks: Array<{ price: string; quantity: string }>;
      };
    }>(`https://api.bithumb.com/public/orderbook/${symbol}`, BOOK_MS);
    if (j?.status !== "0000" || !j.data) return EMPTY_BOOK;
    const map = (rows: Array<{ price: string; quantity: string }>) =>
      rows.map((r) => ({ price: Number(r.price), size: Number(r.quantity) }));
    return { bids: map(j.data.bids), asks: map(j.data.asks) };
  },
};

// ── Bybit (global CEX, USDT quote) ────────────────────────────────────────────
const bybit: ExchangeAdapter = {
  venue: "bybit",
  kind: "cex",
  async fetchTickers() {
    const out: TickerMap = new Map();
    try {
      const res = await fetch("https://api.bybit.com/v5/market/tickers?category=spot", {
        cache: "no-store", signal: AbortSignal.timeout(6000),
      });
      const j = (await res.json()) as {
        retCode: number;
        result?: { list?: Array<{ symbol: string; lastPrice: string; turnover24h: string; bid1Price?: string; ask1Price?: string; bid1Size?: string; ask1Size?: string }> };
      };
      if (j.retCode !== 0) return out;
      for (const r of j.result?.list ?? []) {
        if (!r.symbol.endsWith("USDT")) continue;
        out.set(r.symbol.slice(0, -4), {
          price: Number(r.lastPrice),
          quote: "USDT",
          quoteVolumeUsd: Number(r.turnover24h),
          bid: Number(r.bid1Price) || undefined, ask: Number(r.ask1Price) || undefined,
          bidSize: Number(r.bid1Size) || undefined, askSize: Number(r.ask1Size) || undefined,
        });
      }
    } catch {
      /* network */
    }
    return out;
  },
  async fetchOrderBook(symbol) {
    try {
      const res = await fetch(
        `https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${symbol}&limit=50`,
        { cache: "no-store", signal: AbortSignal.timeout(6000) },
      );
      const j = (await res.json()) as {
        retCode: number;
        result?: { a?: [string, string][]; b?: [string, string][] };
      };
      if (j.retCode !== 0 || !j.result) return EMPTY_BOOK;
      const map = (rows: [string, string][] = []) =>
        rows.map(([p, q]) => ({ price: Number(p), size: Number(q) }));
      return { bids: map(j.result.b), asks: map(j.result.a) };
    } catch {
      return EMPTY_BOOK;
    }
  },
};

// ── OKX (global CEX, USDT quote) ──────────────────────────────────────────────
const okx: ExchangeAdapter = {
  venue: "okx",
  kind: "cex",
  async fetchTickers() {
    const out: TickerMap = new Map();
    try {
      const res = await fetch("https://www.okx.com/api/v5/market/tickers?instType=SPOT", {
        cache: "no-store", signal: AbortSignal.timeout(6000),
      });
      const j = (await res.json()) as {
        code: string;
        data?: Array<{ instId: string; last: string; volCcy24h: string; bidPx?: string; askPx?: string; bidSz?: string; askSz?: string }>;
      };
      if (j.code !== "0") return out;
      for (const r of j.data ?? []) {
        if (!r.instId.endsWith("-USDT")) continue;
        out.set(r.instId.slice(0, -5), {
          price: Number(r.last),
          quote: "USDT",
          quoteVolumeUsd: Number(r.volCcy24h),
          bid: Number(r.bidPx) || undefined, ask: Number(r.askPx) || undefined,
          bidSize: Number(r.bidSz) || undefined, askSize: Number(r.askSz) || undefined,
        });
      }
    } catch {
      /* network */
    }
    return out;
  },
  async fetchOrderBook(symbol) {
    try {
      // symbol arrives OKX-native: BASE-USDT
      const res = await fetch(`https://www.okx.com/api/v5/market/books?instId=${symbol}&sz=50`, {
        cache: "no-store", signal: AbortSignal.timeout(6000),
      });
      const j = (await res.json()) as {
        code: string;
        data?: Array<{ asks: string[][]; bids: string[][] }>;
      };
      const d = j.data?.[0];
      if (j.code !== "0" || !d) return EMPTY_BOOK;
      const map = (rows: string[][] = []) =>
        rows.map(([p, q]) => ({ price: Number(p), size: Number(q) }));
      return { bids: map(d.bids), asks: map(d.asks) };
    } catch {
      return EMPTY_BOOK;
    }
  },
};

export const EXCHANGES: Record<string, ExchangeAdapter> = {
  binance,
  upbit,
  bithumb,
  bybit,
  okx,
  // TODO: uniswap (cex-dex / on-chain).
};

export function getAdapter(venue: Venue): ExchangeAdapter | undefined {
  return EXCHANGES[venue];
}

/** Live USDT/KRW for a KR venue via a single ticker call (for depth quoting).
 *  Sits on the pre-order revalidation path, so it must never hang. */
export async function fetchUsdKrw(venue: Venue): Promise<number | null> {
  if (venue === "upbit") {
    const j = await jfetch<Array<{ trade_price: number }>>(
      "https://api.upbit.com/v1/ticker?markets=KRW-USDT", TICK_MS,
    );
    return j?.[0]?.trade_price ?? null;
  }
  if (venue === "bithumb") {
    const j = await jfetch<{ status: string; data?: { closing_price: string } }>(
      "https://api.bithumb.com/public/ticker/USDT_KRW", TICK_MS,
    );
    return j?.status === "0000" && j.data ? Number(j.data.closing_price) : null;
  }
  return null;
}
