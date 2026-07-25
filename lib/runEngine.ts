// Server-side execution engine — 실행 상태머신의 단일 소유자.
//
// 이전에는 이 루프가 브라우저 탭 안(runStore)에서 돌았다: 탭을 닫으면 진행
// 중 런의 루프가 죽고, 실포지션만 거래소에 남았다. 이제 루프는 서버 모듈이
// 소유하고, UI(runStore)는 /api/runs를 폴링하는 미러일 뿐이다.
//
// 경계 규칙: 이 모듈은 UI/react를 절대 임포트하지 않는다 — 나중에 별도
// 프로세스로 떼어낼 수 있는 유일한 조건이다.
//
// 재시작 시: 런 스냅샷은 data/에 persist된다. 엔진 상태(진행 인덱스의
// 신뢰성·체결 컨텍스트)는 복원할 수 없으므로 진행 중이던 런은 "중단" 오류로
// 복원만 하고 자동 재개는 하지 않는다 — 상태를 모르는 재개가 더 위험하다.

import type { Opportunity } from "./types";
import {
  buildPlan, needsConfirmBeforePublic as needsConfirmBefore, REVALIDATE_STEPS, firstIrreversibleIdx,
  type AutoLevel, type ExecStep, type StepId, type StepPhase, type RunPhase,
} from "./execPlan";
import { runStep } from "./execStep";
import { quoteOpportunity } from "./quote";
import { unwind } from "./unwind";
import { isKilled, setKilled } from "./killswitch";
import { getLimits } from "./risk";
import { CONFIG } from "./config";
import { notify, notifyNow } from "./telegram";
import { loadSection, flushSection } from "./persist";

export type TxRef = { hash: string; url: string | null };

export type RunView = {
  id: string;
  opp: Opportunity;
  base: string;
  kind: string;
  route: string; // "Binance → Upbit"
  sizeUsd: number;
  hedge: boolean;
  autoLevel: AutoLevel;
  plan: ExecStep[];
  statuses: Record<string, StepPhase>;
  messages: Record<string, string>;
  txs: Record<string, TxRef>;
  phase: RunPhase;
  pauseAt: number;
  error: string | null;
  startedAt: number;
  totalQty: number;
  remaining: number;
  pnlUsd: number;
  unwindLog: string[];
  unwinding: boolean;
};

type Engine = {
  cancelled: boolean;
  /** Kill-switch generation this engine was created in. The loop compares it
   *  against the current epoch instead of reading a sticky `cancelled` flag —
   *  that flag was never reset anywhere, so a breaker trip permanently bricked
   *  every run even after the operator released the kill switch. */
  killEpoch: number;
  busy: boolean;
  i: number;
  confirmed: Set<number>;
  qty?: number;
  startTs: number;
  /** Hedge fill quantity — `close` must reduce exactly what was opened. Sizing
   *  the close off the threaded qty (deposit-credited amount) can exceed the
   *  position and get rejected by reduceOnly, leaving a naked short after the
   *  spot leg is already sold. */
  hedgeQty?: number;
  fills: { buyQuote?: number; buyCcy?: string; buyQty?: number; sellQuote?: number; sellCcy?: string; sellQty?: number; hedgeOpenQuote?: number; hedgeCloseQuote?: number };
  durations: Record<string, number>;
  /** Successful step results by step index — replay protection. Retrying a step
   *  that already succeeded must NOT re-send it. */
  done: Map<number, { ok: boolean; message?: string; tx?: TxRef }>;
  /** Set once a rollback has run: the run is terminal and cannot be retried
   *  (retrying after an unwind re-opened hedges and re-dumped spot). */
  rolledBack: boolean;
  /** An unwind is touching this run's position — the loop must not sell too. */
  unwindLock: boolean;
  /** Wallet balance of the coin just before the outbound withdrawal — the `recv`
   *  step judges arrival on the increase, not the absolute balance. */
  walletBefore?: number;
  /** First attempt time per step index — the wait timeout for polling steps
   *  (recv / deposit) is measured from when THAT step started, not from entry. */
  stepFirstAt: Map<number, number>;
  opp: Opportunity;
};

