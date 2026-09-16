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
import { estimateLegSlippage } from "./quote";
import {
  binanceLimitSell, binanceOrderFills, binanceCancelOrder,
  upbitLimitSell, upbitOrderFills, upbitCancelOrder,
  binanceSpot, upbitOrder, binancePerp, roundQty,
} from "./orders";
import { acquireSellWait, releaseSell, renewSell } from "./sellLock";

export type UnwindResult = {
  soldQty: number; // coins sold this call
  hedgeClosedQty: number; // short closed (= soldQty, delta-neutral)
  achievedNetPct: number; // realized net premium for this chunk
  pnlUsd: number;
  remainingQty: number; // after this unwind
  dryRun: boolean;
  log: string[];
};

// Floor must sit ABOVE the round-trip cost — market-dumping below cost
// crystallizes a guaranteed loss and books it as an "orderly" exit. Below the
// floor the right move is usually to HOLD hedged (delta-neutral) instead.
const FLOOR_BUFFER_PCT = 0.1;
// Exiting only costs what is still AHEAD of us. By unwind time the buy taker,
// the on-chain transfer fee and the inbound FX are already spent — charging the
// full round-trip made the floor ~2-3x too high, so the loop refused to sell at
// premiums where selling was genuinely profitable and left the position carrying
// funding + FX risk instead. Marginal exit cost ≈ sell taker + repatriation.
const EXIT_COST_SHARE = 0.45; // of the round-trip cost model
const exitCostPct = (roundTripPct: number) => Math.max(0, roundTripPct) * EXIT_COST_SHARE;
const premiumFloor = (costPct: number) => exitCostPct(costPct) + FLOOR_BUFFER_PCT;
const REPEG_HAIRCUT = 0.15; // premium given up on the re-peg tranche (sim)
const ROUNDS = 3; // limit → re-peg → re-peg, then market fallback
const POLL_MS = 2000;
const POLLS_PER_ROUND = 6; // ~12s per round

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function unwind(opp: Opportunity, remainingQty: number, fractionIn: number): Promise<UnwindResult> {
  const dry = CONFIG.DRY_RUN;
  const fraction = Math.min(1, Math.max(0, fractionIn)); // (0,1] — never over-sell or negative
  if (!dry) {
    // 매도 뮤텍스 — 청산도 매도다. 자동매도 트리거나 실행 엔진의 매도 다리와
    // 같은 (거래소, 코인)을 동시에 던지면 하나가 거절되고, 이미 비례 숏청산이
    // 진행된 뒤라면 델타가 깨진 채 남는다. 락은 라운드마다 renew하며 잡는다.
    const sellVenue = opp.legs.find((l) => l.side === "sell")?.venue;
    if (!sellVenue) throw new Error("매도 다리 없음");
    const owner = `unwind:${opp.id}:${Math.round(fraction * 100)}`;
    if (!(await acquireSellWait(sellVenue, opp.base, owner, 5000))) {
      throw new Error(`${opp.base} ${sellVenue}를 다른 매도자가 처리 중 — 잠시 후 다시 시도`);
    }
    try {
      return await liveUnwind(opp, remainingQty, fraction, owner);
    } finally {
      releaseSell(sellVenue, opp.base, owner);
    }
  }

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
  const p2 = Math.max(gross - REPEG_HAIRCUT, premiumFloor(cost));
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
// the live premium decays under the cost floor) the loop stops and advises holding hedged.
async function liveUnwind(opp: Opportunity, remainingQty: number, fractionIn: number, lockOwner: string): Promise<UnwindResult> {
  const fraction = Math.min(1, Math.max(0, fractionIn));
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
    // 거래소가 보고한 체결량만 인정한다 — 요청 수량을 그대로 더하면 부분 체결에서
    // hedgeClosed가 과대해지고, 엔진이 이 값으로 hedgeQty를 줄이므로 잔여 숏이
    // 장부에서 사라진다(시장가 폴백에 이미 있던 원칙을 여기에도).
    const closed = r.ok ? (r.filledQty && r.filledQty > 0 ? r.filledQty : 0) : 0;
    if (closed > 0) hedgeClosed += closed;
    log.push(
      !r.ok ? `숏 청산 실패: ${r.message} — 수동 확인`
      : closed > 0 ? `숏 ${closed.toFixed(4)} 비례 청산${closed < qty ? ` (요청 ${qty.toFixed(4)} 중 부분)` : ""}`
      : `숏 청산 접수됐으나 체결량 미확인 — 선물 포지션 직접 확인`,
    );
  };

  // Realized numbers for whatever has been sold SO FAR — shared by the normal
  // return and the early "hold hedged" abort (which used to report 0/0 and
  // silently drop the P&L of rounds that had already filled).
  const settleNumbers = () => {
    if (!(sold > 0) || !usdtLeg || !(proceeds > 0)) {
      return { soldQty: sold, hedgeClosedQty: hedgeClosed, achievedNetPct: 0, pnlUsd: 0 };
    }
    const avgQuote = proceeds / sold;
    const avgUsd = sellLeg.quote === "KRW" ? avgQuote / (settleFx || 1) : avgQuote;
    if (!(avgUsd > 0) || (sellLeg.quote === "KRW" && !settleFx)) {
      return { soldQty: sold, hedgeClosedQty: hedgeClosed, achievedNetPct: 0, pnlUsd: 0 };
    }
    const grossPct = ((avgUsd - usdtLeg.price) / usdtLeg.price) * 100;
    const net = grossPct - exitCostPct(opp.costPct ?? 0);
    return {
      soldQty: sold, hedgeClosedQty: hedgeClosed,
      achievedNetPct: net, pnlUsd: (net / 100) * sold * usdtLeg.price,
    };
  };
  // FX for settlement, fetched once when first needed.
  let settleFx = 0;
  if (sellLeg.quote === "KRW") settleFx = (await fetchUsdKrw(venue)) ?? 0;

  // Current gross premium of this route (for the floor check). Only meaningful
  // for KRW legs; USDT legs use 0-floor (no premium concept).
  const livePremium = async (): Promise<number | null> => {
    if (sellLeg.quote !== "KRW" || !usdtLeg) return null;
    const [book, fx] = await Promise.all([ad.fetchOrderBook!(sellLeg.symbol), fetchUsdKrw(venue)]);
    const bid = book.bids[0]?.price;
    if (!bid || !fx) return null;
    return ((bid / fx - usdtLeg.price) / usdtLeg.price) * 100;
  };

  // Authoritative fill read for the order we currently have working. Returns
  // null only when the venue could not be reached at all.
  const readFills = async (orderId: string) =>
    venue === "binance" ? await binanceOrderFills(opp.base, orderId) : await upbitOrderFills(orderId);

  // `bailout` = we have an order in an UNKNOWN state (poll blackout or a cancel
  // we could not confirm). Anything further — another limit, or the market
  // fallback — risks selling a quantity that order already sold. Stop touching
  // the position and hand it to a human.
  let bailout: string | null = null;

  let left = targetQty;
  for (let round = 1; round <= ROUNDS && left > 0 && !bailout; round++) {
    // 락 갱신 — 한 라운드가 ~12초라 갱신하지 않으면 STALE_MS(30s)를 넘겨,
    // 아직 팔고 있는 중에 락이 다른 매도자에게 넘어간다.
    renewSell(venue, opp.base, lockOwner);
    // Premium floor — stop chasing a decaying edge, dump at market instead.
    const prem = await livePremium();
    const floor = premiumFloor(opp.costPct ?? 0.5);
    if (prem !== null && prem < floor) {
      // Below cost: dumping locks in a loss. Stop the loop and tell the
      // operator to hold hedged instead of crystallizing negative net.
      log.push(`프리미엄 ${prem.toFixed(2)}% < 손익분기 ${floor.toFixed(2)}% — 청산 중단, 헷지 유지 권장 (지금 팔면 확정 손실)`);
      // Report what THIS call actually realized. Returning 0/0 here discarded
      // the P&L of rounds that had already filled.
      return { ...settleNumbers(), remainingQty: Math.max(0, remainingQty - sold), dryRun: false, log };
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
      const f = await readFills(placed.id);
      if (!f) continue;
      fin = f; // quoteFilled/filledQty are cumulative PER ORDER
      if (!f.open) break; // fully filled or closed
    }

    // ALWAYS resolve the order before doing anything else. Previously a round
    // where every poll failed left `fin === null`, so `fin?.open` was falsy, the
    // cancel was skipped, and the next round posted a SECOND limit sell for the
    // same quantity while the first was still live — up to 3 stacked orders plus
    // a market fallback, i.e. multiples of the intended size sold.
    if (!fin || fin.open) {
      const cancelled = venue === "binance"
        ? await binanceCancelOrder(opp.base, placed.id)
        : await upbitCancelOrder(placed.id);
      // Re-read AFTER the cancel regardless of its result: fills that land in
      // the window between the last poll and the cancel were previously counted
      // as unsold and then sold again.
      const after = await readFills(placed.id);
      if (after) {
        fin = after;
      } else if (!cancelled) {
        // Unknown state and we could not cancel → do not touch the position.
        bailout = `R${round} 주문 상태 불명(조회·취소 모두 실패) — 거래소에서 직접 확인 후 수동 처리`;
      } else {
        bailout = `R${round} 취소는 됐지만 체결량 조회 실패 — 중복 매도 방지를 위해 중단, 수동 확인`;
      }
      if (!bailout) {
        log.push(cancelled ? `R${round} 취소 → 리페그` : `R${round} 취소 실패(이미 종료된 주문일 수 있음) — 체결량 재확인으로 처리`);
      }
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
    if (bailout) log.push(bailout);
  }

  // Market fallback for whatever's left (timeout or floor hit). NEVER when the
  // working order's state is unknown — this used to run even after the loop
  // `break`, which is exactly the double-sell the break was meant to prevent.
  if (left > 0 && !bailout) {
    // Same slippage discipline as the normal sell leg: a market dump into a
    // broken book can cost more than holding the (hedged) position.
    // fail-closed — 호가 조회가 실패하면 시장가를 안 낸다. 예전엔 `.catch(() => null)`로
    // 게이트를 건너뛰고 덤프했다: 모르는 책에 시장가는 상한 없는 슬리피지다.
    let est: Awaited<ReturnType<typeof estimateLegSlippage>> | "unavailable";
    try { est = await estimateLegSlippage(venue, sellLeg.symbol, "sell", { baseQty: left }); }
    catch { est = "unavailable"; }
    if (est === "unavailable") {
      log.push(`시장가 보류 — 호가 조회 실패 · 잔량 ${left.toFixed(4)} 헷지 유지로 보유 (모르는 호가에 시장가 안 냄)`);
    } else if (est && (est.slipPct > CONFIG.MAX_SLIPPAGE_PCT || !est.filled)) {
      log.push(`시장가 보류 — 예상 슬리피지 ${est.slipPct.toFixed(2)}% > 상한 ${CONFIG.MAX_SLIPPAGE_PCT}% · 잔량 ${left.toFixed(4)} 헷지 유지로 보유`);
    } else {
      const r = venue === "binance"
        ? await binanceSpot(opp.base, "SELL", { qty: left })
        : await upbitOrder(opp.base, "ask", { volume: left });
      if (r.ok) {
        // Only credit what the venue actually reports. Assuming a full fill
        // (`?? left`) over-closed the hedge when the fill was partial.
        const q = r.filledQty && r.filledQty > 0 ? r.filledQty : null;
        if (q == null) {
          log.push(`시장가 매도됨(체결량 미확인) — 수동 확인 필요, 잔량/헷지 보정 필요`);
        } else {
          sold += q;
          if (r.quoteFilled) proceeds += r.quoteFilled;
          log.push(`잔량 ${q.toFixed(4)} 시장가 매도`);
          await closeHedge(venue === "binance" ? await roundQty("perp", `${opp.base}USDT`, q) : q);
          left = Math.max(0, targetQty - sold);
        }
      } else {
        log.push(`시장가 매도 실패: ${r.message} — 잔량 ${left.toFixed(4)} 수동 처리`);
      }
    }
  }

  // Realized numbers — marginal exit cost, not the full round trip (see exitCostPct).
  const final = settleNumbers();
  if (final.soldQty > 0 && final.achievedNetPct !== 0) {
    log.push(`실현 순(한계비용 기준) ${final.achievedNetPct >= 0 ? "+" : ""}${final.achievedNetPct.toFixed(2)}%`);
  }
  const newRemaining = Math.max(0, remainingQty - sold);
  log.push(`청산 완료 — 매도 ${sold.toFixed(4)} · 숏청산 ${hedgeClosed.toFixed(4)} · 남은 물량 ${newRemaining.toFixed(4)}`);
  if (bailout) log.push(`⚠ ${bailout}`);
  return { ...final, remainingQty: newRemaining, dryRun: false, log };
}
