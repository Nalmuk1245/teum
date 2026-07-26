// Listing-play detail — everything you need to decide+execute in one payload:
// token identity (contract, cross-verified), where it trades (CEX matrix with
// my buying power), DEX executability (OKX quote), exchange hot/cold supply,
// and my current position. The UI's detail panel is a straight render of this.

import { resolveToken, type ResolvedToken } from "./tokenResolve";
import { QUOTE_STABLES, quoteDex, dexConfigured } from "./dex";
import { fetchPortfolio } from "./balances";
import { swr } from "./ttlCache";
import { recentListings, type ListingPlay, krDeposits } from "./listings";
import type { Portfolio } from "./types";

export type CexRow = {
  venue: "binance" | "bybit" | "okx" | "upbit" | "bithumb";
  listed: boolean;
  priceUsd: number | null; // KR venues converted via their own USDT/KRW
  priceKrw: number | null;
  myCashUsd: number | null; // buying power at that venue (null = keys absent)
  myCoinQty: number | null; // existing position there
};

export type DexRow = {
  chain: string;
  contract: string;
  decimals: number;
  /** OKX aggregator returned a route for $500 → contract is real + has liquidity. */
  verified: boolean;
  execPriceUsd: number | null; // 500 / outQty
  premiumVsCgPct: number | null; // exec price vs CoinGecko spot (slippage+spread proxy)
  /** DexScreener 최상위 풀 — 차트 임베드에 **페어 주소**가 필요하다(토큰 주소로는
   *  빈 화면이 뜬다). 없으면 그 체인엔 볼 만한 풀이 없다는 뜻이기도 하다. */
  pairAddress?: string;
  /** 최상위 풀의 USD 유동성. "컨트랙트가 있다"와 "거래할 수 있다"는 다르다 —
   *  이 값이 그 차이를 말해주는 유일한 정직한 신호다. */
  liquidityUsd?: number;
  /** 이 체인에서 사면 안 된다. 풀이 비었거나 견적이 현물과 동떨어졌다. */
  untradeable?: boolean;
  note?: string;
};

// 견적이 현물 대비 이만큼 벗어나면 풀이 비었거나 다른 토큰이다 — 매수 금지.
const MAX_SANE_PREMIUM_PCT = 15;
// 이 미만이면 $500도 제대로 못 먹는다.
const MIN_POOL_USD = 20_000;

/** DexScreener에서 이 토큰의 최상위(유동성 최대) 풀을 찾는다. */
async function topPair(chain: string, address: string): Promise<{ pairAddress: string; liquidityUsd: number } | null> {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
      cache: "no-store", signal: AbortSignal.timeout(4000),
    });
    const j = (await r.json()) as { pairs?: Array<{ chainId?: string; pairAddress?: string; liquidity?: { usd?: number } }> };
    const wanted = DS_CHAIN[chain] ?? chain;
    const best = (j.pairs ?? [])
      .filter((x) => x.chainId === wanted && x.pairAddress)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    if (!best?.pairAddress) return null;
    return { pairAddress: best.pairAddress, liquidityUsd: best.liquidity?.usd ?? 0 };
  } catch {
    return null;
  }
}
// 우리 체인 키 → DexScreener chainId
const DS_CHAIN: Record<string, string> = {
  ethereum: "ethereum", base: "base", bsc: "bsc", polygon: "polygon",
  arbitrum: "arbitrum", optimism: "optimism", avalanche: "avalanche", solana: "solana",
};

export type ListingDetail = {
  base: string;
  play: ListingPlay | null;
  /** 개장 전 KR 입금 시계열 (USD) — trackPlays가 60초마다 적재 */
  krDeposits: { ts: number; up: number; bt: number }[];
  token: (ResolvedToken & { contractsList: { chain: string; address: string; decimals: number }[] }) | null;
  cex: CexRow[];
  dex: DexRow[];
  dexReady: boolean; // OKX_WEB3 keys present (quotes/buys possible)
  walletReady: boolean; // signing key present (live DEX buy possible)
  kimchiPct: number | null; // once KR-listed: KR price vs cheapest global, %
  updatedAt: number;
};