const g = globalThis as unknown as {
  __arbRunEngine?: { runs: Record<string, RunView>; engines: Map<string, Engine>; seq: number; booted: boolean; saveTimer: ReturnType<typeof setTimeout> | null; fails: number[]; killEpoch: number };
};
g.__arbRunEngine ??= { runs: {}, engines: new Map(), seq: 0, booted: false, saveTimer: null, fails: [], killEpoch: 0 };
const E = g.__arbRunEngine;
E.fails ??= [];
E.killEpoch ??= 0;

/** Max runs kept in memory. The map was never trimmed (only user-initiated
 *  cancel/clear removed entries), so finished runs — each embedding a full
 *  Opportunity — accumulated for the process lifetime AND were re-serialized
 *  into every 2.5s /api/runs poll. */
const MAX_RUNS = 30;
function trimRuns() {
  const ids = Object.keys(E.runs);
  if (ids.length <= MAX_RUNS) return;
  // Drop the oldest FINISHED runs first; never evict one that still has a
  // position or an open hedge (it needs to stay visible and unwindable).
  const evictable = ids
    .filter((id) => {
      const r = E.runs[id];
      const openHedge = r.statuses.hedge === "done" && r.statuses.close !== "done";
      return r.phase === "done" && r.remaining <= 0 && !openHedge;
    })
    .sort((a, b) => (E.runs[a].startedAt ?? 0) - (E.runs[b].startedAt ?? 0));
  for (const id of evictable) {
    if (Object.keys(E.runs).length <= MAX_RUNS) break;
    delete E.runs[id];
    E.engines.delete(id);
  }
}

// ── 서킷 브레이커 ─────────────────────────────────────────────────────────────
// 실행 단계가 연속 실패하면(거래소 장애·키 문제·버그) 같은 실수를 반복하며
// 수수료·슬리피지를 흘린다. 최근 CB_WINDOW분 내 실행 실패가 CB_MAX회 쌓이면
// 킬 스위치를 자동으로 켜고 알린다. 재검증 실패(엣지 소멸)는 정상 방어라
// 세지 않는다 — 오직 주문/출금/전송의 실집행 실패만.
const CB_WINDOW_MS = Number(process.env.CIRCUIT_FAIL_WINDOW_MIN ?? 10) * 60_000;
const CB_MAX = Number(process.env.CIRCUIT_FAIL_MAX ?? 3);
// Deposit confirmation is a WAIT, not a failure: poll until the chain credits it.
const DEPOSIT_POLL_MS = Number(process.env.DEPOSIT_POLL_SEC ?? 20) * 1000;
const DEPOSIT_WAIT_MAX_SEC = Number(process.env.DEPOSIT_WAIT_MAX_MIN ?? 90) * 60;
const sleep = (ms: number) => new Promise<void>((res) => { setTimeout(res, ms).unref?.(); });
function recordExecFailure(base: string, stepLabel: string) {
  const now = Date.now();
  E.fails = E.fails.filter((t) => now - t < CB_WINDOW_MS);
  E.fails.push(now);
  if (E.fails.length >= CB_MAX && !isKilled()) {
    setEngineKill(true); // epoch 증가 + 킬 — cancelled 플래그를 직접 만지지 않는다
    void notify("circuit", `🛑 서킷 브레이커 — 최근 ${Math.round(CB_WINDOW_MS / 60_000)}분 내 실행 실패 ${E.fails.length}회 (마지막: ${base} ${stepLabel}). 킬 스위치 자동 활성 — 원인 확인 후 운영 탭에서 해제.`);
  }
}

/** Does this failure mean "the tool tried to execute and the venue/network broke"?
 *  Defensive aborts (risk limit, slippage cap, stale snapshot, missing key, gate
 *  closed) are the guards WORKING — counting them tripped the breaker on healthy
 *  refusals. Deposit-still-confirming isn't a failure at all. */
function isExecFailure(r: { message?: string; pending?: boolean }): boolean {
  if (r.pending) return false;
  const m = r.message ?? "";
  return !/리스크 한도|슬리피지|스냅샷 2분 초과|키 없음|미배선|재검증|차단|중단됨|한도 초과|최소 출금|재고 부족/.test(m);
}

