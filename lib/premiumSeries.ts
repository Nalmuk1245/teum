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
export type ChartVenue = "upbit" | "bithumb" | "binance" | "bybit";
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

// ── 거래소별 캔들 ─────────────────────────────────────────────────────────────

async function upbitCandles(market: string, unit: Unit, count: number): Promise<Candle[]> {
  // 업비트는 1회 200개 상한 — 그 이상은 `to`로 과거 방향 페이지네이션.
  const path = unit === 1440 ? "days" : `minutes/${unit}`;
  const out: Candle[] = [];
  let to: string | undefined;
  while (out.length < count) {
    const n = Math.min(200, count - out.length);
    const url = `https://api.upbit.com/v1/candles/${path}?market=${market}&count=${n}${to ? `&to=${encodeURIComponent(to)}` : ""}`;
    const rows = await j<{ candle_date_time_utc: string; trade_price: number }[]>(url);
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

/** 그 거래소에서의 한 다리 캔들 (원화 거래소는 KRW 표기 그대로). */
async function legCandles(spec: VenueSpec, coin: string, unit: Unit, count: number): Promise<Candle[]> {
  const c = coin.toUpperCase();
  switch (spec.venue) {
    case "upbit": return upbitCandles(`KRW-${c}`, unit, count);
    case "bithumb": return bithumbCandles(c, unit, count);
    case "binance": return binanceCandles(`${c}USDT`, spec.market, unit, count);
    case "bybit": return bybitCandles(`${c}USDT`, spec.market, unit, count);
  }
}

/** 원화 → USD 환산용 USDT/KRW 캔들 (그 거래소 자신의 USDT 가격). */
async function fxCandles(venue: ChartVenue, unit: Unit, count: number): Promise<Candle[]> {
  return venue === "bithumb" ? bithumbCandles("USDT", unit, count) : upbitCandles("KRW-USDT", unit, count);
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
