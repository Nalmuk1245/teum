// Personal-wallet controller — multi-chain. The tool holds a key per chain
// family and signs/broadcasts transfers itself (the 개인지갑 → 거래소 send).
//
// ⚠️ SERVER-ONLY. Keys live in env (.env.local, never committed) and must NEVER
// reach the client. A real broadcast happens ONLY when CONFIG.DRY_RUN === false
// AND the relevant family key is set; otherwise sendToken() simulates.
//
// Families: evm (ethers, all EVM chains) · xrp (xrpl) · tron (tronweb) ·
// solana (@solana/web3.js). Native sends are wired; token (ERC20/TRC20/SPL)
// sends still need a per-coin contract/mint map (TODO).

import { Contract, JsonRpcProvider, Wallet, parseEther, parseUnits } from "ethers";
import { CHAINS, type ChainFamily } from "./chains";
import { CONFIG } from "./config";

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
];

function familyKey(family: ChainFamily): string | undefined {
  switch (family) {
    case "evm": return process.env.WALLET_PRIVATE_KEY;
    case "xrp": return process.env.WALLET_XRP_SECRET;
    case "tron": return process.env.WALLET_TRON_KEY;
    case "solana": return process.env.WALLET_SOL_KEY;
  }
}

export function walletConfigured(): boolean {
  return (["evm", "xrp", "tron", "solana"] as ChainFamily[]).some((f) => !!familyKey(f));
}

/** The EVM wallet address (whitelist THIS on the exchange withdraw side). */
export function walletAddress(): string | null {
  try {
    const k = process.env.WALLET_PRIVATE_KEY;
    return k ? new Wallet(k).address : null;
  } catch {
    return null;
  }
}

export type SendResult = { ok: boolean; dryRun: boolean; hash: string | null; message: string };
export type SendReq = {
  chain: string; // chain key from CHAINS
  to: string; // destination deposit address
  amountHuman: string; // whole coins
  tag?: string; // destination tag/memo (XRP etc.) — required by many exchange deposits
  tokenAddress?: string; // ERC20 contract; omit for native
  decimals?: number;
  confirms?: number;
};

export async function sendToken(req: SendReq): Promise<SendResult> {
  const chain = CHAINS[req.chain];
  if (!chain) return { ok: false, dryRun: false, hash: null, message: `미지원 체인: ${req.chain}` };
  const key = familyKey(chain.family);
  const live = !CONFIG.DRY_RUN && !!key;

  if (!live) {
    return {
      ok: true, dryRun: true,
      hash: `sim:${chain.key}:${req.amountHuman}`,
      message: key ? "DRY_RUN — 서명/전송 안 함" : `${chain.family} 키 없음 — 시뮬레이션`,
    };
  }

  try {
    switch (chain.family) {
      case "evm": return await sendEvm(req, key!);
      case "xrp": return await sendXrp(req, key!);
      case "tron": return await sendTron(req, key!);
      case "solana": return await sendSolana(req, key!);
    }
  } catch (e) {
    return { ok: false, dryRun: false, hash: null, message: e instanceof Error ? e.message : "전송 실패" };
  }
}

// ── EVM (ethers) ──────────────────────────────────────────────────────────────
async function sendEvm(req: SendReq, key: string): Promise<SendResult> {
  const provider = new JsonRpcProvider(CHAINS[req.chain].rpc);
  const wallet = new Wallet(key, provider);
  let hash: string;
  if (req.tokenAddress) {
    const erc20 = new Contract(req.tokenAddress, ERC20_ABI, wallet);
    const tx = await erc20.transfer(req.to, parseUnits(req.amountHuman, req.decimals ?? 18));
    hash = tx.hash;
    await tx.wait(req.confirms ?? 1);
  } else {
    const tx = await wallet.sendTransaction({ to: req.to, value: parseEther(req.amountHuman) });
    hash = tx.hash;
    await tx.wait(req.confirms ?? 1);
  }
  return { ok: true, dryRun: false, hash, message: "전송 완료" };
}

// ── XRP (xrpl) — native XRP w/ destination tag ────────────────────────────────
async function sendXrp(req: SendReq, seed: string): Promise<SendResult> {
  const xrpl: any = await import("xrpl");
  const client = new xrpl.Client(process.env.WALLET_WSS_XRP || "wss://s1.ripple.com");
  await client.connect();
  try {
    const w = xrpl.Wallet.fromSeed(seed);
    const prepared = await client.autofill({
      TransactionType: "Payment",
      Account: w.address,
      Amount: xrpl.xrpToDrops(req.amountHuman),
      Destination: req.to,
      ...(req.tag ? { DestinationTag: Number(req.tag) } : {}),
    });
    const signed = w.sign(prepared);
    const res = await client.submitAndWait(signed.tx_blob);
    const ok = res?.result?.meta?.TransactionResult === "tesSUCCESS";
    return { ok, dryRun: false, hash: signed.hash, message: ok ? "전송 완료" : "XRP 전송 실패" };
  } finally {
    await client.disconnect();
  }
}

// ── TRON (tronweb) — native TRX (TRC20 token TODO) ────────────────────────────
async function sendTron(req: SendReq, key: string): Promise<SendResult> {
  const mod: any = await import("tronweb");
  const TronWeb = mod.default ?? mod.TronWeb ?? mod;
  const tronWeb = new TronWeb({ fullHost: CHAINS.tron.rpc, privateKey: key });
  const sun = Math.round(Number(req.amountHuman) * 1e6);
  const tx = await tronWeb.trx.sendTransaction(req.to, sun);
  const hash = tx?.txid ?? tx?.transaction?.txID ?? null;
  return { ok: !!tx?.result || !!hash, dryRun: false, hash, message: hash ? "전송 완료" : "TRX 전송 실패" };
}

// ── Solana (@solana/web3.js) — native SOL (SPL token TODO) ─────────────────────
async function sendSolana(req: SendReq, key: string): Promise<SendResult> {
  const web3: any = await import("@solana/web3.js");
  const secret = key.trim().startsWith("[")
    ? Uint8Array.from(JSON.parse(key))
    : (await import("bs58")).default.decode(key);
  const from = web3.Keypair.fromSecretKey(secret);
  const conn = new web3.Connection(CHAINS.solana.rpc, "confirmed");
  const tx = new web3.Transaction().add(
    web3.SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: new web3.PublicKey(req.to),
      lamports: Math.round(Number(req.amountHuman) * 1e9),
    }),
  );
  const hash = await web3.sendAndConfirmTransaction(conn, tx, [from]);
  return { ok: true, dryRun: false, hash, message: "전송 완료" };
}
