"use client";

// Execution flow — 클라이언트 훅(useFlowRunner)만 남기고 순수 로직은
// execPlan.ts로 이동 (서버 실행엔진과 공유). 기존 임포트 호환을 위해 재수출.

import { useEffect, useRef, useState } from "react";
export * from "./execPlan";
import {
  needsConfirmBeforePublic as needsConfirmBefore,
  type StepId, type ExecStep, type StepPhase, type RunPhase,
  type StepResult, type AutoLevel, type Revalidation,
} from "./execPlan";

// Steps that must re-check the edge right before firing — the quote on screen
// can be minutes old by the time these run.
const REVALIDATE_BEFORE = new Set<StepId>(["buy", "withdraw", "sell", "swap"]);

/**
 * Pausable sequential runner. Each step calls `runStep` (which POSTs to the
 * server step-executor); without one it falls back to a ~600ms simulation. A
 * failing step marks itself error and halts; entry legs auto-unwind pre-withdraw.
 *
 * Integrity: `start()` SNAPSHOTS steps/runStep/revalidate into refs — edits to
 * size/hedge/autoLevel mid-run cannot change what an in-flight run executes.
 */
export function useFlowRunner(
  steps: ExecStep[],
  level: AutoLevel,
  runStep?: (stepId: StepId, opts?: { rollback?: boolean }) => Promise<StepResult>,
  revalidate?: () => Promise<Revalidation>,
) {
  const [statuses, setStatuses] = useState<Record<string, StepPhase>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [txs, setTxs] = useState<Record<string, NonNullable<StepResult["tx"]>>>({});
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [pauseAt, setPauseAt] = useState(-1);
  const [error, setError] = useState<string | null>(null);

  const iRef = useRef(0);
  const confirmed = useRef<Set<number>>(new Set());
  const busy = useRef(false);
  const alive = useRef(true);
  // Frozen at start() — the run executes exactly what was on screen at start.
  const snap = useRef<{
    steps: ExecStep[];
    runStep?: typeof runStep;
    revalidate?: typeof revalidate;
    level: AutoLevel;
  } | null>(null);
  // Set true on (re)mount too — under React StrictMode the effect runs
  // mount→cleanup→mount, so a cleanup-only version would latch alive=false.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const set = (id: string, s: StepPhase) =>
    alive.current && setStatuses((prev) => ({ ...prev, [id]: s }));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const loop = async () => {
    if (busy.current) return;
    const S = snap.current;
    if (!S) return;
    busy.current = true;
    if (alive.current) { setPhase("running"); setError(null); }
    while (iRef.current < S.steps.length) {
      const i = iRef.current;
      const step = S.steps[i];
      if (needsConfirmBefore(step.id, S.level) && !confirmed.current.has(i)) {
        if (alive.current) { setPauseAt(i); setPhase("paused"); }
        busy.current = false;
        return;
      }
      // Stale-edge guard: re-quote before committing capital / the irreversible
      // withdraw / the final sell. Abort (pause as error) if the edge died.
      if (S.revalidate && REVALIDATE_BEFORE.has(step.id) && step.id !== "settle") {
        let v: Revalidation;
        try {
          v = await S.revalidate();
        } catch (e) {
          v = { ok: false, reason: e instanceof Error ? e.message : "재검증 실패" };
        }
        if (!alive.current) { busy.current = false; return; }
        if (!v.ok) {
          set(step.id, "error");
          setMessages((m) => ({ ...m, [step.id]: `재검증 실패: ${v.reason ?? "엣지 소멸"}` }));
          setError(`실행 중단 — ${v.reason ?? "엣지가 사라졌습니다"} (${step.label} 직전 재확인)`);
          setPauseAt(i);
          setPhase("error");
          busy.current = false;
          return;
        }
      }
      set(step.id, "running");
      let r: StepResult;
      try {
        r = S.runStep ? await S.runStep(step.id) : (await sleep(600), { ok: true });
      } catch (e) {
        r = { ok: false, message: e instanceof Error ? e.message : "실패" };
      }
      if (!alive.current) { busy.current = false; return; }
      if (r.message) setMessages((m) => ({ ...m, [step.id]: r.message! }));
      if (r.tx) setTxs((t) => ({ ...t, [step.id]: r.tx! }));
      if (!r.ok) {
        set(step.id, "error");
        // Partial-fill rollback — only BEFORE the irreversible withdraw
        // completed. Unwind completed entry legs (buy/hedge) in reverse, and
        // REPORT each rollback's actual result instead of assuming success.
        const withdrawIdx = S.steps.findIndex((s) => s.id === "withdraw");
        if (i <= withdrawIdx && S.runStep) {
          let allOk = true;
          for (let j = i - 1; j >= 0; j--) {
            if (S.steps[j].id === "buy" || S.steps[j].id === "hedge") {
              let rb: StepResult;
              try {
                rb = await S.runStep(S.steps[j].id, { rollback: true });
              } catch (e) {
                rb = { ok: false, message: e instanceof Error ? e.message : "롤백 실패" };
              }
              if (!alive.current) { busy.current = false; return; }
              allOk = allOk && rb.ok;
              set(S.steps[j].id, rb.ok ? "rolledback" : "error");
              setMessages((m) => ({
                ...m,
                [S.steps[j].id]: `${m[S.steps[j].id] ?? ""} · ${rb.ok ? "롤백됨" : `롤백 실패(${rb.message ?? "?"}) — 수동 처리`}`,
              }));
            }
          }
          setError(`${r.message ?? "단계 실패"} — ${allOk ? "진입 롤백 완료" : "⚠ 일부 롤백 실패, 수동 확인 필요"}`);
        } else {
          setError(`${r.message ?? "단계 실패"} — 출금 이후: 헷지 유지, 수동 처리 필요`);
        }
        setPauseAt(i);
        setPhase("error");
        busy.current = false;
        return;
      }
      set(step.id, "done");
      iRef.current = i + 1;
    }
    if (alive.current) { setPhase("done"); setPauseAt(-1); }
    busy.current = false;
  };

  const start = () => {
    if (busy.current) return;
    snap.current = { steps, runStep, revalidate, level }; // freeze run parameters
    iRef.current = 0;
    confirmed.current = new Set();
    setStatuses({});
    setMessages({});
    setTxs({});
    setError(null);
    setPauseAt(-1);
    void loop();
  };
  const confirmContinue = () => {
    if (busy.current) return; // double-click must not pre-approve the NEXT step
    confirmed.current.add(iRef.current);
    setPauseAt(-1);
    void loop();
  };
  /** Resume at the failed step WITHOUT re-running completed ones (no double entry). */
  const retry = () => {
    if (busy.current || phase !== "error") return;
    const S = snap.current;
    if (S) set(S.steps[iRef.current]?.id ?? "", "pending");
    setError(null);
    setPauseAt(-1);
    void loop();
  };
  const reset = () => {
    if (busy.current) return;
    snap.current = null;
    iRef.current = 0;
    confirmed.current = new Set();
    setStatuses({});
    setMessages({});
    setTxs({});
    setError(null);
    setPhase("idle");
    setPauseAt(-1);
  };

  return { statuses, messages, txs, phase, pauseAt, error, start, confirmContinue, retry, reset };
}
