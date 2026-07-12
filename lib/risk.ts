// Account-level risk limits — the backstop above per-step safety. Even a
// correctly-executed trade is refused if it breaches size / exposure / daily
// loss caps. Server-authoritative for per-trade size + daily loss; in-flight
// exposure is tracked client-side (the client knows what it launched).
//
// Limits + the daily-PnL tally live on globalThis so every route bundle shares
// one value (Next.js can give each route its own module copy), and so the UI
// can adjust limits at runtime (seeded from env on first load).

export type Limits = {
  maxPerTradeUsd: number;
  maxInFlightUsd: number;
  maxDailyLossUsd: number;
};

const g = globalThis as unknown as {
  __arbRisk?: { limits: Limits; day: string; realizedPnlUsd: number };
};
g.__arbRisk ??= {
  limits: {
    maxPerTradeUsd: Number(process.env.RISK_MAX_PER_TRADE_USD ?? 5000),
    maxInFlightUsd: Number(process.env.RISK_MAX_INFLIGHT_USD ?? 15000),
    maxDailyLossUsd: Number(process.env.RISK_MAX_DAILY_LOSS_USD ?? 500),
  },
  day: "",
  realizedPnlUsd: 0,
};
const S = g.__arbRisk;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function roll() {
  const t = today();
  if (t !== S.day) { S.day = t; S.realizedPnlUsd = 0; }
}

export function getLimits(): Limits {
  return { ...S.limits };
}
/** Update limits at runtime (from the UI). Clamps to non-negative. */
export function setLimits(p: Partial<Limits>): Limits {
  for (const k of ["maxPerTradeUsd", "maxInFlightUsd", "maxDailyLossUsd"] as const) {
    if (typeof p[k] === "number" && Number.isFinite(p[k]) && p[k]! >= 0) S.limits[k] = p[k]!;
  }
  return getLimits();
}

/** Record a settled trade's realized P&L (called from the settle step). */
export function recordPnl(usd: number) {
  roll();
  S.realizedPnlUsd += usd;
}

export function riskState() {
  roll();
  return { day: S.day, realizedPnlUsd: S.realizedPnlUsd, ...S.limits };
}

/** Server gate at trade entry (buy). Returns a reason string if blocked. */
export function checkEntry(sizeUsd: number): string | null {
  roll();
  if (sizeUsd > S.limits.maxPerTradeUsd) {
    return `1회 한도 초과 ($${sizeUsd.toFixed(0)} > $${S.limits.maxPerTradeUsd})`;
  }
  const loss = -S.realizedPnlUsd;
  if (loss >= S.limits.maxDailyLossUsd) {
    return `일일 손실 한도 도달 (−$${loss.toFixed(0)} ≥ $${S.limits.maxDailyLossUsd}) — 오늘 신규 실행 중단`;
  }
  return null;
}
