// OKX DEX Aggregator client — quotes (and later swap calldata) across chains
// with multi-DEX routing, one API. Signed with the OKX Web3 API key (separate
// from the trading key; same OK-ACCESS header scheme). Dormant without keys.
//
// Why OKX over a raw QuoterV2: best-route across dozens of DEXes, gas estimate
// in the response, and /swap returns ready-to-sign calldata for the execution
// phase — our wallet just signs (with router whitelist + minOut checks).

import crypto from "crypto";
import { CHAINS } from "./chains";

const HOST = "https://www.okx.com";

function keys() {
  return {
    key: process.env.OKX_WEB3_KEY,
    secret: process.env.OKX_WEB3_SECRET,
    pass: process.env.OKX_WEB3_PASSPHRASE,
  };
}
export function dexConfigured(): boolean {
  const k = keys();
  return !!(k.key && k.secret && k.pass);
}

async function okxGet(path: string, params: Record<string, string>): Promise<unknown[]> {
  const { key, secret, pass } = keys();
  if (!key || !secret || !pass) return [];
  const query = new URLSearchParams(params).toString();
  const requestPath = `${path}?${query}`;
  const ts = new Date().toISOString();
  const sign = crypto.createHmac("sha256", secret).update(`${ts}GET${requestPath}`).digest("base64");
  const res = await fetch(`${HOST}${requestPath}`, {
    headers: {
      "OK-ACCESS-KEY": key,
      "OK-ACCESS-SIGN": sign,
      "OK-ACCESS-TIMESTAMP": ts,
      "OK-ACCESS-PASSPHRASE": pass,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  const j = (await res.json()) as { code: string; data?: unknown[]; msg?: string };
  if (j.code !== "0" || !j.data) throw new Error(`OKX DEX: ${j.msg ?? j.code}`);
  return j.data;
}

export const OKX_CHAIN_ID: Record<string, string> = {
  ethereum: "1", base: "8453", arbitrum: "42161", optimism: "10",
  bsc: "56", polygon: "137", avalanche: "43114", solana: "501",
};

export type DexQuote = {
  toAmount: number; // human units of the to-token
  gasUnits: number; // estimated gas of the swap tx
};

/** Best-route quote: swap `amountHuman` of from-token → to-token on `chainKey`. */
export async function quoteDex(
  chainKey: string,
  from: { address: string; decimals: number },
  to: { address: string; decimals: number },
  amountHuman: number,
): Promise<DexQuote | null> {
  const chainId = OKX_CHAIN_ID[chainKey];
  if (!chainId) return null;
  const amountRaw = BigInt(Math.round(amountHuman * 10 ** Math.min(from.decimals, 12)))
    * BigInt(10) ** BigInt(Math.max(0, from.decimals - 12));
  try {
    const data = await okxGet("/api/v5/dex/aggregator/quote", {
      chainId,
      fromTokenAddress: from.address,
      toTokenAddress: to.address,
      amount: amountRaw.toString(),
    });
    const q = data[0] as { toTokenAmount?: string; estimateGasFee?: string } | undefined;
    if (!q?.toTokenAmount) return null;
    return {
      toAmount: Number(q.toTokenAmount) / 10 ** to.decimals,
      gasUnits: Number(q.estimateGasFee ?? 0),
    };
  } catch {
    return null;
  }
}

// ── Gas cost (USD) for an ethereum-family swap ────────────────────────────────
// gasPrice via the chain RPC + native price in USD (caller supplies ETH price
// from the already-fetched CEX tickers). Cached 60s.
type GasCache = { wei: number; ts: number };
const g = globalThis as unknown as { __arbGasPrice?: Map<string, GasCache> };
g.__arbGasPrice ??= new Map();

export async function gasPriceWei(chainKey: string): Promise<number | null> {
  const hit = g.__arbGasPrice!.get(chainKey);
  if (hit && Date.now() - hit.ts < 60_000) return hit.wei;
  const rpc = CHAINS[chainKey]?.rpc;
  if (!rpc) return null;
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    const j = (await res.json()) as { result?: string };
    if (!j.result) return null;
    const wei = Number.parseInt(j.result, 16);
    g.__arbGasPrice!.set(chainKey, { wei, ts: Date.now() });
    return wei;
  } catch {
    return null;
  }
}

/** USD cost of a swap given its gas units (needs the native coin's USD price). */
export function gasCostUsd(gasUnits: number, gasWei: number, nativeUsd: number): number {
  return (gasUnits * gasWei * nativeUsd) / 1e18;
}
