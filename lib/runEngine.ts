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
  buildPlan, needsConfirmBeforePublic as needsConfirmBefore, REVALIDATE_STEPS,
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
  busy: boolean;
  i: number;
  confirmed: Set<number>;
  qty?: number;
  startTs: number;
  fills: { buyQuote?: number; buyCcy?: string; buyQty?: number; sellQuote?: number; sellCcy?: string; sellQty?: number; hedgeOpenQuote?: number; hedgeCloseQuote?: number };
  durations: Record<string, number>;
  opp: Opportunity;
};

const g = globalThis as unknown as {
  __arbRunEngine?: { runs: Record<string, RunView>; engines: Map<string, Engine>; seq: number; booted: boolean; saveTimer: ReturnType<typeof setTimeout> | null; fails: number[] };
};
g.__arbRunEngine ??= { runs: {}, engines: new Map(), seq: 0, booted: false, saveTimer: null, fails: [] };
const E = g.__arbRunEngine;
E.fails ??= [];

// ── 서킷 브레이커 ─────────────────────────────────────────────────────────────
// 실행 단계가 연속 실패하면(거래소 장애·키 문제·버그) 같은 실수를 반복하며
// 수수료·슬리피지를 흘린다. 최근 CB_WINDOW분 내 실행 실패가 CB_MAX회 쌓이면
// 킬 스위치를 자동으로 켜고 알린다. 재검증 실패(엣지 소멸)는 정상 방어라
// 세지 않는다 — 오직 주문/출금/전송의 실집행 실패만.
const CB_WINDOW_MS = Number(process.env.CIRCUIT_FAIL_WINDOW_MIN ?? 10) * 60_000;
const CB_MAX = Number(process.env.CIRCUIT_FAIL_MAX ?? 3);
function recordExecFailure(base: string, stepLabel: string) {
  const now = Date.now();
  E.fails = E.fails.filter((t) => now - t < CB_WINDOW_MS);
  E.fails.push(now);
  if (E.fails.length >= CB_MAX && !isKilled()) {
    setKilled(true);
    for (const eng of E.engines.values()) eng.cancelled = true;
    void notify("circuit", `🛑 서킷 브레이커 — 최근 ${Math.round(CB_WINDOW_MS / 60_000)}분 내 실행 실패 ${E.fails.length}회 (마지막: ${base} ${stepLabel}). 킬 스위치 자동 활성 — 원인 확인 후 운영 탭에서 해제.`);
  }
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

/** USD notional currently in-flight (runs started and not finished). */
export function inFlightUsd(): number {
  return Object.values(E.runs)
    .filter((r) => r.phase === "running" || r.phase === "paused")
    .reduce((s, r) => s + r.sizeUsd, 0);
}

// ── step / revalidate ─────────────────────────────────────────────────────────
async function callStep(id: string, eng: Engine, stepId: StepId, opts?: { rollback?: boolean }) {
  if (stepId === "buy" && !opts?.rollback) {
    eng.qty = undefined;
    eng.fills = {};
    eng.startTs = Date.now();
  }
  const run = E.runs[id];
  const r = await runStep(stepId, eng.opp, run?.sizeUsd ?? 0, {
    rollback: opts?.rollback, qty: eng.qty, sinceTs: eng.startTs || undefined,
    fills: stepId === "settle" ? eng.fills : undefined,
    durations: stepId === "settle" ? eng.durations : undefined,
    txs: stepId === "settle"
      ? Object.entries(run?.txs ?? {}).map(([step, tx]) => ({ step, hash: tx.hash, url: tx.url }))
      : undefined,
  });
  if (typeof r.filledQty === "number" && r.filledQty > 0) eng.qty = r.filledQty;
  if (r.fill?.quote && !opts?.rollback) {
    if (stepId === "buy") { eng.fills.buyQuote = r.fill.quote; eng.fills.buyCcy = r.fill.ccy; eng.fills.buyQty = r.fill.qty; }
    if (stepId === "sell") { eng.fills.sellQuote = r.fill.quote; eng.fills.sellCcy = r.fill.ccy; eng.fills.sellQty = r.fill.qty; }
    if (stepId === "hedge") eng.fills.hedgeOpenQuote = r.fill.quote;
    if (stepId === "close") eng.fills.hedgeCloseQuote = r.fill.quote;
  }
  // 라이브 실패 = 폰 알림 (기존 라우트 경유 시절의 동작을 엔진 경로에서도 유지)
  if (!r.ok && !CONFIG.DRY_RUN && !opts?.rollback) {
    void notifyNow(`⚠️ <b>${eng.opp.base}</b> ${stepId} 실패\n${r.message ?? ""}`);
  }
  return { ok: r.ok, message: r.message, tx: r.tx as TxRef | undefined };
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
    if (eng.cancelled || isKilled()) {
      if (isKilled() && !eng.cancelled) patch(id, { phase: "error", error: "킬 스위치 — 루프 정지 (포지션 수동 확인)" });
      eng.busy = false;
      return;
    }
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
    const stepT0 = Date.now();
    let r: { ok: boolean; message?: string; tx?: TxRef };
    try { r = await callStep(id, eng, step.id); }
    catch (e) { r = { ok: false, message: e instanceof Error ? e.message : "실패" }; }
    eng.durations[step.id] = Math.round((Date.now() - stepT0) / 1000);
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
        patch(id, { statuses, messages, txs: upd.txs ?? run().txs, error: `${r.message ?? "단계 실패"} — ${allOk ? "진입 롤백 완료" : "⚠ 일부 롤백 실패, 수동 확인"}`, pauseAt: i, phase: "error" });
      } else {
        patch(id, { statuses, messages, txs: upd.txs ?? run().txs, error: `${r.message ?? "단계 실패"} — 출금 이후: 헷지 유지, 수동 처리 필요`, pauseAt: i, phase: "error" });
      }
      recordExecFailure(run().base, step.label); // 서킷 브레이커 — 실집행 실패만
      eng.busy = false;
      return;
    }

    upd.statuses = { ...run().statuses, [step.id]: "done" };
    if (step.id === "buy") {
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
  const dup = Object.values(E.runs).find(
    (r) => r.base === cfg.opp.base && (r.phase === "running" || r.phase === "paused"),
  );
  if (dup) return { error: `${cfg.opp.base} 이미 실행 중 — 중복 실행 차단 (진행 중 런을 먼저 처리)` };
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
    cancelled: false, busy: false, i: 0, confirmed: new Set(),
    startTs: 0, fills: {}, durations: {}, opp: cfg.opp,
  });
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

export function retryRun(id: string) {
  const eng = E.engines.get(id);
  if (!eng || eng.busy || E.runs[id]?.phase !== "error") return;
  patch(id, { error: null, pauseAt: -1 });
  void loop(id);
}

export function cancelRun(id: string) {
  const eng = E.engines.get(id);
  if (eng) eng.cancelled = true;
  delete E.runs[id];
  E.engines.delete(id);
  persistRuns();
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
  patch(id, { unwinding: true });
  try {
    const result = await unwind(run.opp, run.remaining, fraction);
    patch(id, {
      remaining: result.remainingQty,
      pnlUsd: run.pnlUsd + (result.pnlUsd ?? 0),
      unwindLog: [...run.unwindLog, ...(result.log ?? [])],
      unwinding: false,
    });
  } catch (e) {
    patch(id, { unwindLog: [...run.unwindLog, `청산 오류: ${e instanceof Error ? e.message : "?"}`], unwinding: false });
  }
}

export function setEngineKill(v: boolean) {
  setKilled(v);
  if (v) for (const eng of E.engines.values()) eng.cancelled = true;
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
