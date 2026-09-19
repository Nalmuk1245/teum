// Arbitrage strategies. Each implements the same Strategy interface; the scanner
// runs them all over a shared ScanContext and merges the results.
//
// kimchi / cross-cex / cex-dex detect AND execute; funding-basis detects only
// (perp-DEX order routing not wired). Mock samples fill empty strategies via
// the scanner when USE_MOCK is on.

import type { Opportunity, ScanContext, StrategyKind, TransferGate, Venue } from "./types";
import {
  CONFIG, FEES, NETWORK_PCT, NETWORK_PCT_DEFAULT,
  COIN_NETWORK, COIN_NETWORK_DEFAULT,
} from "./config";
import { walletStatus, routeFor, venueChainStatus } from "./transfers";
import { coinNetwork, withdrawFeeCoin, transferEtaMin } from "./networks";
import { erc20Symbol } from "./tokens";
import { chainKeyFromLabel } from "./chains";
import { quoteDex, gasPriceWei, gasCostUsd, dexConfigured, CEXDEX_CHAINS, allTokens, type DexToken } from "./dex";

export interface Strategy {
  kind: StrategyKind;
  label: string;
  scan(ctx: ScanContext): Promise<Opportunity[]>;
}

const now = () => Date.now();
const id = (kind: string, base: string) => `${kind}:${base}`;
const vlabelS = (v: string) => ({ binance: "Binance", upbit: "Upbit", bithumb: "Bithumb", bybit: "Bybit", okx: "OKX" } as Record<string, string>)[v] ?? v;

// Top-of-book spread as % of mid — a freshness/thinness signal. A wide spread
// means the last price is unreliable (stale/illiquid). 0 when book is missing
// (don't gate on absent data; liquid venues always have a book here).
function spreadPct(t: { bid?: number; ask?: number }): number {
  if (!t.bid || !t.ask || t.ask <= 0) return 0;
  return ((t.ask - t.bid) / ((t.ask + t.bid) / 2)) * 100;
}

/** 보드용 유동성 한도 — 두 다리의 **최우선호가 물량**이 허용하는 USD 규모.
 *
 *  예전엔 `notionalCapUsd: null`이었다. 그래서 $100이든 $50,000이든 보드 net이
 *  같아 보였고, 규모가 호가를 넘긴다는 사실은 실행 모달의 재견적에 가서야
 *  드러났다 — 즉 "보이는 엣지"와 "잡을 수 있는 엣지"가 보드에서 구분되지 않았다.
 *
 *  전 종목 풀 오더북은 스캔 주기(3초)에 감당이 안 되지만, 티커가 이미 최우선
 *  호가의 **가격과 물량**을 함께 실어 온다(bidSize/askSize — 바낸·업비트·
 *  바이비트·OKX). 그 한 호가만으로 계산한 보수적 하한이 이 값이다:
 *  실제 체결 가능 규모는 이보다 크지만(아래 호가가 더 있다), **이 값까지는
 *  슬리피지 없이 확실히 들어간다**. 정확한 상한은 모달의 뎁스 견적(quote.ts)이
 *  계속 담당한다.
 *
 *  둘 중 하나라도 물량을 모르면 null(= 미상)을 돌려준다 — 모르는 걸 큰 값으로
 *  꾸미지 않는다. */
function topOfBookCapUsd(
  buy: { ask?: number; askSize?: number } | undefined,
  sell: { bid?: number; bidSize?: number } | undefined,
  buyFx = 1,  // 매수 다리 호가통화 → USD (KRW면 원/달러, USDT면 1)
  sellFx = 1,
): number | null {
  if (!buy?.ask || !buy.askSize || !sell?.bid || !sell.bidSize) return null;
  const buyUsd = (buy.ask * buy.askSize) / buyFx;
  const sellUsd = (sell.bid * sell.bidSize) / sellFx;
  const cap = Math.min(buyUsd, sellUsd);
  return cap > 0 ? cap : null;
}
/** 테스트 전용 재수출 — 이 함수는 조용히 틀리는 종류(한도를 과대평가하면
 *  보드가 못 잡을 규모를 잡을 수 있다고 말한다)라 단위테스트로 못을 박는다. */