const T = (ms: number) => AbortSignal.timeout(ms);

async function cexPrice(venue: CexRow["venue"], base: string): Promise<{ listed: boolean; priceUsd: number | null; priceKrw: number | null }> {
  try {
    if (venue === "binance") {
      const j = await (await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${base}USDT`, { cache: "no-store", signal: T(3000) })).json();
      const p = Number(j.price);
      return { listed: p > 0, priceUsd: p > 0 ? p : null, priceKrw: null };
    }
    if (venue === "bybit") {
      const j = await (await fetch(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${base}USDT`, { cache: "no-store", signal: T(3000) })).json();
      const p = Number(j.result?.list?.[0]?.lastPrice);
      return { listed: p > 0, priceUsd: p > 0 ? p : null, priceKrw: null };
    }
    if (venue === "okx") {
      const j = await (await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${base}-USDT`, { cache: "no-store", signal: T(3000) })).json();
      const p = Number(j.data?.[0]?.last);
      return { listed: p > 0, priceUsd: p > 0 ? p : null, priceKrw: null };
    }
    if (venue === "upbit") {
      const j = await (await fetch(`https://api.upbit.com/v1/ticker?markets=KRW-${base}`, { cache: "no-store", signal: T(3000) })).json();
      const p = Number(Array.isArray(j) ? j[0]?.trade_price : 0);
      return { listed: p > 0, priceUsd: null, priceKrw: p > 0 ? p : null };
    }
    // bithumb
    const j = await (await fetch(`https://api.bithumb.com/public/ticker/${base}_KRW`, { cache: "no-store", signal: T(3000) })).json();
    const p = j.status === "0000" ? Number(j.data?.closing_price) : 0;
    return { listed: p > 0, priceUsd: null, priceKrw: p > 0 ? p : null };
  } catch {
    return { listed: false, priceUsd: null, priceKrw: null };
  }
}

async function usdtKrwQuick(): Promise<number | null> {
  try {
    const j = await (await fetch("https://api.upbit.com/v1/ticker?markets=KRW-USDT", { cache: "no-store", signal: T(3000) })).json();
    const p = Number(Array.isArray(j) ? j[0]?.trade_price : 0);
    return p > 0 ? p : null;
  } catch { return null; }
}

