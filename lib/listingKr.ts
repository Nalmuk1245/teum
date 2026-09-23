// 상장따리 국내 매도 경로 — 해외에서 사서 국내로 보내 두고, 국내 개장 순간 판다.
//
// 해외 선점(공지 순간 매수)만 하면 해외 펌프만 먹는다. 상장 김프의 본체는 국내 개장 직후
// 국내 가격이 해외보다 수~수십 % 비싸게 붙는 순간이다. 그걸 먹으려면 코인이 개장 전에
// 국내 거래소에 도착해 있어야 한다.
//
// 이건 실행 엔진의 김프 플랜과 똑같다: 해외 매수 → (헷지) → 출금 → (개인지갑 경유) →
// 국내 입금 → 국내 매도 → (헷지 청산) → 정산. 그래서 새 상태머신을 만들지 않고 김프 런을
// 띄우되 두 가지만 다르게 한다:
//   · opp.listingRun — 개장 전엔 국내 호가가 없어 단계별 재검증을 건너뛴다 (runEngine.revalidate)
//   · 자동화 레벨 "매도 전 정지" — 입금까지 자동으로 가고 매도 직전에 멈춘다.
//     국내 개장이 감지되면(play.opened) 이 모듈의 루프가 매도를 승인한다.
//
// 라이브 조건(fail-closed): 해외 출금·국내 입금이 **같은 체인에서 확인된 열림**이어야 한다.
// 신규 상장 코인은 국내 입금이 개장 직전에 열리는 경우가 많아, 공지 순간엔 막혀 있을 수 있다.

import type { Opportunity, TransferGate, TransferStatus, Venue } from "./types";
import { getCached } from "./ttlCache";
import { routeFor } from "./transfers";
import { logEvent } from "./events";
import { notifyNow } from "./telegram";
import { CONFIG } from "./config";

const krSymbol = (venue: string, base: string) => (venue === "upbit" ? `KRW-${base}` : `${base}_KRW`);
const globalSymbol = (venue: string, base: string) => (venue === "okx" ? `${base}-USDT` : `${base}USDT`);

/** 상장 코인용 김프 기회 합성. 국내는 아직 가격이 없으니 가격 0 — 매도 단계에서 실호가를 쓴다. */
export function buildListingOpp(args: {
  base: string; krVenue: "upbit" | "bithumb"; globalVenue: string; globalPrice: number; announcedAt: number;
  transfers?: TransferStatus; hasPerp: boolean;
}): Opportunity {
  const { base, krVenue, globalVenue, globalPrice, announcedAt, transfers, hasPerp } = args;
  const route = routeFor(base, globalVenue as Venue, krVenue, transfers);
  const transfer: TransferGate = {
    withdraw: { venue: globalVenue as Venue, enabled: route.withdraw },
    deposit: { venue: krVenue, enabled: route.deposit },
    etaMin: route.etaMin,
    blocked: route.withdraw === false || route.deposit === false,
    network: { chain: route.label, confirms: route.confirms, chainKey: route.chainKey, alternatives: route.alternatives, reason: route.reason },
  };
  return {
    id: `listing-kr:${base}`, kind: "kimchi", base,
    legs: [
      { venue: globalVenue as Venue, side: "buy", symbol: globalSymbol(globalVenue, base), price: globalPrice, quote: "USDT" },
      { venue: krVenue, side: "sell", symbol: krSymbol(krVenue, base), price: 0, quote: "KRW" },
    ],
    grossPct: 0, costPct: 0, netPct: 0, notionalCapUsd: null,
    executable: !transfer.blocked, hasPerp, transfer,
    note: "상장 국내 매도 경로 — 개장 순간 매도",
    listingRun: { krVenue, announcedAt },
    ts: Date.now(),
  };
}

export type KrRunResult = { ok: true; runId: string; note?: string } | { ok: false; reason: string };

