// Arbitrage strategies. Each implements the same Strategy interface; the scanner
// runs them all over a shared ScanContext and merges the results.
//
// Only `kimchi` carries real logic today. The other three are structural stubs
// that document their data source and return [] (plus mock samples via the
// scanner when USE_MOCK is on).

import type { Opportunity, ScanContext, StrategyKind, TransferGate, Venue } from "./types";
import {
  CONFIG, FEES, NETWORK_PCT, NETWORK_PCT_DEFAULT,
  TRANSFER_ETA_MIN, TRANSFER_ETA_DEFAULT_MIN,
  COIN_NETWORK, COIN_NETWORK_DEFAULT,
} from "./config";
import { walletStatus } from "./transfers";
import { coinNetwork, withdrawFeeCoin } from "./networks";
import { quoteDex, gasPriceWei, gasCostUsd, dexConfigured, CEXDEX_CHAINS } from "./dex";

export interface Strategy {
  kind: StrategyKind;
  label: string;
  scan(ctx: ScanContext): Promise<Opportunity[]>;
}

const now = () => Date.now();
const id = (kind: string, base: string) => `${kind}:${base}`;

// Top-of-book spread as % of mid — a freshness/thinness signal. A wide spread
// means the last price is unreliable (stale/illiquid). 0 when book is missing
// (don't gate on absent data; liquid venues always have a book here).
function spreadPct(t: { bid?: number; ask?: number }): number {
  if (!t.bid || !t.ask || t.ask <= 0) return 0;
  return ((t.ask - t.bid) / ((t.ask + t.bid) / 2)) * 100;
}

// KR venues evaluated for kimchi, best-net wins per coin.
const KR_VENUES: Venue[] = ["upbit", "bithumb"];

const krSymbol = (venue: Venue, base: string) =>
  venue === "upbit" ? `KRW-${base}` : `${base}_KRW`;

// Global venues eligible as the kimchi USDT leg (best-net wins per coin).
const GLOBAL_VENUES: Venue[] = ["binance", "bybit", "okx"];
const globalSymbol = (venue: Venue, base: string) =>
  venue === "okx" ? `${base}-USDT` : `${base}USDT`;

// Real, size-aware round-trip cost. Prices the transfer as a FLAT coin fee at a
// reference size (not a fake percent), charges slippage per LEG (×2), and adds
// the hedge round-trip + the eventual KRW→USDT repatriation. `usdPrice` = the
// coin's USD price so the flat withdraw fee can be converted to a % of ref size.
function kimchiCostPct(base: string, globalVenue: Venue, krVenue: Venue, usdPrice: number): number {
  const globalFee = FEES.takerPct[globalVenue] ?? 0.1;
  const krFee = FEES.takerPct[krVenue] ?? 0.05;

  // Transfer: flat coin withdrawal fee → % of the board reference notional.
  const feeCoin = withdrawFeeCoin(base);
  const transferPct = feeCoin != null && usdPrice > 0
    ? (feeCoin * usdPrice / CONFIG.BOARD_REF_USD) * 100
    : (NETWORK_PCT[base] ?? NETWORK_PCT_DEFAULT); // fallback to the rough tier

  const slippage = FEES.slippagePct * 2; // one impact per leg
  // Hedge round-trip (perp taker ×2) is added in the scanner where hasPerp is
  // known; repatriation is charged here since every kimchi cycle recycles KRW.
  return globalFee + krFee + transferPct + FEES.fxSpreadPct + slippage + CONFIG.REPATRIATION_PCT;
}

