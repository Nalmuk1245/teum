// Personal-wallet on-chain balances (read-only). Reads native assets across
// chains using PUBLIC RPCs by ADDRESS only — no private key needed to read.
// Addresses come from WALLET_ADDR_* env, or the EVM one is derived from
// WALLET_PRIVATE_KEY. Server-only. Falls back to a demo wallet when USE_MOCK.

import { JsonRpcProvider, Wallet, formatEther } from "ethers";
import type { CoinBal, VenueBalance } from "./types";
import { CHAINS } from "./chains";
import { CONFIG } from "./config";
import { listCuratedTokens } from "./tokens";
import { listManualTokens } from "./manualTokens";
import { erc20Balance } from "./erc20";

const EVM_READ = ["ethereum", "polygon", "arbitrum", "base"] as const;

// 토큰 USD — 가격맵에 없는 스테이블은 1로 간주 (전송 중 자산의 대부분이 스테이블
// 인데, 스캔 가격맵은 스테이블을 유니버스에서 빼기 때문에 조회가 항상 비었다).
const STABLE_1USD = new Set(["USDT", "USDC", "DAI", "TUSD", "FDUSD"]);
function usdToken(sym: string, px: Map<string, number>): number {
  return px.get(sym) ?? (STABLE_1USD.has(sym) ? 1 : 0);
}

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

// Tron: 계정 조회 한 번이 네이티브 TRX와 TRC20 잔고 목록을 같이 싣고 온다 —
// 별도 컨트랙트 호출 없이 큐레이션 맵에 있는 토큰(USDT 등)만 이름 붙여 편입.
async function tronAssets(addr: string, px: Map<string, number>): Promise<CoinBal[]> {
  try {
    const r = await fetch(`${CHAINS.tron.rpc}/v1/accounts/${addr}`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    const j = (await r.json()) as { data?: Array<{ balance?: number; trc20?: Array<Record<string, string>> }> };
    const out: CoinBal[] = [];
    const trx = Number(j.data?.[0]?.balance ?? 0) / 1e6;
    if (trx > 0) out.push({ asset: "TRX", amount: trx, usdValue: trx * usdNative("TRX", px) });
    const known = new Map(listCuratedTokens().filter((t) => t.chain === "tron").map((t) => [t.address, t]));
    for (const entry of j.data?.[0]?.trc20 ?? []) {
      for (const [contract, raw] of Object.entries(entry)) {
        const t = known.get(contract);
        if (!t) continue; // 모르는 컨트랙트는 표시 안 함 (스캠 에어드랍이 잔고에 섞이는 걸 막는다)
        const amount = Number(raw) / 10 ** t.decimals;
        if (amount > 0) out.push({ asset: `${t.base}·tron`, amount, usdValue: amount * usdToken(t.base, px) });
      }
    }
    return out;
  } catch {
    return [];
  }
}

// EVM ERC20 — 자동 발견이 없으므로 큐레이션 맵 + 운영자 수동 등록분만 읽는다.
// (읽어볼 후보 = 이 콕핏이 전송할 수 있는 토큰 전부와 정확히 일치한다.)
async function evmTokens(addr: string, px: Map<string, number>): Promise<CoinBal[]> {
  const evmChains = new Set(Object.values(CHAINS).filter((c) => c.family === "evm").map((c) => c.key));
  const candidates = new Map<string, { base: string; chain: string; address: string; decimals: number }>();
  for (const t of listCuratedTokens()) if (evmChains.has(t.chain)) candidates.set(`${t.base}:${t.chain}`, t);
  for (const m of listManualTokens()) // 수동 등록은 EVM만 존재
    candidates.set(`${m.base}:${m.chain}`, { base: m.base, chain: m.chain, address: m.entry.address, decimals: m.entry.decimals });
  const jobs = [...candidates.values()].map(async (t): Promise<CoinBal | null> => {
    const amount = await erc20Balance(t.chain, t.address, addr, t.decimals);
    if (!amount || amount <= 0) return null;
    const asset = t.chain === "ethereum" ? t.base : `${t.base}·${t.chain}`;
    return { asset, amount, usdValue: amount * usdToken(t.base, px) };
  });
  return (await Promise.all(jobs)).filter((c): c is CoinBal => !!c);
}

// SPL — getTokenAccountsByOwner 한 번이면 전 토큰 계정이 온다. 민트→심볼은
// 아는 것만 (모르는 민트는 가격도 심볼도 없어 노이즈일 뿐).
const SPL_MINTS: Record<string, { sym: string }> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { sym: "USDC" },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { sym: "USDT" },
};
async function splTokens(addr: string, px: Map<string, number>): Promise<CoinBal[]> {
  try {
    const r = await fetch(CHAINS.solana.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner",
        params: [addr, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { encoding: "jsonParsed" }],
      }),
      cache: "no-store", signal: AbortSignal.timeout(5000),
    });
    const j = (await r.json()) as {
      result?: { value?: Array<{ account?: { data?: { parsed?: { info?: { mint?: string; tokenAmount?: { uiAmount?: number } } } } } }> };
    };
    const out: CoinBal[] = [];
    for (const acc of j.result?.value ?? []) {
      const info = acc.account?.data?.parsed?.info;
      const known = info?.mint ? SPL_MINTS[info.mint] : undefined;
      const amount = info?.tokenAmount?.uiAmount ?? 0;
      if (known && amount > 0) out.push({ asset: `${known.sym}·solana`, amount, usdValue: amount * usdToken(known.sym, px) });
    }
    return out;
  } catch {
    return [];
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
  const listJobs: Promise<CoinBal[]>[] = [];
  if (!okxCoins) {
    if (evm) {
      for (const c of EVM_READ) jobs.push(evmNative(c, evm, px));
      listJobs.push(evmTokens(evm, px)); // 큐레이션+수동 등록 ERC20 (전송 중 토큰이 자산 탭에서 사라지지 않게)
    }
    if (tron) listJobs.push(tronAssets(tron, px)); // TRX + 알려진 TRC20 (계정 조회 1회)
    if (sol) {
      jobs.push(solNative(sol, px));
      listJobs.push(splTokens(sol, px));
    }
  }
  if (xrp) jobs.push(xrpNative(xrp, px)); // OKX 미지원 체인 — 항상 RPC

  const [singles, lists] = await Promise.all([Promise.all(jobs), Promise.all(listJobs)]);
  const rest = [...singles, ...lists.flat()].filter((c): c is CoinBal => !!c && c.usdValue >= 0.5);
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
