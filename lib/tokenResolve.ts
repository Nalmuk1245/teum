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
  /** chainKey → contract (only chains we can query: ethereum / bsc / base) */
  contracts: Partial<Record<"ethereum" | "bsc" | "base", { address: string; decimals: number }>>;
};

const PLATFORM_TO_CHAIN: Record<string, "ethereum" | "bsc" | "base"> = {
  ethereum: "ethereum",
  "binance-smart-chain": "bsc",
  base: "base",
};

type CacheT = Map<string, { ts: number; v: ResolvedToken | null }>;
const g = globalThis as unknown as { __arbTokenResolve?: CacheT };
g.__arbTokenResolve ??= new Map();
const C = g.__arbTokenResolve;
const TTL = 10 * 60_000;

const CG = "https://api.coingecko.com/api/v3";

export async function resolveToken(symbolRaw: string): Promise<ResolvedToken | null> {
  const symbol = symbolRaw.toUpperCase();
  const hit = C.get(symbol);
  if (hit && Date.now() - hit.ts < TTL) return hit.v;
  try {
    const sr = await (await fetch(`${CG}/search?query=${encodeURIComponent(symbol)}`, {
      cache: "no-store", signal: AbortSignal.timeout(8000),
    })).json() as { coins?: { id: string; symbol: string; market_cap_rank: number | null }[] };
    const matches = (sr.coins ?? []).filter((c) => c.symbol?.toUpperCase() === symbol);
    if (!matches.length) { C.set(symbol, { ts: Date.now(), v: null }); return null; }
    // Best-ranked exact-symbol match (rank null → last).
    matches.sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9));
    const id = matches[0].id;

    const d = await (await fetch(
      `${CG}/coins/${id}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`,
      { cache: "no-store", signal: AbortSignal.timeout(8000) },
    )).json() as {
      name?: string;
      detail_platforms?: Record<string, { contract_address?: string; decimal_place?: number | null }>;
      market_data?: { current_price?: { usd?: number }; total_volume?: { usd?: number }; market_cap?: { usd?: number } };
    };
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
      contracts,
    };
    C.set(symbol, { ts: Date.now(), v });
    return v;
  } catch {
    return hit?.v ?? null; // rate-limited / offline → last known (or null)
  }
}
