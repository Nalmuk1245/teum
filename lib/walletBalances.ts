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
    return { asset: c.native, amount, usdValue: amount * usdNative(c.native, px) };
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

  const jobs: Promise<CoinBal | null>[] = [];
  if (evm) for (const c of EVM_READ) jobs.push(evmNative(c, evm, px));
  if (xrp) jobs.push(xrpNative(xrp, px));
  if (tron) jobs.push(tronNative(tron, px));
  if (sol) jobs.push(solNative(sol, px));

  const coins = (await Promise.all(jobs)).filter((c): c is CoinBal => !!c && c.usdValue >= 0.5).sort((a, b) => b.usdValue - a.usdValue);
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