// ── KIMCHI — KR won premium vs global USDT ─────────────────────────────────────
// Best combo of (Upbit|Bithumb) × (Binance|Bybit|OKX) per coin. The hedge is
// still the Binance USDT-M perp regardless of which global venue holds the spot
// leg — it's a price hedge, not an inventory hedge.
const kimchi: Strategy = {
  kind: "kimchi",
  label: "KIMCHI",
  async scan(ctx) {
    // Union of coins listed on any KR venue.
    const bases = new Set<string>();
    for (const v of KR_VENUES) {
      const m = ctx.tickers[v];
      if (m) for (const b of m.keys()) bases.add(b);
    }

    const out: Opportunity[] = [];
    for (const base of bases) {
      if (CONFIG.EXCLUDE.has(base)) continue;

      // Evaluate every KR × global combo; keep the best net edge. Prices are the
      // EXECUTABLE top-of-book (buy at ask, sell at bid) — not the optimistic
      // last trade — so the board net reflects what you'd actually capture.
      let best:
        | { kv: Venue; gv: Venue; krPrice: number; gPrice: number; premiumPct: number; cost: number; net: number; execGross: number }
        | null = null;
      for (const kv of KR_VENUES) {
        const km = ctx.tickers[kv];
        const kr = km?.get(base);
        if (!kr) continue;
        // KR-leg liquidity gate — quoteVolumeUsd holds KRW for KR venues.
        if (kr.quoteVolumeUsd < CONFIG.MIN_KR_VOLUME_KRW) continue;
        if (spreadPct(kr) > CONFIG.MAX_SPREAD_PCT) continue; // thin/stale KR book
        // Per-venue USDT/KRW; a live cross-venue rate is acceptable, but a bank
        // fallback rate fabricates 1-3% premiums — skip rather than mislead.
        const fx = km?.get("USDT")?.price ?? (ctx.fxLive ? ctx.usdKrw : null);
        if (!fx) continue;
        for (const gv of GLOBAL_VENUES) {
          const g = ctx.tickers[gv]?.get(base);
          if (!g || !g.price) continue;
          if (g.quoteVolumeUsd < CONFIG.MIN_VOLUME_USD) continue;
          if (spreadPct(g) > CONFIG.MAX_SPREAD_PCT) continue; // thin/stale global book
          const midPremium = ((kr.price / fx - g.price) / g.price) * 100;
          if (Math.abs(midPremium) > CONFIG.MAX_ABS_PREMIUM_PCT) continue; // bad data
          // Executable gross: cross both spreads in the profitable direction.
          const gAsk = g.ask ?? g.price, gBid = g.bid ?? g.price;
          const kAsk = kr.ask ?? kr.price, kBid = kr.bid ?? kr.price;
          const execGross = midPremium >= 0
            ? ((kBid / fx - gAsk) / gAsk) * 100      // buy global ask → sell KR bid
            : ((gBid - kAsk / fx) / (kAsk / fx)) * 100; // buy KR ask → sell global bid
          const cost = kimchiCostPct(base, gv, kv, g.price);
          const net = execGross - cost;
          if (!best || net > best.net)
            best = { kv, gv, krPrice: kr.price, gPrice: g.price, premiumPct: midPremium, cost, net, execGross };
        }
      }
      if (!best) continue;
      const execGross = best.execGross;

      const buyGlobal = best.premiumPct >= 0; // KR expensive → buy global, sell KR

      // Settlement gate: you WITHDRAW the coin from the buy venue and DEPOSIT it
      // to the sell venue. If either is disabled, the edge can't be captured.
      const buyVenue: Venue = buyGlobal ? best.gv : best.kv;
      const sellVenue: Venue = buyGlobal ? best.kv : best.gv;
      const wStat = walletStatus(ctx.transfers, buyVenue, base);
      const dStat = walletStatus(ctx.transfers, sellVenue, base);
      // 역프 (buy on KR, withdraw KR→overseas): Korean exchanges freeze crypto
      // withdrawals for ~24-72h after a KRW deposit and enforce whitelist/limits,
      // so a KR-buy leg is NOT a 1-minute settlement — reflect a realistic ETA
      // and flag it so the operator doesn't treat it as a fast arb.
      const isReverse = !buyGlobal; // buying on the KR venue
      const baseEta = TRANSFER_ETA_MIN[base] ?? TRANSFER_ETA_DEFAULT_MIN;
      const transfer: TransferGate = {
        withdraw: { venue: buyVenue, enabled: wStat ? wStat.withdraw : null },
        deposit: { venue: sellVenue, enabled: dStat ? dStat.deposit : null },
        etaMin: isReverse ? Math.max(baseEta, 60) : baseEta, // KR withdrawal freeze
        blocked: false,
        network: coinNetwork(base),
      };
      // FAIL-CLOSED: a persistent kimchi premium usually exists BECAUSE deposits
      // are suspended on the KR side — so unknown (null) status must NOT pass as
      // executable. Only an explicitly-confirmed-open pair on BOTH legs is
      // settleable. (`blocked` distinguishes "known off" for the red badge;
      // executable additionally requires both legs known-open.)
      transfer.blocked =
        transfer.withdraw.enabled === false || transfer.deposit.enabled === false;
      const settleable = transfer.withdraw.enabled === true && transfer.deposit.enabled === true;

      const gLeg = { venue: best.gv, symbol: globalSymbol(best.gv, base), price: best.gPrice, quote: "USDT" as const };
      const kLeg = { venue: best.kv, symbol: krSymbol(best.kv, base), price: best.krPrice, quote: "KRW" as const };
      out.push({
        id: id("kimchi", base),
        kind: "kimchi",
        base,
        legs: buyGlobal
          ? [{ ...gLeg, side: "buy" }, { ...kLeg, side: "sell" }]
          : [{ ...kLeg, side: "buy" }, { ...gLeg, side: "sell" }],
        grossPct: execGross, // executable (spread-crossed), not mid-price
        costPct: best.cost,
        netPct: best.net,
        notionalCapUsd: null, // TODO: from order-book depth
        // Live: fail-closed (both gates must be CONFIRMED open). DRY keeps the
        // demo usable without keys — the gate panel still shows "키 필요".
        executable: best.net > 0 && !transfer.blocked && (CONFIG.DRY_RUN || settleable),
        transfer,
        ...(isReverse ? { note: "역프 — KR 출금 정지(원화입금 후 24-72h)·화이트리스트·한도 확인 필요" } : {}),
        ts: now(),
      });
    }
    return out;
  },
};

