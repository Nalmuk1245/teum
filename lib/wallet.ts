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

// ── Raw EVM tx (for DEX swap/approve calldata from OKX) ───────────────────────
// Signs and broadcasts a pre-built transaction (to/data/value). SAFETY: only
// EVM chains, only to a WHITELISTED router/spender, value capped — the calldata
// comes from OKX so we never sign a tx to an arbitrary address. Live only when
// the EVM key is set and DRY_RUN is off.
export type RawTx = { chain: string; to: string; data: string; value?: string; gas?: string };
export type RawTxResult = { ok: boolean; dryRun: boolean; hash: string | null; message: string };

/** OKX v6 솔라나 스왑 tx(base58 직렬화) 서명 + 전송. DRY는 시뮬. */
export async function sendSolRawTx(base58Data: string): Promise<RawTxResult> {
  if (CONFIG.DRY_RUN) return { ok: true, dryRun: true, message: "SOL 스왑 (모의)", hash: "sim:sol:swap" };
  const keyStr = process.env.WALLET_SOL_KEY;
  if (!keyStr) return { ok: false, dryRun: false, message: "WALLET_SOL_KEY 없음", hash: null };
  try {
    const web3 = await import("@solana/web3.js");
    const bs58 = (await import("bs58")).default;
    const secret = bs58.decode(keyStr.trim());
    const kp = web3.Keypair.fromSecretKey(secret);
    const conn = new web3.Connection(CHAINS.solana.rpc, "confirmed");
    const raw = bs58.decode(base58Data);
    const tx = web3.VersionedTransaction.deserialize(raw);
    tx.sign([kp]);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    return { ok: true, dryRun: false, message: "SOL 스왑 전송됨", hash: sig };
  } catch (e) {
    return { ok: false, dryRun: false, message: e instanceof Error ? e.message : "SOL 전송 실패", hash: null };
  }
}

export async function sendRawEvmTx(tx: RawTx, allowList: string[], maxValueWei = 0n): Promise<RawTxResult> {
  const chain = CHAINS[tx.chain];
  if (!chain || chain.family !== "evm") return { ok: false, dryRun: false, hash: null, message: `EVM 체인 아님: ${tx.chain}` };
  const key = process.env.WALLET_PRIVATE_KEY;
  if (CONFIG.DRY_RUN || !key) {
    return { ok: CONFIG.DRY_RUN, dryRun: CONFIG.DRY_RUN, hash: CONFIG.DRY_RUN ? `sim:${tx.chain}:rawtx` : null, message: key ? "DRY_RUN — 서명 안 함" : "지갑 키 없음" };
  }
  // Whitelist + value guard — never sign to an address OKX didn't route us to.
  const to = tx.to.toLowerCase();
  if (!allowList.map((a) => a.toLowerCase()).includes(to)) {
    return { ok: false, dryRun: false, hash: null, message: `목적지 ${tx.to} 화이트리스트 아님 — 서명 차단` };
  }
  const value = BigInt(tx.value ?? "0");
  if (maxValueWei > 0n && value > maxValueWei) {
    return { ok: false, dryRun: false, hash: null, message: `value ${value} > 상한 ${maxValueWei} — 차단` };
  }
  try {
    const provider = new JsonRpcProvider(chain.rpc);
    const wallet = new Wallet(key, provider);
    const sent = await wallet.sendTransaction({ to: tx.to, data: tx.data, value, ...(tx.gas ? { gasLimit: BigInt(tx.gas) } : {}) });
    await sent.wait(1);
    return { ok: true, dryRun: false, hash: sent.hash, message: "온체인 전송 완료" };
  } catch (e) {
    return { ok: false, dryRun: false, hash: null, message: e instanceof Error ? e.message : "raw tx 실패" };
  }
}
