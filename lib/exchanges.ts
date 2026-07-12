// Exchange adapters. Each venue implements the same interface so strategies and
// the execution engine stay venue-agnostic.
//
// Market-data reads use public REST (no keys). Order placement is stubbed — it
// requires signed keys and is gated behind CONFIG.DRY_RUN. Fill these in per
// venue when wiring real semi-auto execution.

import type {
  OrderBook,
  OrderRequest,
  OrderResult,
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
  /** Place a single order. Throws unless keys are configured; DRY_RUN simulates upstream. */
  placeOrder(req: OrderRequest): Promise<OrderResult>;
}

const EMPTY_BOOK: OrderBook = { bids: [], asks: [] };

// ── Binance (global CEX, USDT quote) ──────────────────────────────────────────
const binance: ExchangeAdapter = {
  venue: "binance",
  kind: "cex",
  async fetchTickers() {
    const out: TickerMap = new Map();
    try {
      const res = await fetch("https://api.binance.com/api/v3/ticker/24hr", {
        cache: "no-store",
      });
      const rows = (await res.json()) as Array<{
        symbol: string;
        lastPrice: string;
        quoteVolume: string;
      }>;
      for (const r of rows) {
        if (!r.symbol.endsWith("USDT")) continue;
        const base = r.symbol.slice(0, -4);
        out.set(base, {
          price: Number(r.lastPrice),
          quote: "USDT",
          quoteVolumeUsd: Number(r.quoteVolume),
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
  async placeOrder(req) {
    // TODO: sign with BINANCE_KEY/SECRET and POST /api/v3/order.
    throw new Error(`binance.placeOrder not wired (${req.side} ${req.symbol})`);
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
  async placeOrder(req) {
    // TODO: sign with UPBIT_KEY/SECRET (JWT) and POST /v1/orders.
    throw new Error(`upbit.placeOrder not wired (${req.side} ${req.symbol})`);
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
  async placeOrder(req) {
    // TODO: sign with BITHUMB_KEY/SECRET and POST /trade/place.
    throw new Error(`bithumb.placeOrder not wired (${req.side} ${req.symbol})`);
  },
};

export const EXCHANGES: Record<string, ExchangeAdapter> = {
  binance,
  upbit,
  bithumb,
  // TODO: bybit, okx (cross-cex + funding), uniswap (cex-dex / on-chain).
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