export const topOfBookCapUsdForTest = topOfBookCapUsd;

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

      // Evaluate every KR × global combo. Prices are the EXECUTABLE top-of-book
      // (buy at ask, sell at bid) — not the optimistic last trade — so the board
      // net reflects what you'd actually capture.
      type Cand = { kv: Venue; gv: Venue; krPrice: number; gPrice: number; premiumPct: number; cost: number; net: number; execGross: number };
      const cands: Cand[] = [];
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
          cands.push({ kv, gv, krPrice: kr.price, gPrice: g.price, premiumPct: midPremium, cost, net: execGross - cost, execGross });
        }
      }
      if (!cands.length) continue;

      // ── 게이트를 먼저 보고 고른다 ──
      // 예전엔 순수익 최대 조합 하나를 고른 뒤 게이트를 붙였다. 그러면 "빗썸 +4%인데
      // 입금 닫힘 / 업비트 +1.2%는 열림"에서 빗썸이 뽑혀 🔒로 내려가고, 실제로 잡을
      // 수 있는 업비트 경로는 코인당 한 줄 규칙에 밀려 보드 어디에도 안 나왔다.
      // 이제 조합마다 경로를 평가해 열림 > 미확인 > 닫힘 순으로 메인을 고르고,
      // 닫힌 조합이 메인보다 크면 별도 🔒 행으로 남긴다(열리면 그 행이 알림·승격).
      const evald = cands.map((c) => {
        const buyGlobal = c.premiumPct >= 0;
        const buyVenue: Venue = buyGlobal ? c.gv : c.kv;
        const sellVenue: Venue = buyGlobal ? c.kv : c.gv;
        const route = routeFor(base, buyVenue, sellVenue, ctx.transfers);
        const blocked = route.withdraw === false || route.deposit === false;
        const open = route.withdraw === true && route.deposit === true;
        const gate: "open" | "unknown" | "closed" = blocked ? "closed" : open ? "open" : "unknown";
        return { c, buyGlobal, buyVenue, sellVenue, route, gate };
      });
      const bestOf = (g: "open" | "unknown" | "closed") =>
        evald.filter((e) => e.gate === g).sort((a, b) => b.c.net - a.c.net)[0];
      const main = bestOf("open") ?? bestOf("unknown") ?? bestOf("closed")!;
      const lockedBest = bestOf("closed");
      const extra = lockedBest && lockedBest !== main && lockedBest.c.net > main.c.net ? lockedBest : undefined;

      for (const pick of extra ? [main, extra] : [main]) {
        const { c: best, buyGlobal, buyVenue, sellVenue, route } = pick;
        const lockedRow = pick === extra;
        const execGross = best.execGross;
        // 역프 (buy on KR, withdraw KR→overseas): Korean exchanges freeze crypto
        // withdrawals for ~24-72h after a KRW deposit and enforce whitelist/limits,
        // so a KR-buy leg is NOT a 1-minute settlement — reflect a realistic ETA
        // and flag it so the operator doesn't treat it as a fast arb.
        const isReverse = !buyGlobal; // buying on the KR venue
        const baseEta = route.etaMin;
        const transfer: TransferGate = {
          withdraw: { venue: buyVenue, enabled: route.withdraw },
          deposit: { venue: sellVenue, enabled: route.deposit },
          // 역프 60분: 운영자 결정(2026-07-27) — KR 출금 동결(24~72h)은 **신규 원화
          // 입금분**에 걸리고, 이 계좌는 기존 예치금으로 돌므로 해당 없음. 감사
          // R3(역프 펀딩 과소)도 같은 이유로 기각. 신규 입금으로 운용을 바꾸면
          // 이 가정이 깨진다 — 그때는 이 값과 hedgeCost 펀딩 창을 같이 늘릴 것.
          etaMin: isReverse ? Math.max(baseEta, 60) : baseEta,
          blocked: false,
          network: { chain: route.label, confirms: route.confirms, chainKey: route.chainKey, alternatives: route.alternatives, reason: route.reason },
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
        // 실거래 누수 자동 보정 — 탐지가 실현보다 후하게 나온 만큼 비용에 가산.
        const cal = ctx.calPct ?? 0;
        const calCost = best.cost + cal;
        const calNet = best.net - cal;
        const notes: string[] = [];
        if (isReverse) notes.push("역프 — KR 출금 정지(원화입금 후 24-72h)·화이트리스트·한도 확인 필요");
        if (lockedRow) notes.push(`입출금 닫힘 — 열리면 메인 경로(${vlabelS(main.buyVenue)}→${vlabelS(main.sellVenue)} ${main.c.net >= 0 ? "+" : ""}${main.c.net.toFixed(2)}%)보다 큼`);
        else if (extra) notes.push(`${vlabelS(extra.c.kv)} 쪽은 ${extra.c.net >= 0 ? "+" : ""}${extra.c.net.toFixed(2)}%지만 입출금 닫힘 (🔒 대기 행 참고)`);
        out.push({
          // 닫힌 별도 행은 id를 분리한다 — 지속성·에피소드·알림 쿨다운이 전부 id 기준이라
          // 메인과 섞이면 "열림 알림"이 메인 행의 전환에 묻힌다.
          id: lockedRow ? `${id("kimchi", base)}:locked` : id("kimchi", base),
          kind: "kimchi",
          base,
          legs: buyGlobal
            ? [{ ...gLeg, side: "buy" }, { ...kLeg, side: "sell" }]
            : [{ ...kLeg, side: "buy" }, { ...gLeg, side: "sell" }],
          grossPct: execGross, // executable (spread-crossed), not mid-price
          costPct: calCost,
          netPct: calNet,
          // 최우선호가 기준 보수적 한도 (모달 뎁스 견적이 정확한 상한을 낸다).
          // KR 다리는 원화 호가라 그 거래소의 USDT/KRW로 환산한다.
          notionalCapUsd: (() => {
            const krT = ctx.tickers[best.kv]?.get(base);
            const gT = ctx.tickers[best.gv]?.get(base);
            const krFx = ctx.tickers[best.kv]?.get("USDT")?.price ?? (ctx.fxLive ? ctx.usdKrw : 0);
            if (!krFx) return null;
            return buyGlobal
              ? topOfBookCapUsd(gT, krT, 1, krFx)   // 글로벌 ask 매수 → KR bid 매도
              : topOfBookCapUsd(krT, gT, krFx, 1);  // KR ask 매수 → 글로벌 bid 매도
          })(),
          // Live: fail-closed (both gates must be CONFIRMED open). DRY keeps the
          // demo usable without keys — the gate panel still shows "키 필요".
          executable: calNet > 0 && !transfer.blocked && (CONFIG.DRY_RUN || settleable),
          transfer,
          ...(notes.length ? { note: notes.join(" · ") } : {}),
          ts: now(),
        });
      }
    }
    return out;
  },
};

