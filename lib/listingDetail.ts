// Listing-play detail — everything you need to decide+execute in one payload:
// token identity (contract, cross-verified), where it trades (CEX matrix with
// my buying power), DEX executability (OKX quote), exchange hot/cold supply,
// and my current position. The UI's detail panel is a straight render of this.

import { priceConsensus } from "./priceConsensus";
import { resolveToken, type ResolvedToken } from "./tokenResolve";
import { getRoute, ensureRoute, noteLiquidity, topPair, LIQUIDITY_TTL_MS, type RouteChain } from "./tokenRoutes";
import { QUOTE_STABLES, quoteDex, dexConfigured } from "./dex";
import { fetchPortfolio } from "./balances";
import { swr, peek } from "./ttlCache";
import { recentListings, type ListingPlay, krDeposits } from "./listings";
import type { Portfolio } from "./types";

export type CexRow = {
  venue: "binance" | "bybit" | "okx" | "upbit" | "bithumb";
  listed: boolean;
  priceUsd: number | null; // KR venues converted via their own USDT/KRW
  priceKrw: number | null;
  myCashUsd: number | null; // buying power at that venue (null = keys absent)
  myCoinQty: number | null; // existing position there
  /** 다른 해외 거래소들과 가격이 크게 다름 — 같은 티커의 다른 토큰이거나 멈춘 시장 (priceConsensus) */
  suspect?: boolean;
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
// 이보다 오래 걸린 빌드만 단계별로 기록한다.
const SLOW_LOG_MS = 1500;
// fast 응답의 상한. 이 경로의 유일한 일은 "창을 띄우는 것"이라, 늦는 값은 기다리지
// 말고 없는 채로 그린다 — 어차피 1초 뒤 전체 응답이 덮어쓴다.
const FAST_BUDGET_MS = 1200;

/** 제한 시간 안에 안 오면 null. 원 Promise는 계속 진행해 캐시를 채운다. */
function withBudget<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((res) => { setTimeout(() => res(null), ms).unref?.(); }),
  ]);
}

/** 표시 순서: 거래 가능한 체인 먼저, 그다음 풀이 깊은 순. 폴링해도 안 흔들린다. */
function byTradeability(a: DexRow, b: DexRow): number {
  if (!!a.untradeable !== !!b.untradeable) return a.untradeable ? 1 : -1;
  return (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0) || a.chain.localeCompare(b.chain);
}

type ChainEntry = { chain: string; address: string; decimals: number; cached?: RouteChain };

/** 체인 목록의 출처: 경로 DB(검증 통과분)가 있으면 그걸, 없으면 CoinGecko 원본. */
function chainEntries(route: { chains: RouteChain[] } | null, token: ResolvedToken | null): ChainEntry[] {
  if (route?.chains.length) {
    return route.chains.map((c) => ({ chain: c.chain, address: c.contract, decimals: c.decimals, cached: c }));
  }
  const raw = Object.entries(token?.contracts ?? {}) as [string, { address: string; decimals: number }][];
  return raw.map(([chain, c]) => ({ chain, address: c.address, decimals: c.decimals }));
}

