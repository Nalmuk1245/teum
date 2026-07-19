// OKX Web3 지갑 API 래퍼 — 주소만으로 전 체인·전 토큰 잔고/총가치/tx 히스토리.
// 프라이빗 키 불필요(조회 전용). dexConfigured()가 꺼져 있으면 전부 null.
// 개인지갑 조회의 1차 소스: EVM 7체인 + 솔라나 + 트론 자동 지원 (XRP만 RPC 폴백).

import { okxGet, dexConfigured } from "./dex";

export type OkxCoin = { chain: string; symbol: string; amount: number; usdValue: number; contract: string | null };

// chainIndex → 표시용 체인명 (OKX 지원 범위)
const CHAIN_NAME: Record<string, string> = {
  "1": "eth", "10": "op", "56": "bsc", "137": "poly", "8453": "base",
  "42161": "arb", "43114": "avax", "501": "sol", "195": "tron",
};
const EVM_CHAINS = "1,10,56,137,8453,42161,43114";

async function coinsFor(address: string, chains: string): Promise<OkxCoin[]> {
  const data = await okxGet("/api/v6/dex/balance/all-token-balances-by-address", {
    address, chains, excludeRiskToken: "1",
  });
  const assets = (data[0] as { tokenAssets?: unknown[] })?.tokenAssets ?? [];
  const coins: OkxCoin[] = [];
  for (const a of assets as { chainIndex?: string; symbol?: string; balance?: string; tokenPrice?: string; tokenContractAddress?: string; isRiskToken?: boolean }[]) {
    if (a.isRiskToken) continue;
    const amount = Number(a.balance ?? 0);
    const usd = amount * Number(a.tokenPrice ?? 0);
    if (!(usd > 0.5)) continue; // 더스트 컷
    coins.push({
      chain: CHAIN_NAME[a.chainIndex ?? ""] ?? a.chainIndex ?? "?",
      symbol: (a.symbol ?? "?").toUpperCase(),
      amount, usdValue: usd,
      contract: a.tokenContractAddress ?? null,
    });
  }
  return coins;
}

/** 등록된 모든 주소(EVM·SOL·TRON)의 전 토큰 잔고 — USD 가치순. */
export async function okxAllWalletCoins(addrs: { evm?: string | null; sol?: string | null; tron?: string | null }): Promise<OkxCoin[] | null> {
  if (!dexConfigured()) return null;
  try {
    const jobs: Promise<OkxCoin[]>[] = [];
    if (addrs.evm) jobs.push(coinsFor(addrs.evm, EVM_CHAINS));
    if (addrs.sol) jobs.push(coinsFor(addrs.sol, "501"));
    if (addrs.tron) jobs.push(coinsFor(addrs.tron, "195"));
    if (!jobs.length) return null;
    const merged = (await Promise.all(jobs)).flat();
    merged.sort((a, b) => b.usdValue - a.usdValue);
    return merged.slice(0, 60);
  } catch {
    return null;
  }
}

/** (구버전 호환) EVM 주소 단일 조회. */
export async function okxWalletCoins(address: string): Promise<OkxCoin[] | null> {
  return okxAllWalletCoins({ evm: address });
}

export type OkxTx = { chain: string; hash: string; timeMs: number; symbol: string; amount: string; direction: "in" | "out" | "?" };

async function txsFor(address: string, chains: string, limit: number): Promise<OkxTx[]> {
  const data = await okxGet("/api/v6/dex/post-transaction/transactions-by-address", {
    address, chains, limit: String(limit),
  });
  const txs = (data[0] as { transactions?: unknown[] })?.transactions ?? [];
  const me = address.toLowerCase();
  return (txs as { chainIndex?: string; txHash?: string; txTime?: string; symbol?: string; amount?: string; from?: { address?: string }[]; to?: { address?: string }[] }[])
    .map((t) => ({
      chain: CHAIN_NAME[t.chainIndex ?? ""] ?? t.chainIndex ?? "?",
      hash: t.txHash ?? "",
      timeMs: Number(t.txTime ?? 0),
      symbol: (t.symbol ?? "").toUpperCase(),
      amount: t.amount ?? "",
      direction: (t.to?.some((x) => x.address?.toLowerCase() === me) ? "in"
        : t.from?.some((x) => x.address?.toLowerCase() === me) ? "out" : "?") as "in" | "out" | "?",
    }))
    .filter((t) => t.hash);
}

/** 최근 온체인 tx — 전 주소(EVM·SOL·TRON) 병합, 시간순. */
export async function okxWalletTxs(addrOrAll: string | { evm?: string | null; sol?: string | null; tron?: string | null }, limit = 20): Promise<OkxTx[] | null> {
  if (!dexConfigured()) return null;
  const addrs = typeof addrOrAll === "string" ? { evm: addrOrAll } : addrOrAll;
  try {
    const jobs: Promise<OkxTx[]>[] = [];
    if (addrs.evm) jobs.push(txsFor(addrs.evm, EVM_CHAINS, limit));
    if (addrs.sol) jobs.push(txsFor(addrs.sol, "501", limit));
    if (addrs.tron) jobs.push(txsFor(addrs.tron, "195", limit));
    if (!jobs.length) return null;
    const merged = (await Promise.all(jobs)).flat();
    merged.sort((a, b) => b.timeMs - a.timeMs);
    return merged.slice(0, limit);
  } catch {
    return null;
  }
}