// ── CROSS-CEX — same coin, price gap between two global CEXes ──────────────────
// TRANSFER-style: buy the cheap venue, move the coin on-chain, sell the rich
// venue. Both legs are USDT so there's no FX; cost = taker×2 + on-chain
// transfer + slippage. Majors rarely gap >0.1% — the tail (new listings,
// depegs) is where this fires.
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
    const bases = new Map<string, { v: Venue; ask: number; bid: number; askSize?: number; bidSize?: number }[]>();
    for (const { v, m } of maps) {
      for (const [base, t] of m) {
        if (CONFIG.EXCLUDE.has(base)) continue;
        if (t.quoteVolumeUsd < CONFIG.MIN_VOLUME_USD) continue; // both legs must be liquid
        if (!t.price) continue;
        if (spreadPct(t) > CONFIG.MAX_SPREAD_PCT) continue; // thin/stale book
        const arr = bases.get(base) ?? [];
        arr.push({ v, ask: t.ask ?? t.price, bid: t.bid ?? t.price, askSize: t.askSize, bidSize: t.bidSize });
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
      // 출금비는 **출금하는 거래소**의 것이어야 한다. withdrawFeeCoin은 바이낸스
      // networkList(또는 그 기반 큐레이션 표)에서 오므로, 출금 다리가 바낸이
      // 아니면 그 값은 남의 거래소 수수료다 — 거래소별로 몇 배씩 차이 나는
      // 항목이라 net이 그대로 틀어진다. 바낸 다리일 때만 정확한 정액 수수료를
      // 쓰고, 그 외에는 코인별 대략 티어(NETWORK_PCT)로 물러선다.
      const feeCoin = lo.v === "binance" ? withdrawFeeCoin(base) : undefined;
      const transferPct = feeCoin != null && lo.ask > 0
        ? (feeCoin * lo.ask / CONFIG.BOARD_REF_USD) * 100
        : (NETWORK_PCT[base] ?? NETWORK_PCT_DEFAULT);
      const cost =
        (FEES.takerPct[lo.v] ?? 0.1) + (FEES.takerPct[hi.v] ?? 0.1) +
        transferPct + FEES.slippagePct * 2;
      const net = gross - cost;

      const route = routeFor(base, lo.v, hi.v, ctx.transfers);
      const transfer: TransferGate = {
        withdraw: { venue: lo.v, enabled: route.withdraw },
        deposit: { venue: hi.v, enabled: route.deposit },
        etaMin: route.etaMin,
        blocked: false,
        network: { chain: route.label, confirms: route.confirms, chainKey: route.chainKey, alternatives: route.alternatives, reason: route.reason },
      };
      transfer.blocked =
        transfer.withdraw.enabled === false || transfer.deposit.enabled === false;
      const settleable = transfer.withdraw.enabled === true && transfer.deposit.enabled === true;

      const cal = ctx.calPct ?? 0;
      out.push({
        id: id("cross-cex", base),
        kind: "cross-cex",
        base,
        legs: [
          { venue: lo.v, side: "buy", symbol: crossSymbol(lo.v, base), price: lo.ask, quote: "USDT" },
          { venue: hi.v, side: "sell", symbol: crossSymbol(hi.v, base), price: hi.bid, quote: "USDT" },
        ],
        grossPct: gross,
        costPct: cost + cal,
        netPct: net - cal,
        // 양쪽 다 USDT 호가라 환산 없이 최우선호가 물량이 곧 USD 한도다.
        notionalCapUsd: topOfBookCapUsd(lo, hi),
        executable: net - cal > 0 && !transfer.blocked && (CONFIG.DRY_RUN || settleable),
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
        // >200% APR spreads are almost always new-listing spikes with no real
        // capturable size — flag + demote instead of headlining the board.
        suspectApr: grossApr > 200,
        // Funding pays only at the settlement snapshot — surface the SHORT
        // leg's next one + both intervals so entries can be timed.
        fundingMeta: { nextTs: hi.nextTs, shortIntervalH: hi.intervalH, longIntervalH: lo.intervalH },
        note: `숏 ${hi.venue}(${hi.intervalH ?? "?"}h${hi.predicted ? "·예측" : ""}) / 롱 ${lo.venue}(${lo.intervalH ?? "?"}h) · 진입 ${roundTripPct.toFixed(2)}% · 손익분기 ${breakEvenDays < 99 ? breakEvenDays.toFixed(1) + "일" : "—"} · 감쇠반영(반감 ${FUNDING_HALF_DAYS}일)${entryBasisPct > 0.01 ? ` · 진입베이시스 ${entryBasisPct.toFixed(2)}%` : (hiMark && loMark ? " · 베이시스 유리" : " · 베이시스 미확인")}`,
        ts: now(),
      });
    }
    // Suspect spikes sink below normal rows regardless of APR.
    out.sort((a, b) => (a.suspectApr ? 1 : 0) - (b.suspectApr ? 1 : 0) || b.netPct - a.netPct);
    return out.slice(0, 20);
  },
};

