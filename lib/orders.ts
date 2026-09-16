// Real exchange orders / withdrawal — signed. FULLY WIRED but dormant: each
// call returns a simulated result unless CONFIG.DRY_RUN is false AND the venue's
// keys are set. Server-only (node crypto). Powers the run engine's step executor (execStep).

import crypto from "crypto";
import { CONFIG } from "./config";
import { acquireOrderSlot } from "./rateLimiter";

export type OrderResult = {
  ok: boolean; dryRun: boolean; id: string | null; message: string;
  filledQty?: number; // base actually filled
  quoteFilled?: number; // quote currency actually spent/received (fees excl.)
  txHash?: string;
  /** The request was already in flight when it failed (network error / timeout),
   *  so the venue MAY have accepted it. Never auto-retry and never roll back on
   *  an ambiguous failure — a retried withdrawal sends twice, and rolling back a
   *  withdrawal that actually landed dumps coin we no longer hold.
   *  Explicit venue rejections (retCode != 0, sCode != 0) are NOT ambiguous. */
  ambiguous?: boolean;
  /** Not an error — the thing we're waiting for simply hasn't happened yet
   *  (deposit not credited). A transfer legitimately takes minutes, so this must
   *  never be treated as an execution failure: it used to trip the circuit
   *  breaker after 3 retries and auto-enable the kill switch mid-run. */
  pending?: boolean;
};

/** Failure of a request that was already sent — outcome unknown. */
const inflightFail = (e: unknown, what: string): OrderResult => ({
  ok: false, dryRun: false, id: null, ambiguous: true,
  message: `${what} 응답 없음(전송 후 오류) — 실제 처리 여부 불명: ${e instanceof Error ? e.message : "?"}`,
});

// DRY_RUN → simulate ok. LIVE without the venue key → HARD FAIL: a silent no-op
// leg would let the state machine proceed into real orders on the other side
// (e.g. a naked hedge). Never ok:true for an unexecuted step in live mode.
const sim = (msg: string, hasKey: boolean): OrderResult =>
  CONFIG.DRY_RUN
    ? { ok: true, dryRun: true, id: null, message: hasKey ? `페이퍼 — ${msg}` : `키 없음 — ${msg} (페이퍼)` }
    : { ok: false, dryRun: false, id: null, message: `실행 불가 — ${msg} (키 없음)` };

// ── Binance (spot + futures + withdraw), HMAC-SHA256 ──────────────────────────
function bnKeys() {
  return { key: process.env.BINANCE_KEY, secret: process.env.BINANCE_SECRET };
}
// 키·시크릿 둘 다 있어야 서명이 된다. key만 보고 진행하면 secret 없는 createHmac이
// try 안에서 throw → inflightFail → "결과 불명(ambiguous)"으로 분류돼, 요청이 나간
// 적도 없는데 재시도·롤백이 막히고 폰이 울린다. 다른 거래소는 원래 둘 다 본다.
const bnReady = () => { const { key, secret } = bnKeys(); return !!(key && secret); };

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
    method: "POST", headers: { "X-MBX-APIKEY": key! }, cache: "no-store", signal: AbortSignal.timeout(10_000),
  });
  return res.json();
}

export async function binanceSpot(base: string, side: "BUY" | "SELL", opts: { quoteUsd?: number; qty?: number }): Promise<OrderResult> {
  if (CONFIG.DRY_RUN || !bnReady()) return sim(`Binance ${base} ${side} 현물`, bnReady());
  if (!(await acquireOrderSlot("binance"))) return { ok: false, dryRun: false, id: null, message: "주문 rate 한도 대기 — 다음 주기 재시도" };
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
    return inflightFail(e, "주문");
  }
}

// Perp short (open) / close (reduceOnly buy).
export async function binancePerp(base: string, action: "SHORT" | "CLOSE", qty: number): Promise<OrderResult> {
  if (CONFIG.DRY_RUN || !bnReady()) return sim(`Binance ${base} 선물 ${action}`, bnReady());
  // 헷지 다리도 같은 IP 한도를 먹는다 — 매수 직후 항상 발사되므로, 페이싱에서
  // 빠지면 rate limiter가 막으려던 상황(연속 주문 폭주)이 그대로 생긴다.
  if (!(await acquireOrderSlot("binance"))) return { ok: false, dryRun: false, id: null, message: "주문 rate 한도 대기 — 다음 주기 재시도" };
  try {
    const p: Record<string, string | number> = {
      symbol: `${base}USDT`, type: "MARKET",
      quantity: await roundQty("perp", `${base}USDT`, qty),
      side: action === "SHORT" ? "SELL" : "BUY",
      ...(action === "CLOSE" ? { reduceOnly: "true" } : {}),
    };
    const j = await binanceSigned("fapi.binance.com", "/fapi/v1/order", p);
    const ok = !!j.orderId;
    // MARKET fapi order returns executedQty + cumQuote — the hedge's real fill,
    // fed into settle so perp P&L is a first-class leg.
    const filledQty = j.executedQty ? Number(j.executedQty) : undefined;
    const quoteFilled = j.cumQuote ? Number(j.cumQuote) : undefined;
    return { ok, dryRun: false, id: j.orderId ? String(j.orderId) : null, filledQty, quoteFilled, message: ok ? `Binance ${base} 선물 ${action}` : (j.msg || "선물 주문 실패") };
  } catch (e) {
    return inflightFail(e, "선물 주문");
  }
}

