// Real exchange orders / withdrawal — signed. FULLY WIRED but dormant: each
// call returns a simulated result unless CONFIG.DRY_RUN is false AND the venue's
// keys are set. Server-only (node crypto). Powers the exec-step handlers.

import crypto from "crypto";
import { CONFIG } from "./config";

export type OrderResult = {
  ok: boolean; dryRun: boolean; id: string | null; message: string;
  filledQty?: number; // base actually filled
  quoteFilled?: number; // quote currency actually spent/received (fees excl.)
  txHash?: string;
};

// DRY_RUN → simulate ok. LIVE without the venue key → HARD FAIL: a silent no-op
// leg would let the state machine proceed into real orders on the other side
// (e.g. a naked hedge). Never ok:true for an unexecuted step in live mode.
const sim = (msg: string, hasKey: boolean): OrderResult =>
  CONFIG.DRY_RUN
    ? { ok: true, dryRun: true, id: null, message: hasKey ? `DRY_RUN — ${msg}` : `키 없음 — ${msg} (모의)` }
    : { ok: false, dryRun: false, id: null, message: `실행 불가 — ${msg} (키 없음)` };

// ── Binance (spot + futures + withdraw), HMAC-SHA256 ──────────────────────────
function bnKeys() {
  return { key: process.env.BINANCE_KEY, secret: process.env.BINANCE_SECRET };
}

