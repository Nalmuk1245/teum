// 미실현 손익 — 들고 있는 포지션을 지금 가격으로 평가해 리스크 게이트에 넘긴다.
//
// 대상: (1) 실행 엔진의 런 중 코인이나 헷지를 들고 있는 것, (2) 상장따리로 해외에서 산 코인.
// 가격: 그 포지션의 해외(USDT) 거래소 현재가. 헷지 숏은 무기한 선물이지만 현물가로 근사한다.
//
// 손실 합산은 **포지션별 손실만** 더한다(이익으로 상쇄하지 않는다). 한 포지션이 +$300,
// 다른 포지션이 −$400이면 손실은 $400이다 — +$300은 아직 실현되지 않았고, 이익 포지션이
// 먼저 꺼지면 손실만 남는다. 게이트는 보수적이어야 한다.
//
// 가격을 못 받은 포지션(unpriced)은 손실 0으로 두되 개수를 표시한다 — 모르는 걸 손실로
// 꾸미면 게이트가 근거 없이 막힌다.

import { setUnrealized, type Unrealized } from "./risk";
import { venueTickerPx } from "./listingExit";

export type Position = {
  key: string; base: string; venue: string | null; notionalUsd: number;
  spotQty: number; spotEntryUsd: number | null;
  hedgeQty: number; hedgeEntryUsd: number | null;
};

/** 순수 함수 — 포지션과 현재가로 미실현 손익·손실·노출을 계산. */
export function evaluate(positions: Position[], price: (p: Position) => number | null, runsNotionalUsd = 0): Omit<Unrealized, "at"> {
  let pnl = 0, loss = 0, open = 0, unpriced = 0;
  for (const p of positions) {
    open += p.notionalUsd;
    const px = price(p);
    if (px == null || !(px > 0)) { unpriced++; continue; }
    const spot = p.spotEntryUsd != null ? p.spotQty * (px - p.spotEntryUsd) : 0;
    const hedge = p.hedgeEntryUsd != null ? p.hedgeQty * (p.hedgeEntryUsd - px) : 0;
    const x = spot + hedge;
    pnl += x;
    if (x < 0) loss += -x;
  }
  const r = (n: number) => Math.round(n * 100) / 100;
  return { pnlUsd: r(pnl), lossUsd: r(loss), openNotionalUsd: r(open), runsNotionalUsd: r(runsNotionalUsd), positions: positions.length, unpriced };
}

async function snapshot(): Promise<Position[]> {
  const { riskPositions } = await import("./runEngine");
  const { recentListings } = await import("./listings");
  const out: Position[] = riskPositions().map((r) => ({ key: r.id, ...r }));
  for (const p of recentListings()) {
    const buys = (p.buys ?? []).filter((b) => ["binance", "bybit", "okx"].includes(b.where));
    if (!buys.length) continue;
    const q = (b: { qty: number | null; usd: number; price: number | null }) => b.qty ?? (b.price ? b.usd / b.price : 0);
    const bought = buys.reduce((s, b) => s + q(b), 0);
    const sold = (p.sells ?? []).reduce((s, b) => s + q(b), 0);
    const qty = bought - sold;
    if (!(qty > 1e-12) || !(bought > 0)) continue;
    const usd = buys.reduce((s, b) => s + b.usd, 0);
    const entry = usd / bought;
    out.push({ key: `listing:${p.base}:${p.announcedAt}`, base: p.base, venue: buys[0].where, notionalUsd: qty * entry, spotQty: qty, spotEntryUsd: entry, hedgeQty: 0, hedgeEntryUsd: null });
  }
  return out;
}

const TICK_MS = 15_000;
const g = globalThis as unknown as { __arbUnreal?: { timer: ReturnType<typeof setInterval> | null } };
g.__arbUnreal ??= { timer: null };
if (g.__arbUnreal.timer) { clearInterval(g.__arbUnreal.timer); g.__arbUnreal.timer = null; }

export async function refreshUnrealized(): Promise<Unrealized> {
  const positions = await snapshot();
  const prices = new Map<string, number | null>();
  await Promise.all([...new Set(positions.map((p) => `${p.venue ?? "binance"}:${p.base}`))].map(async (k) => {
    const [venue, base] = k.split(":");
    prices.set(k, await venueTickerPx(venue, base));
  }));
  const { inFlightUsd } = await import("./runEngine");
  const u: Unrealized = { ...evaluate(positions, (p) => prices.get(`${p.venue ?? "binance"}:${p.base}`) ?? null, inFlightUsd()), at: Date.now() };
  // 노출: 런은 엔진의 inFlight(진행 중 포함), 상장은 보유 평가액. 런 포지션을 두 번 세지 않게 엔진 값으로 대체.
  const listingOpen = positions.filter((p) => p.key.startsWith("listing:")).reduce((s, p) => s + p.notionalUsd, 0);
  u.openNotionalUsd = Math.round((u.runsNotionalUsd + listingOpen) * 100) / 100;
  setUnrealized(u);
  return u;
}

export function startUnrealized(): void {
  if (g.__arbUnreal!.timer) return;
  void refreshUnrealized().catch(() => {});
  g.__arbUnreal!.timer = setInterval(() => { void refreshUnrealized().catch(() => {}); }, TICK_MS);
  g.__arbUnreal!.timer.unref?.();
}
