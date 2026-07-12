"use client";

// Background execution store. The runner used to live inside ExecuteModal, so
// closing the modal unmounted it and killed the trade. This module-level store
// owns every run's state machine and drives its loop independently of any
// component — so runs keep going in the background, and a dashboard can list
// them. Components subscribe via useRuns() (useSyncExternalStore).

import { useSyncExternalStore } from "react";
import type { Opportunity } from "./types";
import {
  buildPlan, needsConfirmBeforePublic as needsConfirmBefore, REVALIDATE_STEPS,
  type AutoLevel, type ExecStep, type StepId, type StepPhase, type RunPhase,
} from "./executionPlan";

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
  // Position (smart unwind), meaningful once buy is done and not full-auto.
  totalQty: number;
  remaining: number;
  pnlUsd: number;
  unwindLog: string[];
  unwinding: boolean;
};

// Non-reactive per-run engine record (refs the loop mutates).
type Engine = {
  cancelled: boolean;
  busy: boolean;
  i: number;
  confirmed: Set<number>;
  qty?: number;
  startTs: number;
  fills: { buyQuote?: number; buyCcy?: string; sellQuote?: number; sellCcy?: string };
  opp: Opportunity;
};

type Store = { runs: Record<string, RunView>; killed: boolean };
const g = globalThis as unknown as {
  __arbRuns?: { store: Store; engines: Map<string, Engine>; listeners: Set<() => void>; seq: number };
};
g.__arbRuns ??= { store: { runs: {}, killed: false }, engines: new Map(), listeners: new Set(), seq: 0 };
const R = g.__arbRuns;

function emit() {
  R.store = { ...R.store, runs: { ...R.store.runs } };
  R.listeners.forEach((l) => l());
}
function patch(id: string, p: Partial<RunView>) {
  const cur = R.store.runs[id];
  if (!cur) return;
  R.store.runs[id] = { ...cur, ...p };
  emit();
}


// ── Step / revalidate primitives (per run) ────────────────────────────────────
async function callStep(id: string, eng: Engine, stepId: StepId, opts?: { rollback?: boolean }) {
  if (stepId === "buy" && !opts?.rollback) {
    eng.qty = undefined;
    eng.fills = {};
    eng.startTs = Date.now();
  }
  const res = await fetch("/api/exec-step", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      stepId, opportunity: eng.opp, sizeUsd: R.store.runs[id]?.sizeUsd ?? 0,
      rollback: opts?.rollback, qty: eng.qty, sinceTs: eng.startTs || undefined,
      fills: stepId === "settle" ? eng.fills : undefined,
    }),
  });
  const j = await res.json();
  if (typeof j.filledQty === "number" && j.filledQty > 0) eng.qty = j.filledQty;
  if (j.fill?.quote && !opts?.rollback) {
    if (stepId === "buy") { eng.fills.buyQuote = j.fill.quote; eng.fills.buyCcy = j.fill.ccy; }
    if (stepId === "sell") { eng.fills.sellQuote = j.fill.quote; eng.fills.sellCcy = j.fill.ccy; }
  }
  return { ok: !!j.ok, message: j.message as string | undefined, tx: j.tx as TxRef | undefined };
}

async function revalidate(eng: Engine, sizeUsd: number) {
  if (eng.opp.mock) return { ok: true };
  try {
    const res = await fetch("/api/quote", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ opportunity: eng.opp, sizeUsd }),
    });
    const j = await res.json();
    const q = j.quote;
    if (!q) return { ok: false, reason: "실호가 재조회 실패" };
    if (q.execNetPct <= 0) return { ok: false, reason: `순수익 ${q.execNetPct.toFixed(2)}%로 하락` };
    return { ok: true };
  } catch {
    return { ok: false, reason: "재견적 요청 실패" };
  }
}

