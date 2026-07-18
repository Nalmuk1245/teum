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
      const [bookRes, volRes] = await Promise.all([
        fetch("https://api.binance.com/api/v3/ticker/bookTicker", { cache: "no-store" }),
        volStale
          ? fetch("https://api.binance.com/api/v3/ticker/24hr", { cache: "no-store" })
          : Promise.resolve(null),
      ]);
      if (volRes) {
        const rows = (await volRes.json()) as Array<{ symbol: string; quoteVolume: string }>;
        const vol = new Map<string, number>();
        for (const r of rows) if (r.symbol.endsWith("USDT")) vol.set(r.symbol.slice(0, -4), Number(r.quoteVolume));
        g.__bnVol = { ts: Date.now(), vol };
      }
      const vols = g.__bnVol?.vol;
      const books = (await bookRes.json()) as Array<{
        symbol: string; bidPrice: string; askPrice: string; bidQty: string; askQty: string;
      }>;
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
    try {
      const res = await fetch(
        `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=100`,
        { cache: "no-store" },
      );
      const j = (await res.json()) as { bids: [string, string][]; asks: [string, string][] };
      if (!j.bids || !j.asks) return EMPTY_BOOK;
      const map = (rows: [string, string][]) =>
        rows.map(([p, q]) => ({ price: Number(p), size: Number(q) }));
      return { bids: map(j.bids), asks: map(j.asks) };
    } catch {
      return EMPTY_BOOK;
    }
  },
};

// ── Upbit (KR CEX, KRW quote) ─────────────────────────────────────────────────
// NOTE: Upbit's CDN 403s non-Korean IPs — from a non-KR host fetchTickers will
// return empty. Deploy to a KR region (or relay) for live kimchi data.
const upbit: ExchangeAdapter = {
  venue: "upbit",
  kind: "cex",
  async fetchTickers() {
    const out: TickerMap = new Map();
    try {
      const mkRes = await fetch("https://api.upbit.com/v1/market/all", {
        cache: "no-store",
      });
      const markets = (await mkRes.json()) as Array<{ market: string }>;
      const krw = markets
        .map((m) => m.market)
        .filter((m) => m.startsWith("KRW-"));
      // Upbit caps the ticker query length — chunk the market list.
      for (let i = 0; i < krw.length; i += 100) {
        const chunk = krw.slice(i, i + 100).join(",");
        const res = await fetch(
          `https://api.upbit.com/v1/ticker?markets=${chunk}`,
          { cache: "no-store" },
        );
        const rows = (await res.json()) as Array<{
          market: string;
          trade_price: number;
          acc_trade_price_24h: number;
        }>;
        for (const r of rows) {
          const base = r.market.replace("KRW-", "");
          out.set(base, {
            price: r.trade_price,
            quote: "KRW",
            quoteVolumeUsd: r.acc_trade_price_24h, // KRW; approx, refine later
          });
        }
      }
      // Merge best bid/ask from a bulk orderbook call (multi-market, chunked,
      // chunks fetched in parallel — well under Upbit's 10 req/s quotation cap).
      const codes = [...out.keys()].map((b) => `KRW-${b}`);
      const chunks: string[] = [];
      for (let i = 0; i < codes.length; i += 100) chunks.push(codes.slice(i, i + 100).join(","));
      const obLists = await Promise.all(chunks.map(async (chunk) => {
        const obRes = await fetch(`https://api.upbit.com/v1/orderbook?markets=${chunk}`, { cache: "no-store" });
        return (await obRes.json()) as Array<{ market: string; orderbook_units: Array<{ ask_price: number; bid_price: number; ask_size: number; bid_size: number }> }>;
      }));
      for (const obs of obLists) {
        if (!Array.isArray(obs)) continue;
        for (const ob of obs) {
          const base = ob.market.replace("KRW-", "");
          const u = ob.orderbook_units?.[0];
          const e = out.get(base);
          if (u && e) { e.bid = u.bid_price; e.ask = u.ask_price; e.bidSize = u.bid_size; e.askSize = u.ask_size; }
        }
      }
    } catch {
      /* geo block / network */
    }
    return out;
  },
  async fetchOrderBook(symbol) {
    try {
      const res = await fetch(
        `https://api.upbit.com/v1/orderbook?markets=${symbol}`,
        { cache: "no-store" },
      );
      const j = (await res.json()) as Array<{
        orderbook_units: Array<{
          ask_price: number; bid_price: number; ask_size: number; bid_size: number;
        }>;
      }>;
      const units = j[0]?.orderbook_units ?? [];
      return {
        bids: units.map((u) => ({ price: u.bid_price, size: u.bid_size })),
        asks: units.map((u) => ({ price: u.ask_price, size: u.ask_size })),
      };
    } catch {
      return EMPTY_BOOK;
    }
  },
};