export async function buildListingDetail(baseRaw: string): Promise<ListingDetail> {
  const base = baseRaw.toUpperCase();
  const VENUES: CexRow["venue"][] = ["binance", "bybit", "okx", "upbit", "bithumb"];

  const [token, prices, fx, portfolio] = await Promise.all([
    resolveToken(base),
    Promise.all(VENUES.map((v) => cexPrice(v, base))),
    usdtKrwQuick(),
    swr("portfolio", 10_000, fetchPortfolio).catch(() => null as Portfolio | null),
  ]);

  const cex: CexRow[] = VENUES.map((venue, i) => {
    const p = prices[i];
    const vb = portfolio?.venues.find((x) => x.venue === venue);
    return {
      venue, listed: p.listed,
      priceUsd: p.priceUsd ?? (p.priceKrw != null && fx ? p.priceKrw / fx : null),
      priceKrw: p.priceKrw,
      myCashUsd: vb?.connected ? vb.cashUsd : null,
      myCoinQty: vb?.connected ? (vb.coins.find((cn) => cn.asset === base)?.amount ?? 0) : null,
    };
  });

  // DEX rows — quote $500 through OKX per chain the token exists on. A route
  // coming back is also our contract cross-check (real + liquid).
  const dexReady = dexConfigured();
  let dex: DexRow[] = [];
  if (token) {
    const entries = Object.entries(token.contracts) as [string, { address: string; decimals: number }][];
    // Collect by INDEX, not by pushing inside the async map — `dex.push` in a
    // Promise.all appended in completion order, so the row order reshuffled on
    // every 10s poll and the table visibly flickered.
    const rows = await Promise.all(entries.map(async ([chain, c]) => {
      const stable = QUOTE_STABLES[chain];
      const row: DexRow = { chain, contract: c.address, decimals: c.decimals, verified: false, execPriceUsd: null, premiumVsCgPct: null };
      if (!stable) { row.note = "미지원 체인"; row.untradeable = true; return row; }
      if (!dexReady) { row.note = "OKX_WEB3 키 필요"; return row; }
      // Quote and pool lookup in parallel — the pool tells us whether this chain
      // is real at all, the quote tells us at what price.
      const [q, pair] = await Promise.all([
        quoteDex(chain, stable, { address: c.address, decimals: c.decimals }, 500),
        topPair(chain, c.address),
      ]);
      if (pair) { row.pairAddress = pair.pairAddress; row.liquidityUsd = pair.liquidityUsd; }
      if (q && q.toAmount > 0) {
        row.verified = true;
        row.execPriceUsd = 500 / q.toAmount;
        if (token.priceUsd) row.premiumVsCgPct = ((row.execPriceUsd - token.priceUsd) / token.priceUsd) * 100;
      } else {
        row.note = "OKX 라우트 없음 (유동성/컨트랙트 확인)";
      }
      // "컨트랙트가 존재한다"와 "여기서 살 수 있다"는 완전히 다르다. 토큰이 3개
      // 체인에 배포돼 있어도 풀은 보통 하나에만 있고, 빈 풀에 견적을 넣으면
      // 아무 숫자나 나온다(실제로 EUL은 base +328%, bsc +404%가 찍혔다).
      const wildPrice = row.premiumVsCgPct != null && Math.abs(row.premiumVsCgPct) > MAX_SANE_PREMIUM_PCT;
      const thinPool = row.liquidityUsd != null && row.liquidityUsd < MIN_POOL_USD;
      if (wildPrice || thinPool || !row.verified) {
        row.untradeable = true;
        row.note = wildPrice
          ? `가격 왜곡 ${row.premiumVsCgPct!.toFixed(0)}% — 빈 풀이거나 다른 토큰. 여기서 사지 말 것`
          : thinPool
            ? `풀 유동성 $${Math.round(row.liquidityUsd!).toLocaleString()} — $500도 제대로 안 먹힘`
            : row.note;
      }
      if (chain === "solana" && row.verified && !process.env.WALLET_SOL_KEY) row.note = "라이브 매수엔 SOL 지갑 키 필요";
      return row;
    }));
    // Deterministic order: tradeable first, then by pool depth. Stable across polls.
    dex = rows.sort((a, b) => {
      if (!!a.untradeable !== !!b.untradeable) return a.untradeable ? 1 : -1;
      return (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0) || a.chain.localeCompare(b.chain);
    });
  }

  // Kimchi read once KR side is trading: cheapest global vs cheapest KR.
  const gUsd = Math.min(...cex.filter((r) => ["binance", "bybit", "okx"].includes(r.venue) && r.priceUsd != null).map((r) => r.priceUsd!), Infinity);
  const kUsd = Math.min(...cex.filter((r) => ["upbit", "bithumb"].includes(r.venue) && r.priceUsd != null).map((r) => r.priceUsd!), Infinity);
  const kimchiPct = Number.isFinite(gUsd) && Number.isFinite(kUsd) ? ((kUsd - gUsd) / gUsd) * 100 : null;

  return {
    base,
    play: recentListings().find((p) => p.base === base) ?? null,
    krDeposits: krDeposits(base).pts,
    token: token
      ? { ...token, contractsList: (Object.entries(token.contracts) as [string, { address: string; decimals: number }][]).map(([chain, c]) => ({ chain, address: c.address, decimals: c.decimals })) }
      : null,
    cex, dex, dexReady,
    walletReady: !!process.env.WALLET_PRIVATE_KEY,
    kimchiPct,
    updatedAt: Date.now(),
  };
}
