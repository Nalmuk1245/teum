// Smart unwind — partial position exit (남은 물량 기준). For a chosen fraction of
// the remaining position: post a limit sell at the target premium, re-peg toward
// the market if it doesn't fill, fall back at a premium floor / timeout, and
// close the Binance short in proportion to each fill (stay delta-neutral).
//
// DRY-RUN: the loop is SIMULATED (partial fill at target + re-peg for the rest)
// so the whole flow is testable. Live wiring (limit orders + fill polling +
// cancel/re-peg + proportional close) is TODO — needs local testing.

import type { Opportunity } from "./types";
import { CONFIG } from "./config";

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

export async function unwind(opp: Opportunity, remainingQty: number, fraction: number): Promise<UnwindResult> {
  const dry = CONFIG.DRY_RUN;
  // Live unwind loop (limit order + fill polling + re-peg + proportional close)
  // is NOT wired yet — returning simulated fills in live mode would leave a real
  // naked position while the UI shows "청산 완료". Hard-block until wired.
  if (!dry) {
    throw new Error("라이브 청산 루프 미배선 — DRY_RUN에서만 사용 가능");
  }
  const price = opp.legs.find((l) => l.venue === "binance")?.price ?? 0;
  const gross = opp.grossPct ?? 0; // target premium (live would re-quote)
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
  if (!dry) log.unshift("⚠️ 라이브 청산 루프 미배선 — 현재 시뮬레이션 결과");

  return {
    soldQty: targetQty, hedgeClosedQty: targetQty,
    achievedNetPct: achievedNet, pnlUsd, remainingQty: newRemaining, dryRun: dry, log,
  };
}
