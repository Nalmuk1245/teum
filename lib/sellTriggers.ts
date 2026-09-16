// 자동 매도 트리거 — "이 거래소에 이 코인이 들어오면 즉시 판다"를 서버가 감시.
//
// 실행 엔진(runEngine)과 같은 원칙: 루프는 서버가 소유한다. 브라우저를 꺼도
// 입금이 도착하면 팔린다 — 그게 이 기능의 전부다. UI는 /api/sell-trigger를
// 폴링하는 미러.
//
// ── 속도 설계 (운영자 결정) ───────────────────────────────────────────────────
// 잔고를 "폴링해서 감지한 뒤 주문"하면 감지→주문 왕복이 한 번 더 붙는다. 두 모드:
//  - hammer : 매 주기 매도 주문을 그냥 던진다. "잔고 없음" 거절은 공짜 정찰이고,
//             입금이 크레딧되는 순간 다음 주문이 체결된다 → 감지 지연 0.
//             대신 거절 주문을 쏟으므로 거래소 abuse 감지 위험 — 보수적 페이싱 필수.
//  - hybrid: 매 주기 잔고 read(주문과 다른 rate 버킷, 더 쌈) → 잡히면 같은 주기에
//             즉시 주문. 왕복 1회만큼 느리지만 거절을 안 쏜다. 기본값.
//
// 페이싱은 거래소 주문 한도의 여유 안쪽으로 고정한다(POLL_MS). 429/거절 폭증엔
// 백오프. 라이브는 EXEC_TOKEN 게이트(API 라우트)·킬 스위치를 지킨다.

import { CONFIG } from "./config";
import { isKilled } from "./killswitch";
import { loadSection, saveSection, flushSection } from "./persist";
import { notifyNow } from "./telegram";
import {
  coinBalance, upbitOrder, binanceSpot, bithumbOrder,
  upbitLimitSell, binanceLimitSell, upbitOrderFills, binanceOrderFills,
  upbitCancelOrder, binanceCancelOrder,
} from "./orders";
import { EXCHANGES } from "./exchanges";
import { acquireSell, releaseSell } from "./sellLock";

export type SellMode = "market" | "bid" | "limit";
export type FireMode = "hybrid" | "hammer";

export type SellTrigger = {
  id: string;
  venue: "upbit" | "binance" | "bithumb";
  base: string;
  mode: SellMode;
  fire: FireMode;
  /** limit·bid 모드의 목표/바닥가 (거래소 표기 통화 — KR은 KRW, 글로벌은 USDT). */
  targetPrice?: number;
  /** market·bid 모드의 바닥가 — best bid가 이 밑이면 주문 안 함 (헐값 덤프 방지). */
  floorPrice?: number;
  /** 예상 수량 (출금한 양). hammer가 잔고 read 없이 던질 수량의 근거. */
  expectQty?: number;
  /** 팔고 나서 또 입금 오면 다시 무장할지 (기본 일회성). */
  repeat: boolean;
  status: "arming" | "waiting" | "working" | "done" | "cancelled" | "error";
  /** 연속 비체결(거절/미도착) 횟수 — 백오프 판단. 체결·등록 성공 시 0. */
  nonFill: number;
  createdAt: number;
  dry: boolean;
  soldQty: number;
  proceeds: number;   // 체결 대금 (거래소 통화)
  lastMsg?: string;
  /** 등록해 둔 미체결 지정가 주문 (limit·bid). */
  openOrderId?: string;
  attempts: number;   // 던진 주문 수 (거절 포함) — abuse 감시용
};

const POLL_MS = 250;               // 주기 — 주문 한도의 70~80% 여유 (실측 후 조정)
// hybrid는 매 주기 잔고를 읽는다. 바이낸스 /api/v3/account는 weight 20이라 250ms면
// 4,800/min — IP 한도 6,000의 80%를 트리거 **하나**가 먹는다(둘이면 밴). 업비트
// /v1/accounts는 30/s 버킷이라 250ms가 문제없다. 거래소별로 잔고 폴 주기를 나눈다.
const BAL_POLL_MS: Record<string, number> = { binance: 2000 };
const pollMsFor = (t?: SellTrigger) => (t && t.fire === "hybrid" ? BAL_POLL_MS[t.venue] ?? POLL_MS : POLL_MS);
const BACKOFF_MS = 30_000;         // 거절/429 폭증 시 물러남
const MIN_NOTIONAL = 5;            // 이 미만 잔고는 "도착 안 함"으로 (먼지 방지)
const MAX_ATTEMPTS_DRY = 20;       // DRY에선 무한 시뮬 방지