// ── CROSS-CEX — same coin, price gap between two global CEXes ──────────────────
// Both legs are USDT so there's no FX; cost = taker×2 + on-chain transfer +
// slippage. Majors rarely gap >0.1% — the tail (new listings, depegs) is where
// this fires.
const CROSS_VENUES: Venue[] = ["binance", "bybit", "okx"];
const CROSS_MIN_GROSS = 0.1; // % — below this it's noise, not an edge
const crossSymbol = (venue: Venue, base: string) =>
  venue === "okx" ? `${base}-USDT` : `${base}USDT`;

const crossCex: Strategy = {
  kind: "cross-cex",
  label: "CROSS-CEX",
  async scan(ctx) {
    const out: Opportunity[] = [];
    const maps = CROSS_VENUES
      .map((v) => ({ v, m: ctx.tickers[v] }))
      .filter((x): x is { v: Venue; m: NonNullable<typeof x.m> } => !!x.m && x.m.size > 0);
    if (maps.length < 2) return out;

    // Union of bases seen on at least two venues, with executable bid/ask.
    const bases = new Map<string, { v: Venue; ask: number; bid: number }[]>();
    for (const { v, m } of maps) {
      for (const [base, t] of m) {
        if (CONFIG.EXCLUDE.has(base)) continue;
        if (t.quoteVolumeUsd < CONFIG.MIN_VOLUME_USD) continue; // both legs must be liquid
        if (!t.price) continue;
        if (spreadPct(t) > CONFIG.MAX_SPREAD_PCT) continue; // thin/stale book
        const arr = bases.get(base) ?? [];
        arr.push({ v, ask: t.ask ?? t.price, bid: t.bid ?? t.price });
        bases.set(base, arr);
      }
    }

    for (const [base, quotes] of bases) {
      if (quotes.length < 2) continue;
      // Buy at the cheapest ASK, sell into the richest BID — the executable arb.
      let lo = quotes[0], hi = quotes[0];
      for (const q of quotes) {
        if (q.ask < lo.ask) lo = q;
        if (q.bid > hi.bid) hi = q;
      }
      if (lo.v === hi.v) continue;
      const gross = ((hi.bid - lo.ask) / lo.ask) * 100;
      if (gross < CROSS_MIN_GROSS) continue;
      if (gross > CONFIG.MAX_ABS_PREMIUM_PCT) continue; // stale/broken feed

      // Flat withdrawal fee at the board reference size (percent tiers lie at
      // small size), slippage per LEG. A persistent cross gap usually means the
      // transfer route is down — unknown gate status must not read as tradeable.
      const feeCoin = withdrawFeeCoin(base);
      const transferPct = feeCoin != null && lo.ask > 0
        ? (feeCoin * lo.ask / CONFIG.BOARD_REF_USD) * 100
        : (NETWORK_PCT[base] ?? NETWORK_PCT_DEFAULT);
      const cost =
        (FEES.takerPct[lo.v] ?? 0.1) + (FEES.takerPct[hi.v] ?? 0.1) +
        transferPct + FEES.slippagePct * 2;
      const net = gross - cost;

      const transfer: TransferGate = {
        // Wallet status for bybit/okx isn't wired → null (unknown).
        withdraw: { venue: lo.v, enabled: walletStatus(ctx.transfers, lo.v, base)?.withdraw ?? null },
        deposit: { venue: hi.v, enabled: walletStatus(ctx.transfers, hi.v, base)?.deposit ?? null },
        etaMin: TRANSFER_ETA_MIN[base] ?? TRANSFER_ETA_DEFAULT_MIN,
        blocked: false,
        network: coinNetwork(base),
      };
      transfer.blocked =
        transfer.withdraw.enabled === false || transfer.deposit.enabled === false;
      const settleable = transfer.withdraw.enabled === true && transfer.deposit.enabled === true;

      out.push({
        id: id("cross-cex", base),
        kind: "cross-cex",
        base,
        legs: [
          { venue: lo.v, side: "buy", symbol: crossSymbol(lo.v, base), price: lo.ask, quote: "USDT" },
          { venue: hi.v, side: "sell", symbol: crossSymbol(hi.v, base), price: hi.bid, quote: "USDT" },
        ],
        grossPct: gross,
        costPct: cost,
        netPct: net,
        notionalCapUsd: null,
        executable: net > 0 && !transfer.blocked && (CONFIG.DRY_RUN || settleable),
        transfer,
        ts: now(),
      });
    }
    // Keep the tail from flooding the board.
    out.sort((a, b) => b.netPct - a.netPct);
    return out.slice(0, 20);
  },
};

