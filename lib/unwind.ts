// Smart unwind — partial position exit (남은 물량 기준). For a chosen fraction of
// the remaining position: post a limit sell near the top of book, poll fills,
// cancel-and-re-peg when it doesn't fill, take the market as a floor/timeout
// fallback, and close the Binance short in proportion to each round's fills
// (stay delta-neutral throughout).
//
// DRY-RUN: the loop is SIMULATED (partial fill at target + re-peg for the rest).
// LIVE: real limit orders on Binance spot / Upbit (bithumb leg not wired).

import type { Opportunity } from "./types";
import { CONFIG } from "./config";
import { getAdapter, fetchUsdKrw } from "./exchanges";
import {
  binanceLimitSell, binanceOrderFills, binanceCancelOrder,
  upbitLimitSell, upbitOrderFills, upbitCancelOrder,
  binanceSpot, upbitOrder, binancePerp, roundQty,
} from "./orders";

export type UnwindResult = {
  soldQty: number; // coins sold this call
  hedgeClosedQty: number; // short closed (= soldQty, delta-neutral)
  achievedNetPct: number; // realized net premium for this chunk
  pnlUsd: number;
  remainingQty: number; // after this unwind
  dryRun: boolean;
  log: string[];
};

const PREMIUM_FLOOR = 0.2; // below this, stop chasing — take the market
const REPEG_HAIRCUT = 0.15; // premium given up on the re-peg tranche (sim)
const ROUNDS = 3; // limit → re-peg → re-peg, then market fallback
const POLL_MS = 2000;
const POLLS_PER_ROUND = 6; // ~12s per round

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function unwind(opp: Opportunity, remainingQty: number, fraction: number): Promise<UnwindResult> {
  const dry = CONFIG.DRY_RUN;
  if (!dry) return liveUnwind(opp, remainingQty, fraction);

  const price = opp.legs.find((l) => l.quote === "USDT")?.price ?? 0;
  const gross = opp.grossPct ?? 0; // target premium (live re-quotes)
  const cost = opp.costPct ?? 0.5;
  const targetQty = Math.min(remainingQty, remainingQty * fraction);

  // ── Simulated layered exit ──────────────────────────────────────────────────
  // 1) limit at target premium fills ~60%; 2) re-peg fills the rest a touch lower
  //    (floored). Proportional short close on every fill.
  const q1 = targetQty * 0.6;
  const q2 = targetQty - q1;
  const p1 = gross;
  const p2 = Math.max(gross - REPEG_HAIRCUT, PREMIUM_FLOOR);
  const achievedGross = targetQty > 0 ? (p1 * q1 + p2 * q2) / targetQty : 0;
  const achievedNet = achievedGross - cost;
  const pnlUsd = (achievedNet / 100) * (targetQty * price);
  const newRemaining = Math.max(0, remainingQty - targetQty);

  const log = [
    `목표가 지정가 매도 ${(fraction * 100).toFixed(0)}% (${targetQty.toFixed(4)}) → ${(q1 / targetQty * 100).toFixed(0)}% 체결 @${p1.toFixed(2)}%`,
    `미체결분 리페그 → ${(q2 / targetQty * 100).toFixed(0)}% 체결 @${p2.toFixed(2)}%`,
    `Binance 숏 ${targetQty.toFixed(4)} 비례 청산 (델타 중립)`,
    `실현 순수익 ${achievedNet >= 0 ? "+" : ""}${achievedNet.toFixed(2)}% (${pnlUsd >= 0 ? "+" : "−"}$${Math.abs(pnlUsd).toFixed(2)})`,
    `남은 물량 ${newRemaining.toFixed(4)} (${remainingQty > 0 ? ((newRemaining / remainingQty) * 100).toFixed(0) : 0}% 이월)`,
  ];

  return {
    soldQty: targetQty, hedgeClosedQty: targetQty,
    achievedNetPct: achievedNet, pnlUsd, remainingQty: newRemaining, dryRun: dry, log,
  };
}