export type ListingDetail = {
  base: string;
  play: ListingPlay | null;
  /** 개장 전 KR 입금 시계열 (USD) — trackPlays가 60초마다 적재 */
  krDeposits: { ts: number; up: number; bt: number }[];
  token: (ResolvedToken & { contractsList: { chain: string; address: string; decimals: number }[] }) | null;
  cex: CexRow[];
  dex: DexRow[];
  /** fast 응답 — DEX는 아직 계산 전. 클라이언트가 곧 전체를 다시 받는다. */
  dexPending?: boolean;
  /** 잔고를 아직 안 받았다(≠ 키 없음). UI가 "키없음"으로 단정하지 않게 하는 신호. */
  balancesPending?: boolean;
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

/** `fast`: DEX 단계를 건너뛴다. 토큰·CEX·잔고는 병렬 한 방에 끝나지만 DEX는
 *  체인별 풀 조회 + OKX 견적이라 가장 오래 걸린다. 상장따리는 늘 처음 보는
 *  코인이라 캐시가 없고, 그동안 화면이 비어 있으면 그게 곧 놓친 시간이다.
 *  먼저 fast로 그리고 곧바로 전체를 덧씌운다. */
export async function buildListingDetail(baseRaw: string, opts?: { fast?: boolean }): Promise<ListingDetail> {
  const base = baseRaw.toUpperCase();
  const VENUES: CexRow["venue"][] = ["binance", "bybit", "okx", "upbit", "bithumb"];

  // 잔고는 5개 거래소 인증 조회 + OKX 멀티체인 지갑 집계라 이 페이로드에서 제일
  // 느린 값이다. 그런데 화면의 **부속**이다 — 가격·차트·경로는 잔고 없이도 그려진다.
  // fast에서 이걸 await하면 창 자체가 그 시간만큼 안 뜬다(실측 대상: 수동조회 5~6초).
  // 그래서 fast는 캐시된 값만 쓰고 없으면 뒤에서 채우게 둔다.
  const cachedPortfolio = opts?.fast ? peek("portfolio", 10_000, fetchPortfolio) : null;
  const balancesPending = opts?.fast && !cachedPortfolio;

  // 단계별 소요. 이 경로는 "창이 언제 뜨느냐"가 곧 기회비용이라, 느려졌을 때
  // 어디가 느린지 로그가 말해줘야 한다 — 외부 API 지연은 재현이 안 되는 종류다.
  const t0 = Date.now();
  const mark: Record<string, number> = {};
  const timed = <T,>(name: string, p: Promise<T>): Promise<T> =>
    p.finally(() => { mark[name] = Date.now() - t0; });

  const [token, route, prices, fx, portfolio] = await Promise.all([
    // CoinGecko는 무료 티어라 레이트리밋에 걸리면 초 단위로 늘어진다. fast에선
    // 예산을 넘기면 버리고 간다 — 조회는 계속 돌아 캐시를 채우므로(진행 중 조회
    // 공유) 버려진 왕복이 낭비가 되지도 않는다.
    timed("token", opts?.fast ? withBudget(resolveToken(base), FAST_BUDGET_MS) : resolveToken(base)),
    // fast는 네트워크를 타지 않는다 — 이미 아는 토큰이면 첫 페인트에 차트까지 뜨고,
    // 모르는 토큰이면 그냥 없는 채로 넘어간다. 전체 응답에서 ensureRoute가 채운다.
    timed("route", opts?.fast ? Promise.resolve(getRoute(base)) : ensureRoute(base)),
    timed("cex", Promise.all(VENUES.map((v) => cexPrice(v, base)))),
    timed("fx", usdtKrwQuick()),
    timed("balance", opts?.fast
      ? Promise.resolve(cachedPortfolio)
      : swr("portfolio", 10_000, fetchPortfolio).catch(() => null as Portfolio | null)),
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
  const entries = chainEntries(route, token);
  let dex: DexRow[] = [];
  if (opts?.fast) {
    // 아는 토큰이면 풀 주소가 이미 DB에 있다 → 차트를 즉시 띄운다. 견적은 라이브라
    // verified=false로 두는데, 그것만으로 매수 버튼은 잠긴 채 유지된다.
    dex = entries.map((e) => {
      const row: DexRow = {
        chain: e.chain, contract: e.address, decimals: e.decimals,
        verified: false, execPriceUsd: null, premiumVsCgPct: null, note: "견적 계산 중",
      };
      if (e.cached?.pairAddress) { row.pairAddress = e.cached.pairAddress; row.liquidityUsd = e.cached.liquidityUsd; }
      if (!QUOTE_STABLES[e.chain]) { row.note = "미지원 체인"; row.untradeable = true; }
      else if (row.liquidityUsd != null && row.liquidityUsd < MIN_POOL_USD) {
        row.untradeable = true;
        row.note = `풀 유동성 $${Math.round(row.liquidityUsd).toLocaleString()} — $500도 제대로 안 먹힘`;
      }
      return row;
    }).sort(byTradeability);
  } else if (token) {
    // Collect by INDEX, not by pushing inside the async map — `dex.push` in a
    // Promise.all appended in completion order, so the row order reshuffled on
    // every 10s poll and the table visibly flickered.
    const rows = await Promise.all(entries.map(async (e) => {
      const chain = e.chain, c = { address: e.address, decimals: e.decimals };
      const stable = QUOTE_STABLES[chain];
      const row: DexRow = { chain, contract: c.address, decimals: c.decimals, verified: false, execPriceUsd: null, premiumVsCgPct: null };
      if (!stable) { row.note = "미지원 체인"; row.untradeable = true; return row; }
      if (!dexReady) { row.note = "OKX_WEB3 키 필요"; return row; }
      // Pool check FIRST (DexScreener, ~100ms) — it tells us whether this chain
      // is real at all. Only then spend an OKX quote, which is the expensive
      // call (and slowest exactly when it's going to fail). A new listing is
      // typically deployed on 3 chains with a pool on one, so this drops the
      // quote count from N to ~1 without losing anything.
      // 1시간 안에 본 풀이면 DB 값을 쓴다 — 풀 주소는 그 정도로 자주 안 바뀌고,
      // 이게 다시 연 창에서 체인 수만큼의 왕복을 통째로 없앤다.
      const fresh = e.cached?.pairAddress && e.cached.liquidityAt && Date.now() - e.cached.liquidityAt < LIQUIDITY_TTL_MS;
      const pair = fresh
        ? { pairAddress: e.cached!.pairAddress!, liquidityUsd: e.cached!.liquidityUsd ?? 0 }
        : await topPair(chain, c.address);
      if (pair) {
        row.pairAddress = pair.pairAddress; row.liquidityUsd = pair.liquidityUsd;
        if (!fresh) noteLiquidity(base, chain, pair); // 방금 본 값을 DB에 되먹인다
      }
      if (pair && pair.liquidityUsd < MIN_POOL_USD) {
        row.untradeable = true;
        row.note = `풀 유동성 $${Math.round(pair.liquidityUsd).toLocaleString()} — $500도 제대로 안 먹힘`;
        return row;
      }
      const q = await quoteDex(chain, stable, { address: c.address, decimals: c.decimals }, 500);
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
    dex = rows.sort(byTradeability);
  }

  // 티커 충돌 표시 — 해외 거래소끼리 가격을 대조해 튀는 곳을 suspect로.
  // KR은 대조에서 뺀다: 개장 직후 김프가 30%를 넘는 게 정상이라 KR을 넣으면 오판한다.
  const gl = cex.filter((r) => ["binance", "bybit", "okx"].includes(r.venue) && r.listed && r.priceUsd != null);
  const cons = priceConsensus(gl.map((r) => ({ venue: r.venue, price: r.priceUsd! })));
  for (const r of gl) if (cons.outliers.includes(r.venue)) r.suspect = true;
  // Kimchi read once KR side is trading: cheapest AGREED global vs cheapest KR.
  // 예전엔 "가장 싼 해외 가격"이라 다른 토큰($0.74)이 끼어 +587% 같은 유령값이 나왔다.
  const gUsd = cons.ambiguous ? Infinity : Math.min(...gl.filter((r) => !r.suspect).map((r) => r.priceUsd!), Infinity);
  const kUsd = Math.min(...cex.filter((r) => ["upbit", "bithumb"].includes(r.venue) && r.priceUsd != null).map((r) => r.priceUsd!), Infinity);
  const kimchiPct = Number.isFinite(gUsd) && Number.isFinite(kUsd) ? ((kUsd - gUsd) / gUsd) * 100 : null;

  // 느릴 때만 남긴다 — 정상 응답까지 찍으면 로그가 이걸로 덮인다.
  const total = Date.now() - t0;
  if (total > SLOW_LOG_MS) {
    // 모든 await가 끝난 시각과 총 소요의 차이. 이 구간엔 계산밖에 없으므로
    // 여기가 크면 외부 API가 아니라 **프로세스가 멈춰 있었다**는 뜻이다.
    const settled = Math.max(...Object.values(mark), 0);
    const stall = total - settled;
    console.warn(
      `[listing-detail] ${base}${opts?.fast ? " fast" : ""} ${total}ms — `
      + Object.entries(mark).map(([k, v]) => `${k} ${v}ms`).join(" · ")
      + ` | 대기후 ${stall}ms${stall > 300 ? " ⚠멈춤" : ""}`,
    );
  }

  return {
    base,
    play: recentListings().find((p) => p.base === base) ?? null,
    krDeposits: krDeposits(base).pts,
    // 컨트랙트 목록도 경로 DB를 우선한다 — 온체인 symbol()이 다른 토큰으로
    // 판명된 항목은 여기서부터 아예 빠진다.
    token: token
      ? { ...token, contractsList: entries.map((e) => ({ chain: e.chain, address: e.address, decimals: e.decimals })) }
      : null,
    cex, dex, dexReady,
    balancesPending: balancesPending || undefined,
    walletReady: !!process.env.WALLET_PRIVATE_KEY,
    kimchiPct,
    updatedAt: Date.now(),
  };
}