// ── Bithumb (KR CEX, KRW quote) ───────────────────────────────────────────────
const bithumb: ExchangeAdapter = {
  venue: "bithumb",
  kind: "cex",
  async fetchTickers() {
    const out: TickerMap = new Map();
    try {
      const res = await fetch("https://api.bithumb.com/public/ticker/ALL_KRW", {
        cache: "no-store",
      });
      const j = (await res.json()) as {
        status: string;
        data: Record<string, { closing_price: string; acc_trade_value_24H: string }>;
      };
      if (j.status !== "0000") return out;
      for (const [base, v] of Object.entries(j.data)) {
        if (base === "date") continue; // sentinel field, not a coin
        out.set(base, {
          price: Number(v.closing_price),
          quote: "KRW",
          quoteVolumeUsd: Number(v.acc_trade_value_24H), // KRW; approx
        });
      }
      // Merge best bid/ask from the ALL-coins orderbook (one call).
      const obRes = await fetch("https://api.bithumb.com/public/orderbook/ALL_KRW", { cache: "no-store" });
      const ob = (await obRes.json()) as {
        status: string;
        data?: Record<string, { bids?: Array<{ price: string; quantity: string }>; asks?: Array<{ price: string; quantity: string }> }>;
      };
      if (ob.status === "0000" && ob.data) {
        for (const [base, d] of Object.entries(ob.data)) {
          const e = out.get(base);
          const bid = d.bids?.[0], ask = d.asks?.[0];
          if (e && bid && ask) { e.bid = Number(bid.price); e.ask = Number(ask.price); e.bidSize = Number(bid.quantity); e.askSize = Number(ask.quantity); }
        }
      }
    } catch {
      /* geo block / network */
    }
    return out;
  },
  async fetchOrderBook(symbol) {
    try {
      // symbol arrives as BASE_KRW → Bithumb path is /public/orderbook/BASE_KRW
      const res = await fetch(`https://api.bithumb.com/public/orderbook/${symbol}`, {
        cache: "no-store",
      });
      const j = (await res.json()) as {
        status: string;
        data?: {
          bids: Array<{ price: string; quantity: string }>;
          asks: Array<{ price: string; quantity: string }>;
        };
      };
      if (j.status !== "0000" || !j.data) return EMPTY_BOOK;
      const map = (rows: Array<{ price: string; quantity: string }>) =>
        rows.map((r) => ({ price: Number(r.price), size: Number(r.quantity) }));
      return { bids: map(j.data.bids), asks: map(j.data.asks) };
    } catch {
      return EMPTY_BOOK;
    }
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

/** Live USDT/KRW for a KR venue via a single ticker call (for depth quoting). */
export async function fetchUsdKrw(venue: Venue): Promise<number | null> {
  try {
    if (venue === "upbit") {
      const res = await fetch("https://api.upbit.com/v1/ticker?markets=KRW-USDT", { cache: "no-store" });
      const j = (await res.json()) as Array<{ trade_price: number }>;
      return j[0]?.trade_price ?? null;
    }
    if (venue === "bithumb") {
      const res = await fetch("https://api.bithumb.com/public/ticker/USDT_KRW", { cache: "no-store" });
      const j = (await res.json()) as { status: string; data?: { closing_price: string } };
      return j.status === "0000" && j.data ? Number(j.data.closing_price) : null;
    }
  } catch {
    /* network */
  }
  return null;
}