const KR = new Set(["upbit", "bithumb"]);

type G = { __arbSellTriggers?: Map<string, SellTrigger>; __arbSellLoops?: Map<string, ReturnType<typeof setTimeout>> };
const g = globalThis as unknown as G;
function store(): Map<string, SellTrigger> {
  if (!g.__arbSellTriggers) {
    const saved = loadSection<SellTrigger[]>("sellTriggers") ?? [];
    // 재시작 복원. 미체결 지정가(openOrderId)가 있는 working은 **그대로 둔다** —
    // 거래소에 그 주문이 살아 있으므로 trackOpenOrder가 체결·취소를 이어서 본다.
    // 예전엔 openOrderId를 지우고 waiting으로 돌렸는데, 그러면 거래소의 지정가는
    // 고아가 된다: 잔고가 locked라 재등록은 거절돼 이중 매도는 안 났지만, bid 모드
    // re-peg가 멈추고 체결돼도 soldQty/proceeds에 안 잡혔다. 주문 id가 없는
    // working(시장가 발사 중)·arming은 상태를 알 수 없으니 waiting으로.
    g.__arbSellTriggers = new Map(saved.map((t) => [
      t.id,
      (t.status === "working" && !t.openOrderId) || t.status === "arming" ? { ...t, status: "waiting" } : t,
    ]));
  }
  return g.__arbSellTriggers;
}
g.__arbSellLoops ??= new Map();
function persist() { saveSection("sellTriggers", [...store().values()]); }

// ── 거래소 호가 (best bid) ────────────────────────────────────────────────────
async function bestBid(venue: string, base: string): Promise<number | null> {
  const ad = EXCHANGES[venue as keyof typeof EXCHANGES];
  if (!ad?.fetchOrderBook) return null;
  try {
    const symbol = venue === "upbit" ? `KRW-${base}` : venue === "bithumb" ? `${base}_KRW` : `${base}USDT`;
    const book = await ad.fetchOrderBook(symbol);
    return book.bids[0]?.price ?? null;
  } catch { return null; }
}

async function marketSell(t: SellTrigger, qty: number) {
  if (t.venue === "upbit") return upbitOrder(t.base, "ask", { volume: qty });
  if (t.venue === "binance") return binanceSpot(t.base, "SELL", { qty });
  return bithumbOrder(t.base, "ask", qty); // bithumb
}
async function limitSell(t: SellTrigger, qty: number, price: number) {
  if (t.venue === "upbit") return upbitLimitSell(t.base, qty, price);
  if (t.venue === "binance") return binanceLimitSell(t.base, qty, price);
  // bithumb 지정가 매도는 미배선 — market으로 강등 (호출부에서 처리)
  return null;
}

