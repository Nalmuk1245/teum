// Central config + safety switches. Reads env, provides typed defaults.

export const CONFIG = {
  /** While true, execution only simulates fills — no real orders are sent. */
  DRY_RUN: process.env.DRY_RUN !== "false",
  /** Inject sample opportunities so the board renders without live/KR data. */
  USE_MOCK: process.env.USE_MOCK !== "false",
  /** USD/KRW fallback when no live FX source is wired. */
  USD_KRW: Number(process.env.USD_KRW ?? 1390),
  /** Assets excluded from premium-based strategies (stables / wrapped). */
  EXCLUDE: new Set([
    "USDT", "USDC", "DAI", "FDUSD", "BUSD", "TUSD", "USDP", "USDD",
    "WBTC", "WETH", "WBETH", "STETH", "CBETH", "BTCB",
  ]),
  /** Minimum global-leg 24h volume (USD) for a premium to be actionable. */
  MIN_VOLUME_USD: 5_000_000,
  /** Minimum KR-leg 24h volume (KRW). Drops thin pairs whose stale closing
   *  price fabricates a premium (esp. Bithumb's long tail). ~5억원. */
  MIN_KR_VOLUME_KRW: 500_000_000,
  /** Sanity cap — a |premium| above this is stale/broken data, not an edge. */
  MAX_ABS_PREMIUM_PCT: 40,
  /** Live market orders abort when the book-estimated slippage exceeds this. */
  MAX_SLIPPAGE_PCT: Number(process.env.MAX_SLIPPAGE_PCT ?? 0.5),
} as const;

/** Default round-trip cost model per strategy (% of notional). Tune later. */
export const COST_MODEL: Record<string, number> = {
  kimchi: 0.55, // fallback only; kimchi now uses the structured model below
  "cross-cex": 0.3,
  "funding-basis": 0.15,
  "cex-dex": 0.5, // + gas, handled per-opportunity later
};

// ── Structured fee model (used by the kimchi strategy) ────────────────────────
// Per-venue taker fees + a per-coin transfer cost make `net` realistic and
// coin-specific instead of a single flat number.
export const FEES = {
  /** Taker fee (%) per venue. */
  takerPct: {
    binance: 0.1,
    upbit: 0.05,
    bithumb: 0.04,
    bybit: 0.1,
    okx: 0.1,
  } as Record<string, number>,
  /** USDT/KRW conversion + rate variance across the trade window. */
  fxSpreadPct: 0.15,
  /** Default per-leg market-impact estimate (refine with real depth). */
  slippagePct: 0.1,
  /** Perp taker fee (%) per venue — for the funding-basis round trip. Lighter
   *  is currently zero-fee; HL ~0.045%. */
  perpTakerPct: {
    binance: 0.045,
    bybit: 0.055,
    okx: 0.05,
    hyperliquid: 0.045,
    lighter: 0.0,
  } as Record<string, number>,
};

// On-chain transfer/withdrawal cost as % of notional. Real withdrawal fees are
// flat coin amounts, so this is a rough tier — cheap chains (XRP/TRX) tiny,
// small caps larger. TODO: replace with live per-coin withdrawal fees / size.
export const NETWORK_PCT_DEFAULT = 0.12;
export const NETWORK_PCT: Record<string, number> = {
  BTC: 0.03, ETH: 0.05, XRP: 0.008, TRX: 0.006, SOL: 0.02, DOGE: 0.02,
  ADA: 0.02, AVAX: 0.02, MATIC: 0.02, ATOM: 0.02, TON: 0.02, USDT: 0.02,
  USDC: 0.02, XLM: 0.008, ALGO: 0.01,
};

