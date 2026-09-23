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

import { loadSection, saveSection, flushSection } from "./persist";

/** 미실현 손익 스냅샷 (lib/unrealized가 15초마다 채운다). */
export type Unrealized = { pnlUsd: number; lossUsd: number; openNotionalUsd: number; runsNotionalUsd: number; positions: number; unpriced: number; at: number };
const g = globalThis as unknown as {
  __arbRisk?: { limits: Limits; day: string; realizedPnlUsd: number; unrealized?: Unrealized };
};
const persisted = loadSection<{ day: string; realizedPnlUsd: number }>("riskPnl");
// UI에서 바꾼 한도는 재시작을 넘긴다. 예전엔 메모리에만 있어서 pm2가 재시작하면
// env 초기값으로 돌아갔다 — 사고 중에 1회 한도를 $100으로 낮췄다가 재시작되면
// $5,000으로 복귀했다. 킬 스위치·일일손실 집계는 이미 영속인데 한도만 빠져 있었다.
// 우선순위는 secrets.json과 같다: 저장된 값 > env(초기값).
const persistedLimits = loadSection<Partial<Limits>>("riskLimits");
g.__arbRisk ??= {
  limits: {
    maxPerTradeUsd: persistedLimits?.maxPerTradeUsd ?? Number(process.env.RISK_MAX_PER_TRADE_USD ?? 5000),
    maxInFlightUsd: persistedLimits?.maxInFlightUsd ?? Number(process.env.RISK_MAX_INFLIGHT_USD ?? 15000),
    maxDailyLossUsd: persistedLimits?.maxDailyLossUsd ?? Number(process.env.RISK_MAX_DAILY_LOSS_USD ?? 500),
  },
  day: persisted?.day ?? "",
  realizedPnlUsd: persisted?.realizedPnlUsd ?? 0,
};
const S = g.__arbRisk;

// The daily-loss window rolls at KST midnight, not UTC. `toISOString()` is UTC,
// so for a Korea-operated tool the limit reset landed at 09:00 local — in the
// middle of the trading morning, wiping the day's loss tally right when it
// mattered. Overridable for anyone running elsewhere.
const DAY_TZ = process.env.RISK_DAY_TZ || "Asia/Seoul";
const DAY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: DAY_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
function today(): string {
  return DAY_FMT.format(new Date()); // en-CA → YYYY-MM-DD
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
  // flush — 한도를 낮추는 건 대개 사고 중이고, 그 직후 크래시가 정확히 이 값이
  // 필요한 순간이다.
  flushSection("riskLimits", { ...S.limits });
  return getLimits();
}

/** Record a settled trade's realized P&L (called from the settle step). */
export function recordPnl(usd: number) {
  roll();
  S.realizedPnlUsd += usd;
  // flush, not the 30s debounce: a crash right after a large loss is exactly
  // when the tally matters, and losing it resets the daily-loss cap.
  flushSection("riskPnl", { day: S.day, realizedPnlUsd: S.realizedPnlUsd }); // daily-loss limit survives restarts
}

/** 이보다 낡은 미실현 스냅샷은 쓰지 않는다 — 루프가 죽었는데 옛 손실로 진입을 영원히 막으면 안 된다. */
const UNREAL_STALE_MS = 5 * 60_000;
export function setUnrealized(u: Unrealized) { S.unrealized = u; }
function freshUnrealized(): Unrealized | null {
  const u = S.unrealized;
  return u && Date.now() - u.at < UNREAL_STALE_MS ? u : null;
}
export function riskState() {
  roll();
  const u = freshUnrealized();
  return { day: S.day, realizedPnlUsd: S.realizedPnlUsd, ...S.limits, unrealizedPnlUsd: u?.pnlUsd ?? null, unrealizedLossUsd: u?.lossUsd ?? null, openNotionalUsd: u?.openNotionalUsd ?? null, unpricedPositions: u?.unpriced ?? 0 };
}

/** Server gate at trade entry (buy). Returns a reason string if blocked.
 *  `opts.listing`: 상장 매수 — 실행 엔진의 노출 한도 검사를 거치지 않으므로 여기서 본다.
 *
 *  일일 손실 = 실현 손실 + **미실현 손실**. 예전엔 실현만 봐서, 전송 중 급락으로 −$400 물린
 *  런이 있어도 한도 $500이면 신규 진입이 그대로 나갔다 — 손실이 겹치는 가장 나쁜 순간에. */
export function checkEntry(sizeUsd: number, opts?: { listing?: boolean }): string | null {
  roll();
  if (sizeUsd > S.limits.maxPerTradeUsd) {
    return `1회 한도 초과 ($${sizeUsd.toFixed(0)} > $${S.limits.maxPerTradeUsd})`;
  }
  const u = freshUnrealized();
  const realizedLoss = Math.max(0, -S.realizedPnlUsd);
  const unrealLoss = u?.lossUsd ?? 0;
  const loss = realizedLoss + unrealLoss;
  if (loss >= S.limits.maxDailyLossUsd) {
    return `일일 손실 한도 도달 (실현 −$${realizedLoss.toFixed(0)}${unrealLoss > 0 ? ` + 미실현 −$${unrealLoss.toFixed(0)}` : ""} ≥ $${S.limits.maxDailyLossUsd}) — 신규 실행 중단`;
  }
  if (opts?.listing && u && Number.isFinite(S.limits.maxInFlightUsd) && S.limits.maxInFlightUsd > 0 && u.openNotionalUsd + sizeUsd > S.limits.maxInFlightUsd) {
    return `총 노출 한도 초과 (보유 $${u.openNotionalUsd.toFixed(0)} + $${sizeUsd.toFixed(0)} > $${S.limits.maxInFlightUsd.toFixed(0)})`;
  }
  return null;
}
