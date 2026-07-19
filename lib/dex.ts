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

function okxHeaders(method: string, requestPath: string, bodyStr = ""): Record<string, string> | null {
  const { key, secret, pass } = keys();
  if (!key || !secret || !pass) return null;
  const ts = new Date().toISOString();
  const { createHmac } = require("crypto") as typeof import("crypto");
  const sign = createHmac("sha256", secret).update(ts + method + requestPath + bodyStr).digest("base64");
  const h: Record<string, string> = {
    "OK-ACCESS-KEY": key, "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": pass,
  };
  if (process.env.OKX_WEB3_PROJECT) h["OK-ACCESS-PROJECT"] = process.env.OKX_WEB3_PROJECT;
  return h;
}

/** Wallet API 등 POST 계열 (프로젝트 헤더 포함). */
export async function okxPost(path: string, body: Record<string, unknown>): Promise<{ code: string; data: unknown[]; msg?: string }> {
  const bodyStr = JSON.stringify(body);
  const headers = okxHeaders("POST", path, bodyStr);
  if (!headers) return { code: "-1", data: [], msg: "키 없음" };
  const res = await fetch(`https://www.okx.com${path}`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: bodyStr, cache: "no-store", signal: AbortSignal.timeout(8000),
  });
  return (await res.json()) as { code: string; data: unknown[]; msg?: string };
}

export async function okxGet(path: string, params: Record<string, string>): Promise<unknown[]> {
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
  // DEX 애그리게이터 지원 확인됨 (supported/chain 실측)
  zksync: "324", linea: "59144", mantle: "5000", scroll: "534352",
  xlayer: "196", manta: "169", metis: "1088", blast: "81457",
  sonic: "146", cronos: "25", fantom: "250", monad: "143", hyperevm: "999",
};

// ── cex-dex universe per chain ────────────────────────────────────────────────
// DEX-side token contracts for DETECTION quoting only — deliberately separate
// from tokens.ts (which drives real wallet sends). Bases the CEX doesn't list
// are skipped at runtime, so it's safe to include candidates.
export type DexToken = { address: string; decimals: number };

// ── OKX Wallet API: 전송 tx 빌드 (sign-info) ─────────────────────────────────
// 프로젝트 ID(OKX_WEB3_PROJECT)가 있을 때만 동작 — 가스한도·논스·수수료 제안을
// OKX가 계산해준다. 서명·방송은 항상 로컬(ethers). 실패하면 null → ethers 자체
// 추정으로 폴백하므로 fail-open이어도 안전(빌드 보조일 뿐 자금 위험 없음).
export type TxBuild = {
  nonce?: number; gasLimit?: bigint;
  maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint;
};