/** 한 트리거의 한 주기. */
async function tick(t: SellTrigger): Promise<void> {
  if (t.status === "done" || t.status === "cancelled" || t.status === "error") return;
  // 킬 스위치는 **정지**지 사망이 아니다. 예전엔 status="error"로 세워 루프가
  // 재스케줄을 멈췄고(해제해도 안 살아남), 서킷 브레이커가 **다른 코인**의 실패로
  // 킬을 켜는 순간 전송 중이던 코인의 매도 트리거가 전부 죽었다 — 재등록 전까지
  // 도착한 코인을 아무도 안 팔았다. 이제 주문만 안 내고 루프는 계속 돈다.
  if (isKilled()) { t.lastMsg = "킬 스위치 활성 — 대기 (해제되면 재개)"; return; }

  // 실행 엔진이 같은 코인·거래소를 매도 관리 중이면 양보 (오버셀 방지).
  try {
    const { activeSellForVenue } = await import("./runEngine");
    if (activeSellForVenue(t.venue, t.base)) { t.lastMsg = "실행 런이 이 코인 매도 중 — 양보"; persist(); return; }
  } catch { /* runEngine 경계 — 실패 시 그냥 진행 */ }

  // ── limit·bid: 이미 등록한 미체결 주문이 있으면 체결 추적/재-peg ──
  if (t.openOrderId) return trackOpenOrder(t);

  // ── 수량 결정 ──
  let qty: number | null = null;
  if (t.fire === "hybrid") {
    const bal = await coinBalance(t.venue, t.base);
    if (bal == null) { t.lastMsg = "잔고 조회 실패 — 재시도"; return; }
    qty = bal;
  } else {
    // hammer: 잔고 read 없이 예상 수량으로 던진다. 도착 전엔 "잔고 없음" 거절.
    qty = t.expectQty && t.expectQty > 0 ? t.expectQty * 0.995 : null; // 수수료 편차 흡수
    if (qty == null) {
      // 예상 수량 없으면 hammer 불가 — 잔고 read로 강등 (안전)
      const bal = await coinBalance(t.venue, t.base);
      qty = bal ?? 0;
    }
  }

  const price = await bestBid(t.venue, t.base);
  const notional = price != null && qty != null ? qty * price : null;
  // 아직 도착 안 함 (먼지 미만) — hammer는 계속 던지고(hybrid는 그냥 대기)
  if (t.fire === "hybrid" && (notional == null || notional < MIN_NOTIONAL)) {
    t.status = "waiting"; return;
  }

  // ── 바닥가 방어 (market·bid) ──
  if ((t.mode === "market" || t.mode === "bid") && t.floorPrice && price != null && price < t.floorPrice) {
    t.status = "waiting";
    t.lastMsg = `호가 ${price} < 바닥 ${t.floorPrice} — 대기 (헐값 덤프 방지)`;
    return;
  }

  t.attempts++;
  if (t.dry && t.attempts > MAX_ATTEMPTS_DRY) { t.status = "done"; t.lastMsg = "모의 — 시뮬 종료"; persist(); return; }

  // ── 매도 락 — 실행 엔진·다른 트리거·수동 라우트와 같은 (거래소,코인) 뮤텍스.
  //    주문 직전에 잡는다(감사 #1의 TOCTOU 닫음). 못 잡으면 다른 매도자가
  //    이미 처리 중 → 이번 주기 양보.
  const owner = `trigger:${t.id}`;
  if (!acquireSell(t.venue, t.base, owner)) { t.lastMsg = "다른 매도자 처리 중 — 양보"; return; }
  try {
  // ── 모드별 주문 ──
  if (t.mode === "limit") {
    if (!t.targetPrice) { t.status = "error"; t.lastMsg = "지정가 목표가 없음"; persist(); return; }
    if (price != null && price < t.targetPrice) { t.status = "waiting"; t.lastMsg = `현재가 ${price} < 목표 ${t.targetPrice} — 대기`; return; }
    const r = await limitSell(t, qty!, t.targetPrice);
    if (r?.ok && r.id) { t.openOrderId = r.id; t.status = "working"; t.nonFill = 0; t.lastMsg = `지정가 등록 @${t.targetPrice}`; persist(); }
    else { t.nonFill++; t.lastMsg = r?.message ?? "지정가 등록 실패/미도착"; }
    return;
  }

  if (t.mode === "bid") {
    const px = price ?? t.targetPrice;
    if (px == null) { t.lastMsg = "호가 조회 실패 — 재시도"; return; }
    const r = await limitSell(t, qty!, px);
    if (r == null) { return marketFire(t, qty!); } // bithumb 지정가 미배선 → market
    if (r.ok && r.id) { t.openOrderId = r.id; t.status = "working"; t.nonFill = 0; t.lastMsg = `호가 지정가 등록 @${px}`; persist(); }
    else { t.nonFill++; t.lastMsg = r.message ?? "호가 등록 실패/미도착"; }
    return;
  }

  // market
  return await marketFire(t, qty!);
  } finally {
    releaseSell(t.venue, t.base, owner);
  }
}

