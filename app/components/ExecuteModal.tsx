"use client";

import React from "react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Opportunity, Quote, StrategyKind } from "@/lib/types";
import { pct, usd, price } from "@/lib/format";
import { type LiveAges, type LiveGap, type LiveStatus } from "@/lib/useLivePrices";
import { buildPlan, type AutoLevel, type ExecStep, type StepPhase } from "@/lib/execPlan";
import { useRuns, startRun, confirmRun, retryRun, cancelRun, unwindRun, clearFinished, setKillSwitch, inFlightUsd, setInFlightLimit, type RunView } from "@/lib/runStore";
import { KIND_META, KINDS, GAP_KINDS, ALERT_NET_PCT, beep, Tile, COLS, COLS_MON, Empty, Metric, Line, Warn, LegRow, VENUE_LABEL, vlabel, WL_KEY, statusChip, FundingCountdown, PersistChip, ScanAge, LiveDots, Pill, xBtn, oppKindLabel, kindLabel } from "./cockpit-ui";

export function ExecuteModal({ opp, onClose, isMobile, initialRunId }: { opp: Opportunity; onClose: () => void; isMobile?: boolean; initialRunId?: string | null }) {
  const km = KIND_META[opp.kind];
  // Size as a string (fixes the leading-0 bug on edit) + USD/coin unit toggle.
  const bnPrice = opp.legs.find((l) => l.venue === "binance")?.price ?? 0; // ≈ USD per coin
  const [unit, setUnit] = useState<"usd" | "coin">("usd");
  const [amtStr, setAmtStr] = useState(() => String(Math.min(opp.notionalCapUsd ?? 1000, 1000)));
  const amt = Number(amtStr) || 0;
  const sizeUsd = unit === "usd" ? amt : amt * bnPrice;
  const switchUnit = (u: "usd" | "coin") => {
    if (u === unit || !bnPrice) return;
    setAmtStr(u === "coin" ? String(+(sizeUsd / bnPrice).toFixed(6)) : String(Math.round(sizeUsd)));
    setUnit(u);
  };
  const [hedge, setHedge] = useState(true);
  const hedgeOn = hedge && !!opp.hasPerp; // no perp → can't hedge
  const [autoLevel, setAutoLevel] = useState<AutoLevel>("beforeWithdraw");
  // The run lives in the background store, not this component — so closing the
  // modal doesn't kill it. Bind to an existing run (reopened from the dashboard)
  // or create one on 실행 시작.
  const store = useRuns();
  const [runId, setRunId] = useState<string | null>(initialRunId ?? null);
  const [startErr, setStartErr] = useState<string | null>(null);
  const run = runId ? store.runs[runId] : undefined;
  const phase = run?.phase ?? "idle";
  const running = phase === "running" || phase === "paused" || phase === "error";
  const statuses = run?.statuses ?? {};
  const messages = run?.messages ?? {};
  const txs = run?.txs ?? {};
  const pauseAt = run?.pauseAt ?? -1;
  const error = run?.error ?? null;
  const plan = run?.plan ?? buildPlan(opp, hedgeOn); // preview before start; run's frozen plan after

  // Live depth quote — refetch (debounced) whenever the size changes.
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quotable, setQuotable] = useState(true);
  useEffect(() => {
    if (sizeUsd <= 0) return;
    let cancelled = false;
    const fetchQuote = async (spinner: boolean) => {
      if (spinner) setQuoting(true);
      try {
        const res = await fetch("/api/quote", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ opportunity: opp, sizeUsd }),
        });
        const j = await res.json();
        if (!cancelled) {
          setQuote(j.quote ?? null);
          setQuotable(j.quote != null);
        }
      } catch {
        if (!cancelled && spinner) setQuote(null); // silent refresh keeps last good quote
      } finally {
        if (!cancelled && spinner) setQuoting(false);
      }
    };
    const t = setTimeout(() => fetchQuote(true), 150);
    // Keep the number live while the modal is open — silent (no spinner), and
    // the server book micro-cache makes each tick ~free.
    const iv = setInterval(() => fetchQuote(false), 5000);
    return () => {
      cancelled = true;
      clearTimeout(t);
      clearInterval(iv);
    };
  }, [opp, sizeUsd]);

  const overCap = quote != null && quote.maxSizeUsd > 0 && sizeUsd > quote.maxSizeUsd;

  // The run lives in the background store, so closing just hides the view — the
  // run keeps going and stays visible in the 실행 탭. No confirm needed.
  const guardedClose = () => onClose();

  return (
    <div
      onClick={guardedClose}
      className="overlay-in"
      style={{
        position: "fixed", inset: 0, zIndex: 50,
        background: "rgba(6,8,13,0.66)", backdropFilter: "blur(4px)",
        display: "flex", alignItems: isMobile ? "flex-end" : "center",
        justifyContent: "center", padding: isMobile ? 0 : 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="panel-in"
        style={{
          width: isMobile ? "100%" : 480, maxWidth: "100%",
          // 통스크롤 금지 — 내용이 길면 본문만 스크롤하고, 실행 버튼 줄은
          // 하단 푸터로 상시 노출한다 (스크롤해야 버튼이 보이던 문제).
          maxHeight: isMobile ? "92dvh" : "90dvh",
          display: "flex", flexDirection: "column",
          background: "var(--card)", border: "1px solid var(--border-strong)",
          borderRadius: isMobile ? "16px 16px 0 0" : "var(--radius)",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 18px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ width: 8, height: 8, borderRadius: 9, background: km.color }} />
          <span style={{ fontWeight: 700, fontSize: 15 }}>실행 · {opp.base}</span>
          <span style={{ color: "var(--text-mute)", fontSize: 12 }}>{oppKindLabel(opp)}</span>
          <span style={{ flex: 1 }} />
          {/* 접기 = 그냥 닫기 — 런은 스토어에 살아서 계속 돌고, 우하단 독이
              진행 상황을 이어받는다. ✕와 결과는 같지만 "실행이 죽지 않는다"를
              버튼이 말해준다 (런이 있을 때만 의미가 있어 그때만 노출). */}
          {running && (
            <button type="button" onClick={guardedClose} title="백그라운드로 접기 — 우하단에서 진행 상황이 계속 보입니다"
              style={{ border: "1px solid var(--border-strong)", background: "transparent", color: "var(--text-dim)", borderRadius: 9, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
              접기 ↘
            </button>
          )}
          <button type="button" onClick={guardedClose} style={xBtn}>✕</button>
        </div>

        <div style={{ padding: 18, overflowY: "auto", minHeight: 0, flex: 1 }}>
          {opp.legs.map((l, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", fontSize: 13.5 }}>
              <span>
                <b style={{ color: l.side === "buy" ? "var(--pos)" : "var(--neg)", fontWeight: 600 }}>
                  {l.side === "buy" ? "매수" : "매도"}
                </b>{" "}
                <span style={{ fontWeight: 600 }}>{l.venue}</span>{" "}
                <span style={{ color: "var(--text-mute)", fontSize: 12 }}>{l.symbol}</span>
              </span>
              <span className="tnum" style={{ color: "var(--text-dim)" }}>@{price(l.price)}</span>
            </div>
          ))}

          {/* Futures availability + hedge toggle */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 14, padding: "10px 12px", borderRadius: "var(--radius-sm)", background: "var(--card-2)" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <span style={{ color: "var(--text-dim)" }}>선물</span>
              <span
                style={{
                  fontSize: 11, fontWeight: 700,
                  color: opp.hasPerp ? "var(--pos)" : "var(--text-mute)",
                  border: `1px solid ${opp.hasPerp ? "var(--pos)" : "var(--border-strong)"}`,
                  borderRadius: 9, padding: "1px 8px",
                }}
              >
                {opp.hasPerp ? "있음" : "없음"}
              </span>
            </span>
            <button
              type="button"
              disabled={!opp.hasPerp || running}
              onClick={() => setHedge((v) => !v)}
              style={{
                border: `1px solid ${hedgeOn ? "var(--brand)" : "var(--border-strong)"}`,
                background: hedgeOn ? "var(--brand-soft)" : "transparent",
                color: hedgeOn ? "var(--brand-2)" : "var(--text-mute)",
                borderRadius: 9, padding: "5px 14px", fontSize: 12, fontWeight: 700,
                cursor: opp.hasPerp ? "pointer" : "not-allowed",
              }}
            >
              {hedgeOn ? "헷지 ON" : "헷지 OFF"}
            </button>
          </div>
          {!opp.hasPerp && (
            <div style={{ marginTop: 6, color: "var(--amber)", fontSize: 11 }}>
              선물 없음 — 무헷지(전송 중 가격 노출). 빠른 코인 소액만 권장.
            </div>
          )}
          {/* Transfer-window risk — expected premium drift over the in-flight ETA */}
          {opp.transferRisk && opp.transferRisk.driftPct > 0.01 && (
            <div
              style={{
                marginTop: 8, padding: "8px 10px", borderRadius: 9, fontSize: 11.5,
                background: opp.transferRisk.hedgeAdvised && !hedgeOn ? "var(--neg-soft)" : "var(--card-2)",
                color: opp.transferRisk.hedgeAdvised && !hedgeOn ? "var(--neg)" : "var(--text-dim)",
              }}
            >
              전송창 리스크 — 약 {opp.transferRisk.etaMin}분 이동 중 가격 <b className="tnum">±{opp.transferRisk.driftPct.toFixed(2)}%</b> 변동 예상 (순수익 {pct(opp.netPct)})
              <div style={{ marginTop: 2, fontSize: 10.5, color: "var(--text-mute)" }}>
                최근 최대 점프 {opp.transferRisk.jumpPct.toFixed(2)}%
                {opp.transferRisk.fxDriftPct > 0.01 && ` · 원/USDT ±${opp.transferRisk.fxDriftPct.toFixed(2)}%(헷지 미적용)`}
              </div>
              {opp.transferRisk.hedgeAdvised && (
                <div style={{ marginTop: 3, fontWeight: 600 }}>
                  {hedgeOn ? "✓ 헷지로 코인 가격 리스크를 상쇄합니다 (원/USDT는 별도)" : "⚠ 가격 변동·점프 리스크 큼 — 헷지 ON 권장"}
                </div>
              )}
              {opp.note && <div style={{ marginTop: 3, color: "var(--amber)", fontWeight: 600 }}>{opp.note}</div>}
            </div>
          )}

          {/* Size — USD or coin quantity */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14 }}>
            <label style={{ color: "var(--text-dim)", fontSize: 12, fontWeight: 500 }}>
              수량 ({unit === "usd" ? "USD" : opp.base})
            </label>
            <div style={{ display: "inline-flex", gap: 2, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 9, padding: 2 }}>
              {(["usd", "coin"] as const).map((u) => (
                <button
                  key={u}
                  type="button"
                  disabled={running}
                  onClick={() => switchUnit(u)}
                  style={{
                    border: "none", cursor: "pointer", borderRadius: 9, padding: "3px 11px",
                    fontSize: 11, fontWeight: 600,
                    background: unit === u ? "var(--brand-soft)" : "transparent",
                    color: unit === u ? "var(--brand-2)" : "var(--text-mute)",
                  }}
                >
                  {u === "usd" ? "USD" : opp.base}
                </button>
              ))}
            </div>
          </div>
          <input
            type="number"
            value={amtStr}
            min={0}
            inputMode="decimal"
            disabled={running}
            onChange={(e) => setAmtStr(e.target.value)}
            className="tnum"
            style={{
              width: "100%", marginTop: 6, padding: "11px 13px",
              background: "var(--bg)",
              border: `1px solid ${overCap ? "var(--neg)" : "var(--border-strong)"}`,
              borderRadius: "var(--radius-sm)", color: "var(--text)", fontSize: 15,
            }}
          />
          <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-mute)" }}>
            ≈ {unit === "usd" ? `${bnPrice ? +(sizeUsd / bnPrice).toFixed(4) : 0} ${opp.base}` : usd(sizeUsd)}
          </div>

          {/* Live executable quote (bid/ask VWAP + depth + real withdrawal fee) */}
          <QuotePanel
            opp={opp} quote={quote} quoting={quoting} quotable={quotable}
            overCap={overCap} sizeUsd={sizeUsd}
          />

          {/* Transfer / settlement gate — deposit/withdraw status + ETA + whitelist */}
          <TransferPanel opp={opp} />

          {/* Automation boundary — how far to auto-run before pausing */}
          <div style={{ marginTop: 14 }}>
            <div style={{ color: "var(--text-dim)", fontSize: 12, fontWeight: 500, marginBottom: 6 }}>자동 실행 범위</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 5 }}>
              {([
                { k: "manual", label: "수동", sub: "단계마다" },
                { k: "beforeWithdraw", label: "출금 전", sub: "권장" },
                { k: "beforeSell", label: "매도 전", sub: "청산 직접" },
                { k: "auto", label: "전자동", sub: "끝까지" },
              ] as const).map((a) => {
                const on = autoLevel === a.k;
                return (
                  <button
                    key={a.k}
                    type="button"
                    onClick={() => setAutoLevel(a.k)}
                    disabled={running}
                    style={{
                      border: `1px solid ${on ? "var(--brand)" : "var(--border)"}`,
                      background: on ? "var(--brand-soft)" : "transparent",
                      borderRadius: 9, padding: "8px 4px", cursor: "pointer",
                      display: "flex", flexDirection: "column", alignItems: "center", gap: 1,
                    }}
                  >
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: on ? "var(--brand-2)" : "var(--text-dim)" }}>{a.label}</span>
                    <span style={{ fontSize: 10, color: on ? "var(--brand)" : "var(--text-mute)" }}>{a.sub}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <StepTimeline steps={plan} statuses={statuses} messages={messages} txs={txs} pauseAt={pauseAt} />

          {/* Position / smart unwind — once a position exists (buy filled) and
              the run isn't full-auto. Store-backed → survives modal close.
              Hidden again when nothing is left to unwind (sold or settled) —
              unless a manual unwind happened, whose log/PnL stays visible. */}
          {run && statuses.buy === "done" && run.autoLevel !== "auto" &&
            (run.remaining > run.totalQty * 1e-6 || run.unwindLog.length > 0) && (
            <PositionPanel run={run} />
          )}

          <p style={{ marginTop: 12, color: "var(--text-mute)", fontSize: 11.5, lineHeight: 1.5 }}>
            {store.killed
              ? "킬 스위치가 활성화되어 신규 실행이 차단됩니다. 해제하려면 상단 정지 버튼을 누르세요."
              : "실행은 백그라운드에서 돌아갑니다 — 이 창을 닫아도 계속 진행되며 '운영' 탭에서 상태를 볼 수 있습니다. 현재 페이퍼 모드(시뮬 체결)."}
          </p>
        </div>

        {/* Run controls — 스크롤 영역 밖 고정 푸터. 에러도 버튼 옆에서 바로 보인다. */}
        <div style={{ padding: "12px 18px 14px", borderTop: "1px solid var(--border)", background: "var(--card)", flex: "0 0 auto" }}>
          {phase === "error" && error && <Warn text={error} />}
          {startErr && <Warn text={startErr} />}
          <div style={{ display: "flex", gap: 8, marginTop: (phase === "error" && error) || startErr ? 10 : 0 }}>
            {phase === "idle" || phase === "done" ? (
              <button
                type="button"
                onClick={async () => {
                  // clear a finished run before a fresh one (server refuses if it
                  // still holds a position, which startRun would reject anyway)
                  if (run) await cancelRun(run.id);
                  const res = await startRun({ opp, sizeUsd, hedge: hedgeOn, autoLevel });
                  if ("error" in res) { setStartErr(res.error); return; }
                  setStartErr(null);
                  setRunId(res.id);
                }}
                disabled={sizeUsd <= 0 || store.killed}
                style={{
                  flex: 1, padding: 12, borderRadius: "var(--radius-sm)", border: "none",
                  background: store.killed ? "var(--card-3)" : "var(--brand-grad)",
                  color: store.killed ? "var(--text-mute)" : "var(--brand-ink)", fontWeight: 700, fontSize: 14,
                  cursor: store.killed ? "not-allowed" : "pointer",
                }}
              >
                {store.killed ? "킬 스위치 활성" : phase === "done" ? "새 실행" : "실행 시작 →"}
              </button>
            ) : phase === "paused" ? (
              <>
                <button
                  type="button"
                  onClick={() => runId && confirmRun(runId)}
                  style={{
                    flex: 1, padding: 12, borderRadius: "var(--radius-sm)", border: "none",
                    background: "var(--brand-grad)", color: "var(--brand-ink)", fontWeight: 700, fontSize: 14, cursor: "pointer",
                  }}
                >
                  {plan[pauseAt]?.id === "withdraw" ? "출금 승인 →"
                    : plan[pauseAt]?.id === "sell" ? "매도 진행 →"
                    : "다음 단계 →"}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    if (!runId) return;
                    const r = await cancelRun(runId);
                    if (r.error) { setStartErr(r.error); return; } // 포지션 남으면 삭제 거부
                    setRunId(null);
                  }}
                  style={{
                    padding: "12px 16px", borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--border-strong)", background: "transparent",
                    color: "var(--text-dim)", fontWeight: 600, cursor: "pointer",
                  }}
                >
                  중단
                </button>
              </>
            ) : phase === "error" ? (
              <>
                <button
                  type="button"
                  onClick={async () => {
                    if (!runId) return;
                    setStartErr(null);
                    // 롤백된 런·결과 불명 단계·킬 활성이면 서버가 거부한다.
                    const r = await retryRun(runId);
                    if (r.error) setStartErr(r.error);
                  }}
                  style={{
                    flex: 1, padding: 12, borderRadius: "var(--radius-sm)", border: "none",
                    background: "var(--brand-grad)", color: "var(--brand-ink)", fontWeight: 700, fontSize: 14, cursor: "pointer",
                  }}
                >
                  실패 지점부터 재시도
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    if (!runId) return;
                    const r = await cancelRun(runId);
                    if (r.error) { setStartErr(r.error); return; }
                    setRunId(null);
                  }}
                  style={{
                    padding: "12px 14px", borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--border-strong)", background: "transparent",
                    color: "var(--text-dim)", fontWeight: 600, cursor: "pointer",
                  }}
                >
                  초기화
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={onClose}
                style={{
                  flex: 1, padding: 12, borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--border-strong)", background: "transparent",
                  color: "var(--text-dim)", fontWeight: 700, fontSize: 14, cursor: "pointer",
                }}
              >
                백그라운드로 (닫아도 계속 실행)
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Control tower — runs dashboard + risk limits + kill + tool suggestions ────

