// Destination deposit-address fetch — where the coin gets sent. Returns BOTH
// the address and the destination tag/memo (secondary address) because for
// tag-based coins (XRP/XLM/ATOM/TON…) the exchange deposit is UNCREDITED
// without it. Signed reads (Upbit JWT w/ query_hash, Binance HMAC), dormant
// without keys. Server-only.

import crypto from "crypto";
import type { Venue } from "./types";

export type DepositAddress = { address: string; tag: string | null };

function b64url(b: Buffer | string) {
  return Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Upbit JWT including a query_hash of the params.
function upbitJwt(key: string, secret: string, query: string) {
  const queryHash = crypto.createHash("sha512").update(query).digest("hex");
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    access_key: key, nonce: crypto.randomUUID(),
    query_hash: queryHash, query_hash_alg: "SHA512",
  }));
  const sig = crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${b64url(sig)}`;
}

async function upbitDeposit(base: string, netType: string): Promise<DepositAddress | null> {
  const key = process.env.UPBIT_KEY, secret = process.env.UPBIT_SECRET;
  if (!key || !secret) return null;
  try {
    // Build with URLSearchParams so the signed string is exactly what's sent.
    const query = new URLSearchParams({ currency: base, net_type: netType }).toString();
    const res = await fetch(`https://api.upbit.com/v1/deposits/coin_address?${query}`, {
      headers: { Authorization: `Bearer ${upbitJwt(key, secret, query)}` }, cache: "no-store",
    });
    const j = (await res.json()) as { deposit_address?: string; secondary_address?: string | null };
    if (!j.deposit_address) return null;
    return { address: j.deposit_address, tag: j.secondary_address ?? null };
  } catch {
    return null;
  }
}

async function binanceDeposit(base: string, network: string): Promise<DepositAddress | null> {
  const key = process.env.BINANCE_KEY, secret = process.env.BINANCE_SECRET;
  if (!key || !secret) return null;
  try {
    const query = new URLSearchParams({
      coin: base, network, recvWindow: "5000", timestamp: String(Date.now()),
    }).toString();
    const sig = crypto.createHmac("sha256", secret).update(query).digest("hex");
    const res = await fetch(`https://api.binance.com/sapi/v1/capital/deposit/address?${query}&signature=${sig}`, {
      headers: { "X-MBX-APIKEY": key }, cache: "no-store",
    });
    const j = (await res.json()) as { address?: string; tag?: string };
    if (!j.address) return null;
    return { address: j.address, tag: j.tag || null };
  } catch {
    return null;
  }
}

/** Deposit address (+tag) at `venue` for `base` on network `net`. null = keys/unsupported. */
export async function fetchDepositAddress(venue: Venue, base: string, net: string): Promise<DepositAddress | null> {
  if (venue === "upbit") return upbitDeposit(base, net);
  if (venue === "binance") return binanceDeposit(base, net);
  return null; // bithumb private API TODO
}
