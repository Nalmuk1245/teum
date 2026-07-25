"use client";

// 실행 스토어 — 이제 "미러"다. 실행 상태머신은 서버(lib/runEngine)가 소유하고,
// 여기는 /api/runs를 폴링해 UI에 비추고 액션을 위임할 뿐이다. 탭을 닫아도
// 런은 서버에서 계속 간다. 기존 컴포넌트 호환을 위해 export 표면은 유지
// (startRun만 async로 바뀜 — 서버 왕복이 생겼으므로).

import { useSyncExternalStore } from "react";
import type { Opportunity } from "./types";
import type { AutoLevel } from "./execPlan";
import type { RunView, TxRef, StartResult } from "./runEngine";

export type { RunView, TxRef, StartResult };

type Store = { runs: Record<string, RunView>; killed: boolean; maxInFlightUsd: number };

const g = globalThis as unknown as {
  __arbRunsMirror?: { store: Store; listeners: Set<() => void>; timer: ReturnType<typeof setInterval> | null; fetching: boolean };
};
g.__arbRunsMirror ??= { store: { runs: {}, killed: false, maxInFlightUsd: Infinity }, listeners: new Set(), timer: null, fetching: false };
const M = g.__arbRunsMirror;

const POLL_MS = 2500;

// 라이브 액션 인증 토큰 — 설정창에서 localStorage에 저장해둔 값.
function execToken(): string | null {
  try { return localStorage.getItem("ac.execToken"); } catch { return null; }
}
function headers(): Record<string, string> {
  const t = execToken();
  return { "content-type": "application/json", ...(t ? { "x-exec-token": t } : {}) };
}

function apply(j: unknown) {
  const d = j as { runs?: Record<string, RunView>; killed?: boolean; maxInFlightUsd?: number };
  if (!d || typeof d !== "object" || !d.runs) return;
  const next = {
    runs: d.runs,
    killed: !!d.killed,
    maxInFlightUsd: typeof d.maxInFlightUsd === "number" && d.maxInFlightUsd > 0 ? d.maxInFlightUsd : Infinity,
  };
  // useSyncExternalStore compares by identity, so publishing a brand-new object
  // every 2.5s re-rendered the page and the execute modal unconditionally — ~24
  // renders/min even with `runs: {}`, which is the normal idle state.
  if (
    M.store.killed === next.killed &&
    M.store.maxInFlightUsd === next.maxInFlightUsd &&
    sameRuns(M.store.runs, next.runs)
  ) return;
  M.store = next;
  M.listeners.forEach((l) => l());
}

/** Cheap structural compare of the run map — enough to catch any change the UI
 *  shows (phase, step statuses/messages, tx chips, quantities, P&L). */
function sameRuns(a: Record<string, RunView>, b: Record<string, RunView>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const x = a[k], y = b[k];
    if (!y) return false;
    if (
      x.phase !== y.phase || x.pauseAt !== y.pauseAt || x.error !== y.error ||
      x.remaining !== y.remaining || x.totalQty !== y.totalQty || x.pnlUsd !== y.pnlUsd ||
      x.unwinding !== y.unwinding || x.unwindLog.length !== y.unwindLog.length
    ) return false;
    // Step-level maps are small (≤8 entries); stringify is fine and exact.
    if (JSON.stringify(x.statuses) !== JSON.stringify(y.statuses)) return false;
    if (JSON.stringify(x.messages) !== JSON.stringify(y.messages)) return false;
    if (JSON.stringify(x.txs) !== JSON.stringify(y.txs)) return false;
  }
  return true;
}

async function refresh() {
  if (M.fetching) return;
  M.fetching = true;
  try {
    const res = await fetch("/api/runs", { cache: "no-store" });
    apply(await res.json());
  } catch { /* 다음 폴에서 */ } finally {
    M.fetching = false;
  }
}

async function action(body: Record<string, unknown>): Promise<{ error?: string; id?: string }> {
  try {
    const res = await fetch("/api/runs", { method: "POST", headers: headers(), body: JSON.stringify(body) });
    const j = (await res.json()) as { error?: string; id?: string };
    apply(j); // 액션 응답에 최신 스냅샷 동봉
    return j;
  } catch (e) {
    return { error: e instanceof Error ? e.message : "요청 실패" };
  }
}

function ensurePolling() {
  if (M.timer || typeof window === "undefined") return;
  M.timer = setInterval(() => {
    if (document.visibilityState === "visible") void refresh();
  }, POLL_MS);
  void refresh();
}

// ── 컴포넌트 표면 (기존 API 유지) ─────────────────────────────────────────────
export function inFlightUsd(): number {
  return Object.values(M.store.runs)
    .filter((r) => r.phase === "running" || r.phase === "paused")
    .reduce((s, r) => s + r.sizeUsd, 0);
}

/** 서버 리스크 설정 미러 (한도 집행은 서버가 한다 — 여기는 표시용). */
export function setInFlightLimit(usd: number) {
  M.store = { ...M.store, maxInFlightUsd: Number.isFinite(usd) && usd > 0 ? usd : Infinity };
  M.listeners.forEach((l) => l());
}

export async function startRun(cfg: { opp: Opportunity; sizeUsd: number; hedge: boolean; autoLevel: AutoLevel }): Promise<StartResult> {
  const j = await action({ action: "start", opp: cfg.opp, sizeUsd: cfg.sizeUsd, hedge: cfg.hedge, autoLevel: cfg.autoLevel });
  if (j.error) return { error: j.error };
  if (!j.id) return { error: "시작 실패" };
  return { id: j.id };
}

export function confirmRun(id: string) { void action({ action: "confirm", id }); }
// retry/cancel can be refused server-side (rolled-back run, ambiguous step,
// position still open). Return the reason so the modal can show it instead of
// the click appearing to do nothing.
export async function retryRun(id: string): Promise<{ error?: string }> {
  const j = await action({ action: "retry", id });
  return j.error ? { error: j.error } : {};
}
export async function cancelRun(id: string, force = false): Promise<{ error?: string }> {
  const j = await action({ action: "cancel", id, force });
  return j.error ? { error: j.error } : {};
}
export function clearFinished() { void action({ action: "clear" }); }

export async function unwindRun(id: string, fraction: number) {
  await action({ action: "unwind", id, fraction });
}

export async function setKillSwitch(v: boolean) {
  // 낙관적 반영 — 비상 정지는 화면이 즉시 바뀌어야 한다
  M.store = { ...M.store, killed: v };
  M.listeners.forEach((l) => l());
  await action({ action: "kill", killed: v });
}

// ── 구독 ──────────────────────────────────────────────────────────────────────
const server: Store = { runs: {}, killed: false, maxInFlightUsd: Infinity };
function subscribe(cb: () => void) {
  M.listeners.add(cb);
  ensurePolling();
  return () => M.listeners.delete(cb);
}
function getSnapshot() { return M.store; }

export function useRuns() {
  return useSyncExternalStore(subscribe, getSnapshot, () => server);
}