// LOT_SIZE stepSize cache — raw float quantities get rejected (-1013) on nearly
// every symbol, so quantities must be floored to the symbol's step.
const stepCache = new Map<string, number>(); // `spot:BTCUSDT` / `perp:BTCUSDT` → stepSize
async function lotStep(kind: "spot" | "perp", symbol: string): Promise<number> {
  const ck = `${kind}:${symbol}`;
  const hit = stepCache.get(ck);
  if (hit) return hit;
  try {
    const host = kind === "spot" ? "api.binance.com/api/v3" : "fapi.binance.com/fapi/v1";
    const res = await fetch(`https://${host}/exchangeInfo?symbol=${symbol}`, {
      cache: "no-store", signal: AbortSignal.timeout(5000),
    });
    const j = (await res.json()) as { symbols?: Array<{ filters?: Array<{ filterType: string; stepSize?: string }> }> };
    const f = j.symbols?.[0]?.filters?.find((x) => x.filterType === "LOT_SIZE" || x.filterType === "MARKET_LOT_SIZE");
    const step = f?.stepSize ? Number(f.stepSize) : 0;
    if (step > 0) stepCache.set(ck, step);
    return step || 0;
  } catch {
    return 0;
  }
}
/** Floor `qty` to the symbol's LOT_SIZE step (fixed decimals to avoid float tails). */
export async function roundQty(kind: "spot" | "perp", symbol: string, qty: number): Promise<number> {
  const step = await lotStep(kind, symbol);
  if (!step) return qty;
  const floored = Math.floor(qty / step) * step;
  const decimals = Math.max(0, Math.round(-Math.log10(step)));
  return Number(floored.toFixed(decimals));
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
    if (side === "BUY" && opts.quoteUsd) p.quoteOrderQty = +opts.quoteUsd.toFixed(2);
    else if (opts.qty) p.quantity = await roundQty("spot", `${base}USDT`, opts.qty);
    const j = await binanceSigned("api.binance.com", "/api/v3/order", p);
    const ok = !!j.orderId;
    // executedQty = actual base filled (post-fill; fees may further deduct base on BUY).
    const filledQty = j.executedQty ? Number(j.executedQty) : undefined;
    const quoteFilled = j.cummulativeQuoteQty ? Number(j.cummulativeQuoteQty) : undefined;
    return { ok, dryRun: false, id: j.orderId ? String(j.orderId) : null, filledQty, quoteFilled, message: ok ? `Binance ${base} ${side} 체결${filledQty ? ` ${filledQty}` : ""}` : (j.msg || "주문 실패") };
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
      symbol: `${base}USDT`, type: "MARKET",
      quantity: await roundQty("perp", `${base}USDT`, qty),
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

// ── Limit-order primitives (live unwind loop) ────────────────────────────────
// Place a LIMIT sell, poll fills, cancel — on Binance spot and Upbit. Bithumb
// limit flow is not wired (live unwind on a bithumb leg fails fast upstream).

export async function binanceLimitSell(base: string, qty: number, price: number): Promise<OrderResult> {
  const { key } = bnKeys();
  if (CONFIG.DRY_RUN || !key) return sim(`Binance ${base} 지정가 매도 ${qty}@${price}`, !!key);
  try {
    const j = await binanceSigned("api.binance.com", "/api/v3/order", {
      symbol: `${base}USDT`, side: "SELL", type: "LIMIT", timeInForce: "GTC",
      quantity: await roundQty("spot", `${base}USDT`, qty), price,
    });
    const ok = !!j.orderId;
    return { ok, dryRun: false, id: j.orderId ? String(j.orderId) : null, message: ok ? `지정가 매도 등록 @${price}` : (j.msg || "주문 실패") };
  } catch (e) {
    return { ok: false, dryRun: false, id: null, message: e instanceof Error ? e.message : "주문 실패" };
  }
}

/** Executed base qty + received quote so far for a Binance spot order. */
export async function binanceOrderFills(base: string, orderId: string): Promise<{ filledQty: number; quoteFilled: number; open: boolean } | null> {
  const { key } = bnKeys();
  if (CONFIG.DRY_RUN || !key) return null;
  try {
    const j = await binanceSignedGet("/api/v3/order", { symbol: `${base}USDT`, orderId });
    if (!j.orderId) return null;
    return {
      filledQty: Number(j.executedQty ?? 0),
      quoteFilled: Number(j.cummulativeQuoteQty ?? 0),
      open: j.status === "NEW" || j.status === "PARTIALLY_FILLED",
    };
  } catch {
    return null;
  }
}

export async function binanceCancelOrder(base: string, orderId: string): Promise<boolean> {
  const { key, secret } = bnKeys();
  if (CONFIG.DRY_RUN || !key || !secret) return true;
  try {
    const q = new URLSearchParams({ symbol: `${base}USDT`, orderId, recvWindow: "5000", timestamp: String(Date.now()) }).toString();
    const sig = crypto.createHmac("sha256", secret).update(q).digest("hex");
    const res = await fetch(`https://api.binance.com/api/v3/order?${q}&signature=${sig}`, {
      method: "DELETE", headers: { "X-MBX-APIKEY": key }, cache: "no-store",
    });
    const j = await res.json();
    return !!j.orderId || j.status === "CANCELED";
  } catch {
    return false;
  }
}

export async function upbitLimitSell(base: string, volume: number, priceKrw: number): Promise<OrderResult> {
  const key = process.env.UPBIT_KEY, secret = process.env.UPBIT_SECRET;
  if (CONFIG.DRY_RUN || !key || !secret) return sim(`Upbit ${base} 지정가 매도 ${volume}@₩${priceKrw}`, !!(key && secret));
  try {
    const query = new URLSearchParams({
      market: `KRW-${base}`, side: "ask", ord_type: "limit",
      volume: String(volume), price: String(priceKrw),
    }).toString();
    const res = await fetch(`https://api.upbit.com/v1/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${upbitJwt(key, secret, query)}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: query, cache: "no-store",
    });
    const j = await res.json();
    const ok = !!j.uuid;
    return { ok, dryRun: false, id: j.uuid ?? null, message: ok ? `지정가 매도 등록 @₩${priceKrw}` : (j.error?.message || "주문 실패") };
  } catch (e) {
    return { ok: false, dryRun: false, id: null, message: e instanceof Error ? e.message : "주문 실패" };
  }
}

export async function upbitOrderFills(uuid: string): Promise<{ filledQty: number; quoteFilled: number; open: boolean } | null> {
  const key = process.env.UPBIT_KEY, secret = process.env.UPBIT_SECRET;
  if (CONFIG.DRY_RUN || !key || !secret) return null;
  try {
    const query = new URLSearchParams({ uuid }).toString();
    const res = await fetch(`https://api.upbit.com/v1/order?${query}`, {
      headers: { Authorization: `Bearer ${upbitJwt(key, secret, query)}` }, cache: "no-store",
    });
    const j = await res.json();
    if (!j?.uuid) return null;
    const trades: Array<{ funds: string }> = j.trades ?? [];
    return {
      filledQty: Number(j.executed_volume ?? 0),
      quoteFilled: trades.reduce((s2, t) => s2 + Number(t.funds), 0),
      open: j.state === "wait" || j.state === "watch",
    };
  } catch {
    return null;
  }
}

