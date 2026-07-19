// OKX Web3 지갑 API 래퍼 — 주소만으로 전 체인·전 토큰 잔고/총가치/tx 히스토리.
// 프라이빗 키 불필요(조회 전용). dexConfigured()가 꺼져 있으면 전부 null.

import { okxGet, dexConfigured, OKX_CHAIN_ID } from "./dex";

export type OkxCoin = { chain: string; symbol: string; amount: number; usdValue: number; contract: string | null };

const CHAIN_BY_INDEX: Record<string, string> = Object.fromEntries(
  Object.entries(OKX_CHAIN_ID).map(([k, v]) => [v, k]),
);

const EVM_CHAINS = "1,56,8453"; // ethereum, bsc, base

/** 주소의 전 토큰 잔고 (리스크 토큰 제외, USD 가치순). */
export async function okxWalletCoins(address: string): Promise<OkxCoin[] | null> {
  if (!dexConfigured() || !address) return null;
  try {
    const data = await okxGet("/api/v6/dex/balance/all-token-balances-by-address", {
      address, chains: EVM_CHAINS, excludeRiskToken: "1",
    });
    const assets = (data[0] as { tokenAssets?: unknown[] })?.tokenAssets ?? [];
    const coins: OkxCoin[] = [];
    for (const a of assets as { chainIndex?: string; symbol?: string; balance?: string; tokenPrice?: string; tokenContractAddress?: string; isRiskToken?: boolean }[]) {
      if (a.isRiskToken) continue;
      const amount = Number(a.balance ?? 0);
      const usd = amount * Number(a.tokenPrice ?? 0);
      if (!(usd > 0.5)) continue; // 더스트 컷
      coins.push({
        chain: CHAIN_BY_INDEX[a.chainIndex ?? ""] ?? a.chainIndex ?? "?",
        symbol: (a.symbol ?? "?").toUpperCase(),
        amount, usdValue: usd,
        contract: a.tokenContractAddress ?? null,
      });
    }
    coins.sort((a, b) => b.usdValue - a.usdValue);
    return coins.slice(0, 40);
  } catch {
    return null;
  }
}

export type OkxTx = { chain: string; hash: string; timeMs: number; symbol: string; amount: string; direction: "in" | "out" | "?" };

/** 주소의 최근 온체인 tx (EVM 3체인). */
export async function okxWalletTxs(address: string, limit = 20): Promise<OkxTx[] | null> {
  if (!dexConfigured() || !address) return null;
  try {
    const data = await okxGet("/api/v6/dex/post-transaction/transactions-by-address", {
      address, chains: EVM_CHAINS, limit: String(limit),
    });
    const txs = (data[0] as { transactions?: unknown[] })?.transactions ?? [];
    const me = address.toLowerCase();
    return (txs as { chainIndex?: string; txHash?: string; txTime?: string; symbol?: string; amount?: string; from?: { address?: string }[]; to?: { address?: string }[] }[])
      .map((t) => ({
        chain: CHAIN_BY_INDEX[t.chainIndex ?? ""] ?? t.chainIndex ?? "?",
        hash: t.txHash ?? "",
        timeMs: Number(t.txTime ?? 0),
        symbol: (t.symbol ?? "").toUpperCase(),
        amount: t.amount ?? "",
        direction: (t.to?.some((x) => x.address?.toLowerCase() === me) ? "in"
          : t.from?.some((x) => x.address?.toLowerCase() === me) ? "out" : "?") as "in" | "out" | "?",
      }))
      .filter((t) => t.hash);
  } catch {
    return null;
  }
}
