// Core domain types shared across strategies, scanner, and execution.

export type Venue =
  | "binance"
  | "upbit"
  | "bithumb"
  | "bybit"
  | "okx"
  | "hyperliquid" // perp DEX
  | "lighter" // perp DEX (zkLighter)
  | "dex" // spot DEX leg (OKX aggregator routing)
  | "uniswap"
  | "wallet"; // personal self-custody wallet (in-transit / on-chain assets)

export type VenueKind = "cex" | "dex";

export type StrategyKind =
  | "kimchi" // KR won premium vs global USDT
  | "cross-cex" // same coin, different CEX
  | "funding-basis" // perp funding vs spot (cash-and-carry)
  | "cex-dex"; // centralized vs on-chain DEX

export type Side = "buy" | "sell";

/** One venue-side of an arbitrage trade. */
export type Leg = {
  venue: Venue;
  side: Side;
  symbol: string; // venue-native symbol, e.g. BTCUSDT / KRW-BTC
  price: number; // in the leg's quote currency
  quote: string; // USDT / KRW / USD
};

// ── Transfer / settlement gate ────────────────────────────────────────────────
export type WalletStatus = { deposit: boolean; withdraw: boolean };
export type TransferStatus = {
  byVenue: Partial<Record<Venue, Map<string, WalletStatus>>>;
};

export type LegGate = { venue: Venue; enabled: boolean | null }; // null = unknown (needs key)
export type TransferGate = {
  withdraw: LegGate; // withdraw the bought coin from the buy venue
  deposit: LegGate; // deposit it to the sell venue
  etaMin: number; // estimated in-flight time = price-exposure window
  blocked: boolean; // a known-disabled leg → not settleable regardless of edge
  network?: { chain: string; confirms: number }; // transfer chain + deposit confirmations
};

/** A single ranked arbitrage opportunity, strategy-agnostic. */
export type Opportunity = {
  id: string;
  kind: StrategyKind;
  base: string; // BTC, ETH, …
  legs: Leg[]; // typically [buyLeg, sellLeg]
  grossPct: number; // raw spread before costs
  costPct: number; // modeled round-trip cost
  netPct: number; // grossPct − costPct (the edge)
  /** Executable notional (USD) before the edge decays past cost. null = unknown. */
  notionalCapUsd: number | null;
  /** False when a hard gate (deposits off, no route, stale price) blocks execution. */
  executable: boolean;
  hasPerp?: boolean; // Binance USDT-M perp exists → hedgeable
  transfer?: TransferGate; // deposit/withdraw status + ETA for the settlement legs
  /** How grossPct/netPct should be read: "trade" = one-shot % (default), "apr"
   *  = annualized yield (funding arb, held ongoing). */
  rateBasis?: "trade" | "apr";
  /** Gap persistence — how long/steadily this edge has held (flicker vs real). */
  persistence?: { heldSec: number; hitRatePct: number; samples: number; volPctPerMin: number };
  /** Transfer-window risk: expected premium drift over the in-flight ETA. The
   *  captured premium is at SELL time (minutes later), not now. */
  transferRisk?: { etaMin: number; driftPct: number; hedgeAdvised: boolean };
  /** Funding-basis timing: when the SHORT leg next settles + both intervals. */
  fundingMeta?: { nextTs: number | null; shortIntervalH: number | null; longIntervalH: number | null };
  note?: string;
  mock?: boolean; // sample data, not a live signal
  ts: number;
};

/** Snapshot of one venue's tickers, keyed by base symbol. Top-of-book (bid/ask)
 *  is filled where the venue provides it cheaply — used for executable pricing
 *  and a spread-based freshness/thinness gate. */
export type TickerMap = Map<
  string,
  {
    price: number; // last trade (fallback)
    quote: string;
    quoteVolumeUsd: number;
    bid?: number; ask?: number; // best bid/ask
    bidSize?: number; askSize?: number; // size at best (base units)
  }
>;

export type ScanContext = {
  /** Pre-fetched tickers per venue (scanner fills this once, strategies read it). */
  tickers: Partial<Record<Venue, TickerMap>>;
  usdKrw: number;
  fxLive: boolean; // usdKrw came from a live KR USDT market (false = env fallback)
  transfers?: TransferStatus; // per-coin deposit/withdraw availability
  perps?: Set<string>; // bases with a Binance USDT-M perp (hedgeable)
  funding?: FundingMap; // per-coin funding rates across perp venues
};

/** Per-coin funding across perp venues, normalized to an 8h rate (fraction). */
export type FundingRate = {
  venue: Venue;
  rate8h: number; // normalized to 8h basis for cross-venue comparison
  aprPct: number;
  nextTs: number | null; // next settlement (ms epoch) — funding pays only at this snapshot
  intervalH: number | null; // settlement interval in hours (8 = CEX, 1 = HL/Lighter)
  predicted: boolean; // true = next-window predicted rate, false = last snapshot
};
export type FundingMap = Map<string, FundingRate[]>;

export type BookLevel = { price: number; size: number }; // price in venue quote, size in base
export type OrderBook = { bids: BookLevel[]; asks: BookLevel[] };

/** Executable numbers for one opportunity at a given size, from live books. */
export type Quote = {
  sizeUsd: number;
  execBuyPriceUsd: number;
  execSellPriceUsd: number;
  execGrossPct: number; // spread from VWAP fills (post-slippage)
  buySlippagePct: number;
  sellSlippagePct: number;
  takerPct: number; // buy + sell taker
  fxSpreadPct: number;
  withdrawalPct: number; // real per-coin transfer fee as % of size
  feePct: number; // taker + fx + withdrawal
  execNetPct: number; // execGrossPct − feePct
  maxSizeUsd: number; // depth cap where net crosses 0
  filledFully: boolean; // books deep enough for the requested size
  note?: string;
};

// ── Balances / inventory ──────────────────────────────────────────────────────
export type CoinBal = { asset: string; amount: number; usdValue: number };
export type VenueBalance = {
  venue: Venue;
  connected: boolean; // false = no keys (needs signing) or fetch failed
  cashLabel: string; // "USDT" | "KRW"
  cashRaw: number; // native cash amount
  cashUsd: number; // cash valued in USD
  coins: CoinBal[]; // non-cash holdings, USD-valued, desc
  totalUsd: number;
};
export type Portfolio = {
  venues: VenueBalance[];
  wallet?: VenueBalance; // personal self-custody wallet (in-transit / on-chain)
  globalUsd: number; // USD-side dry powder + holdings (Binance)
  krUsd: number; // KR-side (Upbit + Bithumb)
  totalUsd: number; // global + kr + wallet
  skewPct: number; // global share of exchange capital (%) — 50 = balanced
  usdKrw: number;
  mock: boolean;
};

// (Exchange order/withdraw calls live in lib/orders.ts with their own result type.)
