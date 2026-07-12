// Execution engine — the "one-click" of semi-auto. Given an opportunity and a
// size, it places each leg via the venue adapters. Hard-gated behind
// CONFIG.DRY_RUN: while true (default), it only SIMULATES fills so the whole
// flow is testable without risking capital.

import type { ExecReport, Opportunity, OrderRequest, OrderResult } from "./types";
import { CONFIG } from "./config";
import { getAdapter } from "./exchanges";

export async function executeOpportunity(
  opp: Opportunity,
  sizeUsd: number,
): Promise<ExecReport> {
  const dryRun = CONFIG.DRY_RUN;
  const legs: OrderResult[] = [];

  for (const leg of opp.legs) {
    const req: OrderRequest = {
      venue: leg.venue,
      side: leg.side,
      symbol: leg.symbol,
      quoteAmount: sizeUsd, // TODO: convert per-leg quote (KRW) + split by depth
    };

    if (dryRun) {
      legs.push({
        venue: leg.venue,
        side: leg.side,
        symbol: leg.symbol,
        status: "simulated",
        filledPrice: leg.price,
        message: "DRY_RUN — no order sent",
      });
      continue;
    }

    const adapter = getAdapter(leg.venue);
    if (!adapter) {
      legs.push({
        venue: leg.venue, side: leg.side, symbol: leg.symbol,
        status: "rejected", filledPrice: null, message: "no adapter",
      });
      continue;
    }
    try {
      legs.push(await adapter.placeOrder(req));
    } catch (e) {
      legs.push({
        venue: leg.venue, side: leg.side, symbol: leg.symbol,
        status: "rejected", filledPrice: null,
        message: e instanceof Error ? e.message : "order failed",
      });
    }
  }

  const ok = legs.every((l) => l.status === "filled" || l.status === "simulated");
  return {
    oppId: opp.id,
    base: opp.base,
    dryRun,
    sizeUsd,
    legs,
    realizedNetPct: ok ? opp.netPct : null, // TODO: compute from real fills
    ok,
    ts: Date.now(),
  };
}