// ── FUNDING-BASIS — cross-venue funding-rate arbitrage (perp vs perp) ──────────
// Same coin, funding differs across perp venues. SHORT the high-funding venue
// (receive funding), LONG the low-funding venue (pay least / receive if
// negative) → delta-neutral, no on-chain transfer, capture the funding SPREAD
// every 8h. Hyperliquid & Lighter often diverge sharply from the CEX cluster,
// which is where the real edge lives. Headline is APR (held ongoing).
const FUNDING_MIN_APR = 8; // % — below this the spread doesn't clear fees/risk
const FUNDING_HALF_DAYS = 1.5; // assumed spread half-life (mean-reverting) for the decay model
const perpSymbol = (venue: Venue, base: string) =>
  venue === "okx" ? `${base}-USDT-SWAP`
  : venue === "hyperliquid" || venue === "lighter" ? base
  : `${base}USDT`;

const fundingBasis: Strategy = {
  kind: "funding-basis",
  label: "FUNDING",
  async scan(ctx) {
    const fmap = ctx.funding;
    if (!fmap || fmap.size === 0) return [];
    const out: Opportunity[] = [];

    for (const [base, rates] of fmap) {
      if (CONFIG.EXCLUDE.has(base)) continue;
      if (rates.length < 2) continue; // need at least two venues to spread

      let hi = rates[0], lo = rates[0];
      for (const r of rates) {
        if (r.aprPct > hi.aprPct) hi = r;
        if (r.aprPct < lo.aprPct) lo = r;
      }
      if (hi.venue === lo.venue) continue;

      const grossApr = hi.aprPct - lo.aprPct; // annualized funding spread (today's snapshot)
      if (grossApr < FUNDING_MIN_APR) continue;

      // One-time round trip: taker to open + close on BOTH legs (4 fills).
      const pf = FEES.perpTakerPct;
      // Entry basis: you SHORT hi and LONG lo. If lo's mark > hi's mark you enter
      // at an adverse spread that converges against you — a one-time realized
      // cost often bigger than the funding captured. Add the unfavorable side.
      const marks = ctx.marks?.get(base);
      const hiMark = marks?.[hi.venue], loMark = marks?.[lo.venue];
      const entryBasisPct = (hiMark && loMark && hiMark > 0)
        ? Math.max(0, (loMark - hiMark) / ((hiMark + loMark) / 2)) * 100
        : 0;
      const roundTripPct =
        2 * ((pf[hi.venue] ?? 0.05) + (pf[lo.venue] ?? 0.05)) + entryBasisPct;
      const dailyPct = grossApr / 365;
      const breakEvenDays = dailyPct > 0 ? roundTripPct / dailyPct : Infinity;

      // HONEST headline: cross-venue funding spreads are strongly mean-reverting
      // (the fat ones usually collapse within a few settlement windows). Model a
      // linear decay to zero over FUNDING_HALF_DAYS×2 and cap the hold there:
      // expected capture ≈ grossApr × halfDays/365 (triangle area) − round trip,
      // re-annualized over that hold so the board number is comparable.
      const expectedCapturePct = grossApr * (FUNDING_HALF_DAYS / 365) - roundTripPct;
      const netApr = expectedCapturePct > 0
        ? (expectedCapturePct / (FUNDING_HALF_DAYS * 2)) * 365
        : expectedCapturePct * (365 / (FUNDING_HALF_DAYS * 2)); // negative → show as negative APR
      if (netApr < 0 && grossApr < FUNDING_MIN_APR * 2) continue; // decayed to noise

      out.push({
        id: id("funding-basis", base),
        kind: "funding-basis",
        base,
        legs: [
          // "buy" = long the low-funding venue, "sell" = short the high one.
          { venue: lo.venue, side: "buy", symbol: perpSymbol(lo.venue, base), price: 0, quote: "USDT" },
          { venue: hi.venue, side: "sell", symbol: perpSymbol(hi.venue, base), price: 0, quote: "USDT" },
        ],
        grossPct: grossApr,
        costPct: roundTripPct,
        netPct: netApr, // decay-adjusted expected APR, round trip subtracted
        notionalCapUsd: null,
        executable: false, // perp-DEX / cross-venue order routing not wired yet
        rateBasis: "apr",
        // Funding pays only at the settlement snapshot — surface the SHORT
        // leg's next one + both intervals so entries can be timed.
        fundingMeta: { nextTs: hi.nextTs, shortIntervalH: hi.intervalH, longIntervalH: lo.intervalH },
        note: `숏 ${hi.venue}(${hi.intervalH ?? "?"}h${hi.predicted ? "·예측" : ""}) / 롱 ${lo.venue}(${lo.intervalH ?? "?"}h) · 진입 ${roundTripPct.toFixed(2)}% · 손익분기 ${breakEvenDays < 99 ? breakEvenDays.toFixed(1) + "일" : "—"} · 감쇠반영(반감 ${FUNDING_HALF_DAYS}일)${entryBasisPct > 0.01 ? ` · 진입베이시스 ${entryBasisPct.toFixed(2)}%` : (hiMark && loMark ? " · 베이시스 유리" : " · 베이시스 미확인")}`,
        ts: now(),
      });
    }
    out.sort((a, b) => b.netPct - a.netPct);
    return out.slice(0, 20);
  },
};