// ── persist (서버 파일) ───────────────────────────────────────────────────────
function persistRuns() {
  if (E.saveTimer) return;
  E.saveTimer = setTimeout(() => {
    E.saveTimer = null;
    try {
      const keep = Object.values(E.runs).slice(-30);
      flushSection("runs", Object.fromEntries(keep.map((r) => [r.id, r])));
    } catch { /* disk */ }
  }, 500);
}

function boot() {
  if (E.booted) return;
  E.booted = true;
  try {
    const saved = loadSection<Record<string, RunView>>("runs") ?? {};
    let interrupted = 0;
    for (const [id, rv] of Object.entries(saved)) {
      if (E.runs[id]) continue;
      if (rv.phase === "running" || rv.phase === "paused") {
        rv.phase = "error";
        rv.error = "⚠ 서버 재시작으로 실행 루프 중단 — 거래소 실포지션·헷지 수동 확인 필요";
        interrupted++;
      }
      E.runs[id] = rv;
      // seq가 복원 런 id와 충돌하지 않게 전진
      const m = /^run_(\d+)_/.exec(id);
      if (m) E.seq = Math.max(E.seq, Number(m[1]));
    }
    if (interrupted > 0) {
      void notify("run:interrupted", `⚠ 서버 재시작 — 진행 중이던 런 ${interrupted}건 중단됨. 실포지션 확인 필요.`);
    }
  } catch { /* malformed */ }
}
boot();

function patch(id: string, p: Partial<RunView>) {
  const cur = E.runs[id];
  if (!cur) return;
  E.runs[id] = { ...cur, ...p };
  persistRuns();
}

/** USD notional currently at risk. Counts errored/interrupted runs that still
 *  hold coin or an open hedge — they were excluded, so after a restart (which
 *  rewrites interrupted runs to `error`) the cap saw $0 while real positions were
 *  open and would authorize another full-size run on top. */
export function inFlightUsd(): number {
  return Object.values(E.runs)
    .filter((r) => {
      if (r.phase === "running" || r.phase === "paused") return true;
      const openHedge = r.statuses.hedge === "done" && r.statuses.close !== "done";
      return r.remaining > 0 || openHedge;
    })
    .reduce((s, r) => s + r.sizeUsd, 0);
}

/** Is there an unresolved position on this coin? Blocks a second run on the same
 *  base — compounding shorts on one symbol makes their reduceOnly closes fight. */
function hasOpenPosition(base: string): RunView | undefined {
  return Object.values(E.runs).find((r) => {
    if (r.base !== base) return false;
    if (r.phase === "running" || r.phase === "paused") return true;
    const openHedge = r.statuses.hedge === "done" && r.statuses.close !== "done";
    return r.remaining > 0 || openHedge;
  });
}

