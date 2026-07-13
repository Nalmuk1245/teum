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

async function bybitDeposit(base: string, chain: string): Promise<DepositAddress | null> {
  const key = process.env.BYBIT_KEY, secret = process.env.BYBIT_SECRET;
  if (!key || !secret) return null;
  try {
    const ts = String(Date.now()), recv = "5000";
    const query = new URLSearchParams({ coin: base, chainType: chain }).toString();
    const sig = crypto.createHmac("sha256", secret).update(ts + key + recv + query).digest("hex");
    const res = await fetch(`https://api.bybit.com/v5/asset/deposit/query-address?${query}`, {
      headers: { "X-BAPI-API-KEY": key, "X-BAPI-TIMESTAMP": ts, "X-BAPI-RECV-WINDOW": recv, "X-BAPI-SIGN": sig },
      cache: "no-store",
    });
    const j = (await res.json()) as { retCode: number; result?: { chains?: Array<{ addressDeposit?: string; tagDeposit?: string }> } };
    const c = j.result?.chains?.[0];
    if (j.retCode !== 0 || !c?.addressDeposit) return null;
    return { address: c.addressDeposit, tag: c.tagDeposit || null };
  } catch { return null; }
}

async function okxDeposit(base: string, chain: string): Promise<DepositAddress | null> {
  const key = process.env.OKX_KEY, secret = process.env.OKX_SECRET, pass = process.env.OKX_PASSPHRASE;
  if (!key || !secret || !pass) return null;
  try {
    const path = `/api/v5/asset/deposit-address?ccy=${base}`;
    const ts = new Date().toISOString();
    const sig = crypto.createHmac("sha256", secret).update(ts + "GET" + path).digest("base64");
    const res = await fetch(`https://www.okx.com${path}`, {
      headers: { "OK-ACCESS-KEY": key, "OK-ACCESS-SIGN": sig, "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": pass },
      cache: "no-store",
    });
    const j = (await res.json()) as { code: string; data?: Array<{ addr: string; chain: string; selected: boolean; tag?: string; memo?: string }> };
    if (j.code !== "0") return null;
    // Match the requested chain (OKX chain = "BASE-Network"), else first selected.
    const d = j.data?.find((x) => x.chain?.toUpperCase().includes(chain.toUpperCase()) && x.selected) ?? j.data?.find((x) => x.selected) ?? j.data?.[0];
    if (!d?.addr) return null;
    return { address: d.addr, tag: d.tag || d.memo || null };
  } catch { return null; }
}

/** Deposit address (+tag) at `venue` for `base` on network `net`. null = keys/unsupported. */
export async function fetchDepositAddress(venue: Venue, base: string, net: string): Promise<DepositAddress | null> {
  if (venue === "upbit") return upbitDeposit(base, net);
  if (venue === "binance") return binanceDeposit(base, net);
  if (venue === "bybit") return bybitDeposit(base, net);
  if (venue === "okx") return okxDeposit(base, net);
  if (venue === "bithumb") return bithumbDeposit(base, net);
  return null;
}

// Bithumb v1 /info/wallet_address — returns "address" (with "&tag" appended for
// tag coins, or a separate destination_tag field depending on the coin).
async function bithumbDeposit(base: string, net: string): Promise<DepositAddress | null> {
  const key = process.env.BITHUMB_KEY, secret = process.env.BITHUMB_SECRET;
  if (!key || !secret) return null;
  try {
    const endpoint = "/info/wallet_address";
    const nonce = String(Date.now());
    const body = new URLSearchParams({ endpoint, currency: base, net_type: net }).toString();
    const strData = `${endpoint}${String.fromCharCode(0)}${body}${String.fromCharCode(0)}${nonce}`;
    const sign = Buffer.from(crypto.createHmac("sha512", secret).update(strData).digest("hex")).toString("base64");
    const res = await fetch(`https://api.bithumb.com${endpoint}`, {
      method: "POST",
      headers: { "Api-Key": key, "Api-Sign": sign, "Api-Nonce": nonce, "Content-Type": "application/x-www-form-urlencoded", "api-client-type": "2" },
      body, cache: "no-store",
    });
    const j = (await res.json()) as { status: string; data?: { wallet_address?: string } };
    if (j.status !== "0000" || !j.data?.wallet_address) return null;
    // Tag coins come as "address&tag"; split on the separator.
    const [address, tag] = j.data.wallet_address.split(/[&]/);
    return { address, tag: tag || null };
  } catch { return null; }
}
