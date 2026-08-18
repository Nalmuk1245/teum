// Personal-wallet on-chain balances (read-only). Reads native assets across
// chains using PUBLIC RPCs by ADDRESS only — no private key needed to read.
// Addresses come from WALLET_ADDR_* env, or the EVM one is derived from
// WALLET_PRIVATE_KEY. Server-only. Falls back to a demo wallet when USE_MOCK.

import { JsonRpcProvider, Wallet, formatEther } from "ethers";
import type { CoinBal, VenueBalance } from "./types";
import { CHAINS } from "./chains";
import { CONFIG } from "./config";

const EVM_READ = ["ethereum", "polygon", "arbitrum", "base"] as const;

function evmAddress(): string | null {
  if (process.env.WALLET_ADDR_EVM) return process.env.WALLET_ADDR_EVM;
  const k = process.env.WALLET_PRIVATE_KEY;
  try {
    return k ? new Wallet(k).address : null;
  } catch {
    return null;
  }
}

// native symbol → USD via the price map (with a couple of aliases).
function usdNative(sym: string, px: Map<string, number>): number {
  return px.get(sym) ?? px.get(sym === "POL" ? "MATIC" : sym) ?? 0;
}

async function evmNative(chainKey: string, addr: string, px: Map<string, number>): Promise<CoinBal | null> {
  const c = CHAINS[chainKey];
  if (!c) return null;
  try {
    const provider = new JsonRpcProvider(c.rpc);
    const wei = await provider.getBalance(addr);
    const amount = Number(formatEther(wei));
    if (amount <= 0) return null;
    // 체인 표기는 OKX 경로와 같은 규칙을 쓴다: 이더리움은 그냥 "ETH", 나머지는
    // "ETH·arbitrum". 이게 없으면 EVM 4체인의 네이티브 ETH가 자산 탭에 구분
    // 없는 "ETH" 세 줄로 나란히 떠서, 어느 줄이 어느 체인인지 알 수 없었다
    // (같은 심볼·다른 체인은 전송 경로가 완전히 다른데도).
    const asset = chainKey === "ethereum" ? c.native : `${c.native}·${chainKey}`;
    return { asset, amount, usdValue: amount * usdNative(c.native, px) };
  } catch {
    return null;
  }
}

async function xrpNative(addr: string, px: Map<string, number>): Promise<CoinBal | null> {
  try {
    const r = await fetch(CHAINS.xrp.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "account_info", params: [{ account: addr, ledger_index: "validated" }] }),
      cache: "no-store", signal: AbortSignal.timeout(5000),
    });
    const j = (await r.json()) as { result?: { account_data?: { Balance?: string } } };
    const drops = Number(j.result?.account_data?.Balance ?? 0);
    const amount = drops / 1e6;
    return amount > 0 ? { asset: "XRP", amount, usdValue: amount * usdNative("XRP", px) } : null;
  } catch {
    return null;
  }
}

async function tronNative(addr: string, px: Map<string, number>): Promise<CoinBal | null> {
  try {
    const r = await fetch(`${CHAINS.tron.rpc}/v1/accounts/${addr}`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    const j = (await r.json()) as { data?: Array<{ balance?: number }> };
    const amount = Number(j.data?.[0]?.balance ?? 0) / 1e6;
    return amount > 0 ? { asset: "TRX", amount, usdValue: amount * usdNative("TRX", px) } : null;
  } catch {
    return null;
  }
}

async function solNative(addr: string, px: Map<string, number>): Promise<CoinBal | null> {
  try {
    const r = await fetch(CHAINS.solana.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [addr] }),
      cache: "no-store", signal: AbortSignal.timeout(5000),
    });
    const j = (await r.json()) as { result?: { value?: number } };
    const amount = Number(j.result?.value ?? 0) / 1e9;
    return amount > 0 ? { asset: "SOL", amount, usdValue: amount * usdNative("SOL", px) } : null;
  } catch {
    return null;
  }
}

/** Personal wallet as a VenueBalance ("wallet"). null if no address configured. */
export async function fetchWalletBalance(px: Map<string, number>): Promise<VenueBalance | null> {
  const evm = evmAddress();
  const xrp = process.env.WALLET_ADDR_XRP;
  const tron = process.env.WALLET_ADDR_TRON;
  const sol = process.env.WALLET_ADDR_SOL;
  if (!evm && !xrp && !tron && !sol) return null; // no address → nothing to read

  // 1차: OKX Web3 지갑 API — EVM 7체인 + 솔라나 + 트론 전 토큰 자동 발견(가격
  // 포함). 키가 없거나 실패하면 기존 네이티브 RPC 폴백. XRP는 항상 RPC.
  let okxCoins: CoinBal[] | null = null;
  try {
    const { okxAllWalletCoins } = await import("./okxWallet");
    const okx = await okxAllWalletCoins({ evm, sol, tron });
    if (okx && okx.length) {
      okxCoins = okx.map((c) => ({
        // 체인 표기: 같은 심볼이 여러 체인에 있어도 구분되게.
        asset: c.chain === "eth" ? c.symbol : `${c.symbol}·${c.chain}`,
        amount: c.amount, usdValue: c.usdValue,
      }));
    }
  } catch { /* fallback below */ }

  const jobs: Promise<CoinBal | null>[] = [];
  if (!okxCoins) {
    if (evm) for (const c of EVM_READ) jobs.push(evmNative(c, evm, px));
    if (tron) jobs.push(tronNative(tron, px));
    if (sol) jobs.push(solNative(sol, px));
  }
  if (xrp) jobs.push(xrpNative(xrp, px)); // OKX 미지원 체인 — 항상 RPC

  const rest = (await Promise.all(jobs)).filter((c): c is CoinBal => !!c && c.usdValue >= 0.5);
  const coins = [...(okxCoins ?? []), ...rest].sort((a, b) => b.usdValue - a.usdValue);
  const totalUsd = coins.reduce((s, c) => s + c.usdValue, 0);
  return { venue: "wallet", connected: true, cashLabel: "", cashRaw: 0, cashUsd: 0, coins, totalUsd };
}

export function mockWalletBalance(): VenueBalance {
  const coins: CoinBal[] = [
    { asset: "XRP", amount: 3200, usdValue: 7712 }, // in-transit
    { asset: "ETH", amount: 0.4, usdValue: 1280 },
    { asset: "SOL", amount: 6, usdValue: 1020 },
  ];
  return { venue: "wallet", connected: true, cashLabel: "", cashRaw: 0, cashUsd: 0, coins, totalUsd: coins.reduce((s, c) => s + c.usdValue, 0) };
}