export function StepTimeline({
  steps, statuses, messages, txs, pauseAt,
}: {
  steps: ExecStep[];
  statuses: Record<string, StepPhase>;
  messages: Record<string, string>;
  txs: Record<string, { hash: string; url: string | null }>;
  pauseAt: number;
}) {
  return (
    <div style={{ marginTop: 14, border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "10px 12px" }}>
      <div style={{ color: "var(--text-dim)", fontSize: 12, fontWeight: 600, marginBottom: 8 }}>실행 흐름</div>
      {steps.map((s, i) => {
        const st = statuses[s.id] ?? "pending";
        const paused = i === pauseAt;
        const color =
          st === "error" ? "var(--neg)"
          : st === "rolledback" ? "var(--amber)"
          : st === "done" ? "var(--pos)"
          : st === "running" ? "var(--amber)"
          : paused ? "var(--brand-2)" : "var(--text-mute)";
        const sub = messages[s.id] ?? s.desc;
        const tx = txs[s.id];
        return (
          <div key={s.id} style={{ display: "flex", alignItems: "flex-start", gap: 9, padding: "4px 0" }}>
            <span
              style={{
                marginTop: 4, width: 8, height: 8, borderRadius: 9, background: color,
                boxShadow: st === "running" ? `0 0 6px ${color}` : "none", flex: "0 0 auto",
              }}
            />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: st === "pending" && !paused ? "var(--text-dim)" : "var(--text)" }}>
                {i + 1}. {s.label}
                {st === "done" ? " ✓" : st === "running" ? " …" : st === "error" ? " ✕" : st === "rolledback" ? " ↩ 롤백" : paused ? " · 확인 대기" : ""}
              </div>
              <div style={{ fontSize: 11, color: st === "error" ? "var(--neg)" : "var(--text-mute)" }}>{sub}</div>
              {tx && (
                <a
                  href={tx.url ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => { if (!tx.url) e.preventDefault(); }}
                  title={tx.hash}
                  className="tnum"
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 4, marginTop: 3,
                    fontSize: 10.5, fontWeight: 600,
                    color: tx.url ? "var(--sky)" : "var(--text-mute)",
                    background: "var(--card-2)", border: "1px solid var(--border)",
                    borderRadius: 9, padding: "2px 7px",
                    textDecoration: "none",
                    cursor: tx.url ? "pointer" : "default",
                  }}
                >
                  tx {tx.hash.length > 18 ? `${tx.hash.slice(0, 10)}…${tx.hash.slice(-6)}` : tx.hash}
                  {tx.url ? " ↗" : " (모의)"}
                </a>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Position / smart unwind (남은 물량 기준 부분 청산) — store-backed ────────────

export function PositionPanel({ run }: { run: RunView }) {
  const price = run.opp.legs.find((l) => l.quote === "USDT")?.price ?? 0;
  const totalQty = run.totalQty;
  const remaining = run.remaining;
  const pnl = run.pnlUsd;
  const busy = run.unwinding;
  const log = run.unwindLog;
  const doUnwind = (fraction: number) => { void unwindRun(run.id, fraction); };
  const pctLeft = totalQty > 0 ? (remaining / totalQty) * 100 : 0;
  const done = remaining <= totalQty * 1e-6;
  const opp = run.opp;

  return (
    <div style={{ marginTop: 12, padding: 14, borderRadius: "var(--radius-sm)", background: "var(--card-2)", border: "1px solid var(--border)" }}>
      <div style={{ color: "var(--text-dim)", fontSize: 12, fontWeight: 600, marginBottom: 10 }}>포지션 · 스마트 청산</div>

      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 5 }}>
        <span style={{ color: "var(--text-dim)" }}>보유 <span className="tnum" style={{ color: "var(--text)", fontWeight: 600 }}>{remaining.toFixed(4)} {opp.base}</span></span>
        <span className="tnum" style={{ color: "var(--text-dim)" }}>{usd(remaining * price)}</span>
      </div>
      <div style={{ height: 8, borderRadius: 9, background: "var(--bg)", border: "1px solid var(--border)", overflow: "hidden" }}>
        <div style={{ width: `${pctLeft}%`, height: "100%", background: "var(--brand)", transition: "width 200ms" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "var(--text-mute)", marginTop: 4 }}>
        <span>{pctLeft.toFixed(0)}% 남음</span>
        <span>헷지 잔량 {remaining.toFixed(4)} · 실현 {pnl >= 0 ? "+" : "−"}${Math.abs(pnl).toFixed(2)}</span>
      </div>

      {/* 남은 물량 기준 부분 청산 */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, marginTop: 12 }}>
        {[0.1, 0.25, 0.5, 1].map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => doUnwind(f)}
            disabled={done || busy}
            style={{
              border: "1px solid var(--border-strong)", borderRadius: 9, padding: "8px 4px",
              background: done ? "transparent" : "var(--brand-soft)",
              color: done ? "var(--text-mute)" : "var(--brand-2)",
              fontWeight: 700, fontSize: 13, cursor: done || busy ? "not-allowed" : "pointer",
            }}
          >
            {f === 1 ? "전량" : `${f * 100}%`}
          </button>
        ))}
      </div>

      {done && <div style={{ marginTop: 8, color: "var(--pos)", fontSize: 11.5, fontWeight: 600 }}>✓ 전량 청산 완료 · 실현 {pnl >= 0 ? "+" : "−"}${Math.abs(pnl).toFixed(2)}</div>}

      {log.length > 0 && (
        <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 8, display: "flex", flexDirection: "column", gap: 2 }}>
          {log.map((line, i) => (
            <div key={i} style={{ fontSize: 10.5, color: line === "──" ? "var(--border-strong)" : "var(--text-mute)" }}>
              {line === "──" ? "────────" : line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Live executable quote panel ───────────────────────────────────────────────

export function QuotePanel({
  opp, quote, quoting, quotable, overCap, sizeUsd,
}: {
  opp: Opportunity;
  quote: Quote | null;
  quoting: boolean;
  quotable: boolean;
  overCap: boolean;
  sizeUsd: number;
}) {
  // PnL(USD) = net% applied to the trade size.
  const pnl = (netPct: number) => `${netPct >= 0 ? "+" : "−"}${usd(Math.abs((netPct / 100) * sizeUsd))}`;
  // No live book (mock / unwired venue) → fall back to the board estimate.
  if (!quotable && !quoting) {
    return (
      <div style={{ marginTop: 12, padding: "12px 14px", borderRadius: "var(--radius-sm)", background: "var(--card-2)" }}>
        <Line label="순수익 (추정)" value={`${pct(opp.netPct)} · ${pnl(opp.netPct)}`} valueColor={opp.netPct > 0 ? "var(--pos)" : "var(--neg)"} strong />
        <p style={{ margin: "6px 0 0", color: "var(--text-mute)", fontSize: 11 }}>
          실호가 조회 불가(목업/미연동 거래소) — 티커 추정값입니다.
        </p>
      </div>
    );
  }

  const net = quote?.execNetPct ?? opp.netPct;
  const netColor = net > 0 ? "var(--pos)" : "var(--neg)";

  return (
    <div style={{ marginTop: 12, padding: 14, borderRadius: "var(--radius-sm)", background: "var(--card-2)", border: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "var(--text-dim)", fontSize: 12, fontWeight: 600 }}>
          <span style={{ width: 6, height: 6, borderRadius: 9, background: quoting ? "var(--amber)" : "var(--pos)" }} />
          {quoting ? "실호가 조회 중…" : "실호가 기준 순수익"}
        </span>
        <span style={{ textAlign: "right" }}>
          <div className="tnum" style={{ color: netColor, fontWeight: 800, fontSize: 20, lineHeight: 1.15 }}>{pct(net)}</div>
          <div className="tnum" style={{ color: netColor, fontWeight: 600, fontSize: 12.5 }}>{pnl(net)}</div>
        </span>
      </div>

      {quote && (
        <>
          <Line label="체결 총차익 (VWAP)" value={pct(quote.execGrossPct)} />
          <Line label="테이커 ×2" value={`−${quote.takerPct.toFixed(2)}%`} dim />
          {quote.fxSpreadPct > 0 && <Line label="환 스프레드" value={`−${quote.fxSpreadPct.toFixed(2)}%`} dim />}
          {quote.withdrawalPct > 0 && <Line label={`${opp.base} 출금비`} value={`−${quote.withdrawalPct.toFixed(2)}%`} dim />}
          <div style={{ borderTop: "1px solid var(--border)", margin: "8px 0" }} />
          <Line label="순수익" value={`${pct(quote.execNetPct)} · ${pnl(quote.execNetPct)}`} valueColor={netColor} strong />

          <div style={{ display: "flex", gap: 14, marginTop: 10, flexWrap: "wrap", color: "var(--text-mute)", fontSize: 11 }}>
            <span>슬리피지 매수 {quote.buySlippagePct.toFixed(2)}% · 매도 {quote.sellSlippagePct.toFixed(2)}%</span>
            <span>호가 한도 {quote.maxSizeUsd > 0 ? usd(quote.maxSizeUsd) : "—"}</span>
          </div>
          {overCap && <Warn text={`수량이 호가 한도(${usd(quote.maxSizeUsd)})를 넘어 수익이 비용 밑으로 떨어집니다.`} />}
          {!quote.filledFully && <Warn text="호가가 얇아 이 수량을 다 채울 수 없습니다." />}
        </>
      )}
    </div>
  );
}

export function TransferPanel({ opp }: { opp: Opportunity }) {
  const t = opp.transfer;
  const [wl, setWl] = useState(false);
  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem(WL_KEY) || "[]") as string[];
      setWl(s.includes(opp.base));
    } catch {
      /* private mode */
    }
  }, [opp.base]);
  const toggleWl = () =>
    setWl((prev) => {
      const next = !prev;
      try {
        const s = new Set<string>(JSON.parse(localStorage.getItem(WL_KEY) || "[]"));
        if (next) s.add(opp.base);
        else s.delete(opp.base);
        localStorage.setItem(WL_KEY, JSON.stringify([...s]));
      } catch {
        /* private mode */
      }
      return next;
    });

  if (!t) return null;
  const w = statusChip(t.withdraw.enabled);
  const d = statusChip(t.deposit.enabled);
  return (
    <div style={{ marginTop: 12, padding: 14, borderRadius: "var(--radius-sm)", background: "var(--card-2)", border: "1px solid var(--border)" }}>
      <div style={{ color: "var(--text-dim)", fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
        송금 상태
      </div>
      <LegRow
        label={`출금 · ${VENUE_LABEL[t.withdraw.venue] ?? t.withdraw.venue}`}
        statusText={w.t} statusColor={w.c} chain={t.network?.chain}
      />
      <LegRow
        label={`입금 · ${VENUE_LABEL[t.deposit.venue] ?? t.deposit.venue}`}
        statusText={d.t} statusColor={d.c} chain={t.network?.chain} confirms={t.network?.confirms}
      />
      <Line label="전송 예상" value={`~${t.etaMin}분 (가격 노출)`} dim />

      {/* Withdrawal address whitelist — user-maintained (per-account prerequisite). */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0 0" }}>
        <span style={{ color: "var(--text-dim)", fontSize: 13 }}>출금 화이트리스트</span>
        <button
          type="button"
          onClick={toggleWl}
          style={{
            border: `1px solid ${wl ? "var(--pos)" : "var(--amber)"}`,
            background: "transparent", cursor: "pointer",
            color: wl ? "var(--pos)" : "var(--amber)",
            borderRadius: 9, padding: "3px 11px", fontSize: 12, fontWeight: 600,
          }}
        >
          {wl ? "등록 ✓" : "미등록"}
        </button>
      </div>

      {t.blocked && <Warn text="입출금 중단 — 이 경로로는 실행 불가." />}
      {!t.blocked && !wl && (
        <div style={{ marginTop: 8, color: "var(--text-mute)", fontSize: 11, lineHeight: 1.5 }}>
          ⓘ 실행 전에 {opp.base} 출금 주소를 미리 화이트리스트에 등록해 두세요 (신규 등록 시 보통 24~72시간 잠금).
        </div>
      )}
    </div>
  );
}

// Funding settlement countdown — funding pays only at the snapshot, so "how
// long until the short leg settles" decides entry timing. Amber when imminent.
export default ExecuteModal;
