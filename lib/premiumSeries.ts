// 프리미엄 차트 데이터 — 두 거래소의 캔들을 같은 시각축에 놓고 갭(%)을 만든다.
//
// 저장하지 않는다: 공개 캔들 API를 요청 시점에 불러 정렬만 하면 과거 며칠치가
// 즉시 나온다. 우리가 직접 틱을 쌓으면 "오늘부터"만 볼 수 있고 용량도 든다.
//
// 원화 거래소는 USD 환산이 필요한데, 환율은 **그 거래소의 USDT/KRW 캔들**을
// 쓴다 (스캐너의 per-venue FX와 같은 기준 — 거래소마다 USDT 가격이 다르고,
// 김프는 결국 그 거래소에서 USDT를 사고팔 때의 괴리이기 때문).
//
// 한계(화면에도 명시할 것): 캔들엔 호가가 없다. 그래서 과거 구간의 갭은
// **종가 기준**이고, 진입갭/청산갭(매수·매도 호가를 가로지르는 실제 갭)은
// 현재값에서만 정확하다.

export type MarketKind = "spot" | "futures";
export type ChartVenue = "upbit" | "bithumb" | "binance" | "bybit" | "okx";
export type VenueSpec = { venue: ChartVenue; market: MarketKind };

/** 분 단위 — UI의 1분/3분/5분/15분/30분/1시간/4시간/1일에 대응. */
export type Unit = 1 | 3 | 5 | 15 | 30 | 60 | 240 | 1440;
export const UNITS: Unit[] = [1, 3, 5, 15, 30, 60, 240, 1440];

export type Candle = { t: number; close: number }; // t = epoch seconds (봉 시작)

const KR: Record<string, true> = { upbit: true, bithumb: true };
export const isKrVenue = (v: ChartVenue) => !!KR[v];

const UA = { "User-Agent": "Mozilla/5.0", Accept: "application/json" };
async function j<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store", headers: UA, signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 60)}`);
  return (await r.json()) as T;
}

// ── 업비트 캔들 한도 — group=candles 초당 10회(IP 단위) ────────────────────────
// 차트 하나가 4회(코인 2페이지 + USDT/KRW 2페이지)를 동시에 쏘고, 차트 여러 개·재시도가
// 겹치면 한도를 넘어 429로 통째로 실패했다. 호출 간격을 120ms로 줄 세우고(초당 ~8회),
// 그래도 429면 잠깐 쉬고 두 번까지 다시 부른다.
const UPBIT_GAP_MS = 120;
const gq = globalThis as unknown as { __upCandleNext?: number };
async function upbitSlot(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, gq.__upCandleNext ?? 0);
  gq.__upCandleNext = at + UPBIT_GAP_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}
async function upbitJ<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await upbitSlot();
    const r = await fetch(url, { cache: "no-store", headers: UA, signal: AbortSignal.timeout(12_000) });
    if (r.status === 429 && attempt < 2) { await new Promise((res) => setTimeout(res, 600 * (attempt + 1))); continue; }
    if (!r.ok) throw new Error(r.status === 429 ? "업비트 요청 한도 초과 — 잠시 후 다시 시도" : `${r.status} ${url.slice(0, 60)}`);
    return (await r.json()) as T;
  }
}

// ── 거래소별 캔들 ─────────────────────────────────────────────────────────────

async function upbitCandles(market: string, unit: Unit, count: number): Promise<Candle[]> {
  // 업비트는 1회 200개 상한 — 그 이상은 `to`로 과거 방향 페이지네이션.
  const path = unit === 1440 ? "days" : `minutes/${unit}`;
  const out: Candle[] = [];
  let to: string | undefined;
  while (out.length < count) {
    const n = Math.min(200, count - out.length);
    const url = `https://api.upbit.com/v1/candles/${path}?market=${market}&count=${n}${to ? `&to=${encodeURIComponent(to)}` : ""}`;
    const rows = await upbitJ<{ candle_date_time_utc: string; trade_price: number }[]>(url);
    if (!rows.length) break;
    for (const c of rows) out.push({ t: Math.floor(Date.parse(`${c.candle_date_time_utc}Z`) / 1000), close: c.trade_price });
    to = rows[rows.length - 1].candle_date_time_utc;
    if (rows.length < n) break;
  }
  return out.reverse(); // 과거 → 현재
}