// ── LIVE loop ─────────────────────────────────────────────────────────────────
// Round: read the book → post a limit at the best ask (maker, top of queue side)
// → poll fills, closing the short in proportion after each round → if still open
// at round timeout, cancel and re-peg at the fresh best ask. After ROUNDS (or if
// the live premium decays under PREMIUM_FLOOR) the remainder goes market.
async function liveUnwind(opp: Opportunity, remainingQty: number, fraction: number): Promise<UnwindResult> {
  const sellLeg = opp.legs.find((l) => l.side === "sell");
  const usdtLeg = opp.legs.find((l) => l.quote === "USDT");
  if (!sellLeg) throw new Error("매도 다리 없음");
  const venue = sellLeg.venue;
  if (venue !== "binance" && venue !== "upbit") {
    throw new Error(`${venue} 지정가 청산 미배선 — 수동 처리 필요`);
  }
  const ad = getAdapter(venue);
  if (!ad?.fetchOrderBook) throw new Error(`${venue} 오더북 없음`);

  const log: string[] = [];
  let sold = 0; // base filled so far
  let proceeds = 0; // quote received so far (venue currency)
  let hedgeClosed = 0;
  const targetQty = venue === "binance"
    ? await roundQty("spot", `${opp.base}USDT`, Math.min(remainingQty, remainingQty * fraction))
    : Math.min(remainingQty, remainingQty * fraction);
  if (targetQty <= 0) throw new Error("청산 수량 0");

  // Proportional short close for this round's fills — delta-neutral per spec.
  const closeHedge = async (qty: number) => {
    if (qty <= 0 || !opp.hasPerp) return;
    const r = await binancePerp(opp.base, "CLOSE", qty);
    if (r.ok) hedgeClosed += qty;
    log.push(r.ok ? `숏 ${qty.toFixed(4)} 비례 청산` : `숏 청산 실패: ${r.message} — 수동 확인`);
  };

  // Current gross premium of this route (for the floor check). Only meaningful
  // for KRW legs; USDT legs use 0-floor (no premium concept).
  const livePremium = async (): Promise<number | null> => {
    if (sellLeg.quote !== "KRW" || !usdtLeg) return null;
    const [book, fx] = await Promise.all([ad.fetchOrderBook!(sellLeg.symbol), fetchUsdKrw(venue)]);
    const bid = book.bids[0]?.price;
    if (!bid || !fx) return null;
    return ((bid / fx - usdtLeg.price) / usdtLeg.price) * 100;
  };

  let left = targetQty;
  for (let round = 1; round <= ROUNDS && left > 0; round++) {
    // Premium floor — stop chasing a decaying edge, dump at market instead.
    const prem = await livePremium();
    if (prem !== null && prem < PREMIUM_FLOOR) {
      log.push(`프리미엄 ${prem.toFixed(2)}% < 바닥 ${PREMIUM_FLOOR}% — 시장가 전환`);
      break;
    }

    const book = await ad.fetchOrderBook(sellLeg.symbol);
    const ask = book.asks[0]?.price;
    if (!ask) { log.push("호가 없음 — 시장가 전환"); break; }

    const placed = venue === "binance"
      ? await binanceLimitSell(opp.base, left, ask)
      : await upbitLimitSell(opp.base, left, ask);
    if (!placed.ok || !placed.id) {
      log.push(`지정가 등록 실패(${placed.message}) — 시장가 전환`);
      break;
    }
    log.push(`R${round} 지정가 매도 ${left.toFixed(4)} @${ask}${prem !== null ? ` (프리미엄 ${prem.toFixed(2)}%)` : ""}`);

    const roundStartSold = sold;
    const roundStartProceeds = proceeds;
    let fin: { filledQty: number; quoteFilled: number; open: boolean } | null = null;
    for (let i = 0; i < POLLS_PER_ROUND; i++) {
      await sleep(POLL_MS);
      const f = venue === "binance"
        ? await binanceOrderFills(opp.base, placed.id)
        : await upbitOrderFills(placed.id);
      if (!f) continue;
      fin = f; // quoteFilled/filledQty are cumulative PER ORDER
      if (!f.open) break; // fully filled or closed
    }
    if (fin) {
      sold = roundStartSold + fin.filledQty;
      proceeds = roundStartProceeds + fin.quoteFilled;
    }

    const roundFilled = sold - roundStartSold;
    if (roundFilled > 0) {
      log.push(`R${round} 체결 ${roundFilled.toFixed(4)} / ${left.toFixed(4)}`);
      await closeHedge(venue === "binance" ? await roundQty("perp", `${opp.base}USDT`, roundFilled) : roundFilled);
    }
    left = Math.max(0, targetQty - sold);
    if (left > 0 && fin?.open) {
      const cancelled = venue === "binance"
        ? await binanceCancelOrder(opp.base, placed.id)
        : await upbitCancelOrder(placed.id);
      log.push(cancelled ? `R${round} 잔량 ${left.toFixed(4)} 취소 → 리페그` : `R${round} 취소 실패 — 수동 확인 필요`);
      if (!cancelled) break; // don't double-sell into an order we couldn't cancel
    }
  }

  // Market fallback for whatever's left (timeout or floor hit).
  if (left > 0) {
    const r = venue === "binance"
      ? await binanceSpot(opp.base, "SELL", { qty: left })
      : await upbitOrder(opp.base, "ask", { volume: left });
    if (r.ok) {
      const q = r.filledQty ?? left;
      sold += q;
      if (r.quoteFilled) proceeds += r.quoteFilled;
      log.push(`잔량 ${q.toFixed(4)} 시장가 매도`);
      await closeHedge(venue === "binance" ? await roundQty("perp", `${opp.base}USDT`, q) : q);
      left = Math.max(0, targetQty - sold);
    } else {
      log.push(`시장가 매도 실패: ${r.message} — 잔량 ${left.toFixed(4)} 수동 처리`);
    }
  }

  // Realized numbers — approximate premium vs the (scan-time) USDT leg.
  let achievedNet = 0, pnlUsd = 0;
  if (sold > 0 && usdtLeg) {
    const fx = sellLeg.quote === "KRW" ? await fetchUsdKrw(venue) : 1;
    const avgUsd = fx ? (proceeds > 0 ? proceeds / sold / (sellLeg.quote === "KRW" ? fx : 1) : 0) : 0;
    if (avgUsd > 0) {
      const grossPct = ((avgUsd - usdtLeg.price) / usdtLeg.price) * 100;
      achievedNet = grossPct - (opp.costPct ?? 0);
      pnlUsd = ((achievedNet / 100) * sold * usdtLeg.price);
      log.push(`실현 프리미엄 ${grossPct >= 0 ? "+" : ""}${grossPct.toFixed(2)}% · 순 ${achievedNet >= 0 ? "+" : ""}${achievedNet.toFixed(2)}%`);
    }
  }

  const newRemaining = Math.max(0, remainingQty - sold);
  log.push(`청산 완료 — 매도 ${sold.toFixed(4)} · 숏청산 ${hedgeClosed.toFixed(4)} · 남은 물량 ${newRemaining.toFixed(4)}`);
  return {
    soldQty: sold, hedgeClosedQty: hedgeClosed,
    achievedNetPct: achievedNet, pnlUsd, remainingQty: newRemaining, dryRun: false, log,
  };
}
