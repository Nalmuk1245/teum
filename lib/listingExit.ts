// 상장따리 자동 청산 — 산 코인을 언제 파나.
//
// 공지 자동매수는 사기만 했다. 상장 펌프는 몇 분~몇십 분 안에 꺼지는 게 보통이라(히스토리
// 도달 시간 중앙값 수십 분), 사람이 보고 있지 않으면 올라갔다 내려온 뒤에야 판다.
// 규칙 다섯 가지 중 **먼저 걸리는 것**으로 판다 (전량, 매수한 해외 거래소에서 시장가):
//
//   1) 손절       — 진입가 대비 −SL%
//   2) 익절       — 진입가 대비 +TP%
//   3) 트레일링   — 진입 후 최고가 대비 −TRAIL% (단 최고가가 진입가 위일 때만 — 한 번도
//                  수익권에 못 간 포지션은 손절 규칙이 맡는다)
//   4) 개장 후 N분 — 국내 거래 개시 후 N분 (김프 펌프가 개장 직후 몰리는 패턴)
//   5) 최대 보유   — 첫 매수 후 M분
//
// 판단(decideExit)은 순수 함수, 루프는 5초 주기. 킬 스위치면 주문만 안 낸다(자동매도 트리거와
// 같은 원칙). 라이브 매도는 자동매수와 같은 이중 옵트인(LISTING_AUTO_LIVE=true)을 요구한다.

import { loadSection, flushSection } from "./persist";
import { logEvent } from "./events";
import { notifyNow } from "./telegram";

export type ListingExitCfg = {
  enabled: boolean;
  takeProfitPct: number;   // 0 = 끔
  stopLossPct: number;     // 0 = 끔
  trailingPct: number;     // 0 = 끔
  afterOpenMin: number;    // 0 = 끔
  maxHoldMin: number;      // 0 = 끔
};
export const DEFAULT_EXIT: ListingExitCfg = { enabled: false, takeProfitPct: 20, stopLossPct: 8, trailingPct: 7, afterOpenMin: 5, maxHoldMin: 60 };

export type ExitInput = {
  entryPx: number; curPx: number; peakPx: number;
  heldMin: number; openedMinAgo: number | null;
  cfg: ListingExitCfg;
};
export type ExitDecision = { sell: false } | { sell: true; rule: "stop" | "take" | "trail" | "open" | "hold"; reason: string };

export function decideExit(x: ExitInput): ExitDecision {
  const { entryPx, curPx, peakPx, heldMin, openedMinAgo, cfg } = x;
  if (!cfg.enabled || !(entryPx > 0) || !(curPx > 0)) return { sell: false };
  const pnl = (curPx / entryPx - 1) * 100;
  if (cfg.stopLossPct > 0 && pnl <= -cfg.stopLossPct) return { sell: true, rule: "stop", reason: `손절 ${pnl.toFixed(1)}% ≤ −${cfg.stopLossPct}%` };
  if (cfg.takeProfitPct > 0 && pnl >= cfg.takeProfitPct) return { sell: true, rule: "take", reason: `익절 +${pnl.toFixed(1)}% ≥ +${cfg.takeProfitPct}%` };
  if (cfg.trailingPct > 0 && peakPx > entryPx) {
    const dd = (curPx / peakPx - 1) * 100;
    if (dd <= -cfg.trailingPct) return { sell: true, rule: "trail", reason: `트레일링 — 최고가 대비 ${dd.toFixed(1)}% (수익 ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%)` };
  }
  if (cfg.afterOpenMin > 0 && openedMinAgo != null && openedMinAgo >= cfg.afterOpenMin) return { sell: true, rule: "open", reason: `국내 개장 후 ${Math.floor(openedMinAgo)}분 (수익 ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%)` };
  if (cfg.maxHoldMin > 0 && heldMin >= cfg.maxHoldMin) return { sell: true, rule: "hold", reason: `최대 보유 ${Math.floor(heldMin)}분 (수익 ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%)` };
  return { sell: false };
}

// ── 설정 ──────────────────────────────────────────────────────────────────────
export function getExitCfg(): ListingExitCfg {
  return { ...DEFAULT_EXIT, ...(loadSection<Partial<ListingExitCfg>>("listingExit") ?? {}) };
}
export function setExitCfg(p: Partial<ListingExitCfg>): ListingExitCfg {
  const cur = getExitCfg();
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
  const next: ListingExitCfg = {
    enabled: typeof p.enabled === "boolean" ? p.enabled : cur.enabled,
    takeProfitPct: num(p.takeProfitPct, cur.takeProfitPct),
    stopLossPct: num(p.stopLossPct, cur.stopLossPct),
    trailingPct: num(p.trailingPct, cur.trailingPct),
    afterOpenMin: num(p.afterOpenMin, cur.afterOpenMin),
    maxHoldMin: num(p.maxHoldMin, cur.maxHoldMin),
  };
  flushSection("listingExit", next);
  logEvent("listing.exit_cfg", { ...next });
  return next;
}