// ── CEX-DEX — CEX price vs on-chain DEX (OKX aggregator routing) ───────────────
// Inventory-style arb: hold both sides, fire DEX swap + CEX order together —
// no transfer in the critical path. Detection compares OKX DEX best-route
// quotes (routing/pool fees baked into the executable amountOut) against the
// CEX top-of-book, with REAL gas priced in (gas dominates small sizes and is
// why most naive cex-dex "opportunities" are fake). Monitoring-only until the
// swap execution phase is wired. Dormant without OKX_WEB3_* keys.
const DEXDEX_REF_USD = 2000; // quote size — gas% and depth are size-dependent
const CEXDEX_TTL_MS = 60_000; // OKX web3 rate limits — refresh once a minute
const CEXDEX_MEV_PCT = 0.1; // sandwich/re-quote buffer
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

type CexDexCache = { opps: Opportunity[]; ts: number; busy: boolean };
const gcd = globalThis as unknown as { __arbCexDex?: CexDexCache };
gcd.__arbCexDex ??= { opps: [], ts: 0, busy: false };

// Multi-chain sweep: for every chain universe (Ethereum/Base/BSC), quote both
// directions per coin against that chain's stable and compare with the CEX
// top-of-book. Gas is priced in the chain's native coin (ETH or BNB).
async function scanCexDex(ctx: ScanContext): Promise<Opportunity[]> {
  const bnb = ctx.tickers.binance;
  if (!bnb) return [];
  const out: Opportunity[] = [];

  for (const uni of CEXDEX_CHAINS) {
    const nativeUsd = bnb.get(uni.native)?.price;
    if (!nativeUsd) continue;
    const gasWei = await gasPriceWei(uni.chain);
    if (!gasWei) continue;
    const quoteTok = { address: uni.quote.address, decimals: uni.quote.decimals };

    for (const [base, token] of Object.entries(uni.bases)) {
      const cex = bnb.get(base);
      if (!cex?.bid || !cex?.ask) continue; // CEX doesn't list it (or no book) — skip
      if (cex.quoteVolumeUsd < CONFIG.MIN_VOLUME_USD) continue;
      const mid = (cex.bid + cex.ask) / 2;

      // Two quotes per coin, sequenced gently for the rate limit.
      const buyQ = await quoteDex(uni.chain, quoteTok, token, DEXDEX_REF_USD);
      await sleepMs(250);
      const qty = DEXDEX_REF_USD / mid;
      const sellQ = await quoteDex(uni.chain, token, quoteTok, qty);
      await sleepMs(250);

      const cexTaker = FEES.takerPct.binance ?? 0.1;
      const mk = (dir: "buyDex" | "sellDex", grossPct: number, gasUnits: number, dexPrice: number) => {
        const gasUsd = gasCostUsd(gasUnits, gasWei, nativeUsd);
        const gasPct = (gasUsd / DEXDEX_REF_USD) * 100;
        const cost = gasPct + cexTaker + CEXDEX_MEV_PCT;
        const net = grossPct - cost;
        const dexLeg = { venue: "dex" as const, symbol: `${base}/${uni.quote.symbol}@${uni.chain}`, price: dexPrice, quote: "USDT" };
        const cexLeg = { venue: "binance" as const, symbol: `${base}USDT`, price: dir === "buyDex" ? cex.bid! : cex.ask!, quote: "USDT" };
        out.push({
          id: id("cex-dex", `${base}:${uni.chain}:${dir}`),
          kind: "cex-dex",
          base,
          legs: dir === "buyDex"
            ? [{ ...dexLeg, side: "buy" }, { ...cexLeg, side: "sell" }]
            : [{ ...cexLeg, side: "buy" }, { ...dexLeg, side: "sell" }],
          grossPct,
          costPct: cost,
          netPct: net,
          notionalCapUsd: DEXDEX_REF_USD,
          executable: false, // swap execution phase not wired yet
          // Stale-quote warning: OKX DEX quote is up to CEXDEX_TTL_MS + sweep old
          // vs ~12s blocks — real dislocations close within 1-2 blocks, so the
          // board edge is indicative only. Age shown so it's never mistaken live.
          note: `${uni.chain} · OKX 라우팅 · 가스 $${gasUsd.toFixed(2)} (${gasPct.toFixed(2)}%) · $${DEXDEX_REF_USD} 기준 · 견적 최대 ${Math.round(CEXDEX_TTL_MS / 1000)}s 지연(블록당 소멸, 참고용)`,
          ts: now(),
        });
      };

      if (buyQ && buyQ.toAmount > 0) {
        const dexBuy = DEXDEX_REF_USD / buyQ.toAmount; // effective $/coin buying on DEX
        mk("buyDex", ((cex.bid - dexBuy) / dexBuy) * 100, buyQ.gasUnits, dexBuy);
      }
      if (sellQ && sellQ.toAmount > 0) {
        const dexSell = sellQ.toAmount / qty; // effective $/coin selling on DEX
        mk("sellDex", ((dexSell - cex.ask) / cex.ask) * 100, sellQ.gasUnits, dexSell);
      }
    }
  }
  // Keep the best direction per coin×chain, top-N overall.
  const bestPer = new Map<string, Opportunity>();
  for (const o of out) {
    const key = o.id.replace(/:(buyDex|sellDex)$/, "");
    const cur = bestPer.get(key);
    if (!cur || o.netPct > cur.netPct) bestPer.set(key, o);
  }
  return [...bestPer.values()].sort((a, b) => b.netPct - a.netPct).slice(0, 15);
}

const cexDex: Strategy = {
  kind: "cex-dex",
  label: "CEX-DEX",
  async scan(ctx) {
    if (!dexConfigured()) return []; // dormant until OKX_WEB3_* keys (mock covers demo)
    const C = gcd.__arbCexDex!;
    // Own TTL: the two-quotes-per-coin sweep is rate-limited (~5s) — refresh at
    // most once a minute, serve the cached batch to every scan in between.
    if (Date.now() - C.ts > CEXDEX_TTL_MS && !C.busy) {
      C.busy = true;
      try {
        C.opps = await scanCexDex(ctx);
        C.ts = Date.now();
      } finally {
        C.busy = false;
      }
    }
    return C.opps.map((o) => ({ ...o, ts: now() }));
  },
};

export const STRATEGIES: Strategy[] = [kimchi, crossCex, fundingBasis, cexDex];