export async function upbitCancelOrder(uuid: string): Promise<boolean> {
  const key = process.env.UPBIT_KEY, secret = process.env.UPBIT_SECRET;
  if (CONFIG.DRY_RUN || !key || !secret) return true;
  try {
    const query = new URLSearchParams({ uuid }).toString();
    const res = await fetch(`https://api.upbit.com/v1/order?${query}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${upbitJwt(key, secret, query)}` }, cache: "no-store",
    });
    const j = await res.json();
    return !!j?.uuid;
  } catch {
    return false;
  }
}

/** Poll an exchange withdrawal for its on-chain txId (broadcast can lag). */
export async function binanceWithdrawTx(base: string, wdId: string): Promise<string | null> {
  const { key } = bnKeys();
  if (CONFIG.DRY_RUN || !key) return null;
  try {
    const j = await binanceSignedGet("/sapi/v1/capital/withdraw/history", { coin: base });
    const rec = Array.isArray(j) ? j.find((w: { id?: string; txId?: string }) => w.id === wdId) : undefined;
    return rec?.txId || null;
  } catch {
    return null;
  }
}

export async function upbitWithdrawTx(uuid: string): Promise<string | null> {
  const key = process.env.UPBIT_KEY, secret = process.env.UPBIT_SECRET;
  if (CONFIG.DRY_RUN || !key || !secret) return null;
  try {
    const query = new URLSearchParams({ uuid }).toString();
    const res = await fetch(`https://api.upbit.com/v1/withdraw?${query}`, {
      headers: { Authorization: `Bearer ${upbitJwt(key, secret, query)}` }, cache: "no-store",
    });
    const j = await res.json();
    return j?.txid || null;
  } catch {
    return null;
  }
}