// ── The loop ──────────────────────────────────────────────────────────────────
async function loop(id: string) {
  const eng = R.engines.get(id);
  if (!eng || eng.busy) return;
  eng.busy = true;
  const run = () => R.store.runs[id];
  patch(id, { phase: "running", error: null });

  while (eng.i < run().plan.length) {
    if (eng.cancelled) { eng.busy = false; return; }
    const i = eng.i;
    const step = run().plan[i];

    if (needsConfirmBefore(step.id, run().autoLevel) && !eng.confirmed.has(i)) {
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
    let r: { ok: boolean; message?: string; tx?: TxRef };
    try { r = await callStep(id, eng, step.id); }
    catch (e) { r = { ok: false, message: e instanceof Error ? e.message : "실패" }; }
    if (eng.cancelled) { eng.busy = false; return; }

    const upd: Partial<RunView> = {};
    if (r.message) upd.messages = { ...run().messages, [step.id]: r.message };
    if (r.tx) upd.txs = { ...run().txs, [step.id]: r.tx };

    if (!r.ok) {
      const statuses = { ...run().statuses, [step.id]: "error" as StepPhase };
      const withdrawIdx = run().plan.findIndex((s) => s.id === "withdraw");
      const messages = { ...(upd.messages ?? run().messages) };
      let allOk = true;
      if (i <= withdrawIdx) {
        for (let j = i - 1; j >= 0; j--) {
          const sid = run().plan[j].id;
          if (sid === "buy" || sid === "hedge") {
            let rb: { ok: boolean; message?: string };
            try { rb = await callStep(id, eng, sid, { rollback: true }); }
            catch (e) { rb = { ok: false, message: e instanceof Error ? e.message : "롤백 실패" }; }
            allOk = allOk && rb.ok;
            statuses[sid] = rb.ok ? "rolledback" : "error";
            messages[sid] = `${messages[sid] ?? ""} · ${rb.ok ? "롤백됨" : `롤백 실패(${rb.message ?? "?"}) — 수동`}`;
          }
        }
        patch(id, { statuses, messages, error: `${r.message ?? "단계 실패"} — ${allOk ? "진입 롤백 완료" : "⚠ 일부 롤백 실패, 수동 확인"}`, pauseAt: i, phase: "error" });
      } else {
        patch(id, { statuses, messages, error: `${r.message ?? "단계 실패"} — 출금 이후: 헷지 유지, 수동 처리 필요`, pauseAt: i, phase: "error" });
      }
      eng.busy = false;
      return;
    }

    upd.statuses = { ...run().statuses, [step.id]: "done" };
    // Seed the position when the buy fills (for smart unwind display).
    if (step.id === "buy") {
      const price = eng.opp.legs.find((l) => l.quote === "USDT")?.price ?? 0;
      const tq = eng.qty ?? (price ? run().sizeUsd / price : 0);
      upd.totalQty = tq; upd.remaining = tq;
    }
    patch(id, upd);
    eng.i = i + 1;
  }
  patch(id, { phase: "done", pauseAt: -1 });
  eng.busy = false;
}

// ── Public actions ────────────────────────────────────────────────────────────
export function startRun(cfg: { opp: Opportunity; sizeUsd: number; hedge: boolean; autoLevel: AutoLevel }): string {
  const id = `run_${++R.seq}_${cfg.opp.base}`;
  const plan = buildPlan(cfg.opp, cfg.hedge);
  const buy = cfg.opp.legs.find((l) => l.side === "buy");
  const sell = cfg.opp.legs.find((l) => l.side === "sell");
  R.store.runs[id] = {
    id, opp: cfg.opp, base: cfg.opp.base, kind: cfg.opp.kind,
    route: `${buy?.venue ?? "?"} → ${sell?.venue ?? "?"}`,
    sizeUsd: cfg.sizeUsd, hedge: cfg.hedge, autoLevel: cfg.autoLevel, plan,
    statuses: {}, messages: {}, txs: {}, phase: "running", pauseAt: -1, error: null,
    startedAt: Date.now(), totalQty: 0, remaining: 0, pnlUsd: 0, unwindLog: [], unwinding: false,
  };
  R.engines.set(id, {
    cancelled: false, busy: false, i: 0, confirmed: new Set(),
    startTs: 0, fills: {}, opp: cfg.opp,
  });
  emit();
  void loop(id);
  return id;
}

export function confirmRun(id: string) {
  const eng = R.engines.get(id);
  if (!eng || eng.busy) return;
  eng.confirmed.add(eng.i);
  patch(id, { pauseAt: -1 });
  void loop(id);
}

export function retryRun(id: string) {
  const eng = R.engines.get(id);
  if (!eng || eng.busy || R.store.runs[id]?.phase !== "error") return;
  patch(id, { error: null, pauseAt: -1 });
  void loop(id);
}

export function cancelRun(id: string) {
  const eng = R.engines.get(id);
  if (eng) eng.cancelled = true;
  delete R.store.runs[id];
  R.engines.delete(id);
  emit();
}

export function clearFinished() {
  for (const [id, run] of Object.entries(R.store.runs)) {
    if (run.phase === "done") { R.engines.delete(id); delete R.store.runs[id]; }
  }
  emit();
}

/** Partial smart-unwind on a run's remaining position (calls /api/unwind). */
export async function unwindRun(id: string, fraction: number) {
  const run = R.store.runs[id];
  const eng = R.engines.get(id);
  if (!run || !eng || run.unwinding || run.remaining <= 0) return;
  patch(id, { unwinding: true });
  try {
    const res = await fetch("/api/unwind", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ opportunity: eng.opp, remainingQty: run.remaining, fraction }),
    });
    const j = await res.json();
    if (j.result) {
      patch(id, {
        remaining: j.result.remainingQty,
        pnlUsd: run.pnlUsd + (j.result.pnlUsd ?? 0),
        unwindLog: [...run.unwindLog, ...(j.result.log ?? [])],
        unwinding: false,
      });
    } else {
      patch(id, { unwindLog: [...run.unwindLog, `청산 실패: ${j.error ?? "?"}`], unwinding: false });
    }
  } catch (e) {
    patch(id, { unwindLog: [...run.unwindLog, `청산 오류: ${e instanceof Error ? e.message : "?"}`], unwinding: false });
  }
}

// ── Kill switch (mirrors server flag, halts all local loops) ──────────────────
export async function setKillSwitch(v: boolean) {
  R.store.killed = v;
  if (v) for (const eng of R.engines.values()) eng.cancelled = true;
  emit();
  try {
    await fetch("/api/kill", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ killed: v }) });
  } catch { /* ignore */ }
}

// ── Subscription ──────────────────────────────────────────────────────────────
function subscribe(cb: () => void) { R.listeners.add(cb); return () => R.listeners.delete(cb); }
function getSnapshot() { return R.store; }
const server: Store = { runs: {}, killed: false };

export function useRuns() {
  return useSyncExternalStore(subscribe, getSnapshot, () => server);
}