/** 해외 매수 → 국내 입금 → 개장 매도 런을 띄운다. */
export async function startListingKrRun(base: string, sizeUsd: number): Promise<KrRunResult> {
  const { getPlay, patchPlay, globalVenueFor } = await import("./listings");
  const play = getPlay(base);
  if (!play) return { ok: false, reason: `${base} 상장 플레이 없음` };
  if (play.krRun) return { ok: false, reason: `${base} 국내 매도 런이 이미 있음 (${play.krRun.runId})` };
  const g = await globalVenueFor(base);
  if (!g) return { ok: false, reason: `${base} 해외 미상장 — 국내로 보낼 코인을 살 곳이 없음` };
  if (g.ambiguous) return { ok: false, reason: `${base} 해외 거래소 가격이 서로 달라 같은 토큰인지 불명 — 중단` };
  const transfers = getCached<TransferStatus>("transfers") ?? undefined;
  const perps = getCached<Set<string>>("perps");
  const opp = buildListingOpp({
    base, krVenue: play.venue, globalVenue: g.venue, globalPrice: g.price, announcedAt: play.announcedAt,
    transfers, hasPerp: !!perps?.has(base),
  });
  const t = opp.transfer!;
  if (t.blocked) return { ok: false, reason: `입출금 막힘 — ${t.network?.reason ?? ""}` };
  if (!CONFIG.DRY_RUN && !(t.withdraw.enabled === true && t.deposit.enabled === true)) {
    return { ok: false, reason: `입출금 미확인 — ${t.network?.reason ?? "키 필요"} (라이브는 양쪽 확인된 열림만)` };
  }
  const eng = await import("./runEngine");
  const res = eng.startRun({ opp, sizeUsd, hedge: !!opp.hasPerp, autoLevel: "beforeSell" });
  if ("error" in res) return { ok: false, reason: res.error };
  patchPlay(base, { krRun: { runId: res.id, startedAt: Date.now(), sizeUsd } });
  logEvent("listing.kr_run", { base, runId: res.id, sizeUsd, globalVenue: g.venue, krVenue: play.venue, chain: t.network?.chain, hedge: !!opp.hasPerp });
  void notifyNow(`🇰🇷 <b>${base}</b> 국내 매도 경로 시작 — ${g.venue} $${sizeUsd} 매수 → ${play.venue} 입금 → 개장 순간 매도${opp.hasPerp ? " (헷지)" : " (헷지 없음 — 퍼프 없음)"}${CONFIG.DRY_RUN ? " (페이퍼)" : ""}\n체인 ${t.network?.chain} · ETA ~${t.etaMin}분`);
  return { ok: true, runId: res.id, note: t.withdraw.enabled == null || t.deposit.enabled == null ? "입출금 미확인 상태로 시작(페이퍼)" : undefined };
}

// ── 개장 감지 → 매도 승인 ────────────────────────────────────────────────────
/** 순수 판단 — 이 런의 매도를 지금 승인해야 하나. */
export function shouldReleaseSell(args: { opened: boolean; released?: boolean; phase?: string; pausedStepId?: string }): boolean {
  return args.opened && !args.released && args.phase === "paused" && args.pausedStepId === "sell";
}

const TICK_MS = 3000;
const g = globalThis as unknown as { __arbListingKr?: { timer: ReturnType<typeof setInterval> | null } };
g.__arbListingKr ??= { timer: null };
if (g.__arbListingKr.timer) { clearInterval(g.__arbListingKr.timer); g.__arbListingKr.timer = null; }

async function tick(): Promise<void> {
  const { recentListings, patchPlay } = await import("./listings");
  const eng = await import("./runEngine");
  const runs = eng.snapshot().runs;
  for (const p of recentListings()) {
    if (!p.krRun || p.krRun.released) continue;
    const run = runs[p.krRun.runId];
    if (!run) continue;
    const paused = run.plan[run.pauseAt]?.id;
    if (!shouldReleaseSell({ opened: p.opened, released: p.krRun.released, phase: run.phase, pausedStepId: paused })) continue;
    const ok = eng.confirmRun(run.id);
    if (!ok) continue;
    patchPlay(p.base, { krRun: { ...p.krRun, released: true } });
    logEvent("listing.kr_sell", { base: p.base, runId: run.id, openedAt: p.openedAt, krOpenPremPct: p.krOpenPremPct ?? null });
    void notifyNow(`🔔 <b>${p.base}</b> 국내 개장 — 매도 승인 (${p.venue})${p.krOpenPremPct != null ? ` · 개장 김프 ${p.krOpenPremPct >= 0 ? "+" : ""}${p.krOpenPremPct}%` : ""}`);
  }
}

export function startListingKr(): void {
  if (g.__arbListingKr!.timer) return;
  g.__arbListingKr!.timer = setInterval(() => { void tick().catch(() => {}); }, TICK_MS);
  g.__arbListingKr!.timer.unref?.();
}