// Estimated transfer time (network confirm + exchange crediting), in MINUTES.
// This is the price-exposure window while the coin is in-flight between venues.
// Rough per-coin defaults; refine with Binance estimatedArrivalTime once keyed.
export const TRANSFER_ETA_MIN: Record<string, number> = {
  BTC: 30, ETH: 6, BNB: 1, XRP: 1, TRX: 1, SOL: 1, DOGE: 15, ADA: 5,
  AVAX: 2, MATIC: 5, ATOM: 1, TON: 1, DOT: 3, LINK: 6, NEAR: 1, APT: 1,
  ARB: 3, OP: 3, SUI: 1, SEI: 1, XLM: 1, ALGO: 1, USDT: 3, USDC: 3, IOTA: 1,
};
export const TRANSFER_ETA_DEFAULT_MIN = 10;

// Transfer chain + typical deposit confirmations per coin. Representative values
// (Binance's actual minConfirm varies) — replaced by live networkList from
// `/sapi/v1/capital/config/getall` (needs key) once wired.
export const COIN_NETWORK: Record<string, { chain: string; confirms: number }> = {
  BTC: { chain: "Bitcoin", confirms: 1 },
  ETH: { chain: "Ethereum (ERC20)", confirms: 12 },
  XRP: { chain: "XRP Ledger", confirms: 1 },
  TRX: { chain: "Tron (TRC20)", confirms: 20 },
  SOL: { chain: "Solana", confirms: 1 },
  DOGE: { chain: "Dogecoin", confirms: 20 },
  ADA: { chain: "Cardano", confirms: 15 },
  AVAX: { chain: "Avalanche C", confirms: 1 },
  MATIC: { chain: "Polygon", confirms: 100 },
  ATOM: { chain: "Cosmos", confirms: 1 },
  DOT: { chain: "Polkadot", confirms: 1 },
  LINK: { chain: "Ethereum (ERC20)", confirms: 12 },
  NEAR: { chain: "NEAR", confirms: 1 },
  APT: { chain: "Aptos", confirms: 1 },
  ARB: { chain: "Arbitrum One", confirms: 120 },
  OP: { chain: "Optimism", confirms: 120 },
  SUI: { chain: "Sui", confirms: 1 },
  SEI: { chain: "Sei", confirms: 1 },
  XLM: { chain: "Stellar", confirms: 1 },
  ALGO: { chain: "Algorand", confirms: 1 },
  USDT: { chain: "Tron (TRC20)", confirms: 20 },
  USDC: { chain: "Ethereum (ERC20)", confirms: 12 },
  TON: { chain: "TON", confirms: 1 },
  IOTA: { chain: "IOTA", confirms: 1 },
};
// Most KR-listed alts settle on Ethereum ERC20 — sensible default until the
// real per-coin networkList is pulled from Binance (needs key).
export const COIN_NETWORK_DEFAULT = { chain: "Ethereum (ERC20)", confirms: 12 };

// Coins whose exchange deposits REQUIRE a destination tag/memo. Sending without
// one lands in the exchange's omnibus wallet uncredited — treat as a hard gate:
// any withdraw/transfer of these without a tag must FAIL, never fall through.
export const TAG_REQUIRED = new Set([
  "XRP", "XLM", "EOS", "ATOM", "TON", "HBAR", "XEM", "BNB", "KAVA", "INJ", "SEI", "OSMO", "CRO", "STX",
]);

// Real on-chain withdrawal fees in COIN units (cheapest common network). Used
// by the depth quote to price the transfer leg exactly at execution size.
// TODO: pull live from Binance /sapi/v1/capital/config/getall (needs key).
export const WITHDRAW_FEE_COIN: Record<string, number> = {
  BTC: 0.0002, ETH: 0.0012, BNB: 0.0005, XRP: 0.25, TRX: 1, SOL: 0.008,
  DOGE: 4, ADA: 1, AVAX: 0.01, MATIC: 0.1, ATOM: 0.005, TON: 0.02, DOT: 0.05,
  LINK: 0.15, NEAR: 0.01, APT: 0.01, ARB: 0.5, OP: 0.2, SUI: 0.1, SEI: 0.5,
  XLM: 0.02, ALGO: 0.1, USDT: 1, USDC: 1.5, AAVE: 0.02, IOTA: 0.5,
};
