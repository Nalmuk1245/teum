// Real exchange orders / withdrawal — signed. FULLY WIRED but dormant: each
// call returns a simulated result unless CONFIG.DRY_RUN is false AND the venue's
// keys are set. Server-only (node crypto). Powers the exec-step handlers.

import crypto from "crypto";
import { CONFIG } from "./config";

export type OrderResult = { ok: boolean; dryRun: boolean; id: string | null; message: string };

const sim = (msg: string, key: boolean): OrderResult => ({
  ok: true, dryRun: true, id: null,
  message: key ? `DRY_RUN — ${msg}` : `키 없음 — ${msg} (모의)`,
});

// ── Binance (spot + futures + withdraw), HMAC-SHA256 ──────────────────────────
function bnKeys() {
  return { key: process.env.BINANCE_KEY, secret: process.env.BINANCE_SECRET };
}
async function binanceSigned(host: string, path: string, params: Record<string, string | number>) {
  const { key, secret } = bnKeys();
  const q = new URLSearchParams({ ...params, recvWindow: "5000", timestamp: String(Date.now()) } as Record<string, string>).toString();
  const sig = crypto.createHmac("sha256", secret!).update(q).digest("hex");
  const res = await fetch(`https://${host}${path}?${q}&signature=${sig}`, {
    method: "POST", headers: { "X-MBX-APIKEY": key! }, cache: "no-store",
  });
  return res.json();
}

export async function binanceSpot(base: string, side: "BUY" | "SELL", opts: { quoteUsd?: number; qty?: number }): Promise<OrderResult> {
  const { key } = bnKeys();
  if (CONFIG.DRY_RUN || !key) return sim(`Binance ${base} ${side} 현물`, !!key);
  try {
    const p: Record<string, string | number> = { symbol: `${base}USDT`, side, type: "MARKET" };
    if (side === "BUY" && opts.quoteUsd) p.quoteOrderQty = opts.quoteUsd;
    else if (opts.qty) p.quantity = opts.qty;
    const j = await binanceSigned("api.binance.com", "/api/v3/order", p);
    const ok = !!j.orderId;
    return { ok, dryRun: false, id: j.orderId ? String(j.orderId) : null, message: ok ? `Binance ${base} ${side} 체결` : (j.msg || "주문 실패") };
  } catch (e) {
    return { ok: false, dryRun: false, id: null, message: e instanceof Error ? e.message : "주문 실패" };
  }
}

// Perp short (open) / close (reduceOnly buy).
export async function binancePerp(base: string, action: "SHORT" | "CLOSE", qty: number): Promise<OrderResult> {
  const { key } = bnKeys();
  if (CONFIG.DRY_RUN || !key) return sim(`Binance ${base} 선물 ${action}`, !!key);
  try {
    const p: Record<string, string | number> = {
      symbol: `${base}USDT`, type: "MARKET", quantity: qty,
      side: action === "SHORT" ? "SELL" : "BUY",
      ...(action === "CLOSE" ? { reduceOnly: "true" } : {}),
    };
    const j = await binanceSigned("fapi.binance.com", "/fapi/v1/order", p);
    const ok = !!j.orderId;
    return { ok, dryRun: false, id: j.orderId ? String(j.orderId) : null, message: ok ? `Binance ${base} 선물 ${action}` : (j.msg || "선물 주문 실패") };
  } catch (e) {
    return { ok: false, dryRun: false, id: null, message: e instanceof Error ? e.message : "선물 주문 실패" };
  }
}

export async function binanceWithdraw(base: string, network: string, address: string, amount: number): Promise<OrderResult> {
  const { key } = bnKeys();
  if (CONFIG.DRY_RUN || !key) return sim(`Binance ${base} 출금 → ${address.slice(0, 10)}…`, !!key);
  try {
    const j = await binanceSigned("api.binance.com", "/sapi/v1/capital/withdraw/apply", {
      coin: base, network, address, amount,
    });
    const ok = !!j.id;
    return { ok, dryRun: false, id: j.id ?? null, message: ok ? `Binance ${base} 출금 요청` : (j.msg || "출금 실패") };
  } catch (e) {
    return { ok: false, dryRun: false, id: null, message: e instanceof Error ? e.message : "출금 실패" };
  }
}

// ── Upbit (JWT with query_hash) ───────────────────────────────────────────────
function b64url(b: Buffer | string) {
  return Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function upbitJwt(key: string, secret: string, query: string) {
  const queryHash = crypto.createHash("sha512").update(query).digest("hex");
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ access_key: key, nonce: crypto.randomUUID(), query_hash: queryHash, query_hash_alg: "SHA512" }));
  const s = crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${b64url(s)}`;
}

export async function upbitOrder(base: string, side: "bid" | "ask", opts: { volume?: number; priceKrw?: number }): Promise<OrderResult> {
  const key = process.env.UPBIT_KEY, secret = process.env.UPBIT_SECRET;
  if (CONFIG.DRY_RUN || !key || !secret) return sim(`Upbit ${base} ${side === "ask" ? "매도" : "매수"}`, !!(key && secret));
  try {
    // market sell = ord_type "market" + volume; market buy = "price" + price.
    const params: Record<string, string> = { market: `KRW-${base}`, side };
    if (side === "ask") { params.ord_type = "market"; params.volume = String(opts.volume ?? 0); }
    else { params.ord_type = "price"; params.price = String(opts.priceKrw ?? 0); }
    const query = new URLSearchParams(params).toString();
    const res = await fetch(`https://api.upbit.com/v1/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${upbitJwt(key, secret, query)}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: query, cache: "no-store",
    });
    const j = await res.json();
    const ok = !!j.uuid;
    return { ok, dryRun: false, id: j.uuid ?? null, message: ok ? `Upbit ${base} ${side === "ask" ? "매도" : "매수"} 체결` : (j.error?.message || "주문 실패") };
  } catch (e) {
    return { ok: false, dryRun: false, id: null, message: e instanceof Error ? e.message : "주문 실패" };
  }
}
