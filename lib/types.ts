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
  network?: {
    chain: string; confirms: number; // transfer chain label + deposit confirmations
    /** 정규화 체인 키 (netcodes.canonChain) — 실행 단계가 거래소별 코드로 되돌린다 */
    chainKey?: string;
    /** 양쪽 다 열린 다른 체인 수 (이 체인이 막혀도 갈 길이 있나) */
    alternatives?: number;
    /** 선택 사유 / 막힌 이유 */
    reason?: string;
  };
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
  persistence?: { heldSec: number; hitRatePct: number; samples: number; volPctPerMin: number; jumpPct: number };
  /** 30-min gross% history, downsampled (≤40, oldest→newest) — 보드 행 스파크라인.
   *  net으로 그리려면 현재 costPct를 빼서 쓴다 (과거 비용은 안 남기므로 근사). */
  spark?: number[];
  /** Fresh KR listing (상장따리): announced/opened on Upbit/Bithumb — the
   *  fastest kimchi spike. overseas = on a global CEX (front-runnable);
   *  opened = trading is live (else: announced, pre-open). */
  newListing?: { venue: string; ageSec: number; overseas: boolean; opened: boolean };
  /** Transfer-window risk: expected PRICE drift over the in-flight ETA (the
   *  unhedged exposure is the coin's price vol, not the premium's), plus the
   *  worst recent single-step jump and the USDT/KRW (tether-premium) drift that
   *  the coin hedge doesn't cover. */
  transferRisk?: { etaMin: number; driftPct: number; jumpPct: number; fxDriftPct: number; hedgeAdvised: boolean };
  /** 헷지 실비용 분해 — 테이커 왕복·진입 베이시스·창 안 펀딩. hasPerp인 전송형
   *  기회에만 붙는다. netPct엔 이미 반영돼 있고, 이 필드는 내역 표시용이다. */
  hedge?: { takerPct: number; basisPct: number; fundingPct: number; totalPct: number; settlesInWindow: boolean; basisSuspect?: boolean };
  /** Funding-basis timing: when the SHORT leg next settles + both intervals. */
  fundingMeta?: { nextTs: number | null; shortIntervalH: number | null; longIntervalH: number | null };
  note?: string;
  mock?: boolean; // sample data, not a live signal
  /** Funding: gross APR is an outlier spike (new listing / thin OI) — likely
   *  not capturable at size; ranked below normal rows. */
  suspectApr?: boolean;
  /** cex-dex 동적 유니버스: 심볼만 일치, 컨트랙트 미검증 — 실행 금지·강등 */
  unverified?: boolean;
  /** 깊이 사다리 — 양쪽 오더북을 걸어 내려가며 구간별로 모은 규모와 총 이익.
   *  최우선호가 한 칸(notionalCapUsd)이 아니라 "이 갭에서 실제로 뽑을 수 있는 돈".
   *  프리웜 캐시(상위 기회)에만 붙는다. */
  depth?: DepthLadder;
  /** 입출금 게이트 상태 (gateState.classifyGate). closed/suspect는 배지·강등·대기 목록. */
  gate?: "open" | "closed" | "suspect" | "unknown";
  /** 닫힘/의심이던 게이트가 확인된 열림으로 바뀐 시각 — 알림·행 깜빡임. */
  reopenedAt?: number;
  ts: number;
};

/** 깊이 사다리 한 벌. tiers는 순수익 하한별 누적 규모(USD). */
export type DepthLadder = {
  tiers: { minNet: number; sizeUsd: number }[];
  /** 순수익 > 0 인 마지막 칸까지의 누적 규모 */
  maxSizeUsd: number;
  /** 그 규모를 다 먹었을 때의 기대 이익 (USD) */
  profitUsd: number;
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
  marks?: Map<string, Partial<Record<Venue, number>>>; // perp mark px per venue (entry basis)
  /** 실거래 누수 기반 비용 자동 보정 (%p) — 김프·크로스 비용에 가산. */
  calPct?: number;
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
