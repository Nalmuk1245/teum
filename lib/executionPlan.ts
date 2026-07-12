"use client";

// Execution flow — the ordered step plan for a bottari (kimchi) trade and a
// pausable, DRY_RUN-simulated runner. Conditional on the hedge toggle and the
// user's automation boundary. Real order/withdraw calls are TODO stubs; each
// step here just simulates so the whole state machine is exercisable safely.

import { useEffect, useRef, useState } from "react";
import type { Opportunity } from "./types";

export type StepId =
  | "buy" | "hedge" | "withdraw" | "transfer" | "deposit" | "sell" | "close" | "settle";

export type ExecStep = { id: StepId; label: string; desc: string };
export type StepPhase = "pending" | "running" | "done" | "error";
export type RunPhase = "idle" | "running" | "paused" | "done" | "error";
export type StepResult = { ok: boolean; message?: string };
export type AutoLevel = "manual" | "beforeWithdraw" | "auto";

const VENUE: Record<string, string> = {
  binance: "Binance", upbit: "Upbit", bithumb: "Bithumb",
  bybit: "Bybit", okx: "OKX", uniswap: "Uniswap",
};
const vlabel = (v?: string) => (v ? VENUE[v] ?? v : "?");

// Buy on the buy-venue → withdraw to personal wallet → (auto) deposit to the
// sell-venue → sell. Hedge = short Binance perp for the whole in-flight window.
export function buildPlan(opp: Opportunity, hedge: boolean): ExecStep[] {
  const buy = opp.legs.find((l) => l.side === "buy");
  const sell = opp.legs.find((l) => l.side === "sell");
  const bv = vlabel(buy?.venue);
  const sv = vlabel(sell?.venue);
  const steps: ExecStep[] = [];
  steps.push({ id: "buy", label: `${bv} 현물 매수`, desc: `${opp.base} 매수 · 진입` });
  if (hedge) steps.push({ id: "hedge", label: "Binance 선물 숏", desc: "같은 수량 · 진입가에 가격 잠금" });
  steps.push({ id: "withdraw", label: `${bv} → 개인지갑 출금`, desc: "온체인 · 되돌릴 수 없음" });
  steps.push({ id: "transfer", label: `개인지갑 → ${sv} 송금`, desc: "트래블룰 우회 · 자동 입금" });
  steps.push({ id: "deposit", label: `${sv} 입금 확인`, desc: "컨펌 대기" });
  steps.push({ id: "sell", label: `${sv} 현물 매도`, desc: `${opp.base} → KRW` });
  if (hedge) steps.push({ id: "close", label: "Binance 선물 청산", desc: "매도와 동시 · 헷지 해제" });
  steps.push({ id: "settle", label: "정산", desc: "P&L 확정" });
  return steps;
}

function needsConfirmBefore(id: StepId, level: AutoLevel): boolean {
  if (level === "auto") return false;
  if (level === "manual") return true;
  return id === "withdraw"; // beforeWithdraw: only the irreversible step
}

/**
 * Pausable sequential runner. Each step calls `runStep` (which POSTs to the
 * server step-executor); without one it falls back to a ~600ms simulation. A
 * failing step marks itself error and halts.
 */
export function useFlowRunner(
  steps: ExecStep[],
  level: AutoLevel,
  runStep?: (stepId: StepId) => Promise<StepResult>,
) {
  const [statuses, setStatuses] = useState<Record<string, StepPhase>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [pauseAt, setPauseAt] = useState(-1);
  const [error, setError] = useState<string | null>(null);

  const iRef = useRef(0);
  const confirmed = useRef<Set<number>>(new Set());
  const busy = useRef(false);
  const alive = useRef(true);
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
    busy.current = true;
    if (alive.current) { setPhase("running"); setError(null); }
    while (iRef.current < steps.length) {
      const i = iRef.current;
      const step = steps[i];
      if (needsConfirmBefore(step.id, level) && !confirmed.current.has(i)) {
        if (alive.current) { setPauseAt(i); setPhase("paused"); }
        busy.current = false;
        return;
      }
      set(step.id, "running");
      let r: StepResult;
      try {
        r = runStep ? await runStep(step.id) : (await sleep(600), { ok: true });
      } catch (e) {
        r = { ok: false, message: e instanceof Error ? e.message : "실패" };
      }
      if (!alive.current) { busy.current = false; return; }
      if (r.message) setMessages((m) => ({ ...m, [step.id]: r.message! }));
      if (!r.ok) {
        set(step.id, "error");
        setError(r.message ?? "단계 실패");
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
    iRef.current = 0;
    confirmed.current = new Set();
    setStatuses({});
    setMessages({});
    setError(null);
    setPauseAt(-1);
    void loop();
  };
  const confirmContinue = () => {
    confirmed.current.add(iRef.current);
    setPauseAt(-1);
    void loop();
  };
  const reset = () => {
    iRef.current = 0;
    confirmed.current = new Set();
    setStatuses({});
    setMessages({});
    setError(null);
    setPhase("idle");
    setPauseAt(-1);
  };

  return { statuses, messages, phase, pauseAt, error, start, confirmContinue, reset };
}