// ── step / revalidate ─────────────────────────────────────────────────────────
async function callStep(id: string, eng: Engine, stepId: StepId, opts?: { rollback?: boolean }) {
  // Entry step resets the run's derived state and stamps startTs. `buy` is not
  // the entry on every plan — cex-dex buyDex enters via `swap`, and there
  // startTs stayed 0, so the deposit check fell back to "any deposit in the last
  // hour" and could advance to `sell` while the coin was still in flight.
  const dexSide = eng.opp.legs.find((l) => l.venue === "dex")?.side;
  const isEntry = stepId === "buy" || (stepId === "swap" && dexSide === "buy");
  if (isEntry && !opts?.rollback) {
    eng.qty = undefined;
    eng.fills = {};
    eng.startTs = Date.now();
  }
  // Replay protection. The idempotency cache in execStep was only wired into
  // /api/exec-step, which nothing calls — the engine path (the one the UI drives
  // via retry) had none, so retrying a step whose HTTP call had timed out
  // re-sent it: a second withdrawal, a second on-chain transfer, a second swap.
  if (!opts?.rollback) {
    const hit = eng.done.get(eng.i);
    if (hit) return { ...hit, replayed: true };
  }

  const run = E.runs[id];
  const r = await runStep(stepId, eng.opp, run?.sizeUsd ?? 0, {
    rollback: opts?.rollback, qty: eng.qty, sinceTs: eng.startTs || undefined,
    // `close` reduces exactly the hedge that was opened, not the threaded qty.
    hedgeQty: stepId === "close" ? eng.hedgeQty : undefined,
    walletBefore: stepId === "recv" || stepId === "deposit" ? eng.walletBefore : undefined,
    fills: stepId === "settle" ? eng.fills : undefined,
    durations: stepId === "settle" ? eng.durations : undefined,
    txs: stepId === "settle"
      ? Object.entries(run?.txs ?? {}).map(([step, tx]) => ({ step, hash: tx.hash, url: tx.url }))
      : undefined,
  });
  // The hedge's own fill must not overwrite the carried spot quantity — that
  // coupling is what made the transfer amount fee-adjusted only when hedging was
  // on (and LOT-floored to the PERP step size, stranding the remainder).
  if (typeof r.filledQty === "number" && r.filledQty > 0) {
    if (stepId === "hedge") eng.hedgeQty = r.filledQty;
    else eng.qty = r.filledQty;
  }
  if (typeof r.walletBefore === "number") eng.walletBefore = r.walletBefore;
  if (r.fill?.quote && !opts?.rollback) {
    if (stepId === "buy") { eng.fills.buyQuote = r.fill.quote; eng.fills.buyCcy = r.fill.ccy; eng.fills.buyQty = r.fill.qty; }
    if (stepId === "sell") { eng.fills.sellQuote = r.fill.quote; eng.fills.sellCcy = r.fill.ccy; eng.fills.sellQty = r.fill.qty; }
    if (stepId === "hedge") eng.fills.hedgeOpenQuote = r.fill.quote;
    if (stepId === "close") eng.fills.hedgeCloseQuote = r.fill.quote;
  }
  // 라이브 실패 = 폰 알림 (기존 라우트 경유 시절의 동작을 엔진 경로에서도 유지)
  if (!r.ok && !r.pending && !CONFIG.DRY_RUN && !opts?.rollback) {
    void notifyNow(`⚠️ <b>${eng.opp.base}</b> ${stepId} 실패\n${r.message ?? ""}`);
  }
  const out = {
    ok: r.ok, message: r.message, tx: r.tx as TxRef | undefined,
    ambiguous: r.ambiguous, pending: r.pending,
  };
  // Remember only real successes, and never for the polling arrival steps.
  if (r.ok && !opts?.rollback && stepId !== "deposit" && stepId !== "recv") eng.done.set(eng.i, out);
  return out;
}

async function revalidate(eng: Engine, sizeUsd: number) {
  if (eng.opp.mock) return { ok: true as const };
  try {
    // fresh: 돈이 움직이기 직전 — 캐시된 호가로 판단하지 않는다
    const q = await quoteOpportunity(eng.opp, sizeUsd, { fresh: true });
    if (!q) return { ok: false as const, reason: "실호가 재조회 실패" };
    if (q.execNetPct <= 0) return { ok: false as const, reason: `순수익 ${q.execNetPct.toFixed(2)}%로 하락` };
    return { ok: true as const };
  } catch {
    return { ok: false as const, reason: "재견적 요청 실패" };
  }
}