/** Free USDT margin on the futures wallet (live only; null = unknown/keys). */
export async function binanceFuturesFree(): Promise<number | null> {
  if (CONFIG.DRY_RUN || !bnReady()) return null;
  try {
    const j = await binanceSignedGet("/fapi/v2/balance", {}, "fapi.binance.com");
    const usdt = Array.isArray(j) ? j.find((b: { asset?: string }) => b.asset === "USDT") : null;
    return usdt ? Number(usdt.availableBalance ?? 0) : null;
  } catch {
    return null;
  }
}

// ── Limit-order primitives (live unwind loop) ────────────────────────────────
// Place a LIMIT sell, poll fills, cancel — on Binance spot and Upbit. Bithumb
// limit flow is not wired (live unwind on a bithumb leg fails fast upstream).

export async function binanceLimitSell(base: string, qty: number, price: number): Promise<OrderResult> {
  if (CONFIG.DRY_RUN || !bnReady()) return sim(`Binance ${base} 지정가 매도 ${qty}@${price}`, bnReady());
  if (!(await acquireOrderSlot("binance"))) return { ok: false, dryRun: false, id: null, message: "주문 rate 한도 대기 — 다음 주기 재시도" };
  try {
    const j = await binanceSigned("api.binance.com", "/api/v3/order", {
      symbol: `${base}USDT`, side: "SELL", type: "LIMIT", timeInForce: "GTC",
      quantity: await roundQty("spot", `${base}USDT`, qty), price,
    });
    const ok = !!j.orderId;
    return { ok, dryRun: false, id: j.orderId ? String(j.orderId) : null, message: ok ? `지정가 매도 등록 @${price}` : (j.msg || "주문 실패") };
  } catch (e) {
    return inflightFail(e, "주문");
  }
}

/** Executed base qty + received quote so far for a Binance spot order. */
export async function binanceOrderFills(base: string, orderId: string): Promise<{ filledQty: number; quoteFilled: number; open: boolean } | null> {
  if (CONFIG.DRY_RUN || !bnReady()) return null;
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
      method: "DELETE", headers: { "X-MBX-APIKEY": key }, cache: "no-store", signal: AbortSignal.timeout(10_000),
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
  if (!(await acquireOrderSlot("upbit"))) return { ok: false, dryRun: false, id: null, message: "주문 rate 한도 대기 — 다음 주기 재시도" };
  try {
    const query = new URLSearchParams({
      market: `KRW-${base}`, side: "ask", ord_type: "limit",
      volume: String(volume), price: String(priceKrw),
    }).toString();
    const res = await fetch(`https://api.upbit.com/v1/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${upbitJwt(key, secret, query)}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: query, cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    const j = await res.json();
    const ok = !!j.uuid;
    return { ok, dryRun: false, id: j.uuid ?? null, message: ok ? `지정가 매도 등록 @₩${priceKrw}` : (j.error?.message || "주문 실패") };
  } catch (e) {
    return inflightFail(e, "주문");
  }
}

export async function upbitOrderFills(uuid: string): Promise<{ filledQty: number; quoteFilled: number; open: boolean } | null> {
  const key = process.env.UPBIT_KEY, secret = process.env.UPBIT_SECRET;
  if (CONFIG.DRY_RUN || !key || !secret) return null;
  try {
    const query = new URLSearchParams({ uuid }).toString();
    const res = await fetch(`https://api.upbit.com/v1/order?${query}`, {
      headers: { Authorization: `Bearer ${upbitJwt(key, secret, query)}` }, cache: "no-store", signal: AbortSignal.timeout(10_000),
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
      headers: { Authorization: `Bearer ${upbitJwt(key, secret, query)}` }, cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    const j = await res.json();
    return !!j?.uuid;
  } catch {
    return false;
  }
}

/** Poll an exchange withdrawal for its on-chain txId (broadcast can lag). */
export async function binanceWithdrawTx(base: string, wdId: string): Promise<string | null> {
  if (CONFIG.DRY_RUN || !bnReady()) return null;
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
      headers: { Authorization: `Bearer ${upbitJwt(key, secret, query)}` }, cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    const j = await res.json();
    return j?.txid || null;
  } catch {
    return null;
  }
}

