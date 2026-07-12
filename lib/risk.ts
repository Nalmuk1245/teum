// Account-level risk limits — the backstop above per-step safety. Even a
// correctly-executed trade is refused if it breaches size / exposure / daily
// loss caps. Server-authoritative for per-trade size + daily loss; in-flight
// exposure is tracked client-side (the client knows what it launched).

export const RISK = {
  /** Max notional (USD) for a single trade. */
  maxPerTradeUsd: Number(process.env.RISK_MAX_PER_TRADE_USD ?? 5000),
  /** Max total in-flight (USD) across concurrent runs (client-enforced). */
  maxInFlightUsd: Number(process.env.RISK_MAX_INFLIGHT_USD ?? 15000),
  /** Stop new trades once today's realized loss reaches this (USD, positive). */
  maxDailyLossUsd: Number(process.env.RISK_MAX_DAILY_LOSS_USD ?? 500),
};

// Realized-PnL tally, reset each UTC day. On globalThis so every route bundle
// shares one value (see killswitch.ts for the same reasoning).
type PnlTally = { day: string; realizedPnlUsd: number };
const g = globalThis as unknown as { __arbPnl?: PnlTally };
g.__arbPnl ??= { day: "", realizedPnlUsd: 0 };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function roll() {
  const t = today();
  if (t !== g.__arbPnl!.day) g.__arbPnl = { day: t, realizedPnlUsd: 0 };
}

/** Record a settled trade's realized P&L (called from the settle step). */
export function recordPnl(usd: number) {
  roll();
  g.__arbPnl!.realizedPnlUsd += usd;
}

export function riskState() {
  roll();
  return { ...g.__arbPnl!, ...RISK };
}

/** Server gate at trade entry (buy). Returns a reason string if blocked. */
export function checkEntry(sizeUsd: number): string | null {
  roll();
  if (sizeUsd > RISK.maxPerTradeUsd) {
    return `1회 한도 초과 ($${sizeUsd.toFixed(0)} > $${RISK.maxPerTradeUsd})`;
  }
  const loss = -g.__arbPnl!.realizedPnlUsd;
  if (loss >= RISK.maxDailyLossUsd) {
    return `일일 손실 한도 도달 (−$${loss.toFixed(0)} ≥ $${RISK.maxDailyLossUsd}) — 오늘 신규 실행 중단`;
  }
  return null;
}