export async function binanceWithdraw(base: string, network: string, address: string, amount: number, tag?: string): Promise<OrderResult> {
  const { key } = bnKeys();
  if (CONFIG.DRY_RUN || !key) return sim(`Binance ${base} 출금 → ${address.slice(0, 10)}…${tag ? ` (tag:${tag})` : ""}`, !!key);
  try {
    const j = await binanceSigned("api.binance.com", "/sapi/v1/capital/withdraw/apply", {
      coin: base, network, address, amount,
      ...(tag ? { addressTag: tag } : {}),
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

function upbitAuth(query: string) {
  const key = process.env.UPBIT_KEY!, secret = process.env.UPBIT_SECRET!;
  return `Bearer ${upbitJwt(key, secret, query)}`;
}

/** Fetch an Upbit order's real fills (volume + KRW funds). Best-effort. */
async function upbitOrderDetail(uuid: string): Promise<{ filledQty?: number; quoteKrw?: number } | null> {
  const key = process.env.UPBIT_KEY, secret = process.env.UPBIT_SECRET;
  if (!key || !secret) return null;
  await new Promise((r) => setTimeout(r, 600)); // market orders fill ~instantly
  const query = new URLSearchParams({ uuid }).toString();
  const res = await fetch(`https://api.upbit.com/v1/order?${query}`, {
    headers: { Authorization: `Bearer ${upbitJwt(key, secret, query)}` }, cache: "no-store",
  });
  const j = await res.json();
  if (!j?.uuid) return null;
  const trades: Array<{ volume: string; funds: string }> = j.trades ?? [];
  const filledQty = Number(j.executed_volume ?? 0) || trades.reduce((s2, t) => s2 + Number(t.volume), 0) || undefined;
  const quoteKrw = trades.reduce((s2, t) => s2 + Number(t.funds), 0) || undefined;
  return { filledQty, quoteKrw };
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
    // Best-effort real-fill lookup — the create response has no fills.
    let filledQty: number | undefined, quoteFilled: number | undefined;
    if (ok) {
      const d = await upbitOrderDetail(j.uuid).catch(() => null);
      if (d) { filledQty = d.filledQty; quoteFilled = d.quoteKrw; }
    }
    return { ok, dryRun: false, id: j.uuid ?? null, filledQty, quoteFilled, message: ok ? `Upbit ${base} ${side === "ask" ? "매도" : "매수"} 체결` : (j.error?.message || "주문 실패") };
  } catch (e) {
    return { ok: false, dryRun: false, id: null, message: e instanceof Error ? e.message : "주문 실패" };
  }
}

export async function upbitWithdraw(base: string, netType: string, address: string, amount: number, tag?: string): Promise<OrderResult> {
  const key = process.env.UPBIT_KEY, secret = process.env.UPBIT_SECRET;
  if (CONFIG.DRY_RUN || !key || !secret) return sim(`Upbit ${base} 출금 → ${address.slice(0, 10)}…`, !!(key && secret));
  try {
    const params: Record<string, string> = { currency: base, net_type: netType, amount: String(amount), address };
    if (tag) params.secondary_address = tag;
    const query = new URLSearchParams(params).toString();
    const res = await fetch(`https://api.upbit.com/v1/withdraws/coin`, {
      method: "POST",
      headers: { Authorization: upbitAuth(query), "Content-Type": "application/x-www-form-urlencoded" },
      body: query, cache: "no-store",
    });
    const j = await res.json();
    const ok = !!j.uuid;
    return { ok, dryRun: false, id: j.uuid ?? null, message: ok ? `Upbit ${base} 출금 요청` : (j.error?.message || "출금 실패") };
  } catch (e) {
    return { ok: false, dryRun: false, id: null, message: e instanceof Error ? e.message : "출금 실패" };
  }
}

// ── Bithumb (v1 private, HMAC-SHA512) ─────────────────────────────────────────
async function bithumbSigned(endpoint: string, params: Record<string, string>) {
  const key = process.env.BITHUMB_KEY!, secret = process.env.BITHUMB_SECRET!;
  const nonce = String(Date.now());
  const body = new URLSearchParams({ endpoint, ...params }).toString();
  const strData = `${endpoint}${String.fromCharCode(0)}${body}${String.fromCharCode(0)}${nonce}`;
  const hmacHex = crypto.createHmac("sha512", secret).update(strData).digest("hex");
  const sign = Buffer.from(hmacHex).toString("base64");
  const res = await fetch(`https://api.bithumb.com${endpoint}`, {
    method: "POST",
    headers: {
      "Api-Key": key, "Api-Sign": sign, "Api-Nonce": nonce,
      "Content-Type": "application/x-www-form-urlencoded", "api-client-type": "2",
    },
    body, cache: "no-store",
  });
  return res.json();
}

export async function bithumbOrder(base: string, side: "bid" | "ask", units: number): Promise<OrderResult> {
  const key = process.env.BITHUMB_KEY, secret = process.env.BITHUMB_SECRET;
  const label = side === "ask" ? "매도" : "매수";
  if (CONFIG.DRY_RUN || !key || !secret) return sim(`Bithumb ${base} ${label}`, !!(key && secret));
  try {
    const endpoint = side === "ask" ? "/trade/market_sell" : "/trade/market_buy";
    const j = await bithumbSigned(endpoint, { order_currency: base, payment_currency: "KRW", units: String(units) });
    const ok = j.status === "0000";
    return { ok, dryRun: false, id: j.order_id ?? null, message: ok ? `Bithumb ${base} ${label} 체결` : (j.message || "주문 실패") };
  } catch (e) {
    return { ok: false, dryRun: false, id: null, message: e instanceof Error ? e.message : "주문 실패" };
  }
}

export async function bithumbWithdraw(base: string, address: string, amount: number, tag?: string): Promise<OrderResult> {
  const key = process.env.BITHUMB_KEY, secret = process.env.BITHUMB_SECRET;
  if (CONFIG.DRY_RUN || !key || !secret) return sim(`Bithumb ${base} 출금 → ${address.slice(0, 10)}…`, !!(key && secret));
  try {
    const params: Record<string, string> = { currency: base, address, units: String(amount) };
    if (tag) params.destination = tag;
    const j = await bithumbSigned("/trade/btc_withdrawal", params);
    const ok = j.status === "0000";
    return { ok, dryRun: false, id: null, message: ok ? `Bithumb ${base} 출금 요청` : (j.message || "출금 실패") };
  } catch (e) {
    return { ok: false, dryRun: false, id: null, message: e instanceof Error ? e.message : "출금 실패" };
  }
}

// ── Deposit crediting check (poll) ────────────────────────────────────────────
async function binanceSignedGet(path: string, params: Record<string, string | number>) {
  const { key, secret } = bnKeys();
  const q = new URLSearchParams({ ...params, recvWindow: "5000", timestamp: String(Date.now()) } as Record<string, string>).toString();
  const sig = crypto.createHmac("sha256", secret!).update(q).digest("hex");
  const res = await fetch(`https://api.binance.com${path}?${q}&signature=${sig}`, {
    headers: { "X-MBX-APIKEY": key! }, cache: "no-store",
  });
  return res.json();
}

/**
 * Has a deposit of `base` been credited at `venue` SINCE `sinceTs`? Matching any
 * historical deposit would advance the flow while the coin is still in flight —
 * so only records newer than the run's start count. DRY → simulate ok.
 */
export async function checkDeposit(venue: string, base: string, sinceTs: number): Promise<OrderResult> {
  if (venue === "binance") {
    const { key } = bnKeys();
    if (CONFIG.DRY_RUN || !key) return sim(`Binance ${base} 입금 확인`, !!key);
    try {
      const j = await binanceSignedGet("/sapi/v1/capital/deposit/hisrec", { coin: base, startTime: sinceTs });
      const rec = Array.isArray(j)
        ? j.find((d: { status?: number; insertTime?: number; txId?: string }) => d.status === 1 && (d.insertTime ?? 0) >= sinceTs)
        : undefined;
      return { ok: !!rec, dryRun: false, id: null, txHash: rec?.txId, message: rec ? `Binance ${base} 입금 확인` : "입금 대기" };
    } catch (e) {
      return { ok: false, dryRun: false, id: null, message: e instanceof Error ? e.message : "입금 조회 실패" };
    }
  }
  if (venue === "upbit") {
    const key = process.env.UPBIT_KEY, secret = process.env.UPBIT_SECRET;
    if (CONFIG.DRY_RUN || !key || !secret) return sim(`Upbit ${base} 입금 확인`, !!(key && secret));
    try {
      const query = new URLSearchParams({ currency: base }).toString();
      const res = await fetch(`https://api.upbit.com/v1/deposits?${query}`, { headers: { Authorization: upbitAuth(query) }, cache: "no-store" });
      const j = await res.json();
      const rec = Array.isArray(j)
        ? j.find((d: { state?: string; created_at?: string; txid?: string }) =>
            d.state === "ACCEPTED" && new Date(d.created_at ?? 0).getTime() >= sinceTs)
        : undefined;
      return { ok: !!rec, dryRun: false, id: null, txHash: rec?.txid, message: rec ? `Upbit ${base} 입금 확인` : "입금 대기" };
    } catch (e) {
      return { ok: false, dryRun: false, id: null, message: e instanceof Error ? e.message : "입금 조회 실패" };
    }
  }
  if (venue === "bithumb") {
    const key = process.env.BITHUMB_KEY, secret = process.env.BITHUMB_SECRET;
    if (CONFIG.DRY_RUN || !key || !secret) return sim(`Bithumb ${base} 입금 확인`, !!(key && secret));
    try {
      // searchGb 4 = coin deposit. transfer_date is in MICROseconds.
      const j = await bithumbSigned("/info/user_transactions", {
        order_currency: base, payment_currency: "KRW", searchGb: "4", count: "20",
      });
      if (j.status !== "0000") return { ok: false, dryRun: false, id: null, message: j.message || "입금 조회 실패" };
      const rec = (Array.isArray(j.data) ? j.data : []).find(
        (d: { transfer_date?: number | string }) => Number(d.transfer_date ?? 0) / 1000 >= sinceTs,
      );
      return { ok: !!rec, dryRun: false, id: null, message: rec ? `Bithumb ${base} 입금 확인` : "입금 대기" };
    } catch (e) {
      return { ok: false, dryRun: false, id: null, message: e instanceof Error ? e.message : "입금 조회 실패" };
    }
  }
  return sim(`${venue} ${base} 입금 확인 (미배선)`, false); // 그 외 venue — live → fail via sim
}

// ── Bybit (v5, HMAC-SHA256) ───────────────────────────────────────────────────
// Sign: HMAC(timestamp + apiKey + recvWindow + payload). POST payload = JSON body,
// GET payload = query string.
async function bybitSigned(method: "GET" | "POST", path: string, params: Record<string, string | number>) {
  const key = process.env.BYBIT_KEY!, secret = process.env.BYBIT_SECRET!;
  const ts = String(Date.now());
  const recv = "5000";
  const payload = method === "GET"
    ? new URLSearchParams(params as Record<string, string>).toString()
    : JSON.stringify(params);
  const sign = crypto.createHmac("sha256", secret).update(ts + key + recv + payload).digest("hex");
  const headers: Record<string, string> = {
    "X-BAPI-API-KEY": key, "X-BAPI-TIMESTAMP": ts, "X-BAPI-RECV-WINDOW": recv, "X-BAPI-SIGN": sign,
  };
  let url = `https://api.bybit.com${path}`;
  const init: RequestInit = { method, headers, cache: "no-store" };
  if (method === "GET") url += `?${payload}`;
  else { headers["Content-Type"] = "application/json"; init.body = payload; }
  const res = await fetch(url, init);
  return res.json();
}

export async function bybitOrder(base: string, side: "BUY" | "SELL", opts: { quoteUsd?: number; qty?: number }): Promise<OrderResult> {
  const key = process.env.BYBIT_KEY, secret = process.env.BYBIT_SECRET;
  const label = side === "SELL" ? "매도" : "매수";
  if (CONFIG.DRY_RUN || !key || !secret) return sim(`Bybit ${base} ${label}`, !!(key && secret));
  try {
    // Spot market: BUY uses marketUnit=quoteCoin (spend USDT), SELL uses base qty.
    const p: Record<string, string | number> = {
      category: "spot", symbol: `${base}USDT`, side: side === "BUY" ? "Buy" : "Sell",
      orderType: "Market", marketUnit: side === "BUY" ? "quoteCoin" : "baseCoin",
      qty: String(side === "BUY" ? (opts.quoteUsd ?? 0) : (opts.qty ?? 0)),
    };
    const j = await bybitSigned("POST", "/v5/order/create", p);
    const ok = j.retCode === 0 && j.result?.orderId;
    return { ok: !!ok, dryRun: false, id: ok ? String(j.result.orderId) : null, message: ok ? `Bybit ${base} ${label} 체결` : (j.retMsg || "주문 실패") };
  } catch (e) {
    return { ok: false, dryRun: false, id: null, message: e instanceof Error ? e.message : "주문 실패" };
  }
}

export async function bybitWithdraw(base: string, chain: string, address: string, amount: number, tag?: string): Promise<OrderResult> {
  const key = process.env.BYBIT_KEY, secret = process.env.BYBIT_SECRET;
  if (CONFIG.DRY_RUN || !key || !secret) return sim(`Bybit ${base} 출금 → ${address.slice(0, 10)}…`, !!(key && secret));
  try {
    const p: Record<string, string | number> = {
      coin: base, chain, address, amount: String(amount), timestamp: Date.now(),
      ...(tag ? { tag } : {}),
    };
    const j = await bybitSigned("POST", "/v5/asset/withdraw/create", p);
    const ok = j.retCode === 0 && j.result?.id;
    return { ok: !!ok, dryRun: false, id: ok ? String(j.result.id) : null, message: ok ? `Bybit ${base} 출금 요청` : (j.retMsg || "출금 실패") };
  } catch (e) {
    return { ok: false, dryRun: false, id: null, message: e instanceof Error ? e.message : "출금 실패" };
  }
}

// ── OKX (v5, HMAC-SHA256 + passphrase) ────────────────────────────────────────
async function okxSigned(method: "GET" | "POST", path: string, body?: Record<string, unknown>) {
  const key = process.env.OKX_KEY!, secret = process.env.OKX_SECRET!, pass = process.env.OKX_PASSPHRASE!;
  const ts = new Date().toISOString();
  const bodyStr = body ? JSON.stringify(body) : "";
  const sign = crypto.createHmac("sha256", secret).update(ts + method + path + bodyStr).digest("base64");
  const res = await fetch(`https://www.okx.com${path}`, {
    method,
    headers: {
      "OK-ACCESS-KEY": key, "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": ts,
      "OK-ACCESS-PASSPHRASE": pass, "Content-Type": "application/json",
    },
    body: method === "POST" ? bodyStr : undefined,
    cache: "no-store",
  });
  return res.json();
}

export async function okxOrder(base: string, side: "BUY" | "SELL", opts: { quoteUsd?: number; qty?: number }): Promise<OrderResult> {
  const key = process.env.OKX_KEY, secret = process.env.OKX_SECRET, pass = process.env.OKX_PASSPHRASE;
  const label = side === "SELL" ? "매도" : "매수";
  if (CONFIG.DRY_RUN || !key || !secret || !pass) return sim(`OKX ${base} ${label}`, !!(key && secret && pass));
  try {
    // Spot market: BUY tgtCcy=quote_ccy (spend USDT), SELL sz = base qty.
    const body = {
      instId: `${base}-USDT`, tdMode: "cash", side: side.toLowerCase(), ordType: "market",
      tgtCcy: side === "BUY" ? "quote_ccy" : "base_ccy",
      sz: String(side === "BUY" ? (opts.quoteUsd ?? 0) : (opts.qty ?? 0)),
    };
    const j = await okxSigned("POST", "/api/v5/trade/order", body);
    const d = j.data?.[0];
    const ok = j.code === "0" && d?.sCode === "0";
    return { ok: !!ok, dryRun: false, id: ok ? String(d.ordId) : null, message: ok ? `OKX ${base} ${label} 체결` : (d?.sMsg || j.msg || "주문 실패") };
  } catch (e) {
    return { ok: false, dryRun: false, id: null, message: e instanceof Error ? e.message : "주문 실패" };
  }
}

export async function okxWithdraw(base: string, chain: string, address: string, amount: number, tag?: string): Promise<OrderResult> {
  const key = process.env.OKX_KEY, secret = process.env.OKX_SECRET, pass = process.env.OKX_PASSPHRASE;
  if (CONFIG.DRY_RUN || !key || !secret || !pass) return sim(`OKX ${base} 출금 → ${address.slice(0, 10)}…`, !!(key && secret && pass));
  try {
    // OKX wants chain as "BASE-Network" and the fee explicitly; amt is net.
    const body: Record<string, unknown> = {
      ccy: base, amt: String(amount), dest: "4" /* on-chain */, toAddr: tag ? `${address}:${tag}` : address, chain,
    };
    const j = await okxSigned("POST", "/api/v5/asset/withdrawal", body);
    const d = j.data?.[0];
    const ok = j.code === "0" && d?.wdId;
    return { ok: !!ok, dryRun: false, id: ok ? String(d.wdId) : null, message: ok ? `OKX ${base} 출금 요청` : (j.msg || "출금 실패") };
  } catch (e) {
    return { ok: false, dryRun: false, id: null, message: e instanceof Error ? e.message : "출금 실패" };
  }
}
