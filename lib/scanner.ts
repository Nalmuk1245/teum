// Scanner — prefetch venue tickers once, run every strategy over the shared
// context, merge and rank the opportunities. Optionally inject mock samples so
// the board is meaningful without live/KR data.

import type { Opportunity, ScanContext, TickerMap, Venue } from "./types";
import { CONFIG, FEES } from "./config";
import { EXCHANGES } from "./exchanges";
import { STRATEGIES } from "./strategies";
import { fetchTransferStatus } from "./transfers";
import { fetchPerpBases } from "./perps";
import { fetchFundingRates, fetchMarks } from "./funding";
import { recordGap, pruneHistory, confidence } from "./history";
import { listingInfo } from "./listings";
import { computeCalibrationPct } from "./calibration";

// Slow-moving inputs don't need a fresh fetch every scan tick — gates/funding
// change on the minutes scale, the perp list on the days scale. TTL-cache them
// (globalThis so all route bundles share) and only tickers stay per-scan fresh.
type TtlEntry = { v: unknown; ts: number };
const gc = globalThis as unknown as { __arbTtl?: Map<string, TtlEntry> };
gc.__arbTtl ??= new Map();
async function ttl<T>(key: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const hit = gc.__arbTtl!.get(key);
  if (hit && Date.now() - hit.ts < ms) return hit.v as T;
  const v = await fn();
  gc.__arbTtl!.set(key, { v, ts: Date.now() });
  return v;
}

async function buildContext(): Promise<ScanContext> {
  const cexAdapters = Object.values(EXCHANGES).filter((a) => a.kind === "cex");
  const [entries, transfers, perps, funding, marks, cal] = await Promise.all([
    Promise.all(
      cexAdapters.map(
        async (a) => [a.venue, await a.fetchTickers()] as [Venue, TickerMap],
      ),
    ),
    ttl("transfers", 60_000, fetchTransferStatus),
    // Perp listings change on the days scale — worst case a brand-new perp's
    // hedge toggle lags by up to the TTL, so keep it at 1h (not longer).
    ttl("perps", 60 * 60_000, fetchPerpBases),
    // Funding settles every 1–8h; the countdown is computed from nextTs
    // client-side, so a 2min rate refresh loses nothing visible.
    ttl("funding", 2 * 60_000, fetchFundingRates),
    ttl("marks", 2 * 60_000, fetchMarks),
    // 실거래 누수 → 비용 자동 보정 (실거래 3건 미만이면 0)
    ttl("cal", 5 * 60_000, computeCalibrationPct),
  ]);
  const tickers: Partial<Record<Venue, TickerMap>> = {};
  for (const [venue, map] of entries) tickers[venue] = map;
  // Prefer a live USDT/KRW rate from a KR venue's own USDT market — that's the
  // correct denominator for a kimchi premium. The env fallback is a stale bank
  // rate that can inflate every premium by 1-3%, so flag it (fxLive=false) and
  // let strategies refuse to fabricate premiums from it.
  const liveFx = tickers.upbit?.get("USDT")?.price ?? tickers.bithumb?.get("USDT")?.price ?? null;
  return { tickers, usdKrw: liveFx ?? CONFIG.USD_KRW, fxLive: liveFx != null, transfers, perps, funding, marks, calPct: cal.pct };
}