export async function bybitWithdrawTx(wdId: string): Promise<string | null> {
  const key = process.env.BYBIT_KEY, secret = process.env.BYBIT_SECRET;
  if (CONFIG.DRY_RUN || !key || !secret) return null;
  try {
    const j = await bybitSigned("GET", "/v5/asset/withdraw/query-record", { withdrawID: wdId });
    const rec = j?.result?.rows?.[0] as { txID?: string } | undefined;
    return rec?.txID || null;
  } catch {
    return null;
  }
}

export async function okxWithdrawTx(wdId: string): Promise<string | null> {
  const key = process.env.OKX_KEY, secret = process.env.OKX_SECRET, pass = process.env.OKX_PASSPHRASE;
  if (CONFIG.DRY_RUN || !key || !secret || !pass) return null;
  try {
    const path = `/api/v5/asset/withdrawal-history?wdId=${wdId}`;
    const ts = new Date().toISOString();
    const sign = crypto.createHmac("sha256", secret!).update(ts + "GET" + path).digest("base64");
    const res = await fetch(`https://www.okx.com${path}`, {
      headers: { "OK-ACCESS-KEY": key, "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": pass },
      cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    const j = (await res.json()) as { code: string; data?: Array<{ txId?: string }> };
    return j.code === "0" ? (j.data?.[0]?.txId || null) : null;
  } catch {
    return null;
  }
}

export async function binanceWithdraw(base: string, network: string, address: string, amount: number, tag?: string): Promise<OrderResult> {
  if (CONFIG.DRY_RUN || !bnReady()) return sim(`Binance ${base} 출금 → ${address.slice(0, 10)}…${tag ? ` (tag:${tag})` : ""}`, bnReady());
  try {
    const j = await binanceSigned("api.binance.com", "/sapi/v1/capital/withdraw/apply", {
      coin: base, network, address, amount,
      ...(tag ? { addressTag: tag } : {}),
    });
    const ok = !!j.id;
    return { ok, dryRun: false, id: j.id ?? null, message: ok ? `Binance ${base} 출금 요청` : (j.msg || "출금 실패") };
  } catch (e) {
    return inflightFail(e, "출금");
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
  // 시장가는 보통 즉시 체결되지만 상세 조회에 체결이 반영되기까지 잠깐 늦을 수
  // 있다. 예전엔 600ms 후 딱 1회 조회라, 그 순간 비어 있으면 체결량 미확인 →
  // 매수는 ambiguous로 서고 매도는 정산이 추정치로 빠져 일일손실 한도가 눈멀었다.
  // 바이비트/OKX/빗썸처럼 몇 번 더 본다.
  let last: { filledQty?: number; quoteKrw?: number } | null = null;
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, i === 0 ? 600 : 400));
    try {
      const query = new URLSearchParams({ uuid }).toString();
      const res = await fetch(`https://api.upbit.com/v1/order?${query}`, {
        headers: { Authorization: `Bearer ${upbitJwt(key, secret, query)}` }, cache: "no-store", signal: AbortSignal.timeout(10_000),
      });
      const j = await res.json();
      if (!j?.uuid) continue;
      const trades: Array<{ volume: string; funds: string }> = j.trades ?? [];
      const filledQty = Number(j.executed_volume ?? 0) || trades.reduce((s2, t) => s2 + Number(t.volume), 0) || undefined;
      const quoteKrw = trades.reduce((s2, t) => s2 + Number(t.funds), 0) || undefined;
      last = { filledQty, quoteKrw };
      if (filledQty && filledQty > 0) return last;
    } catch { /* retry */ }
  }
  return last;
}

