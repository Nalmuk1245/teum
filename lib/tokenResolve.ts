// Ticker → on-chain contract resolution via CoinGecko (free, no key).
// The dangerous part of listing-play chain lookups is symbol collisions with
// scam tokens — so we resolve through CoinGecko's curated list and pick the
// best market-cap-ranked match, never a raw DEX search.

export type ResolvedToken = {
  id: string;
  name: string;
  symbol: string;
  priceUsd: number | null;
  volumeUsd: number | null; // 24h, all markets
  marketCapUsd: number | null;
  priceChange24hPct: number | null;
  /** chainKey → contract (ethereum / bsc / base / solana) */
  contracts: Partial<Record<"ethereum" | "bsc" | "base" | "solana", { address: string; decimals: number }>>;
};

const PLATFORM_TO_CHAIN: Record<string, "ethereum" | "bsc" | "base" | "solana"> = {
  ethereum: "ethereum",
  "binance-smart-chain": "bsc",
  base: "base",
  solana: "solana",
};

type CacheT = Map<string, { ts: number; v: ResolvedToken | null }>;
type InflightT = Map<string, Promise<ResolvedToken | null>>;
const g = globalThis as unknown as { __arbTokenResolve?: CacheT; __arbTokenResolveInflight?: InflightT };
g.__arbTokenResolve ??= new Map();
g.__arbTokenResolveInflight ??= new Map();
const C = g.__arbTokenResolve;
const INFLIGHT = g.__arbTokenResolveInflight;
const TTL = 10 * 60_000;
const NEG_TTL = 60_000; // "미등록" 부정 캐시는 1분만 — 레이트리밋 오판이 오래 안 굳게

const CG = "https://api.coingecko.com/api/v3";

// CoinGecko 응답을 JSON으로 — 단, HTTP 실패(특히 429 레이트리밋)는 throw해서
// "미등록"으로 오인·캐시하지 않게 한다. 429가 빈 body를 200처럼 흘리면 컨트랙트
// 없는 결과가 10분 굳어버리는 게 이 함수의 존재 이유.
async function cgJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`); // 429/5xx → 캐시 금지
  return res.json() as Promise<T>;
}

export function resolveToken(symbolRaw: string): Promise<ResolvedToken | null> {
  const symbol = symbolRaw.toUpperCase();
  const hit = C.get(symbol);
  // 성공값은 TTL(10분) 캐시, "미등록(null)"은 짧게(NEG_TTL)만 — 레이트리밋 순간에
  // 잘못 든 null이 오래 굳지 않도록, 또 실제 미등록도 재조회 폭주는 막도록.
  if (hit && Date.now() - hit.ts < (hit.v ? TTL : NEG_TTL)) return Promise.resolve(hit.v);
  // 캐시는 "끝난 뒤"에만 채워진다. 같은 티커를 동시에 물으면 전부 미스로 떨어져
  // CoinGecko 왕복이 그 수만큼 늘어난다 — 무료 티어에서 이건 곧 429다. 상장 감지
  // 직후엔 프리워밍·패널·해석이 겹치는 게 정상이라 진행 중인 조회를 공유한다.
  const running = INFLIGHT.get(symbol);
  if (running) return running;
  const p = fetchToken(symbol, hit).finally(() => INFLIGHT.delete(symbol));
  INFLIGHT.set(symbol, p);
  return p;
}

async function fetchToken(symbol: string, hit: { ts: number; v: ResolvedToken | null } | undefined): Promise<ResolvedToken | null> {
  try {
    const sr = await cgJson<{ coins?: { id: string; symbol: string; market_cap_rank: number | null }[] }>(
      `${CG}/search?query=${encodeURIComponent(symbol)}`,
    );
    const matches = (sr.coins ?? []).filter((c) => c.symbol?.toUpperCase() === symbol);
    if (!matches.length) { C.set(symbol, { ts: Date.now(), v: null }); return null; }
    // Best-ranked exact-symbol match (rank null → last).
    matches.sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9));
    const id = matches[0].id;

    const d = await cgJson<{
      name?: string;
      detail_platforms?: Record<string, { contract_address?: string; decimal_place?: number | null }>;
      market_data?: { current_price?: { usd?: number }; total_volume?: { usd?: number }; market_cap?: { usd?: number }; price_change_percentage_24h?: number | null };
    }>(`${CG}/coins/${id}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`);
    // 정상 상세면 최소한 market_data가 온다 — 없으면 비정상 응답(레이트리밋 등)으로
    // 보고 throw → 컨트랙트 빈 결과를 성공처럼 캐시하지 않는다.
    if (!d.market_data && !d.detail_platforms) throw new Error("CoinGecko 상세 비정상");
    const contracts: ResolvedToken["contracts"] = {};
    for (const [platform, info] of Object.entries(d.detail_platforms ?? {})) {
      const chain = PLATFORM_TO_CHAIN[platform];
      if (!chain || !info?.contract_address) continue;
      contracts[chain] = { address: info.contract_address, decimals: info.decimal_place ?? 18 };
    }
    const v: ResolvedToken = {
      id, name: d.name ?? id, symbol,
      priceUsd: d.market_data?.current_price?.usd ?? null,
      volumeUsd: d.market_data?.total_volume?.usd ?? null,
      marketCapUsd: d.market_data?.market_cap?.usd ?? null,
      priceChange24hPct: d.market_data?.price_change_percentage_24h ?? null,
      contracts,
    };
    C.set(symbol, { ts: Date.now(), v });
    return v;
  } catch {
    return hit?.v ?? null; // rate-limited / offline → last known (or null)
  }
}