// ── the loop ──────────────────────────────────────────────────────────────────
async function loop(id: string) {
  const eng = E.engines.get(id);
  if (!eng || eng.busy) return;
  eng.busy = true;
  const run = () => E.runs[id];
  patch(id, { phase: "running", error: null });

  while (run() && eng.i < run().plan.length) {
    // Stop on explicit cancel, or when the kill switch has been flipped since
    // this engine started. Always surface WHY — the old guard was
    // `if (isKilled() && !eng.cancelled)`, and the breaker set both flags, so the
    // error patch was skipped in exactly the case that mattered: the run sat at
    // "running" forever, retry refused it (needs phase "error"), and it kept
    // consuming the in-flight exposure cap.
    if (eng.cancelled || eng.killEpoch !== E.killEpoch || isKilled()) {
      patch(id, {
        phase: "error",
        error: eng.cancelled
          ? "실행 취소 — 루프 정지 (포지션 수동 확인)"
          : "킬 스위치 — 루프 정지 (포지션 수동 확인). 해제 후 재시도하면 실패 지점부터 이어갑니다",
      });
      if (!CONFIG.DRY_RUN) {
        void notifyNow(`🛑 <b>${eng.opp.base}</b> 실행 정지 — 킬 스위치/취소. 거래소 실포지션·헷지 수동 확인 필요`);
      }
      eng.busy = false;
      return;
    }
    if (eng.unwindLock) { // 청산이 이 런의 물량을 만지는 중 — 매도 경합 금지
      patch(id, { phase: "paused", pauseAt: eng.i, error: "청산 진행 중 — 실행 일시 정지" });
      eng.busy = false;
      return;
    }
    const i = eng.i;
    const step = run().plan[i];

    if (needsConfirmBefore(step, run().autoLevel) && !eng.confirmed.has(i)) {
      patch(id, { pauseAt: i, phase: "paused" });
      eng.busy = false;
      return;
    }

    if (REVALIDATE_STEPS.has(step.id)) {
      const v = await revalidate(eng, run().sizeUsd);
      if (eng.cancelled) { eng.busy = false; return; }
      if (!v.ok) {
        patch(id, {
          statuses: { ...run().statuses, [step.id]: "error" },
          messages: { ...run().messages, [step.id]: `재검증 실패: ${v.reason ?? "엣지 소멸"}` },
          error: `실행 중단 — ${v.reason ?? "엣지 소멸"} (${step.label} 직전 재확인)`,
          pauseAt: i, phase: "error",
        });
        eng.busy = false;
        return;
      }
    }

    patch(id, { statuses: { ...run().statuses, [step.id]: "running" } });
    const stepT0 = Date.now();
    if (!eng.stepFirstAt.has(i)) eng.stepFirstAt.set(i, stepT0);
    let r: { ok: boolean; message?: string; tx?: TxRef; ambiguous?: boolean; pending?: boolean; replayed?: boolean };
    try { r = await callStep(id, eng, step.id); }
    catch (e) { r = { ok: false, message: e instanceof Error ? e.message : "실패" }; }
    eng.durations[step.id] = Math.round((Date.now() - stepT0) / 1000);
    if (eng.cancelled) { eng.busy = false; return; }

    const upd: Partial<RunView> = {};
    if (r.message) upd.messages = { ...run().messages, [step.id]: r.message };
    if (r.tx) upd.txs = { ...run().txs, [step.id]: r.tx };

    // Deposit not credited yet is NOT a failure — a transfer takes minutes.
    // Wait and poll instead of erroring out. Previously each "입금 대기" counted
    // toward the circuit breaker, so the normal kimchi flow auto-enabled the kill
    // switch after three retries.
    if (!r.ok && r.pending) {
      // Measured from when THIS step first ran — not from run entry, so a slow
      // earlier leg doesn't eat the arrival window.
      const firstAt = eng.stepFirstAt.get(i) ?? stepT0;
      const waited = Math.round((Date.now() - firstAt) / 1000);
      if (waited > DEPOSIT_WAIT_MAX_SEC) {
        patch(id, {
          statuses: { ...run().statuses, [step.id]: "error" },
          messages: upd.messages ?? run().messages,
          error: `${step.label} 미확인 ${Math.round(waited / 60)}분 초과 — 수동 확인 필요 (헷지 유지)`,
          pauseAt: i, phase: "error",
        });
        if (!CONFIG.DRY_RUN) void notifyNow(`⏰ <b>${eng.opp.base}</b> ${step.label}이 ${Math.round(waited / 60)}분째 미확인 — 수동 확인 필요`);
        eng.busy = false;
        return;
      }
      patch(id, {
        statuses: { ...run().statuses, [step.id]: "running" },
        messages: { ...(upd.messages ?? run().messages), [step.id]: `${r.message ?? "대기 중"} (${waited}초 경과 · 자동 재확인)` },
        phase: "running", error: null,
      });
      await sleep(DEPOSIT_POLL_MS);
      continue; // 같은 단계 재확인 — eng.i 전진하지 않음
    }

    if (!r.ok) {
      const statuses = { ...run().statuses, [step.id]: "error" as StepPhase };
      const messages = { ...(upd.messages ?? run().messages) };
      // Rollback is allowed only BEFORE the first irreversible step, and never
      // when the outcome is ambiguous (the venue may have accepted it — rolling
      // back would dump coin that is already gone).
      const irrIdx = firstIrreversibleIdx(run().plan);
      const beforeIrreversible = irrIdx === -1 ? true : i <= irrIdx;
      const canRollback = beforeIrreversible && !r.ambiguous;
      let allOk = true;
      if (canRollback) {
        for (let j = i - 1; j >= 0; j--) {
          const sid = run().plan[j].id;
          // Only undo steps that actually COMPLETED. Dispatching on step id alone
          // re-sold an entry that a previous rollback had already unwound.
          if ((sid === "buy" || sid === "hedge") && run().statuses[sid] === "done") {
            let rb: { ok: boolean; message?: string };
            try { rb = await callStep(id, eng, sid, { rollback: true }); }
            catch (e) { rb = { ok: false, message: e instanceof Error ? e.message : "롤백 실패" }; }
            allOk = allOk && rb.ok;
            statuses[sid] = rb.ok ? "rolledback" : "error";
            messages[sid] = `${messages[sid] ?? ""} · ${rb.ok ? "롤백됨" : `롤백 실패(${rb.message ?? "?"}) — 수동`}`;
            eng.done.delete(j); // 되돌린 단계는 "완료"가 아니다
            eng.rolledBack = true;
          }
        }
        patch(id, {
          statuses, messages, txs: upd.txs ?? run().txs,
          error: `${r.message ?? "단계 실패"} — ${allOk ? "진입 롤백 완료 (재시도 불가: 새 실행으로 진입하세요)" : "⚠ 일부 롤백 실패, 수동 확인"}`,
          pauseAt: i, phase: "error", remaining: allOk ? 0 : run().remaining,
        });
      } else {
        const why = r.ambiguous
          ? "결과 불명(전송 후 오류) — 거래소에서 실제 처리 여부를 먼저 확인하세요. 자동 재시도·롤백 모두 차단"
          : "비가역 단계 이후: 헷지 유지, 수동 처리 필요";
        patch(id, { statuses, messages, txs: upd.txs ?? run().txs, error: `${r.message ?? "단계 실패"} — ${why}`, pauseAt: i, phase: "error" });
        if (r.ambiguous && !CONFIG.DRY_RUN) {
          void notifyNow(`❓ <b>${eng.opp.base}</b> ${step.label} 결과 불명 — 거래소 내역 확인 필요 (자동 재시도 차단)`);
        }
      }
      // 서킷 브레이커 — 실집행 실패만. 방어적 중단(리스크·슬리피지·게이트)은 제외.
      if (isExecFailure(r)) recordExecFailure(run().base, step.label);
      eng.busy = false;
      return;
    }

    upd.statuses = { ...run().statuses, [step.id]: "done" };
    // Entry step (buy, or swap on the buyDex plan) establishes the position size.
    if (step.id === "buy" || (step.id === "swap" && eng.opp.legs.find((l) => l.venue === "dex")?.side === "buy")) {
      const price = eng.opp.legs.find((l) => l.quote === "USDT")?.price ?? 0;
      const tq = eng.qty ?? (price ? run().sizeUsd / price : 0);
      upd.totalQty = tq; upd.remaining = tq;
    }
    if (step.id === "sell" || step.id === "settle") upd.remaining = 0;
    patch(id, upd);
    eng.i = i + 1;
  }
  patch(id, { phase: "done", pauseAt: -1 });
  eng.busy = false;
}