async function marketFire(t: SellTrigger, qty: number): Promise<void> {
  const r = await marketSell(t, qty);
  if (r.ok) {
    const filled = r.filledQty ?? qty;
    t.soldQty += filled;
    t.proceeds += r.quoteFilled ?? 0;
    t.status = "working";
    t.nonFill = 0;
    t.lastMsg = `시장가 매도 · ${r.message}`;
    // hammer: 판 만큼 예상 수량에서 뺀다 — 안 그러면 다음 tick이 원래 예상
    // 수량 전량을 다시 던져 이미 판 걸 또 팔려 한다(감사 #4).
    if (t.fire === "hammer" && t.expectQty) t.expectQty = Math.max(0, t.expectQty - filled / 0.995);
    await finalizeIfDone(t);
    persist();
  } else {
    // "잔고 없음" = 아직 도착 안 함 (hammer의 정상 상태). 그 외 실패는 기록.
    t.status = "waiting";
    t.nonFill++;
    t.lastMsg = r.message ?? "매도 실패/미도착";
  }
}

async function trackOpenOrder(t: SellTrigger): Promise<void> {
  const fills = t.venue === "upbit" ? await upbitOrderFills(t.openOrderId!)
    : t.venue === "binance" ? await binanceOrderFills(t.base, t.openOrderId!)
    : null;
  if (!fills) return; // 조회 실패 — 다음 주기
  if (fills.filledQty > t.soldQty) { t.proceeds += 0; } // 대금은 완료 시 합산
  t.soldQty = Math.max(t.soldQty, fills.filledQty);
  if (!fills.open) {
    // 체결 완료 or 취소됨 → 대금 반영 후 정리
    t.proceeds = fills.quoteFilled || t.proceeds;
    t.openOrderId = undefined;
    await finalizeIfDone(t);
    persist();
    return;
  }
  // bid 모드: 미체결이면 호가가 움직였을 수 있다 → 취소하고 재-peg.
  if (t.mode === "bid") {
    const px = await bestBid(t.venue, t.base);
    if (px != null && t.targetPrice != null && Math.abs(px - t.targetPrice) / t.targetPrice > 0.002) {
      const cancelled = t.venue === "upbit" ? await upbitCancelOrder(t.openOrderId!)
        : t.venue === "binance" ? await binanceCancelOrder(t.base, t.openOrderId!) : false;
      if (cancelled) { t.openOrderId = undefined; t.targetPrice = px; t.lastMsg = `호가 이동 — 재등록 준비 @${px}`; persist(); }
    }
  }
}

async function finalizeIfDone(t: SellTrigger): Promise<void> {
  // hammer + 예상 수량이 있으면 그걸 먼저 믿는다 — 시장가 체결 직후 거래소 잔고
  // 반영은 순간 지연되는데(감사 #4), 그 창에 잔고 read를 믿으면 "아직 남음"으로
  // 오판해 다음 tick이 또 던진다. 판 누적이 예상의 99% 넘으면 완료로 본다.
  if (t.fire === "hammer" && t.expectQty != null && (t.expectQty <= 0 || t.soldQty >= t.expectQty * 0.995 * 0.99)) {
    return finish(t);
  }
  // 남은 잔고 확인 — 없으면 완료.
  const bal = await coinBalance(t.venue, t.base);
  const price = await bestBid(t.venue, t.base);
  const leftNotional = bal != null && price != null ? bal * price : null;
  if (bal != null && (leftNotional == null || leftNotional < MIN_NOTIONAL)) {
    return finish(t);
  }
}

function finish(t: SellTrigger): void {
  if (t.repeat) { t.status = "waiting"; t.nonFill = 0; t.expectQty = undefined; t.lastMsg = `1회 매도 완료 (누적 ${t.soldQty}) — 재무장`; }
  else { t.status = "done"; t.lastMsg = `매도 완료 · 총 ${t.soldQty} · 대금 ${Math.round(t.proceeds)}`; stopLoop(t.id); }
  if (!t.dry) void notifyNow(`✅ <b>${t.base}</b> 자동매도 ${t.repeat ? "1회" : "완료"} · ${t.venue} · ${t.soldQty}`);
}