// 단일 코인 잔고 (거래소별). 자동매도 트리거의 하이브리드 모드가 매 주기 이걸
// 읽는다 — 주문 rate 버킷과 분리된(대체로 더 여유로운) 계정조회 API를 쓴다.
// null = 조회 실패(키 없음/네트워크) — 호출부가 "아직 모름"으로 다뤄야 한다.
export async function coinBalance(venue: string, base: string): Promise<number | null> {
  try {
    if (venue === "upbit") {
      const key = process.env.UPBIT_KEY, secret = process.env.UPBIT_SECRET;
      if (!key || !secret) return null;
      const res = await fetch("https://api.upbit.com/v1/accounts", {
        headers: { Authorization: `Bearer ${upbitJwt(key, secret, "")}` }, cache: "no-store", signal: AbortSignal.timeout(6000),
      });
      const rows = (await res.json()) as Array<{ currency: string; balance: string; locked: string }>;
      const a = Array.isArray(rows) ? rows.find((x) => x.currency === base) : null;
      return a ? Number(a.balance) + Number(a.locked) : 0;
    }
    if (venue === "binance") {
      if (!bnReady()) return null;
      // GET이다. 예전엔 binanceSigned(POST 고정)를 써서 바이낸스가 에러 JSON을
      // 돌려줬고, j.balances가 없으니 아래 폴백이 **0**을 반환했다(null이 아님).
      // hybrid 자동매도 트리거는 잔고 0 = "아직 도착 안 함"으로 읽어 영원히
      // waiting이었다 — 코인이 바이낸스에 들어와도 아무도 안 팔았다.
      const j = await binanceSignedGet("/api/v3/account", {});
      if (!Array.isArray(j?.balances)) return null; // 에러 응답 → "모름"
      const b = (j.balances as Array<{ asset: string; free: string; locked: string }> | undefined)?.find((x) => x.asset === base);
      return b ? Number(b.free) + Number(b.locked) : 0;
    }
    if (venue === "bithumb") {
      const key = process.env.BITHUMB_KEY, secret = process.env.BITHUMB_SECRET;
      if (!key || !secret) return null;
      const j = await bithumbSigned("/info/balance", { order_currency: base, payment_currency: "KRW" });
      if (j.status !== "0000" || !j.data) return 0;
      const avail = Number(j.data[`available_${base.toLowerCase()}`] ?? 0);
      const inuse = Number(j.data[`in_use_${base.toLowerCase()}`] ?? 0);
      return avail + inuse;
    }
    return null;
  } catch {
    return null;
  }
}

