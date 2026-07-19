// Listing-play detail — everything you need to decide+execute in one payload:
// token identity (contract, cross-verified), where it trades (CEX matrix with
// my buying power), DEX executability (OKX quote), exchange hot/cold supply,
// and my current position. The UI's detail panel is a straight render of this.

import { resolveToken, type ResolvedToken } from "./tokenResolve";
import { QUOTE_STABLES, quoteDex, dexConfigured } from "./dex";
import { fetchPortfolio } from "./balances";
import { swr } from "./ttlCache";
import { recentListings, type ListingPlay } from "./listings";
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
  note?: string;
};

export type ListingDetail = {
  base: string;
  play: ListingPlay | null;
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
  const dex: DexRow[] = [];
  if (token) {
    await Promise.all(
      (Object.entries(token.contracts) as [string, { address: string; decimals: number }][]).map(async ([chain, c]) => {
        const stable = QUOTE_STABLES[chain];
        const row: DexRow = { chain, contract: c.address, decimals: c.decimals, verified: false, execPriceUsd: null, premiumVsCgPct: null };
        if (!stable) { row.note = "미지원 체인"; dex.push(row); return; }
        if (!dexReady) { row.note = "OKX_WEB3 키 필요"; dex.push(row); return; }
        const q = await quoteDex(chain, stable, { address: c.address, decimals: c.decimals }, 500);
        if (q && q.toAmount > 0) {
          row.verified = true;
          row.execPriceUsd = 500 / q.toAmount;
          if (token.priceUsd) row.premiumVsCgPct = ((row.execPriceUsd - token.priceUsd) / token.priceUsd) * 100;
        } else {
          row.note = "OKX 라우트 없음 (유동성/컨트랙트 확인)";
        }
        if (chain === "solana" && row.verified && !process.env.WALLET_SOL_KEY) row.note = "라이브 매수엔 SOL 지갑 키 필요";
        dex.push(row);
      }),
    );
  }

  // Kimchi read once KR side is trading: cheapest global vs cheapest KR.
  const gUsd = Math.min(...cex.filter((r) => ["binance", "bybit", "okx"].includes(r.venue) && r.priceUsd != null).map((r) => r.priceUsd!), Infinity);
  const kUsd = Math.min(...cex.filter((r) => ["upbit", "bithumb"].includes(r.venue) && r.priceUsd != null).map((r) => r.priceUsd!), Infinity);
  const kimchiPct = Number.isFinite(gUsd) && Number.isFinite(kUsd) ? ((kUsd - gUsd) / gUsd) * 100 : null;

  return {
    base,
    play: recentListings().find((p) => p.base === base) ?? null,
    token: token
      ? { ...token, contractsList: (Object.entries(token.contracts) as [string, { address: string; decimals: number }][]).map(([chain, c]) => ({ chain, address: c.address, decimals: c.decimals })) }
      : null,
    cex, dex, dexReady,
    walletReady: !!process.env.WALLET_PRIVATE_KEY,
    kimchiPct,
    updatedAt: Date.now(),
  };
}