const BITHUMB_IV: Record<Unit, string> = { 1: "1m", 3: "3m", 5: "5m", 15: "15m", 30: "30m", 60: "1h", 240: "4h", 1440: "24h" };
async function bithumbCandles(symbol: string, unit: Unit, count: number): Promise<Candle[]> {
  // [ts(ms), open, close, high, low, volume] — 페이지네이션 없음(최근 N개 고정).
  const r = await j<{ status: string; data: [number, string, string, string, string, string][] }>(
    `https://api.bithumb.com/public/candlestick/${symbol}_KRW/${BITHUMB_IV[unit]}`,
  );
  if (r.status !== "0000") throw new Error(`bithumb ${r.status}`);
  return r.data.slice(-count).map((c) => ({ t: Math.floor(c[0] / 1000), close: Number(c[2]) }));
}

const BINANCE_IV: Record<Unit, string> = { 1: "1m", 3: "3m", 5: "5m", 15: "15m", 30: "30m", 60: "1h", 240: "4h", 1440: "1d" };
async function binanceCandles(symbol: string, market: MarketKind, unit: Unit, count: number): Promise<Candle[]> {
  const host = market === "futures" ? "https://fapi.binance.com/fapi/v1" : "https://api.binance.com/api/v3";
  const rows = await j<(string | number)[][]>(`${host}/klines?symbol=${symbol}&interval=${BINANCE_IV[unit]}&limit=${Math.min(1000, count)}`);
  return rows.map((k) => ({ t: Math.floor(Number(k[0]) / 1000), close: Number(k[4]) }));
}

const BYBIT_IV: Record<Unit, string> = { 1: "1", 3: "3", 5: "5", 15: "15", 30: "30", 60: "60", 240: "240", 1440: "D" };
async function bybitCandles(symbol: string, market: MarketKind, unit: Unit, count: number): Promise<Candle[]> {
  const cat = market === "futures" ? "linear" : "spot";
  const r = await j<{ retCode: number; retMsg: string; result: { list: string[][] } }>(
    `https://api.bybit.com/v5/market/kline?category=${cat}&symbol=${symbol}&interval=${BYBIT_IV[unit]}&limit=${Math.min(1000, count)}`,
  );
  if (r.retCode !== 0) throw new Error(`bybit ${r.retMsg}`);
  // 최신순으로 온다 — [start, open, high, low, close, ...]
  return r.result.list.map((k) => ({ t: Math.floor(Number(k[0]) / 1000), close: Number(k[4]) })).reverse();
}

// OKX — 1회 300개 상한, 최신순. 더 과거는 `after`(이 시각보다 이전)로 페이지네이션.
// 최근 1440개까지는 /candles, 그 너머는 /history-candles. 일봉은 1Dutc(다른 거래소와 같은 UTC 경계).
const OKX_BAR: Record<Unit, string> = { 1: "1m", 3: "3m", 5: "5m", 15: "15m", 30: "30m", 60: "1H", 240: "4H", 1440: "1Dutc" };
async function okxCandles(instId: string, unit: Unit, count: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let after: string | undefined;
  for (let page = 0; out.length < count && page < 10; page++) {
    const n = Math.min(300, count - out.length);
    const ep = out.length + n > 1440 ? "history-candles" : "candles";
    const r = await j<{ code: string; msg: string; data: string[][] }>(
      `https://www.okx.com/api/v5/market/${ep}?instId=${instId}&bar=${OKX_BAR[unit]}&limit=${n}${after ? `&after=${after}` : ""}`,
    );
    if (r.code !== "0") throw new Error(`okx ${r.msg || r.code}`);
    if (!r.data.length) break;
    for (const k of r.data) out.push({ t: Math.floor(Number(k[0]) / 1000), close: Number(k[4]) });
    after = r.data[r.data.length - 1][0];
    if (r.data.length < n) break;
  }
  return out.reverse(); // 과거 → 현재
}

/** 그 거래소에서의 한 다리 캔들 (원화 거래소는 KRW 표기 그대로). */
async function legCandles(spec: VenueSpec, coin: string, unit: Unit, count: number): Promise<Candle[]> {
  const c = coin.toUpperCase();
  switch (spec.venue) {
    case "upbit": return upbitCandles(`KRW-${c}`, unit, count);
    case "bithumb": return bithumbCandles(c, unit, count);
    case "binance": return binanceCandles(`${c}USDT`, spec.market, unit, count);
    case "bybit": return bybitCandles(`${c}USDT`, spec.market, unit, count);
    case "okx": return okxCandles(spec.market === "futures" ? `${c}-USDT-SWAP` : `${c}-USDT`, unit, count);
  }
}