// ── public actions (API 라우트가 호출) ────────────────────────────────────────
export type StartResult = { id: string } | { error: string };

export function startRun(cfg: { opp: Opportunity; sizeUsd: number; hedge: boolean; autoLevel: AutoLevel }): StartResult {
  if (isKilled()) return { error: "킬 스위치 활성 — 신규 실행 차단" };
  if (cfg.opp.mock && !CONFIG.DRY_RUN) return { error: "목업 기회는 실행 불가" };
  // 같은 코인으로 활성 런이 이미 있으면 거부 — 동시 진행은 헷지 수량·재고를
  // 꼬이게 한다. (error 런은 사용자가 인지·정리하는 상태라 허용.)
  const dup = hasOpenPosition(cfg.opp.base);
  if (dup) {
    return {
      error: dup.phase === "running" || dup.phase === "paused"
        ? `${cfg.opp.base} 이미 실행 중 — 중복 실행 차단 (진행 중 런을 먼저 처리)`
        : `${cfg.opp.base} 미정리 포지션 있음 (${dup.remaining > 0 ? `잔량 ${dup.remaining.toFixed(6)}` : "헷지 열림"}) — 청산·정리 후 실행하세요`,
    };
  }
  const cap = getLimits().maxInFlightUsd;
  if (Number.isFinite(cap) && cap > 0 && inFlightUsd() + cfg.sizeUsd > cap) {
    return { error: `총 노출 한도 초과 (진행 중 $${inFlightUsd().toFixed(0)} + $${cfg.sizeUsd.toFixed(0)} > $${cap.toFixed(0)})` };
  }
  const id = `run_${++E.seq}_${cfg.opp.base}`;
  const plan = buildPlan(cfg.opp, cfg.hedge);
  const buy = cfg.opp.legs.find((l) => l.side === "buy");
  const sell = cfg.opp.legs.find((l) => l.side === "sell");
  E.runs[id] = {
    id, opp: cfg.opp, base: cfg.opp.base, kind: cfg.opp.kind,
    route: `${buy?.venue ?? "?"} → ${sell?.venue ?? "?"}`,
    sizeUsd: cfg.sizeUsd, hedge: cfg.hedge, autoLevel: cfg.autoLevel, plan,
    statuses: {}, messages: {}, txs: {}, phase: "running", pauseAt: -1, error: null,
    startedAt: Date.now(), totalQty: 0, remaining: 0, pnlUsd: 0, unwindLog: [], unwinding: false,
  };
  E.engines.set(id, {
    cancelled: false, killEpoch: E.killEpoch, busy: false, i: 0, confirmed: new Set(),
    startTs: 0, fills: {}, durations: {}, done: new Map(), stepFirstAt: new Map(),
    rolledBack: false, unwindLock: false, opp: cfg.opp,
  });
  trimRuns();
  persistRuns();
  void loop(id);
  return { id };
}