// ── 루프 ──────────────────────────────────────────────────────────────────────
const EXIT_TICK_MS = 5000;
const g = globalThis as unknown as { __arbListingExit?: { timer: ReturnType<typeof setInterval> | null; busy: Set<string>; peak: Record<string, { px: number; at: number }> } };
g.__arbListingExit ??= { timer: null, busy: new Set(), peak: loadSection<Record<string, { px: number; at: number }>>("listingExitPeak") ?? {} };
const S = g.__arbListingExit;
if (S.timer) { clearInterval(S.timer); S.timer = null; }

export async function venueTickerPx(venue: string, base: string): Promise<number | null> {
  const url = venue === "binance" ? `https://api.binance.com/api/v3/ticker/price?symbol=${base}USDT`
    : venue === "bybit" ? `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${base}USDT`
    : venue === "okx" ? `https://www.okx.com/api/v5/market/ticker?instId=${base}-USDT` : null;
  if (!url) return null;
  try {
    const j = await (await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(3000) })).json();
    const p = venue === "binance" ? Number(j.price) : venue === "bybit" ? Number(j.result?.list?.[0]?.lastPrice) : Number(j.data?.[0]?.last);
    return p > 0 ? p : null;
  } catch { return null; }
}

async function tick(): Promise<void> {
  const cfg = getExitCfg();
  if (!cfg.enabled) return;
  const { recentListings, recordListingSell } = await import("./listings");
  const { isKilled } = await import("./killswitch");
  const { CONFIG } = await import("./config");
  for (const p of recentListings()) {
    const buys = (p.buys ?? []).filter((b) => ["binance", "bybit", "okx"].includes(b.where));
    if (!buys.length) continue;
    const where = buys[0].where;
    const dry = buys.every((b) => b.dry);
    if (!dry && !CONFIG.DRY_RUN && process.env.LISTING_AUTO_LIVE !== "true") continue; // 라이브 이중 옵트인
    // 모의 매수는 체결 수량이 비어 있을 수 있다 — 금액/가격으로 추정한다.
    const qtyOf = (b: { qty?: number | null; usd: number; price?: number | null }) => b.qty ?? (b.price ? b.usd / b.price : 0);
    const boughtQty = buys.reduce((s, b) => s + qtyOf(b), 0);
    const soldQty = (p.sells ?? []).reduce((s, b) => s + qtyOf(b), 0);
    const qty = boughtQty - soldQty;
    if (!(qty > 1e-12)) continue;
    const key = `${p.base}:${p.announcedAt}`;
    if (S.busy.has(key)) continue;
    const usd = buys.reduce((s, b) => s + b.usd, 0);
    const entryPx = boughtQty > 0 ? usd / boughtQty : buys[0].price ?? 0;
    const cur = await venueTickerPx(where, p.base);
    if (!cur) continue;
    const pk = S.peak[key];
    if (!pk || cur > pk.px) { S.peak[key] = { px: cur, at: Date.now() }; flushSection("listingExitPeak", S.peak); }
    const firstBuy = Math.min(...buys.map((b) => b.ts));
    const d = decideExit({
      entryPx, curPx: cur, peakPx: S.peak[key].px,
      heldMin: (Date.now() - firstBuy) / 60_000,
      openedMinAgo: p.openedAt ? (Date.now() - p.openedAt) / 60_000 : null,
      cfg,
    });
    if (!d.sell) continue;
    if (isKilled()) continue; // 킬이면 주문만 안 낸다 — 해제되면 다음 틱에 다시 판단
    S.busy.add(key);
    try {
      const { acquireSell, releaseSell } = await import("./sellLock");
      const owner = `listing-exit:${Date.now()}`;
      if (!acquireSell(where, p.base, owner)) continue;
      let r;
      try {
        const o = await import("./orders");
        r = where === "binance" ? await o.binanceSpot(p.base, "SELL", { qty })
          : where === "bybit" ? await o.bybitOrder(p.base, "SELL", { qty })
          : await o.okxOrder(p.base, "SELL", { qty });
      } finally { releaseSell(where, p.base, owner); }
      logEvent("listing.exit", { base: p.base, where, qty, rule: d.rule, reason: d.reason, entryPx, curPx: cur, ok: r.ok, dry: r.dryRun, message: r.message });
      if (r.ok) {
        const proceeds = r.quoteFilled ?? qty * cur;
        recordListingSell(p.base, { where, usd: proceeds, qty, price: proceeds / qty, ts: Date.now(), dry: !!r.dryRun });
        void notifyNow(`🏁 상장 청산 — <b>${p.base}</b> ${d.reason}\n${where} ${qty.toFixed(4)} · $${proceeds.toFixed(2)} (진입 $${usd.toFixed(2)})${r.dryRun ? " (모의)" : ""}`);
      } else {
        void notifyNow(`⚠️ 상장 청산 실패 — <b>${p.base}</b> ${d.reason}\n${r.message ?? ""}`);
      }
    } finally { S.busy.delete(key); }
  }
}

export function startListingExit(): void {
  if (S.timer) return;
  S.timer = setInterval(() => { void tick().catch(() => {}); }, EXIT_TICK_MS);
  S.timer.unref?.();
}