/** 원화 → USD 환산용 USDT/KRW 캔들 (그 거래소 자신의 USDT 가격).
 *  코인과 무관한 값이라 30초 공유 캐시 — 여러 코인 차트가 매번 같은 환율 캔들을 다시 받지 않게. */
const gfx = globalThis as unknown as { __fxCandles?: Map<string, { ts: number; p: Promise<Candle[]> }> };
gfx.__fxCandles ??= new Map();
async function fxCandles(venue: ChartVenue, unit: Unit, count: number): Promise<Candle[]> {
  const key = `${venue}:${unit}:${count}`;
  const hit = gfx.__fxCandles!.get(key);
  if (hit && Date.now() - hit.ts < 30_000) return hit.p;
  const p = venue === "bithumb" ? bithumbCandles("USDT", unit, count) : upbitCandles("KRW-USDT", unit, count);
  gfx.__fxCandles!.set(key, { ts: Date.now(), p });
  p.catch(() => gfx.__fxCandles!.delete(key)); // 실패는 캐시하지 않는다
  return p;
}

// ── 정렬 + 갭 계산 ────────────────────────────────────────────────────────────

export type PremiumPoint = { t: number; a: number; b: number; prem: number };
export type PremiumSeries = {
  coin: string;
  a: VenueSpec; b: VenueSpec; unit: Unit;
  points: PremiumPoint[];
  stats: { n: number; hi: number; lo: number; avg: number; cur: number } | null;
  note: string;
};

/**
 * A 대비 B의 프리미엄(%) 시계열. 두 다리를 USD로 맞춘 뒤 (a/b − 1) × 100.
 * 김프면 A=업비트/빗썸, B=바이낸스 → 양수 = 국내가 비쌈(김프), 음수 = 역프.
 */
export async function premiumSeries(
  coin: string, a: VenueSpec, b: VenueSpec, unit: Unit, count: number,
): Promise<PremiumSeries> {
  const need = Math.max(20, Math.min(2000, count));
  const [aRaw, bRaw, aFx, bFx] = await Promise.all([
    legCandles(a, coin, unit, need),
    legCandles(b, coin, unit, need),
    isKrVenue(a.venue) ? fxCandles(a.venue, unit, need) : Promise.resolve([] as Candle[]),
    isKrVenue(b.venue) ? fxCandles(b.venue, unit, need) : Promise.resolve([] as Candle[]),
  ]);

  const map = (rows: Candle[]) => new Map(rows.map((c) => [c.t, c.close]));
  const A = map(aRaw), B = map(bRaw), AF = map(aFx), BF = map(bFx);
  const usd = (v: number, venue: ChartVenue, fx: Map<number, number>, t: number): number | null => {
    if (!isKrVenue(venue)) return v;
    const rate = fx.get(t);
    return rate && rate > 0 ? v / rate : null;
  };

  const points: PremiumPoint[] = [];
  for (const t of [...A.keys()].sort((x, y) => x - y)) {
    const bv = B.get(t);
    if (bv == null) continue; // 한쪽에만 있는 봉은 버린다 (거래 없던 구간)
    const au = usd(A.get(t)!, a.venue, AF, t);
    const bu = usd(bv, b.venue, BF, t);
    if (au == null || bu == null || au <= 0 || bu <= 0) continue;
    points.push({ t, a: au, b: bu, prem: Math.round(((au / bu - 1) * 100) * 1000) / 1000 });
  }

  const prem = points.map((p) => p.prem);
  const stats = prem.length
    ? {
        n: prem.length,
        hi: Math.max(...prem), lo: Math.min(...prem),
        avg: Math.round((prem.reduce((s, v) => s + v, 0) / prem.length) * 1000) / 1000,
        cur: prem[prem.length - 1],
      }
    : null;

  return {
    coin: coin.toUpperCase(), a, b, unit, points, stats,
    note: "종가 기준 — 호가(진입/청산갭)는 현재값만 정확",
  };
}