export function confirmRun(id: string) {
  const eng = E.engines.get(id);
  if (!eng || eng.busy) return;
  eng.confirmed.add(eng.i);
  patch(id, { pauseAt: -1 });
  void loop(id);
}

export type RetryResult = { ok: true } | { error: string };
export function retryRun(id: string): RetryResult {
  const eng = E.engines.get(id);
  if (!eng) return { error: "엔진 없음 — 재시작으로 끊긴 런은 재개할 수 없습니다 (수동 확인)" };
  if (eng.busy) return { error: "실행 중" };
  if (E.runs[id]?.phase !== "error") return { error: "오류 상태의 런만 재시도할 수 있습니다" };
  // A run whose entry was already unwound must not be resumed: the next step
  // would re-open the hedge against a position that no longer exists, and the
  // following failure would market-sell again.
  if (eng.rolledBack) {
    return { error: "진입이 롤백된 런입니다 — 재시도 불가. 보드에서 새로 실행하세요" };
  }
  const st = E.runs[id]?.statuses ?? {};
  const amb = Object.entries(st).find(([, v]) => v === "error");
  if (amb && /결과 불명/.test(E.runs[id]?.error ?? "")) {
    return { error: "결과 불명 단계 — 거래소 내역을 먼저 확인하고, 필요하면 수동 처리하세요" };
  }
  if (isKilled()) return { error: "킬 스위치 활성 — 먼저 해제하세요" };
  eng.killEpoch = E.killEpoch; // 해제된 킬 세대에 맞춰 재개 허용
  eng.cancelled = false;
  patch(id, { error: null, pauseAt: -1 });
  void loop(id);
  return { ok: true };
}

export type CancelResult = { ok: true } | { error: string };
/** Stop the loop and remove the run. Refuses while the run still holds a
 *  position or an open hedge — deleting it made the exposure invisible: unwind
 *  became unreachable and the hedge-margin watcher (which iterates E.runs)
 *  stopped watching it. `force` is the operator saying "I closed it manually". */