export async function okxSignInfo(
  chainKey: string, fromAddr: string, toAddr: string, valueWei: bigint, data?: string,
): Promise<TxBuild | null> {
  if (!process.env.OKX_WEB3_PROJECT) return null;
  // 지갑 API의 chainIndex = EVM chainId — DEX 미지원 체인(Kaia 등)도 빌드는 가능.
  const { CHAINS } = await import("./chains");
  const chainId = CHAINS[chainKey]?.evmChainId != null ? String(CHAINS[chainKey].evmChainId) : OKX_CHAIN_ID[chainKey];
  if (!chainId) return null;
  try {
    const r = await okxPost("/api/v5/wallet/pre-transaction/sign-info", {
      chainIndex: chainId, fromAddr, toAddr,
      txAmount: valueWei.toString(),
      ...(data ? { extJson: { inputData: data } } : {}),
    });
    if (r.code !== "0" || !r.data[0]) return null;
    const d = r.data[0] as Record<string, unknown>;
    const num = (v: unknown): bigint | null => {
      const n = typeof v === "string" || typeof v === "number" ? BigInt(String(v).split(".")[0]) : null;
      return n != null && n > 0n ? n : null;
    };
    const out: TxBuild = {};
    const nonce = num(d.nonce);
    if (nonce != null) out.nonce = Number(nonce);
    const gasLimit = num(d.gasLimit);
    if (gasLimit != null) out.gasLimit = (gasLimit * 12n) / 10n; // +20% 여유
    const gp = d.gasPrice as Record<string, unknown> | undefined;
    const proto = (gp?.eip1559Protocol ?? gp?.erc1599Protocol) as Record<string, unknown> | undefined;
    if (proto) {
      const base = num(proto.suggestBaseFee ?? proto.baseFee);
      const prio = num(proto.proposePriorityFee ?? proto.safePriorityFee);
      if (base != null && prio != null) {
        out.maxFeePerGas = base * 2n + prio; // 다음 블록 baseFee 급등 버퍼
        out.maxPriorityFeePerGas = prio;
      }
    } else {
      const normal = num(gp?.normal);
      if (normal != null) out.gasPrice = normal;
    }
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}
export type DexChainUniverse = {
  chain: string; // chains.ts key
  native: "ETH" | "BNB"; // gas is paid in this (priced via CEX ticker)
  quote: { symbol: string; address: string; decimals: number }; // stable we quote against
  bases: Record<string, DexToken>;
};

// 체인별 견적 스테이블 — 상장 상세·DEX 매수·브릿지가 공용으로 쓴다.
// (CEXDEX_CHAINS는 cex-dex 전략 전용 EVM 유니버스 — 솔라나는 여기만)
export const QUOTE_STABLES: Record<string, { symbol: string; address: string; decimals: number }> = {
  ethereum: { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  base: { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  bsc: { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
  solana: { symbol: "USDC", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  // 아래는 OKX all-tokens에서 추출 후 네이티브→스테이블 실견적 통과한 주소만
  // (팬텀은 리스트에 스테이블이 없어 제외 — 소닉으로 이주)
  polygon: { symbol: "USDC", address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", decimals: 6 },
  arbitrum: { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
  optimism: { symbol: "USDC", address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", decimals: 6 },
  avalanche: { symbol: "USDC", address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6 },
  zksync: { symbol: "USDC", address: "0x1d17cbcf0d6d143135ae902365d2e5e2a16538d4", decimals: 6 },
  linea: { symbol: "USDC", address: "0x176211869ca2b568f2a7d4ee941e073a821ee1ff", decimals: 6 },
  mantle: { symbol: "USDC", address: "0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9", decimals: 6 },
  scroll: { symbol: "USDC", address: "0x06efdbff2a14a7c8e15944d1f4a48f9f95f663a4", decimals: 6 },
  xlayer: { symbol: "USDC", address: "0x74b7f16337b8972027f6196a17a631ac6de26d22", decimals: 6 },
  manta: { symbol: "USDC", address: "0xb73603c5d87fa094b7314c74ace2e64d165016fb", decimals: 6 },
  metis: { symbol: "m.USDT", address: "0xbB06DCA3AE6887fAbF931640f67cab3e3a16F4dC", decimals: 6 },
  blast: { symbol: "USDB", address: "0x4300000000000000000000000000000000000003", decimals: 18 },
  sonic: { symbol: "USDC", address: "0x29219dd400f2bf60e5a23d13be72b486d4038894", decimals: 6 },
  cronos: { symbol: "USDC", address: "0xc21223249CA28397B4B6541dfFaEcC539BfF0c59", decimals: 6 },
  monad: { symbol: "USDC", address: "0x754704bc059f8c67012fed69bc8a327a5aafb603", decimals: 6 },
  hyperevm: { symbol: "USDC", address: "0xb88339cb7199b77e23db6e890353e22632ba630f", decimals: 6 },
};

// OKX 토큰리스트 (체인당 1시간 캐시) — cex-dex 유니버스 자동 확장의 원천.
// 같은 심볼이 여러 컨트랙트면 모호 → null 마킹(스캠 충돌 방지, 스킵).
const gTok = globalThis as unknown as { __okxTokens?: Map<string, { ts: number; map: Map<string, DexToken | null> }> };
gTok.__okxTokens ??= new Map();
export async function allTokens(chainKey: string): Promise<Map<string, DexToken | null>> {
  const chainId = OKX_CHAIN_ID[chainKey];
  if (!chainId) return new Map();
  const hit = gTok.__okxTokens!.get(chainKey);
  if (hit && Date.now() - hit.ts < 60 * 60_000) return hit.map;
  const map = new Map<string, DexToken | null>();
  try {
    const data = await okxGet("/api/v6/dex/aggregator/all-tokens", { chainIndex: chainId });
    for (const t of data as { tokenSymbol?: string; tokenContractAddress?: string; decimals?: string }[]) {
      const sym = t.tokenSymbol?.toUpperCase();
      if (!sym || !t.tokenContractAddress) continue;
      if (map.has(sym)) { map.set(sym, null); continue; } // 중복 심볼 = 모호
      map.set(sym, { address: t.tokenContractAddress, decimals: Number(t.decimals ?? 18) });
    }
    gTok.__okxTokens!.set(chainKey, { ts: Date.now(), map });
  } catch { /* 리스트 실패 → 빈 맵 (하드코딩 유니버스만) */ }
  return map;
}

export const CEXDEX_CHAINS: DexChainUniverse[] = [
  {
    chain: "ethereum", native: "ETH",
    quote: { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    bases: {
      UNI: { address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", decimals: 18 },
      LINK: { address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", decimals: 18 },
      AAVE: { address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", decimals: 18 },
      PEPE: { address: "0x6982508145454Ce325dDbE47a25d4ec3d2311933", decimals: 18 },
      SHIB: { address: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", decimals: 18 },
      CRV: { address: "0xD533a949740bb3306d119CC777fa900bA034cd52", decimals: 18 },
      LDO: { address: "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32", decimals: 18 },
      MKR: { address: "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2", decimals: 18 },
      GRT: { address: "0xc944E90C64B2c07662A292be6244BDf05Cda44a7", decimals: 18 },
    },
  },
  {
    chain: "base", native: "ETH", // Base gas is ETH
    quote: { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
    bases: {
      VIRTUAL: { address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", decimals: 18 },
      AERO: { address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", decimals: 18 },
      DEGEN: { address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", decimals: 18 },
    },
  },
  {
    chain: "bsc", native: "BNB",
    quote: { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 }, // BSC-USD is 18dp
    bases: {
      CAKE: { address: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", decimals: 18 },
      FLOKI: { address: "0xfb5B838b6cfEEdC2873aB27866079AC55363D37E", decimals: 9 }, // BSC FLOKI is 9dp
      TWT: { address: "0x4B0F1812e5Df2A09796481Ff14017e6005508003", decimals: 18 },
    },
  },
];

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
    const data = await okxGet("/api/v6/dex/aggregator/quote", {
      chainIndex: chainId,
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

// ── 스왑 미리보기 — 견적 응답의 리치 필드까지 전부 ───────────────────────────
// 가격임팩트·수수료·라우팅 경로에 더해 OKX가 토큰 안전성(허니팟·전송세)도
// 같이 주므로 상장따리 매수 전 확인용으로 그대로 노출한다.
export type DexPreview = {
  toAmount: number;
  gasUnits: number;
  priceImpactPct: number | null;
  tradeFeeUsd: number | null;
  route: string[]; // hop별 "USDC→PEPE Uniswap V3 100%"
  honeypot: boolean;
  taxRatePct: number | null; // 매수 대상 토큰의 전송세 (%)
};

export async function quoteDexPreview(
  chainKey: string,
  from: { address: string; decimals: number },
  to: { address: string; decimals: number },
  amountHuman: number,
): Promise<DexPreview | null> {
  const chainId = OKX_CHAIN_ID[chainKey];
  if (!chainId) return null;
  const amountRaw = BigInt(Math.round(amountHuman * 10 ** Math.min(from.decimals, 12)))
    * BigInt(10) ** BigInt(Math.max(0, from.decimals - 12));
  try {
    const data = await okxGet("/api/v6/dex/aggregator/quote", {
      chainIndex: chainId,
      fromTokenAddress: from.address,
      toTokenAddress: to.address,
      amount: amountRaw.toString(),
    });
    type Hop = {
      dexProtocol?: { dexName?: string; percent?: string } | { dexName?: string; percent?: string }[];
      fromToken?: { tokenSymbol?: string };
      toToken?: { tokenSymbol?: string };
    };
    const q = data[0] as {
      toTokenAmount?: string; estimateGasFee?: string; priceImpactPercent?: string;
      tradeFee?: string; dexRouterList?: Hop[];
      toToken?: { isHoneyPot?: boolean; taxRate?: string };
    } | undefined;
    if (!q?.toTokenAmount) return null;
    const route: string[] = [];
    for (const hop of q.dexRouterList ?? []) {
      const protos = Array.isArray(hop.dexProtocol) ? hop.dexProtocol : hop.dexProtocol ? [hop.dexProtocol] : [];
      const via = protos.map((p) => `${p.dexName ?? "?"}${p.percent && p.percent !== "100" ? ` ${p.percent}%` : ""}`).join("+");
      route.push(`${hop.fromToken?.tokenSymbol ?? "?"}→${hop.toToken?.tokenSymbol ?? "?"} (${via || "?"})`);
    }
    const tax = q.toToken?.taxRate != null ? Number(q.toToken.taxRate) * 100 : null;
    return {
      toAmount: Number(q.toTokenAmount) / 10 ** to.decimals,
      gasUnits: Number(q.estimateGasFee ?? 0),
      priceImpactPct: q.priceImpactPercent != null && q.priceImpactPercent !== "" ? Number(q.priceImpactPercent) : null,
      tradeFeeUsd: q.tradeFee != null && q.tradeFee !== "" ? Number(q.tradeFee) : null,
      route,
      honeypot: !!q.toToken?.isHoneyPot,
      taxRatePct: tax != null && tax > 0 ? tax : null,
    };
  } catch {
    return null;
  }
}

// ── 스왑 tx 상태 추적 (post-transaction/orders) ───────────────────────────────
// 방송 후 OKX가 온체인 확정/실패를 추적해준다. txStatus: 1=대기 2=성공 3=실패.
export type SwapTxStatus = { status: "pending" | "success" | "fail" | "unknown"; failReason: string | null };

export async function okxSwapTxStatus(chainKey: string, address: string, txHash: string): Promise<SwapTxStatus | null> {
  const chainId = OKX_CHAIN_ID[chainKey];
  if (!chainId) return null;
  try {
    const data = await okxGet("/api/v6/dex/post-transaction/orders", {
      chainIndex: chainId, address, txHash, limit: "5",
    });
    const orders = (data[0] as { orders?: { txHash?: string; txStatus?: string; failReason?: string }[] })?.orders ?? [];
    const o = orders.find((x) => x.txHash?.toLowerCase() === txHash.toLowerCase()) ?? orders[0];
    if (!o) return { status: "unknown", failReason: null };
    const st = o.txStatus === "2" ? "success" : o.txStatus === "3" ? "fail" : o.txStatus === "1" ? "pending" : "unknown";
    return { status: st, failReason: o.failReason ? String(o.failReason).slice(0, 200) : null };
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

// ── Swap / approve calldata (execution phase) ─────────────────────────────────
// OKX returns a ready-to-sign tx; the wallet signs it (with the returned router
// as the only allowed destination). Dormant without OKX_WEB3_* keys.

export type SwapTx = {
  to: string; // router/aggregator contract (whitelist source)
  data: string;
  value: string; // wei (native-in swaps)
  gas: string;
  minReceive: string; // raw units — our slippage floor, checked before signing
  toAmount: string; // expected out (raw)
};

/** Build a swap tx: `amountHuman` of from-token → to-token, slippage as fraction. */
export async function swapDex(
  chainKey: string,
  from: { address: string; decimals: number },
  to: { address: string; decimals: number },
  amountHuman: number,
  slippage: number,
  walletAddr: string,
): Promise<SwapTx | null> {
  const chainId = OKX_CHAIN_ID[chainKey];
  if (!chainId) return null;
  const amountRaw = BigInt(Math.round(amountHuman * 10 ** Math.min(from.decimals, 12)))
    * BigInt(10) ** BigInt(Math.max(0, from.decimals - 12));
  try {
    const data = await okxGet("/api/v6/dex/aggregator/swap", {
      chainIndex: chainId,
      fromTokenAddress: from.address,
      toTokenAddress: to.address,
      amount: amountRaw.toString(),
      slippagePercent: String(slippage * 100), // v6는 % 단위 (v5는 소수)
      userWalletAddress: walletAddr,
    });
    const d = data[0] as { tx?: { to: string; data: string; value: string; gas: string; minReceiveAmount: string }; routerResult?: { toTokenAmount: string } } | undefined;
    if (!d?.tx?.to || !d.tx.data) return null;
    return {
      to: d.tx.to, data: d.tx.data, value: d.tx.value ?? "0", gas: d.tx.gas ?? "0",
      minReceive: d.tx.minReceiveAmount ?? "0", toAmount: d.routerResult?.toTokenAmount ?? "0",
    };
  } catch {
    return null;
  }
}

/** Build an ERC20 approve tx for the aggregator's spender (one-time per token). */
export async function approveDex(chainKey: string, tokenAddress: string, amountRaw: string): Promise<{ to: string; data: string } | null> {
  const chainId = OKX_CHAIN_ID[chainKey];
  if (!chainId) return null;
  try {
    const data = await okxGet("/api/v6/dex/aggregator/approve-transaction", {
      chainIndex: chainId, tokenContractAddress: tokenAddress, approveAmount: amountRaw,
    });
    const d = data[0] as { dexContractAddress?: string; data?: string } | undefined;
    if (!d?.dexContractAddress || !d.data) return null;
    return { to: d.dexContractAddress, data: d.data };
  } catch {
    return null;
  }
}