export async function scanAll(): Promise<Opportunity[]> {
  const ctx = await buildContext();
  const batches = await Promise.all(STRATEGIES.map((s) => s.scan(ctx)));
  const opps = batches.flat();
  // 목업은 "라이브 데이터가 없는 전략"의 빈자리만 채운다 — 실측 행과 가짜
  // 행이 같은 보드에 섞이면(예: 목업 PEPE +6.9% vs 실측 PEPE −0.4%) 보드
  // 전체의 신뢰가 무너진다.
  if (CONFIG.USE_MOCK) {
    const liveKinds = new Set(opps.map((o) => o.kind));
    opps.push(...MOCK_OPPS().filter((m) => !liveKinds.has(m.kind)));
  }
  if (ctx.perps) for (const o of opps) o.hasPerp = ctx.perps.has(o.base);

  // Hedge round-trip cost (perp taker open+close) — charged once hasPerp is
  // known. The recommended kimchi flow hedges whenever possible, so the board
  // net assumes it; unhedged coins skip the fee but carry the (bigger) price
  // risk shown by transferRisk instead.
  const hedgeRt = (FEES.perpTakerPct.binance ?? 0.045) * 2;
  for (const o of opps) {
    // 전송형 kinds(kimchi, cex-dex)만 — 전송 중 노출을 헷지한다는 전제의 비용.
    if (o.mock || !o.hasPerp || (o.kind !== "kimchi" && o.kind !== "cex-dex")) continue;
    o.costPct += hedgeRt;
    o.netPct -= hedgeRt;
    if (o.netPct <= 0) o.executable = false;
  }

  // Persistence: record each live opp's net into rolling history and attach the
  // held-duration / hit-rate. Rank by a confidence-weighted score so fresh
  // one-scan spikes sink below sustained edges of similar size (not hidden).
  // USDT/KRW (tether premium) volatility — the coin hedge does NOT cover this,
  // yet proceeds land in KRW and repatriate at a later USDT/KRW. Track it under
  // a synthetic id so transferRisk can add its ETA-scaled drift.
  const usdtKr = ctx.tickers.upbit?.get("USDT")?.price ?? ctx.tickers.bithumb?.get("USDT")?.price ?? 0;
  const ts = Date.now();
  const fxP = usdtKr > 0 ? recordGap("_fx:USDTKRW", 1, 0, usdtKr, ts) : null;
  const fxVolPerMin = fxP?.volPctPerMin ?? 0;

  const seen = new Set<string>(["_fx:USDTKRW"]);
  for (const o of opps) {
    if (o.mock) continue;
    seen.add(o.id);
    // 상장따리: flag a fresh KR listing (fastest kimchi spike).
    const listing = listingInfo(o.base);
    if (listing) o.newListing = listing;
    const gPrice = o.legs.find((l) => l.quote === "USDT")?.price ?? 0;
    o.persistence = recordGap(o.id, o.netPct, o.grossPct, gPrice, ts);
    // Transfer-window risk: proceeds are captured at SELL time, ETA minutes
    // later. The unhedged exposure is the coin's PRICE vol (σ×√ETA) plus a
    // one-sided jump tail; even hedged, the USDT/KRW drift is uncovered. Hedge
    // is advised whenever price risk approaches the edge OR the transfer is
    // slow (ETA > 5min) — a coin can gap on a headline regardless of quiet vol.
    if (o.transfer && (o.kind === "kimchi" || o.kind === "cex-dex")) {
      const etaMin = o.transfer.etaMin;
      const drift = (o.persistence?.volPctPerMin ?? 0) * Math.sqrt(Math.max(1, etaMin));
      const jump = o.persistence?.jumpPct ?? 0;
      const fxDrift = fxVolPerMin * Math.sqrt(Math.max(1, etaMin));
      o.transferRisk = {
        etaMin, driftPct: drift, jumpPct: jump, fxDriftPct: fxDrift,
        hedgeAdvised: !!o.hasPerp && (drift > o.netPct || jump > o.netPct || etaMin > 5),
      };
    }
  }
  pruneHistory(seen, ts);
  // Fresh listings float to the very top (+1000) — a spike you want to see NOW,
  // ranked above any steady edge regardless of current net.
  const score = (o: Opportunity) =>
    (o.newListing ? 1000 : 0) + (o.mock ? o.netPct : o.netPct * confidence(o.persistence));
  opps.sort((a, b) => score(b) - score(a));
  return opps;
}

// Sample opportunities across all four kinds — clearly flagged `mock:true`.
// Lets the UI + execution flow be exercised end-to-end before live data/keys.
function MOCK_OPPS(): Opportunity[] {
  const ts = Date.now();
  return [
    {
      id: "mock:kimchi:XRP", kind: "kimchi", base: "XRP",
      legs: [
        { venue: "binance", side: "buy", symbol: "XRPUSDT", price: 2.41, quote: "USDT" },
        { venue: "upbit", side: "sell", symbol: "KRW-XRP", price: 3450, quote: "KRW" },
      ],
      grossPct: 1.82, costPct: 0.55, netPct: 1.27,
      notionalCapUsd: 42000, executable: true, mock: true, ts,
    },
    {
      id: "mock:cross-cex:SOL", kind: "cross-cex", base: "SOL",
      legs: [
        { venue: "bybit", side: "buy", symbol: "SOLUSDT", price: 172.1, quote: "USDT" },
        { venue: "binance", side: "sell", symbol: "SOLUSDT", price: 173.4, quote: "USDT" },
      ],
      grossPct: 0.75, costPct: 0.3, netPct: 0.45,
      notionalCapUsd: 88000, executable: true, mock: true, ts,
    },
    {
      id: "mock:funding-basis:BTC", kind: "funding-basis", base: "BTC",
      legs: [
        { venue: "binance", side: "buy", symbol: "BTCUSDT", price: 62700, quote: "USDT" },
        { venue: "binance", side: "sell", symbol: "BTCUSDT-PERP", price: 62740, quote: "USDT" },
      ],
      grossPct: 0.38, costPct: 0.15, netPct: 0.23,
      notionalCapUsd: 250000, executable: true, mock: true,
      note: "funding +0.038%/8h → ~34% APR carry", ts,
    },
    {
      id: "mock:cex-dex:PEPE", kind: "cex-dex", base: "PEPE",
      legs: [
        { venue: "uniswap", side: "buy", symbol: "PEPE/WETH", price: 0.0000102, quote: "USD" },
        { venue: "binance", side: "sell", symbol: "PEPEUSDT", price: 0.0000109, quote: "USDT" },
      ],
      grossPct: 6.86, costPct: 0.5, netPct: 6.36,
      notionalCapUsd: 3000, executable: false, mock: true,
      note: "gate: gas + bridge time; small size only", ts,
    },
  ];
}