export function cancelRun(id: string, force = false): CancelResult {
  const run = E.runs[id];
  const eng = E.engines.get(id);
  if (run && !force) {
    const openHedge = run.statuses.hedge === "done" && run.statuses.close !== "done";
    if (run.remaining > 0 || openHedge) {
      if (eng) eng.cancelled = true; // 루프는 즉시 세우되 런은 남긴다
      patch(id, {
        phase: "error",
        error: `실행 중단됨 — ${run.remaining > 0 ? `잔량 ${run.remaining.toFixed(6)} ${run.base}` : ""}${openHedge ? " · 헷지 열림" : ""} 보유. 청산하거나 수동 정리 후 삭제하세요`,
      });
      return { error: "포지션/헷지가 남아 있어 삭제하지 않았습니다 — 청산 또는 수동 정리 후 삭제" };
    }
  }
  if (eng) eng.cancelled = true;
  delete E.runs[id];
  E.engines.delete(id);
  persistRuns();
  return { ok: true };
}

export function clearFinished() {
  for (const [id, run] of Object.entries(E.runs)) {
    // done + 재시작으로 엔진을 잃은 error 런(루프 재개 불가)도 정리 대상
    if (run.phase === "done" || (run.phase === "error" && !E.engines.has(id))) {
      E.engines.delete(id);
      delete E.runs[id];
    }
  }
  persistRuns();
}

export async function unwindRun(id: string, fraction: number) {
  const run = E.runs[id];
  if (!run || run.unwinding || run.remaining <= 0) return;
  const eng = E.engines.get(id);
  // The loop and an unwind must never touch the same position concurrently:
  // unwinding while the loop is mid-`sell` (or paused right before it) sold the
  // same quantity twice, and the loop's `remaining = 0` could be overwritten by
  // this function's stale captured value, resurrecting a phantom position.
  if (eng?.busy) return;
  if (eng) eng.unwindLock = true;
  patch(id, { unwinding: true });
  try {
    const result = await unwind(run.opp, run.remaining, fraction);
    // Re-read: `run` was captured before a multi-second await.
    const cur = E.runs[id] ?? run;
    patch(id, {
      remaining: result.remainingQty,
      pnlUsd: cur.pnlUsd + (result.pnlUsd ?? 0),
      unwindLog: [...cur.unwindLog, ...(result.log ?? [])],
      unwinding: false,
    });
  } catch (e) {
    const cur = E.runs[id] ?? run;
    patch(id, { unwindLog: [...cur.unwindLog, `청산 오류: ${e instanceof Error ? e.message : "?"}`], unwinding: false });
  } finally {
    if (eng) eng.unwindLock = false;
  }
}

/** Kill switch. Enabling bumps the epoch so every RUNNING loop stops at its next
 *  checkpoint; releasing does NOT resurrect them (the operator retries
 *  explicitly), but it no longer leaves them permanently unretryable — the old
 *  version set a per-engine `cancelled` flag that was never cleared anywhere. */
export function setEngineKill(v: boolean) {
  setKilled(v);
  if (v) E.killEpoch++;
}

export function snapshot() {
  return {
    runs: E.runs,
    killed: isKilled(),
    inFlightUsd: inFlightUsd(),
    maxInFlightUsd: getLimits().maxInFlightUsd,
  };
}

// ── 헷지 마진 워치 (서버 상주 — 탭 무관) ─────────────────────────────────────
// 헷지 열림 + 미청산 런이 있으면 60초마다 선물 가용 마진 점검, 30% 미만 경보.
const gW = globalThis as unknown as { __arbHedgeWatchSrv?: boolean };
if (!gW.__arbHedgeWatchSrv) {
  gW.__arbHedgeWatchSrv = true;
  setInterval(() => {
    void (async () => {
      try {
        const active = Object.values(E.runs).filter(
          (r) => r.hedge && r.statuses.hedge === "done" && r.statuses.close !== "done"
            && (r.phase === "running" || r.phase === "paused" || r.phase === "error"),
        );
        if (!active.length) return;
        const notional = active.reduce((s, r) => s + r.sizeUsd, 0);
        const { binanceFuturesFree } = await import("./orders");
        const free = await binanceFuturesFree();
        if (free !== null && free < notional * 0.3) {
          void notify("hedge:margin", `🚨 헷지 증거금 경보 — 선물 가용 $${free.toFixed(0)} / 헷지 명목 $${notional.toFixed(0)}. 증거금 추가 또는 부분 청산 검토.`);
        }
      } catch { /* next tick */ }
    })();
  }, 60_000);
}