// ── CEX-DEX — CEX price vs on-chain DEX (OKX aggregator routing) ───────────────
// TRANSFER-style arb: buy the cheap side, move the coin, sell the expensive
// side — buyDex = DEX 매수 → 지갑→바낸 전송 → 매도 / sellDex = 바낸 매수 →
// 출금 → DEX 매도. Costs therefore include the transfer leg (token-send gas or
// CEX withdraw fee) and the edge carries in-flight price risk (ETA + hedge,
// applied by the scanner like kimchi). Hard gates: Binance deposit/withdraw
// open for THIS coin on THIS chain, and the Binance transfer network must be
// the same chain we quoted on. Dormant without OKX_WEB3_* keys.
const DEXDEX_REF_USD = 2000; // quote size — gas% and depth are size-dependent
const CEXDEX_TTL_MS = 60_000; // OKX web3 rate limits — refresh once a minute
const CEXDEX_MEV_PCT = 0.1; // sandwich/re-quote buffer
const CEXDEX_SEND_GAS = 65_000; // ERC20 transfer 가스 (지갑→거래소 입금 전송)
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

    // 유니버스 = 하드코딩 + (OKX 토큰리스트 ∩ 바낸 상장, 볼륨 상위) 로테이션.
    // 전 종목을 매 스윕 견적하면 레이트 리밋이 터지므로 동적 후보는 회전창으로
    // 사이클당 6개만 — 하드코딩 코어는 항상 포함.
    const universe: Record<string, DexToken> = { ...uni.bases };
    const dynUnverified = new Set<string>();
    if (dexConfigured()) {
      try {
        const dyn = await allTokens(uni.chain);
        const cand: [string, DexToken][] = [];
        for (const [sym, tok] of dyn) {
          if (!tok || universe[sym]) continue;
          if (sym === uni.quote.symbol || sym === "USDT" || sym === "USDC" || sym === "DAI") continue;
          const t = bnb.get(sym);
          if (!t?.bid || !t?.ask || t.quoteVolumeUsd < CONFIG.MIN_VOLUME_USD * 5) continue;
          cand.push([sym, tok]);
        }
        cand.sort((a, b) => (bnb.get(b[0])?.quoteVolumeUsd ?? 0) - (bnb.get(a[0])?.quoteVolumeUsd ?? 0));
        const gRot = globalThis as unknown as { __cexdexRot?: Record<string, number> };
        gRot.__cexdexRot ??= {};
        const ptr = gRot.__cexdexRot[uni.chain] ?? 0;
        // 심볼 일치만으로는 바낸의 코인과 DEX 토큰이 같다는 보장이 없다(동명
        // 이토큰 함정). OKX 리스트가 이미 중복 심볼을 null로 배제하지만, 한 번
        // 더 온체인 symbol()로 컨트랙트가 실제 그 심볼인지 확인한다 — 불일치=
        // 래핑/스캠 제외, 확인불가=포함하되 unverified 강등. (CoinGecko 대신
        // 온체인 RPC를 써서 상장 순간을 위한 CG 레이트리밋 예산을 보존한다.)
        const picks = Array.from({ length: Math.min(6, cand.length) }, (_, k) => cand[(ptr + k) % cand.length]);
        const checks = await Promise.all(picks.map(async ([sym, tok]) => {
          const onchain = await erc20Symbol(uni.chain, tok.address);
          return { sym, tok, onchain };
        }));
        for (const { sym, tok, onchain } of checks) {
          if (onchain && onchain.toUpperCase() !== sym) continue; // 다른 토큰 확정 → 제외
          universe[sym] = tok;
          if (!onchain) dynUnverified.add(sym); // 확인불가 → 강등
        }
        gRot.__cexdexRot[uni.chain] = cand.length ? (ptr + 6) % cand.length : 0;
      } catch { /* 리스트 실패 → 코어만 */ }
    }

    for (const [base, token] of Object.entries(universe)) {
      const cex = bnb.get(base);
      if (!cex?.bid || !cex?.ask) continue; // CEX doesn't list it (or no book) — skip
      if (cex.quoteVolumeUsd < CONFIG.MIN_VOLUME_USD) continue;
      const mid = (cex.bid + cex.ask) / 2;

      // Two quotes per coin, sequenced gently for the rate limit. Only sleep
      // BETWEEN calls that actually hit the API — the unconditional trailing
      // sleep (including after a null/instant failure, and after the last coin)
      // was pure dead time in a sweep already racing its own 60s TTL.
      const qty = DEXDEX_REF_USD / mid;
      const buyQ = await quoteDex(uni.chain, quoteTok, token, DEXDEX_REF_USD);
      await sleepMs(250);
      const sellQ = await quoteDex(uni.chain, token, quoteTok, qty);

      const cexTaker = FEES.takerPct.binance ?? 0.1;
      // 전송형 공통 게이트 재료: 바낸의 이 코인 입출금 네트워크가 견적 체인과
      // 같아야 루트가 성립한다 (다르면 산 코인을 그 체인으로 못 보낸다).
      const netInfo = coinNetwork(base); // live(바낸 networkList) 우선, 없으면 큐레이션
      // 바낸이 이 코인을 **견적 체인**으로 입출금하는지를 그 체인 행으로 직접 본다.
      // 체인 행이 있으면(키 있음) supported·deposit·withdraw가 그 체인 값이고,
      // 없으면(키 없음) 큐레이션 기본 체인과 견적 체인의 일치 여부로 강등한다.
      const cs = venueChainStatus(ctx.transfers, "binance", base, uni.chain);
      const netChainKey = chainKeyFromLabel(netInfo.chain);
      const chainMatch: boolean | null = cs.supported !== null ? cs.supported : (netChainKey ? netChainKey === uni.chain : null);
      const wStat = cs.deposit === null && cs.withdraw === null ? null : { deposit: cs.deposit === true, withdraw: cs.withdraw === true };
      const etaMin = transferEtaMin(base); // 컨펌 시간 기반 (미상 코인은 내부에서 테이블→기본값 강등)
      const mk = (dir: "buyDex" | "sellDex", grossPct: number, gasUnits: number, dexPrice: number) => {
        // ±8% 넘는 "갭"은 차익이 아니라 죽은 풀이거나 다른 토큰이다 — 행 자체를
        // 만들지 않는다 (메이저 $2000 기준 실제 괴리는 수 % 안에서 소멸).
        if (Math.abs(grossPct) > 8) return;
        const unverified = dynUnverified.has(base);
        const swapGasUsd = gasCostUsd(gasUnits, gasWei, nativeUsd);
        // 전송 다리 비용 — buyDex: 지갑→바낸 토큰 전송 가스 / sellDex: 바낸 출금
        // 수수료(코인 단위 × 가격). 수수료 미상이면 보수적 0.05%p.
        const sendGasUsd = gasCostUsd(CEXDEX_SEND_GAS, gasWei, nativeUsd);
        const wFeeCoin = withdrawFeeCoin(base);
        const wFeePct = wFeeCoin != null ? ((wFeeCoin * mid) / DEXDEX_REF_USD) * 100 : null;
        const transferPct = dir === "buyDex"
          ? (sendGasUsd / DEXDEX_REF_USD) * 100
          : (wFeePct ?? 0.05);
        const gasPct = (swapGasUsd / DEXDEX_REF_USD) * 100;
        const cost = gasPct + transferPct + cexTaker + CEXDEX_MEV_PCT;
        const net = grossPct - cost;
        // 손익분기 규모 — 고정비($: 가스·출금비)와 변동비(%)를 분해해 "이 갭이
        // 흑자가 되는 최소 규모"를 산출. $2000 고정 표기의 착시 제거용.
        const fixedUsd = swapGasUsd + (dir === "buyDex" ? sendGasUsd : (wFeeCoin != null ? wFeeCoin * mid : DEXDEX_REF_USD * 0.0005));
        const propPct = cexTaker + CEXDEX_MEV_PCT;
        const breakevenUsd = grossPct > propPct ? fixedUsd / ((grossPct - propPct) / 100) : null;
        // 방향별 하드 게이트: buyDex는 바낸 "입금" 열림, sellDex는 "출금" 열림.
        const gateOpen: boolean | null = wStat ? (dir === "buyDex" ? wStat.deposit : wStat.withdraw) : null;
        const blocked = gateOpen === false || chainMatch === false;
        const transfer: TransferGate = {
          withdraw: dir === "buyDex"
            ? { venue: "dex" as Venue, enabled: true } // 온체인 매수분은 항상 내 지갑에 있음
            : { venue: "binance" as Venue, enabled: wStat ? wStat.withdraw : null },
          deposit: dir === "buyDex"
            ? { venue: "binance" as Venue, enabled: wStat ? wStat.deposit : null }
            : { venue: "dex" as Venue, enabled: true },
          etaMin, blocked,
          network: { chain: uni.chain, confirms: netInfo.confirms },
        };
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
          transfer,
          // 라이브 실행은 게이트가 "확인된 열림"일 때만 (미상=차단). DRY는 게이트
          // 미상이어도 시뮬 가능하되, 확인된 차단은 DRY에서도 막는다.
          executable: net > 0 && !unverified && !blocked
            && (CONFIG.DRY_RUN || (dexConfigured() && gateOpen === true && chainMatch === true)),
          unverified: unverified || undefined,
          // Stale-quote warning: OKX DEX quote is up to CEXDEX_TTL_MS + sweep old
          // vs ~12s blocks — real dislocations close within 1-2 blocks, so the
          // board edge is indicative only. Age shown so it's never mistaken live.
          note: [
            `${uni.chain} · 전송형 ${dir === "buyDex" ? "DEX매수→바낸입금→매도" : "바낸매수→출금→DEX매도"}`,
            `스왑가스 $${swapGasUsd.toFixed(2)} + ${dir === "buyDex" ? `전송가스 $${sendGasUsd.toFixed(2)}` : `출금수수료 ${wFeePct != null ? wFeePct.toFixed(2) + "%" : "미상(0.05% 가정)"}`}`,
            `ETA ~${etaMin}분(전송 중 가격 노출)`,
            chainMatch === false ? `⚠ 바낸 입출금 체인(${netInfo.chain})과 불일치 — 이 루트 불가` : null,
            gateOpen === false ? `⚠ 바낸 ${dir === "buyDex" ? "입금" : "출금"} 정지` : gateOpen === null ? "입출금 미확인(바낸 키 필요)" : null,
            breakevenUsd != null ? `손익분기 ≥$${Math.ceil(breakevenUsd / 10) * 10}` : "규모 무관 적자",
            `$${DEXDEX_REF_USD} 기준 · 견적 최대 ${Math.round(CEXDEX_TTL_MS / 1000)}s 지연`,
            unverified ? "⚠ 심볼일치만(컨트랙트 미검증) — 수동확인 필요" : null,
          ].filter(Boolean).join(" · "),
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
  return [...bestPer.values()]
    .sort((a, b) => (a.unverified ? 1 : 0) - (b.unverified ? 1 : 0) || b.netPct - a.netPct)
    .slice(0, 15);
}

const cexDex: Strategy = {
  kind: "cex-dex",
  label: "CEX-DEX",
  async scan(ctx) {
    if (!dexConfigured()) return []; // dormant until OKX_WEB3_* keys (mock covers demo)
    const C = gcd.__arbCexDex!;
    // Own TTL: the two-quotes-per-coin sweep is rate-limited (~5s) — refresh at
    // most once a minute, serve the cached batch to every scan in between.
    // 스윕(코인당 0.5s+, CG 검증 포함 수십 초)은 백그라운드로 — 스캔 사이클을
    // 절대 막지 않는다. 그동안은 직전 배치를 서빙. ts는 견적 생성 시각 유지
    // (재도장하면 60s 묵은 견적이 매 스캔 "방금"처럼 보인다).
    if (Date.now() - C.ts > CEXDEX_TTL_MS && !C.busy) {
      C.busy = true;
      scanCexDex(ctx)
        .then((o) => { C.opps = o; C.ts = Date.now(); })
        .catch(() => { /* 다음 주기 재시도 */ })
        .finally(() => { C.busy = false; });
    }
    return C.opps.map((o) => ({ ...o }));
  },
};

export const STRATEGIES: Strategy[] = [kimchi, crossCex, fundingBasis, cexDex];