export async function upbitOrder(base: string, side: "bid" | "ask", opts: { volume?: number; priceKrw?: number }): Promise<OrderResult> {
  const key = process.env.UPBIT_KEY, secret = process.env.UPBIT_SECRET;
  if (CONFIG.DRY_RUN || !key || !secret) return sim(`Upbit ${base} ${side === "ask" ? "매도" : "매수"}`, !!(key && secret));
  if (!(await acquireOrderSlot("upbit"))) return { ok: false, dryRun: false, id: null, message: "주문 rate 한도 대기 — 다음 주기 재시도" };
  try {
    // market sell = ord_type "market" + volume; market buy = "price" + price.
    const params: Record<string, string> = { market: `KRW-${base}`, side };
    if (side === "ask") { params.ord_type = "market"; params.volume = String(opts.volume ?? 0); }
    else { params.ord_type = "price"; params.price = String(opts.priceKrw ?? 0); }
    const query = new URLSearchParams(params).toString();
    const res = await fetch(`https://api.upbit.com/v1/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${upbitJwt(key, secret, query)}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: query, cache: "no-store", signal: AbortSignal.timeout(10_000),
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
    return inflightFail(e, "주문");
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
      body: query, cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    const j = await res.json();
    const ok = !!j.uuid;
    return { ok, dryRun: false, id: j.uuid ?? null, message: ok ? `Upbit ${base} 출금 요청` : (j.error?.message || "출금 실패") };
  } catch (e) {
    return inflightFail(e, "출금");
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
    body, cache: "no-store", signal: AbortSignal.timeout(10_000),
  });
  return res.json();
}

export async function bithumbOrder(base: string, side: "bid" | "ask", units: number): Promise<OrderResult> {
  const key = process.env.BITHUMB_KEY, secret = process.env.BITHUMB_SECRET;
  const label = side === "ask" ? "매도" : "매수";
  if (CONFIG.DRY_RUN || !key || !secret) return sim(`Bithumb ${base} ${label}`, !!(key && secret));
  if (!(await acquireOrderSlot("bithumb"))) return { ok: false, dryRun: false, id: null, message: "주문 rate 한도 대기 — 다음 주기 재시도" };
  try {
    const endpoint = side === "ask" ? "/trade/market_sell" : "/trade/market_buy";
    const j = await bithumbSigned(endpoint, { order_currency: base, payment_currency: "KRW", units: String(units) });
    const ok = j.status === "0000";
    if (!ok) return { ok: false, dryRun: false, id: null, message: j.message || "주문 실패" };
    // Bithumb's market order response returns the executed contracts inline;
    // when it doesn't, fall back to the order detail so downstream steps get a
    // real quantity instead of the nominal scan-price estimate.
    let filledQty = 0, quoteFilled = 0;
    for (const c of (Array.isArray(j.data) ? j.data : []) as Array<{ units?: string; total?: string; price?: string }>) {
      filledQty += Math.abs(Number(c.units ?? 0));
      quoteFilled += Number(c.total ?? (Number(c.units ?? 0) * Number(c.price ?? 0)));
    }
    if (!(filledQty > 0) && j.order_id) {
      const d = await bithumbOrderFill(base, String(j.order_id), side);
      if (d) { filledQty = d.filledQty; quoteFilled = d.quoteFilled; }
    }
    return {
      ok: true, dryRun: false, id: j.order_id ? String(j.order_id) : null,
      filledQty: filledQty > 0 ? filledQty : undefined,
      quoteFilled: quoteFilled > 0 ? quoteFilled : undefined,
      message: `Bithumb ${base} ${label} 체결${filledQty > 0 ? ` ${filledQty}` : " (체결량 미확인)"}`,
    };
  } catch (e) {
    return inflightFail(e, "주문");
  }
}

/** Bithumb order detail → executed base units + KRW total. */
async function bithumbOrderFill(base: string, orderId: string, side: "bid" | "ask"): Promise<{ filledQty: number; quoteFilled: number } | null> {
  for (let i = 0; i < 3; i++) {
    try {
      const j = await bithumbSigned("/info/order_detail", {
        order_id: orderId, order_currency: base, payment_currency: "KRW", type: side,
      });
      if (j.status === "0000" && j.data) {
        const rows = (j.data.contract ?? []) as Array<{ units?: string; total?: string }>;
        let qty = 0, quote = 0;
        for (const c of rows) { qty += Math.abs(Number(c.units ?? 0)); quote += Number(c.total ?? 0); }
        if (qty > 0) return { filledQty: qty, quoteFilled: quote };
      }
    } catch { /* retry */ }
    if (i < 2) await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

export async function bithumbWithdraw(base: string, netType: string, address: string, amount: number, tag?: string): Promise<OrderResult> {
  const key = process.env.BITHUMB_KEY, secret = process.env.BITHUMB_SECRET;
  if (CONFIG.DRY_RUN || !key || !secret) return sim(`Bithumb ${base} 출금 → ${address.slice(0, 10)}…`, !!(key && secret));
  try {
    // net_type 명시 — 입금주소 조회(deposits.ts)는 넘기면서 출금만 빠져 있었다.
    // USDT 같은 멀티체인 코인은 거래소가 체인을 고르게 되는데, 체인이 어긋난
    // 전송은 되돌릴 수 없다.
    const params: Record<string, string> = { currency: base, net_type: netType, address, units: String(amount) };
    if (tag) params.destination = tag;
    const j = await bithumbSigned("/trade/btc_withdrawal", params);
    const ok = j.status === "0000";
    return { ok, dryRun: false, id: null, message: ok ? `Bithumb ${base} 출금 요청` : (j.message || "출금 실패") };
  } catch (e) {
    return inflightFail(e, "출금");
  }
}

// ── Deposit crediting check (poll) ────────────────────────────────────────────
// host 인자 — 선물(/fapi/*)은 fapi.binance.com이다. 예전엔 api.binance.com 고정이라
// binanceFuturesFree()가 라이브에서 **항상** 404 → null이었고, 헷지 마진 게이트는
// (당시 fail-open이라) 한 번도 실제로 검사한 적이 없었다. 게이트를 fail-closed로
// 바꾸면서 이게 드러났다 — 안 고치면 헷지가 항상 차단된다.
async function binanceSignedGet(path: string, params: Record<string, string | number>, host = "api.binance.com") {
  const { key, secret } = bnKeys();
  const q = new URLSearchParams({ ...params, recvWindow: "5000", timestamp: String(Date.now()) } as Record<string, string>).toString();
  const sig = crypto.createHmac("sha256", secret!).update(q).digest("hex");
  const res = await fetch(`https://${host}${path}?${q}&signature=${sig}`, {
    headers: { "X-MBX-APIKEY": key! }, cache: "no-store", signal: AbortSignal.timeout(10_000),
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
    if (CONFIG.DRY_RUN || !bnReady()) return sim(`Binance ${base} 입금 확인`, bnReady());
    try {
      const j = await binanceSignedGet("/sapi/v1/capital/deposit/hisrec", { coin: base, startTime: sinceTs });
      const rec = Array.isArray(j)
        ? j.find((d: { status?: number; insertTime?: number; txId?: string; amount?: string }) => d.status === 1 && (d.insertTime ?? 0) >= sinceTs)
        : undefined;
      // Thread the CREDITED amount forward — sell/close should size to what
      // actually arrived, not to what was bought.
      const credited = rec?.amount ? Number(rec.amount) : undefined;
      return { ok: !!rec, pending: !rec, dryRun: false, id: null, txHash: rec?.txId, filledQty: credited, message: rec ? `Binance ${base} 입금 확인${credited ? ` ${credited}` : ""}` : "입금 대기" };
    } catch (e) {
      return { ok: false, pending: true, dryRun: false, id: null, message: `입금 조회 실패(재확인 대기): ${e instanceof Error ? e.message : "?"}` };
    }
  }
  if (venue === "upbit") {
    const key = process.env.UPBIT_KEY, secret = process.env.UPBIT_SECRET;
    if (CONFIG.DRY_RUN || !key || !secret) return sim(`Upbit ${base} 입금 확인`, !!(key && secret));
    try {
      const query = new URLSearchParams({ currency: base }).toString();
      const res = await fetch(`https://api.upbit.com/v1/deposits?${query}`, { headers: { Authorization: upbitAuth(query) }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
      const j = await res.json();
      const rec = Array.isArray(j)
        ? j.find((d: { state?: string; created_at?: string; txid?: string; amount?: string }) =>
            d.state === "ACCEPTED" && new Date(d.created_at ?? 0).getTime() >= sinceTs)
        : undefined;
      const credited = rec?.amount ? Number(rec.amount) : undefined;
      return { ok: !!rec, pending: !rec, dryRun: false, id: null, txHash: rec?.txid, filledQty: credited, message: rec ? `Upbit ${base} 입금 확인${credited ? ` ${credited}` : ""}` : "입금 대기" };
    } catch (e) {
      return { ok: false, pending: true, dryRun: false, id: null, message: `입금 조회 실패(재확인 대기): ${e instanceof Error ? e.message : "?"}` };
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
      if (j.status !== "0000") return { ok: false, pending: true, dryRun: false, id: null, message: (j.message || "입금 조회 실패") + " — 재확인 대기" };
      const rec = (Array.isArray(j.data) ? j.data : []).find(
        (d: { transfer_date?: number | string }) => Number(d.transfer_date ?? 0) / 1000 >= sinceTs,
      );
      return { ok: !!rec, pending: !rec, dryRun: false, id: null, message: rec ? `Bithumb ${base} 입금 확인` : "입금 대기" };
    } catch (e) {
      return { ok: false, pending: true, dryRun: false, id: null, message: `입금 조회 실패(재확인 대기): ${e instanceof Error ? e.message : "?"}` };
    }
  }
  if (venue === "bybit") {
    const key = process.env.BYBIT_KEY, secret = process.env.BYBIT_SECRET;
    if (CONFIG.DRY_RUN || !key || !secret) return sim(`Bybit ${base} 입금 확인`, !!(key && secret));
    try {
      const j = await bybitSigned("GET", "/v5/asset/deposit/query-record", { coin: base });
      const rec = (j?.result?.rows ?? []).find(
        (d: { status?: number; successAt?: string; txID?: string; amount?: string }) =>
          d.status === 3 && Number(d.successAt ?? 0) >= sinceTs, // 3 = success
      );
      const credited = rec?.amount ? Number(rec.amount) : undefined;
      return { ok: !!rec, pending: !rec, dryRun: false, id: null, txHash: rec?.txID, filledQty: credited, message: rec ? `Bybit ${base} 입금 확인${credited ? ` ${credited}` : ""}` : "입금 대기" };
    } catch (e) {
      return { ok: false, pending: true, dryRun: false, id: null, message: `입금 조회 실패(재확인 대기): ${e instanceof Error ? e.message : "?"}` };
    }
  }
  if (venue === "okx") {
    const key = process.env.OKX_KEY, secret = process.env.OKX_SECRET, pass = process.env.OKX_PASSPHRASE;
    if (CONFIG.DRY_RUN || !key || !secret || !pass) return sim(`OKX ${base} 입금 확인`, !!(key && secret && pass));
    try {
      const path = `/api/v5/asset/deposit-history?ccy=${base}`;
      const ts = new Date().toISOString();
      const sign = crypto.createHmac("sha256", secret).update(ts + "GET" + path).digest("base64");
      const res = await fetch(`https://www.okx.com${path}`, {
        headers: { "OK-ACCESS-KEY": key, "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": pass },
        cache: "no-store", signal: AbortSignal.timeout(10_000),
      });
      const j = (await res.json()) as { code: string; data?: Array<{ state?: string; ts?: string; txId?: string; amt?: string }> };
      if (j.code !== "0") return { ok: false, pending: true, dryRun: false, id: null, message: "입금 조회 실패 — 재확인 대기" };
      const rec = (j.data ?? []).find((d) => d.state === "2" && Number(d.ts ?? 0) >= sinceTs); // 2 = credited
      const credited = rec?.amt ? Number(rec.amt) : undefined;
      return { ok: !!rec, pending: !rec, dryRun: false, id: null, txHash: rec?.txId, filledQty: credited, message: rec ? `OKX ${base} 입금 확인${credited ? ` ${credited}` : ""}` : "입금 대기" };
    } catch (e) {
      return { ok: false, pending: true, dryRun: false, id: null, message: `입금 조회 실패(재확인 대기): ${e instanceof Error ? e.message : "?"}` };
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
  const init: RequestInit = { method, headers, cache: "no-store", signal: AbortSignal.timeout(10_000) };
  if (method === "GET") url += `?${payload}`;
  else { headers["Content-Type"] = "application/json"; init.body = payload; }
  const res = await fetch(url, init);
  return res.json();
}

export async function bybitOrder(base: string, side: "BUY" | "SELL", opts: { quoteUsd?: number; qty?: number }): Promise<OrderResult> {
  const key = process.env.BYBIT_KEY, secret = process.env.BYBIT_SECRET;
  const label = side === "SELL" ? "매도" : "매수";
  if (CONFIG.DRY_RUN || !key || !secret) return sim(`Bybit ${base} ${label}`, !!(key && secret));
  if (!(await acquireOrderSlot("bybit"))) return { ok: false, dryRun: false, id: null, message: "주문 rate 한도 대기 — 다음 주기 재시도" };
  try {
    // Spot market: BUY uses marketUnit=quoteCoin (spend USDT), SELL uses base qty.
    const p: Record<string, string | number> = {
      category: "spot", symbol: `${base}USDT`, side: side === "BUY" ? "Buy" : "Sell",
      orderType: "Market", marketUnit: side === "BUY" ? "quoteCoin" : "baseCoin",
      qty: String(side === "BUY" ? (opts.quoteUsd ?? 0) : (opts.qty ?? 0)),
    };
    const j = await bybitSigned("POST", "/v5/order/create", p);
    const ok = j.retCode === 0 && j.result?.orderId;
    if (!ok) return { ok: false, dryRun: false, id: null, message: j.retMsg || "주문 실패" };
    const id = String(j.result.orderId);
    // Bybit's create response carries no fill data — every downstream step
    // (hedge sizing, withdrawal amount, settle P&L) needs the REAL fill, so
    // query it. Without this the run silently used the nominal scan-price qty
    // and settle could never take the real-fill branch, which also meant
    // recordPnl never ran → the daily-loss limit was blind on this venue.
    const f = await bybitOrderFill(base, id);
    return {
      ok: true, dryRun: false, id,
      filledQty: f?.filledQty, quoteFilled: f?.quoteFilled,
      message: `Bybit ${base} ${label} 체결${f?.filledQty ? ` ${f.filledQty}` : " (체결량 미확인)"}`,
    };
  } catch (e) {
    return inflightFail(e, "주문");
  }
}

/** Realized fill of a Bybit spot order. Polls briefly — a market order is
 *  usually filled by the time the create call returns, but not always. */
async function bybitOrderFill(base: string, orderId: string): Promise<{ filledQty: number; quoteFilled: number } | null> {
  for (let i = 0; i < 4; i++) {
    try {
      const j = await bybitSigned("GET", "/v5/order/realtime", { category: "spot", symbol: `${base}USDT`, orderId });
      const row = j?.result?.list?.[0] as { cumExecQty?: string; cumExecValue?: string; orderStatus?: string } | undefined;
      const qty = Number(row?.cumExecQty ?? 0);
      if (qty > 0 && (row?.orderStatus === "Filled" || i === 3)) {
        return { filledQty: qty, quoteFilled: Number(row?.cumExecValue ?? 0) };
      }
      if (row?.orderStatus === "Filled") return { filledQty: qty, quoteFilled: Number(row?.cumExecValue ?? 0) };
    } catch { /* retry */ }
    // 마지막 시도 전에만 대기 — 시장가는 보통 즉시 체결된다
    if (i < 3) await new Promise((r) => setTimeout(r, 400));
  }
  // 히스토리 폴백 (realtime은 체결 완료 후 목록에서 빠질 수 있다)
  try {
    const j = await bybitSigned("GET", "/v5/order/history", { category: "spot", symbol: `${base}USDT`, orderId });
    const row = j?.result?.list?.[0] as { cumExecQty?: string; cumExecValue?: string } | undefined;
    const qty = Number(row?.cumExecQty ?? 0);
    if (qty > 0) return { filledQty: qty, quoteFilled: Number(row?.cumExecValue ?? 0) };
  } catch { /* 아래서 null */ }
  return null;
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
    return inflightFail(e, "출금");
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
    cache: "no-store", signal: AbortSignal.timeout(10_000),
  });
  return res.json();
}

export async function okxOrder(base: string, side: "BUY" | "SELL", opts: { quoteUsd?: number; qty?: number }): Promise<OrderResult> {
  const key = process.env.OKX_KEY, secret = process.env.OKX_SECRET, pass = process.env.OKX_PASSPHRASE;
  const label = side === "SELL" ? "매도" : "매수";
  if (CONFIG.DRY_RUN || !key || !secret || !pass) return sim(`OKX ${base} ${label}`, !!(key && secret && pass));
  if (!(await acquireOrderSlot("okx"))) return { ok: false, dryRun: false, id: null, message: "주문 rate 한도 대기 — 다음 주기 재시도" };
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
    if (!ok) return { ok: false, dryRun: false, id: null, message: d?.sMsg || j.msg || "주문 실패" };
    const id = String(d.ordId);
    const f = await okxOrderFill(base, id);
    return {
      ok: true, dryRun: false, id,
      filledQty: f?.filledQty, quoteFilled: f?.quoteFilled,
      message: `OKX ${base} ${label} 체결${f?.filledQty ? ` ${f.filledQty}` : " (체결량 미확인)"}`,
    };
  } catch (e) {
    return inflightFail(e, "주문");
  }
}

/** Realized fill of an OKX spot order: accFillSz (base) + avgPx → quote. */
async function okxOrderFill(base: string, ordId: string): Promise<{ filledQty: number; quoteFilled: number } | null> {
  for (let i = 0; i < 4; i++) {
    try {
      const j = await okxSigned("GET", `/api/v5/trade/order?instId=${base}-USDT&ordId=${ordId}`);
      const d = j?.data?.[0] as { accFillSz?: string; avgPx?: string; state?: string } | undefined;
      const qty = Number(d?.accFillSz ?? 0);
      const px = Number(d?.avgPx ?? 0);
      if (qty > 0 && (d?.state === "filled" || i === 3)) {
        return { filledQty: qty, quoteFilled: px > 0 ? qty * px : 0 };
      }
    } catch { /* retry */ }
    if (i < 3) await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

/** OKX per-chain withdrawal fee (minFee), 10min cached. null = unknown. */
const okxFeeCache = new Map<string, { fee: number; ts: number }>();
async function okxWithdrawFee(base: string, chain: string): Promise<number | null> {
  const ck = `${base}:${chain}`;
  const hit = okxFeeCache.get(ck);
  if (hit && Date.now() - hit.ts < 10 * 60_000) return hit.fee;
  try {
    const j = await okxSigned("GET", `/api/v5/asset/currencies?ccy=${base}`);
    if (j?.code !== "0" || !Array.isArray(j.data)) return null;
    const rows = j.data as Array<{ chain?: string; minFee?: string; canWd?: boolean }>;
    // `chain` arrives as OKX's own "CCY-Network" label; match exactly, then loosely.
    const row = rows.find((r) => r.chain === chain)
      ?? rows.find((r) => r.chain?.toUpperCase().includes(chain.toUpperCase()));
    const fee = row?.minFee != null ? Number(row.minFee) : NaN;
    if (!Number.isFinite(fee)) return null;
    okxFeeCache.set(ck, { fee, ts: Date.now() });
    return fee;
  } catch {
    return null;
  }
}

export async function okxWithdraw(base: string, chain: string, address: string, amount: number, tag?: string): Promise<OrderResult> {
  const key = process.env.OKX_KEY, secret = process.env.OKX_SECRET, pass = process.env.OKX_PASSPHRASE;
  if (CONFIG.DRY_RUN || !key || !secret || !pass) return sim(`OKX ${base} 출금 → ${address.slice(0, 10)}…`, !!(key && secret && pass));
  try {
    // OKX wants the chain as "CCY-Network" and — unlike every other venue —
    // requires the withdrawal `fee` explicitly. Omitting it rejects the request,
    // which on a live run means failing AFTER buy+hedge and dumping the entry.
    // Read the per-chain minFee from /asset/currencies rather than guessing.
    const fee = await okxWithdrawFee(base, chain);
    const body: Record<string, unknown> = {
      ccy: base, amt: String(amount), dest: "4" /* on-chain */, toAddr: tag ? `${address}:${tag}` : address, chain,
      ...(fee != null ? { fee: String(fee) } : {}),
    };
    if (fee == null) {
      return { ok: false, dryRun: false, id: null, message: `OKX ${base}/${chain} 출금 수수료 조회 실패 — 출금 차단 (수수료 누락 시 거부됨)` };
    }
    const j = await okxSigned("POST", "/api/v5/asset/withdrawal", body);
    const d = j.data?.[0];
    const ok = j.code === "0" && d?.wdId;
    return { ok: !!ok, dryRun: false, id: ok ? String(d.wdId) : null, message: ok ? `OKX ${base} 출금 요청` : (j.msg || "출금 실패") };
  } catch (e) {
    return inflightFail(e, "출금");
  }
}
