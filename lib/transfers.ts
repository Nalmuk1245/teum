// Transfer/settlement status — per-coin deposit & withdrawal availability.
// This is the real gate on whether an edge is executable: if the coin's
// withdrawal is off on the buy venue, or deposit is off on the sell venue, the
// leg can't settle no matter how big the premium.
//
// Data sources:
//   • Bithumb — PUBLIC (/public/assetsstatus/ALL), always on.
//   • Upbit   — SIGNED (/v1/status/wallet, JWT). Needs UPBIT_KEY/SECRET.
//   • Binance — SIGNED (/sapi/v1/capital/config/getall, HMAC). Needs BINANCE_KEY/SECRET.
//
// The signed calls are FULLY WIRED but dormant: with no keys in env they return
// null (surfaced as "키 필요"). Drop keys into .env.local and they light up — no
// code change needed. Server-only module (uses node crypto); imported by the
// scanner which runs in the /api/scan route.

import crypto from "crypto";
import type { TransferStatus, Venue, WalletStatus } from "./types";
import { BINANCE_NET, chainKeyFromLabel } from "./chains";
import { COIN_NETWORK, COIN_NETWORK_DEFAULT } from "./config";

// ── Bithumb (public) ──────────────────────────────────────────────────────────
async function fetchBithumb(): Promise<Map<string, WalletStatus>> {
  const m = new Map<string, WalletStatus>();
  try {
    const res = await fetch("https://api.bithumb.com/public/assetsstatus/ALL", {
      cache: "no-store",
    });
    const j = (await res.json()) as {
      status: string;
      data?: Record<string, { deposit_status: number; withdrawal_status: number }>;
    };
    if (j.status === "0000" && j.data) {
      for (const [base, v] of Object.entries(j.data)) {
        m.set(base, {
          deposit: v.deposit_status === 1,
          withdraw: v.withdrawal_status === 1,
        });
      }
    }
  } catch {
    /* network */
  }
  return m;
}

// ── Upbit (signed, JWT) ───────────────────────────────────────────────────────
function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// HS256 JWT with { access_key, nonce } — Upbit's auth for param-less endpoints.
function upbitJwt(accessKey: string, secretKey: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ access_key: accessKey, nonce: crypto.randomUUID() }));
  const sig = crypto.createHmac("sha256", secretKey).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${b64url(sig)}`;
}

async function fetchUpbit(): Promise<Map<string, WalletStatus> | null> {
  const key = process.env.UPBIT_KEY;
  const secret = process.env.UPBIT_SECRET;
  if (!key || !secret) return null; // dormant until keys added
  try {
    const res = await fetch("https://api.upbit.com/v1/status/wallet", {
      headers: { Authorization: `Bearer ${upbitJwt(key, secret)}` },
      cache: "no-store",
    });
    const arr = (await res.json()) as Array<{ currency: string; wallet_state: string }>;
    if (!Array.isArray(arr)) return null;
    const m = new Map<string, WalletStatus>();
    for (const x of arr) {
      const s = x.wallet_state; // working | withdraw_only | deposit_only | paused | unsupported
      m.set(x.currency, {
        deposit: s === "working" || s === "deposit_only",
        withdraw: s === "working" || s === "withdraw_only",
      });
    }
    return m;
  } catch {
    return null;
  }
}

// ── Binance (signed, HMAC-SHA256) ─────────────────────────────────────────────
async function fetchBinance(): Promise<Map<string, WalletStatus> | null> {
  const key = process.env.BINANCE_KEY;
  const secret = process.env.BINANCE_SECRET;
  if (!key || !secret) return null; // dormant until keys added
  try {
    const query = `recvWindow=5000&timestamp=${Date.now()}`;
    const sig = crypto.createHmac("sha256", secret).update(query).digest("hex");
    const res = await fetch(
      `https://api.binance.com/sapi/v1/capital/config/getall?${query}&signature=${sig}`,
      { headers: { "X-MBX-APIKEY": key }, cache: "no-store" },
    );
    const arr = (await res.json()) as Array<{
      coin: string;
      depositAllEnable: boolean;
      withdrawAllEnable: boolean;
      networkList?: Array<{ network: string; depositEnable: boolean; withdrawEnable: boolean }>;
    }>;
    if (!Array.isArray(arr)) return null;
    const m = new Map<string, WalletStatus>();
    for (const c of arr) {
      // Per-network gate: the coin-level flags say "some network works", but we
      // transfer on ONE specific chain (COIN_NETWORK) — if that chain is
      // suspended while another is up, coin-level would greenlight a trade that
      // strands at the withdraw step. Match our chain's networkList entry.
      const chainKey = chainKeyFromLabel((COIN_NETWORK[c.coin] ?? COIN_NETWORK_DEFAULT).chain);
      const wanted = BINANCE_NET[chainKey];
      const net = wanted ? c.networkList?.find((n) => n.network === wanted) : undefined;
      m.set(c.coin, net
        ? { deposit: !!net.depositEnable, withdraw: !!net.withdrawEnable }
        : { deposit: !!c.depositAllEnable, withdraw: !!c.withdrawAllEnable });
    }
    return m;
  } catch {
    return null;
  }
}

// ── Aggregate ─────────────────────────────────────────────────────────────────
export async function fetchTransferStatus(): Promise<TransferStatus> {
  const [bithumb, upbit, binance] = await Promise.all([
    fetchBithumb(),
    fetchUpbit(),
    fetchBinance(),
  ]);
  const byVenue: TransferStatus["byVenue"] = { bithumb };
  if (upbit) byVenue.upbit = upbit;
  if (binance) byVenue.binance = binance;
  return { byVenue };
}

/** Wallet status for a coin on a venue, or null when unknown (no keys / not listed). */
export function walletStatus(
  ts: TransferStatus | undefined,
  venue: Venue,
  base: string,
): WalletStatus | null {
  return ts?.byVenue[venue]?.get(base) ?? null;
}