// ── 자기 재스케줄 루프 (트리거당) ─────────────────────────────────────────────
function scheduleLoop(id: string): void {
  const run = () => {
    const t = store().get(id);
    if (!t || t.status === "done" || t.status === "cancelled" || t.status === "error") { stopLoop(id); return; }
    void tick(t).catch((e) => { t.lastMsg = e instanceof Error ? e.message : "tick 오류"; }).finally(() => {
      const cur = store().get(id);
      if (cur && cur.status !== "done" && cur.status !== "cancelled" && cur.status !== "error") {
        // 백오프 배선(감사 #2): 연속 비체결이 쌓이면 — 거래소가 거절을 abuse로
        // 세기 시작하는 구간 — 폴 간격을 점진적으로 늘린다. 체결/등록되면 0으로.
        // nonFill 8회(≈2초)부터 개입, 32회면 BACKOFF_MS 상한.
        const nf = cur.nonFill;
        const base = pollMsFor(cur);
        const delay = nf < 8 ? base : Math.min(BACKOFF_MS, base * Math.pow(2, Math.floor((nf - 8) / 8) + 1));
        g.__arbSellLoops!.set(id, setTimeout(run, delay));
      }
    });
  };
  g.__arbSellLoops!.set(id, setTimeout(run, pollMsFor(store().get(id))));
}
function stopLoop(id: string): void {
  const h = g.__arbSellLoops!.get(id);
  if (h) { clearTimeout(h); g.__arbSellLoops!.delete(id); }
}

// ── 공개 API ──────────────────────────────────────────────────────────────────
export function createTrigger(cfg: Omit<SellTrigger, "id" | "status" | "createdAt" | "dry" | "soldQty" | "proceeds" | "attempts" | "nonFill">): SellTrigger | { error: string } {
  // 같은 거래소·코인에 이미 살아있는 트리거가 있으면 거부 — 둘이 같은 잔고를
  // 노려 이중 주문·거절·알림 중복을 낸다 (감사 #3).
  const dup = [...store().values()].find((x) => x.venue === cfg.venue && x.base === cfg.base && (x.status === "waiting" || x.status === "working" || x.status === "arming"));
  if (dup) return { error: `${cfg.base} ${cfg.venue}에 이미 활성 트리거가 있습니다 (먼저 취소)` };
  // 실행 런이 같은 코인·거래소를 매도 관리 중이면 거부 — 둘이 공존하면 지정가
  // 미체결이 잔고를 잠가 런의 매도를 굶긴다(감사 #1의 지정가 변형).
  try {
    const s2 = (globalThis as unknown as { __arbRunEngine?: { runs: Record<string, { base: string; phase: string; remaining: number; opp: { legs: { side: string; venue: string }[] } }> } }).__arbRunEngine;
    if (s2) for (const r of Object.values(s2.runs)) {
      if (r.base === cfg.base && !(r.phase === "done" && r.remaining <= 0) && r.opp.legs.find((l) => l.side === "sell")?.venue === cfg.venue) {
        return { error: `${cfg.base} ${cfg.venue}를 실행 런이 매도 관리 중 — 완료·정리 후 등록` };
      }
    }
  } catch { /* 경계 실패 — 통과 (락이 마지막 방어) */ }
  const id = `st_${Date.now().toString(36)}_${cfg.base}`;
  const t: SellTrigger = {
    ...cfg, id, status: "waiting", createdAt: Date.now(), dry: CONFIG.DRY_RUN,
    soldQty: 0, proceeds: 0, attempts: 0, nonFill: 0,
  };
  store().set(id, t);
  persist();
  scheduleLoop(id);
  return t;
}

export function cancelTrigger(id: string): boolean {
  const t = store().get(id);
  if (!t) return false;
  // 미체결 지정가 주문이 있으면 취소 시도 (best-effort, 비동기)
  if (t.openOrderId) {
    const oid = t.openOrderId;
    if (t.venue === "upbit") void upbitCancelOrder(oid);
    else if (t.venue === "binance") void binanceCancelOrder(t.base, oid);
  }
  t.status = "cancelled";
  t.lastMsg = "사용자 취소";
  stopLoop(id);
  flushSection("sellTriggers", [...store().values()]);
  return true;
}

export function listTriggers(): SellTrigger[] {
  return [...store().values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** 부팅 시 재무장 — waiting 트리거의 루프를 다시 건다. */
export function bootSellTriggers(): void {
  for (const t of store().values()) {
    if (t.status === "waiting" || t.status === "working") scheduleLoop(t.id);
  }
}
