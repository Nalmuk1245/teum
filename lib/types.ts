// Core domain types shared across strategies, scanner, and execution.

export type Venue =
  | "binance"
  | "upbit"
  | "bithumb"
  | "bybit"
  | "okx"
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
  note?: string;
  mock?: boolean; // sample data, not a live signal
  ts: number;
};

/** Snapshot of one venue's tickers, keyed by base symbol. */
export type TickerMap = Map<
  string,
  { price: number; quote: string; quoteVolumeUsd: number }
>;

export type ScanContext = {
  /** Pre-fetched tickers per venue (scanner fills this once, strategies read it). */
  tickers: Partial<Record<Venue, TickerMap>>;
  usdKrw: number;
  transfers?: TransferStatus; // per-coin deposit/withdraw availability
  perps?: Set<string>; // bases with a Binance USDT-M perp (hedgeable)
};

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

export type OrderRequest = {
  venue: Venue;
  side: Side;
  symbol: string;
  /** Notional in the quote currency of the symbol. */
  quoteAmount: number;
};

export type OrderResult = {
  venue: Venue;
  side: Side;
  symbol: string;
  status: "filled" | "simulated" | "rejected";
  filledPrice: number | null;
  message?: string;
};

export type ExecReport = {
  oppId: string;
  base: string;
  dryRun: boolean;
  sizeUsd: number;
  legs: OrderResult[];
  realizedNetPct: number | null;
  ok: boolean;
  ts: number;
};
