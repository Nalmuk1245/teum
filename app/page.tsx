"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Opportunity, Quote, StrategyKind } from "@/lib/types";
import { pct, usd, price } from "@/lib/format";
import { useLivePrices, type LiveAges, type LiveGap, type LiveStatus } from "@/lib/useLivePrices";
import { buildPlan, type AutoLevel, type ExecStep, type StepPhase } from "@/lib/executionPlan";
import { useRuns, startRun, confirmRun, retryRun, cancelRun, unwindRun, clearFinished, setKillSwitch, inFlightUsd, setInFlightLimit, type RunView } from "@/lib/runStore";
import AssetsPanel, { AssetSummary } from "./components/InventoryPanel";

const KIND_META: Record<StrategyKind, { label: string; color: string }> = {
  kimchi: { label: "김프", color: "var(--brand-2)" },
  "cross-cex": { label: "크로스", color: "var(--sky)" },
  "funding-basis": { label: "펀딩", color: "var(--amber)" },
  "cex-dex": { label: "CEX-DEX", color: "var(--teal)" },
};
const KINDS = Object.keys(KIND_META) as StrategyKind[];
// Funding has its own tab — the gap board/filter only covers one-shot strategies.
const GAP_KINDS = KINDS.filter((k) => k !== "funding-basis");

// Live net crossing this fires the spike alert (beep + notification + flash).
const ALERT_NET_PCT = 0.5;

// Short attention beep via WebAudio — no asset file needed.
function beep() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.36);
    osc.onended = () => void ctx.close();
  } catch { /* audio blocked until first user gesture — fine */ }
}

function useIsMobile() {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const on = () => setMobile(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}

export default function Cockpit() {
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [meta, setMeta] = useState<{ dryRun: boolean; mock: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<StrategyKind | "all">("all");
  const [selected, setSelected] = useState<Opportunity | null>(null);
  // Tabs: monitor = one-shot gaps, funding = APR yields, execute = launch
  // trades, control = ops (runs dashboard + risk + kill), assets = balances.
  const [mode, setMode] = useState<"monitor" | "funding" | "execute" | "control" | "assets">("monitor");

  // Ordering guard — a stale /api/scan response must never overwrite a newer
  // one. Compare against the last APPLIED seq (not the last issued): requiring
  // seq === latest-issued would discard every response whenever responses run
  // slower than the 8s poll interval (permanent "스캔 중" livelock).
  const scanSeq = useRef(0);
  const appliedSeq = useRef(0);
  const [scanTs, setScanTs] = useState(0);
  const load = useCallback(async () => {
    const seq = ++scanSeq.current;
    try {
      const res = await fetch("/api/scan", { cache: "no-store" });
      const j = await res.json();
      if (seq <= appliedSeq.current) return; // an equal-or-newer response already applied
      appliedSeq.current = seq;
      setOpps(j.opportunities ?? []);
      setMeta(j.meta ?? null);
      setScanTs(Date.now());
      setLoading(false);
    } catch {
      /* keep stale */
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [load]);

  // Funding lives in its own tab — APR yields don't belong on a one-shot gap board.
  const funding = mode === "funding";
  const gapOpps = useMemo(() => opps.filter((o) => o.kind !== "funding-basis"), [opps]);
  const fundingOpps = useMemo(() => opps.filter((o) => o.kind === "funding-basis"), [opps]);
  const pool = funding ? fundingOpps : gapOpps;
  const isMobile = useIsMobile();
  // Real-time overlay — client WebSockets recompute premium/net sub-second.
  const { overlay: liveOverlay, status: liveStatus, ages: liveAges } = useLivePrices(opps, true);
  // Gap rows re-rank by the LIVE net — a coin that spikes right now jumps to the
  // top immediately instead of waiting for the next 8s scan's ordering.
  const rows = useMemo(() => {
    const base = funding || filter === "all" ? pool : pool.filter((o) => o.kind === filter);
    if (funding) return base;
    const liveNet = (o: Opportunity) => liveOverlay[o.id]?.netPct ?? o.netPct;
    return [...base].sort((a, b) => liveNet(b) - liveNet(a));
  }, [pool, filter, funding, liveOverlay]);
  const positive = pool.filter((o) => o.netPct > 0).length;
  const bestEdge = pool.length ? Math.max(...pool.map((o) => o.netPct)) : null;

  // ── Spike alerts — live net crossing the threshold beeps + notifies + flashes.
  const [alertsOn, setAlertsOn] = useState(false);
  useEffect(() => { setAlertsOn(localStorage.getItem("ac.alerts") === "1"); }, []);
  const toggleAlerts = () => {
    const v = !alertsOn;
    setAlertsOn(v);
    localStorage.setItem("ac.alerts", v ? "1" : "0");
    if (v && "Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  };
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const aboveRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const crossed: { id: string; base: string; net: number }[] = [];
    const nowAbove = new Set<string>();
    for (const o of gapOpps) {
      if (o.mock) continue;
      const net = liveOverlay[o.id]?.netPct ?? o.netPct;
      if (net >= ALERT_NET_PCT) {
        nowAbove.add(o.id);
        if (!aboveRef.current.has(o.id)) crossed.push({ id: o.id, base: o.base, net });
      }
    }
    aboveRef.current = nowAbove;
    if (!crossed.length) return;
    setFlashIds((prev) => new Set([...prev, ...crossed.map((c) => c.id)]));
    const t = setTimeout(() => setFlashIds(new Set()), 4000);
    if (alertsOn) {
      beep();
      if ("Notification" in window && Notification.permission === "granted") {
        const top = crossed.sort((a, b) => b.net - a.net)[0];
        new Notification(`갭 포착 — ${top.base} +${top.net.toFixed(2)}%`, {
          body: crossed.length > 1 ? `외 ${crossed.length - 1}건 임계 돌파` : "순수익 임계 돌파",
          tag: "arb-spike",
        });
      }
    }
    return () => clearTimeout(t);
  }, [liveOverlay, gapOpps, alertsOn]);
  // Best live opportunity in the current pool (for the sticky summary bar).
  const best = useMemo(() => {
    let top: { o: Opportunity; net: number } | null = null;
    for (const o of pool) {
      if (o.mock) continue;
      const net = liveOverlay[o.id]?.netPct ?? o.netPct;
      if (!top || net > top.net) top = { o, net };
    }
    return top;
  }, [pool, liveOverlay]);

  // Background runs + kill switch (survive modal close; shown in the 실행 탭).
  const runsStore = useRuns();
  const runList = Object.values(runsStore.runs).sort((a, b) => b.startedAt - a.startedAt);
  const activeRuns = runList.filter((r) => r.phase === "running" || r.phase === "paused").length;
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  // On first client mount, sync the kill flag from the server.
  useEffect(() => {
    fetch("/api/kill").then((r) => r.json()).then((s) => { if (s.killed) void setKillSwitch(true); }).catch(() => {});
  }, []);

  return (
    <main style={{ minHeight: "100dvh" }}>
      {/* ── Header ─────────────────────────────────────────────── */}
      <header
        style={{
          position: "sticky", top: 0, zIndex: 20,
          display: "flex", alignItems: "center", gap: isMobile ? 10 : 14,
          padding: isMobile ? "9px 12px" : "9px 16px",
          borderBottom: "1px solid var(--border)",
          background: "rgba(11,14,17,0.85)",
          backdropFilter: "blur(12px)",
        }}
      >
        <div
          style={{
            width: 28, height: 28, borderRadius: 6,
            background: "var(--brand-grad)",
            display: "grid", placeItems: "center",
            color: "#181a20", fontWeight: 800, fontSize: 14,
          }}
        >
          ⇄
        </div>
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.15 }}>
          <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em", whiteSpace: "nowrap" }}>
            Arb Cockpit
          </span>
          {!isMobile && (
            <span style={{ color: "var(--text-mute)", fontSize: 11 }}>
              반자동 · 개인용
            </span>
          )}
        </div>
        <span style={{ flex: 1 }} />
        {/* Kill switch — halt all runs + block new ones. Always reachable. */}
        <button
          type="button"
          onClick={() => setKillSwitch(!runsStore.killed)}
          title={runsStore.killed ? "킬 스위치 활성 — 눌러서 해제" : "전체 중단 (킬 스위치)"}
          style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            border: `1px solid ${runsStore.killed ? "var(--neg)" : "var(--border-strong)"}`,
            background: runsStore.killed ? "var(--neg-soft)" : "transparent",
            color: runsStore.killed ? "var(--neg)" : "var(--text-dim)",
            borderRadius: 6, padding: "3px 9px", fontSize: 11, fontWeight: 700, cursor: "pointer",
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: 999, background: runsStore.killed ? "var(--neg)" : "var(--text-mute)" }} />
          {runsStore.killed ? "중단됨" : "STOP"}
        </button>
        <LiveDots status={liveStatus} ages={liveAges} isMobile={isMobile} />
        {meta?.mock && !isMobile && <Pill text="목업" tone="var(--sky)" soft />}
        {/* Don't flash "실주문"(red) before meta loads — unknown ≠ live. */}
        {meta && (
          <Pill
            text={meta.dryRun ? "모의" : "실주문"}
            tone={meta.dryRun ? "var(--pos)" : "var(--neg)"}
            soft
            dot
          />
        )}
      </header>

      <div style={{ maxWidth: 1180, margin: "0 auto", padding: isMobile ? "10px 10px" : "16px" }}>
        {/* ── Mode: gap monitor (view-only) vs execution (trade) ── */}
        <div
          style={{
            display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 3,
            padding: 4, marginBottom: isMobile ? 10 : 14,
            background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12,
          }}
        >
          {([
            { k: "monitor", label: "갭", sub: "원샷 차익" },
            { k: "funding", label: "펀딩", sub: "APR" },
            { k: "execute", label: "실행", sub: "주문" },
            { k: "control", label: "관제", sub: "실행·리스크" },
            { k: "assets", label: "자산", sub: "잔고" },
          ] as const).map((m) => {
            const active = mode === m.k;
            return (
              <button
                key={m.k}
                type="button"
                onClick={() => {
                  // Runs persist in the background store now, so leaving the
                  // execute view never kills anything — just close the modal.
                  if (m.k !== "execute") setSelected(null);
                  setMode(m.k);
                }}
                style={{
                  border: "none", cursor: "pointer", borderRadius: 9, padding: "9px 8px",
                  background: active ? "var(--brand-soft)" : "transparent",
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 1,
                }}
              >
                <span style={{ fontSize: 14, fontWeight: 700, color: active ? "var(--brand-2)" : "var(--text-dim)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                  {m.label}
                  {m.k === "control" && activeRuns > 0 && (
                    <span className="tnum" style={{ fontSize: 10, fontWeight: 700, color: "#181a20", background: "var(--brand)", borderRadius: 999, padding: "0 5px", minWidth: 14, textAlign: "center" }}>
                      {activeRuns}
                    </span>
                  )}
                </span>
                <span style={{ fontSize: 11, color: active ? "var(--brand)" : "var(--text-mute)" }}>
                  {m.sub}
                </span>
              </button>
            );
          })}
        </div>

        {/* ── Assets: one-line summary on trading tabs; full panel on 자산 ── */}
        {mode === "assets" ? (
          <AssetsPanel isMobile={isMobile} />
        ) : mode === "control" ? null : (
          <AssetSummary isMobile={isMobile} onOpen={() => setMode("assets")} />
        )}

        {/* ── Control tower: runs dashboard + risk limits + tools ── */}
        {mode === "control" && (
          <ControlPanel
            runs={runList}
            killed={runsStore.killed}
            onOpen={(r) => { setOpenRunId(r.id); setSelected(r.opp); setMode("execute"); }}
          />
        )}

        {(mode === "monitor" || mode === "funding" || mode === "execute") && (<>
        {/* ── KPI tiles ────────────────────────────────────────── */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: isMobile ? 6 : 10,
            marginBottom: isMobile ? 10 : 14,
          }}
        >
          <Tile
            label={funding ? "펀딩 기회" : "기회"}
            value={String(pool.length)}
            sub={funding ? "스프레드 8%+" : `전략 ${GAP_KINDS.length}종`}
            compact={isMobile}
          />
          <Tile
            label={funding ? "수익 스프레드" : "수익 기회"}
            value={String(positive)}
            sub={funding ? "APR 양수" : "비용 넘김"}
            tone="var(--pos)"
            compact={isMobile}
          />
          <Tile
            label={funding ? "최고 APR" : "최고 수익"}
            value={bestEdge == null ? "—" : pct(bestEdge)}
            sub={funding ? "연환산" : "수수료 반영"}
            tone={bestEdge && bestEdge > 0 ? "var(--pos)" : "var(--text)"}
            compact={isMobile}
          />
        </div>

        {/* ── Segmented filter (gap modes only — funding is a single strategy) ── */}
        {!funding && (
        <div style={{ overflowX: "auto", marginBottom: 16, maxWidth: "100%", WebkitOverflowScrolling: "touch" }}>
        <div
          style={{
            display: "inline-flex", gap: 4, padding: 4,
            background: "var(--card)", border: "1px solid var(--border)",
            borderRadius: 999,
          }}
        >
          {(["all", ...GAP_KINDS] as const).map((k) => {
            const active = filter === k;
            const label = k === "all" ? "전체" : KIND_META[k].label;
            const n = k === "all" ? pool.length : pool.filter((o) => o.kind === k).length;
            return (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                style={{
                  border: "none", cursor: "pointer", borderRadius: 999,
                  padding: "5px 12px", fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap",
                  background: active ? "var(--brand-soft)" : "transparent",
                  color: active ? "var(--brand-2)" : "var(--text-dim)",
                  transition: "background 120ms, color 120ms",
                }}
              >
                {label}
                <span style={{ color: active ? "var(--brand)" : "var(--text-mute)", marginLeft: 6, fontWeight: 500 }}>
                  {n}
                </span>
              </button>
            );
          })}
        </div>
        </div>
        )}

        {/* Runs live on the 관제 tab now — nudge there when any are active. */}
        {mode === "execute" && activeRuns > 0 && (
          <button
            type="button"
            onClick={() => setMode("control")}
            style={{
              width: "100%", textAlign: "left", cursor: "pointer", marginBottom: 12,
              background: "var(--brand-soft)", border: "1px solid var(--brand)",
              borderRadius: "var(--radius)", padding: "9px 12px", color: "var(--brand-2)",
              fontSize: 12.5, fontWeight: 600,
            }}
          >
            실행 중 {activeRuns}건 — 관제 탭에서 현황 보기 →
          </button>
        )}

        {/* ── Board ────────────────────────────────────────────── */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "0 2px 6px" }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-dim)" }}>
            {funding ? "펀딩 스프레드 (숏 받는쪽 → 롱 내는쪽)" : "기회 테이블"}
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            {!funding && (
              <button
                type="button"
                onClick={toggleAlerts}
                title={`라이브 순수익 +${ALERT_NET_PCT}% 돌파 시 알림음 + 브라우저 알림`}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  background: alertsOn ? "var(--brand-soft)" : "transparent",
                  border: `1px solid ${alertsOn ? "var(--brand)" : "var(--border)"}`,
                  color: alertsOn ? "var(--brand-2)" : "var(--text-mute)",
                  borderRadius: 4, padding: "2px 8px", fontSize: 10.5, fontWeight: 700, cursor: "pointer",
                }}
              >
                <span style={{ width: 5, height: 5, borderRadius: 999, background: alertsOn ? "var(--brand)" : "var(--text-mute)" }} />
                알림 {alertsOn ? "ON" : "OFF"}
              </button>
            )}
            <ScanAge ts={scanTs} live={Object.keys(liveOverlay).length > 0} />
          </span>
        </div>
        <Board rows={rows} loading={loading} onExecute={(o) => { setOpenRunId(null); setSelected(o); }} mobile={isMobile} showExecute={mode === "execute"} live={liveOverlay} flash={flashIds} />

        <p style={{ color: "var(--text-mute)", fontSize: 12, marginTop: 14, paddingBottom: 56 }}>
          {funding
            ? "APR = 8h 정규화 펀딩 스프레드의 연환산 (바낸·바이비트는 다음 주기 예측). 정산 시점에만 지급 — 카운트다운 참고. 실행 배선 전, 모니터링 전용."
            : "순수익 = 총차익 − 예상 왕복비용. 김프·크로스(거래소 갭)는 실데이터 연동, CEX-DEX는 목업 스텁입니다."}
        </p>
        </>)}
      </div>

      {/* ── Sticky summary bar (var1) — best live opportunity at a glance ── */}
      {mode !== "assets" && best && (
        <div
          style={{
            position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 30,
            display: "flex", alignItems: "center", gap: 10,
            padding: "9px 14px",
            background: "rgba(11,14,17,0.92)", backdropFilter: "blur(10px)",
            borderTop: "1px solid var(--border)",
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: 999, background: best.net > 0 ? "var(--pos)" : "var(--text-mute)" }} />
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
            최고 <b style={{ color: "var(--text)" }}>{best.o.base}</b>
          </span>
          <span className="tnum" style={{ fontSize: 14, fontWeight: 700, color: best.net > 0 ? "var(--pos)" : "var(--neg)" }}>
            {pct(best.net)}
          </span>
          <span className="tnum" style={{ fontSize: 11, color: "var(--text-mute)" }}>
            {best.o.rateBasis === "apr" ? "APR · " : ""}≈{usd(Math.abs((best.net / 100) * 1000))}/{best.o.rateBasis === "apr" ? "yr" : "1k"}
          </span>
          <span style={{ flex: 1 }} />
          <span className="tnum" style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
            수익 기회 <b style={{ color: "var(--pos)" }}>{positive}</b>건
          </span>
          {mode === "execute" && best.o.executable && (
            <button
              type="button"
              onClick={() => setSelected(best.o)}
              style={{
                border: "none", borderRadius: "var(--radius-sm)", padding: "6px 14px",
                background: "var(--brand-grad)", color: "#0b0e11",
                fontWeight: 700, fontSize: 12, cursor: "pointer",
              }}
            >
              실행
            </button>
          )}
        </div>
      )}

      {selected && mode === "execute" && (
        <ExecuteModal opp={selected} initialRunId={openRunId} onClose={() => { setSelected(null); setOpenRunId(null); }} isMobile={isMobile} />
      )}
    </main>
  );
}

// ── KPI tile ──────────────────────────────────────────────────────────────────
function Tile({
  label, value, sub, tone, compact,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
  compact?: boolean;
}) {
  return (
    <div
      style={{
        background: "var(--card)", border: "1px solid var(--border)",
        borderRadius: "var(--radius)", padding: compact ? "8px 10px" : "10px 14px",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div style={{ color: "var(--text-dim)", fontSize: compact ? 11 : 12, fontWeight: 500, whiteSpace: "nowrap" }}>{label}</div>
      <div
        className="tnum"
        style={{ color: tone ?? "var(--text)", fontSize: compact ? 17 : 20, fontWeight: 700, letterSpacing: "-0.02em", marginTop: compact ? 3 : 4 }}
      >
        {value}
      </div>
      {sub && <div style={{ color: "var(--text-mute)", fontSize: compact ? 10 : 11, marginTop: 2, whiteSpace: "nowrap" }}>{sub}</div>}
    </div>
  );
}

// ── Board ─────────────────────────────────────────────────────────────────────
const COLS = "108px minmax(0,1fr) minmax(0,1.5fr) 74px 66px 84px 84px 104px";
const COLS_MON = "108px minmax(0,1fr) minmax(0,1.5fr) 74px 66px 84px 84px"; // monitor: no execute column

function Board({
  rows, loading, onExecute, mobile, showExecute, live, flash,
}: {
  rows: Opportunity[];
  loading: boolean;
  onExecute: (o: Opportunity) => void;
  mobile?: boolean;
  showExecute?: boolean;
  live?: Record<string, LiveGap>;
  flash?: Set<string>;
}) {
  return (
    <div
      style={{
        background: "var(--card)", border: "1px solid var(--border)",
        borderRadius: "var(--radius)", overflow: "hidden", boxShadow: "var(--shadow-sm)",
      }}
    >
      {!mobile && (
        <div
          style={{
            display: "grid", gridTemplateColumns: showExecute ? COLS : COLS_MON, gap: 10,
            padding: "7px 12px", color: "var(--text-mute)", fontSize: 10.5,
            fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span>전략</span>
          <span>종목</span>
          <span>경로</span>
          <span style={{ textAlign: "right" }}>총차익</span>
          <span style={{ textAlign: "right" }}>비용</span>
          <span style={{ textAlign: "right" }}>순수익</span>
          <span style={{ textAlign: "right" }}>한도</span>
          {showExecute && <span />}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <Empty text="시장 스캔 중…" />
      ) : rows.length === 0 ? (
        <Empty text="기회 없음" />
      ) : (
        rows.map((o) =>
          mobile ? (
            <OppCard key={o.id} o={o} onExecute={onExecute} showExecute={showExecute} live={live?.[o.id]} flashing={flash?.has(o.id)} />
          ) : (
            <Row key={o.id} o={o} onExecute={onExecute} showExecute={showExecute} live={live?.[o.id]} flashing={flash?.has(o.id)} />
          ),
        )
      )}
    </div>
  );
}

// Mobile opportunity card — stacked layout instead of the wide desktop table.
function OppCard({ o, onExecute, showExecute, live, flashing }: { o: Opportunity; onExecute: (o: Opportunity) => void; showExecute?: boolean; live?: LiveGap; flashing?: boolean }) {
  const km = KIND_META[o.kind];
  const net = live?.netPct ?? o.netPct;
  const gross = live?.grossPct ?? o.grossPct;
  const netTone = net > 0 ? "var(--pos)" : net < 0 ? "var(--neg)" : "var(--text-dim)";
  const [buy, sell] = o.legs;
  const isApr = o.rateBasis === "apr";
  return (
    <div className={flashing ? "spike-flash" : undefined} style={{ padding: "9px 11px 9px 9px", borderBottom: "1px solid var(--border)", borderLeft: `3px solid ${km.color}` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          <span
            style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              background: "color-mix(in srgb, " + km.color + " 14%, transparent)",
              color: km.color, borderRadius: 999, padding: "3px 8px", fontSize: 10, fontWeight: 600,
              flex: "0 0 auto",
            }}
          >
            <span style={{ width: 5, height: 5, borderRadius: 999, background: km.color }} />
            {km.label}
          </span>
          <span style={{ fontWeight: 700, fontSize: 15 }}>{o.base}</span>
          {o.mock && <span style={{ color: "var(--text-mute)", fontSize: 9, border: "1px solid var(--border)", borderRadius: 4, padding: "0 3px" }}>mock</span>}
        </span>
        <span style={{ textAlign: "right", flex: "0 0 auto" }}>
          <span
            className="tnum"
            style={{
              display: "inline-block",
              background: net > 0 ? "var(--pos-soft)" : net < 0 ? "var(--neg-soft)" : "transparent",
              color: netTone, fontWeight: 800, fontSize: 16, borderRadius: 6, padding: "2px 8px",
            }}
          >
            {pct(net)}
          </span>
          <span className="tnum" style={{ display: "block", fontSize: 10, color: "var(--text-mute)", marginTop: 1 }}>
            {isApr ? "APR · " : ""}≈{usd(Math.abs((net / 100) * 1000))}/{isApr ? "yr" : "1k"}
          </span>
        </span>
      </div>

      <div style={{ color: "var(--text-dim)", fontSize: 12.5, margin: "9px 0 10px", display: "flex", alignItems: "center", gap: 8 }}>
        {buy && sell ? (
          <span>
            <b style={{ color: "var(--pos)", fontWeight: 600 }}>{isApr ? "롱" : "매수"}</b> {vlabel(buy.venue)}
            <span style={{ color: "var(--text-mute)", margin: "0 6px" }}>→</span>
            <b style={{ color: "var(--neg)", fontWeight: 600 }}>{isApr ? "숏" : "매도"}</b> {vlabel(sell.venue)}
          </span>
        ) : <span>—</span>}
        {!isApr && <PersistChip p={o.persistence} />}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <span className="tnum" style={{ color: "var(--text-mute)", fontSize: 12 }}>
            {isApr
              ? `펀딩 스프레드 ${pct(gross, false)} APR · 진입 −${o.costPct.toFixed(2)}%`
              : `총차익 ${pct(gross, false)} · 비용 −${o.costPct.toFixed(2)}%${o.notionalCapUsd ? ` · 한도 ${usd(o.notionalCapUsd)}` : ""}`}
          </span>
          {o.note && isApr && (
            <span style={{ color: "var(--text-mute)", fontSize: 11 }}>{o.note}</span>
          )}
          {isApr && o.fundingMeta && <FundingCountdown meta={o.fundingMeta} />}
          {o.transfer?.blocked && (
            <span style={{ color: "var(--neg)", fontSize: 11, fontWeight: 600 }}>입출금 중단</span>
          )}
        </div>
        {showExecute && (
          <button
            type="button"
            disabled={!o.executable}
            onClick={() => onExecute(o)}
            style={{
              borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 600,
              cursor: o.executable ? "pointer" : "not-allowed",
              border: o.executable ? "none" : "1px solid var(--border-strong)",
              background: o.executable ? "var(--brand-grad)" : "transparent",
              color: o.executable ? "#fff" : "var(--text-mute)",
              boxShadow: "none",
              flex: "0 0 auto",
            }}
          >
            실행
          </button>
        )}
      </div>
    </div>
  );
}

function Row({ o, onExecute, showExecute, live, flashing }: { o: Opportunity; onExecute: (o: Opportunity) => void; showExecute?: boolean; live?: LiveGap; flashing?: boolean }) {
  const km = KIND_META[o.kind];
  const [hover, setHover] = useState(false);
  const net = live?.netPct ?? o.netPct;
  const gross = live?.grossPct ?? o.grossPct;
  const netTone = net > 0 ? "var(--pos)" : net < 0 ? "var(--neg)" : "var(--text-dim)";
  const [buy, sell] = o.legs;
  const isApr = o.rateBasis === "apr";
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={flashing ? "spike-flash" : undefined}
      style={{
        display: "grid", gridTemplateColumns: showExecute ? COLS : COLS_MON, gap: 10, alignItems: "center",
        padding: "8px 12px", borderBottom: "1px solid var(--border)", fontSize: 12.5,
        background: hover ? "var(--card-2)" : "transparent",
        transition: "background 100ms",
      }}
    >
      {/* strategy pill */}
      <span
        style={{
          justifySelf: "start",
          display: "inline-flex", alignItems: "center", gap: 6,
          background: "color-mix(in srgb, " + km.color + " 14%, transparent)",
          color: km.color, borderRadius: 999, padding: "3px 9px",
          fontSize: 11, fontWeight: 600,
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: 999, background: km.color }} />
        {km.label}
      </span>

      {/* pair */}
      <span style={{ display: "flex", alignItems: "baseline", gap: 7, minWidth: 0 }}>
        <span style={{ fontWeight: 700, letterSpacing: "-0.01em" }}>{o.base}</span>
        {o.mock ? (
          <span style={{ color: "var(--text-mute)", fontSize: 10, border: "1px solid var(--border)", borderRadius: 5, padding: "0 4px" }}>
            mock
          </span>
        ) : !isApr && <PersistChip p={o.persistence} />}
      </span>

      {/* route */}
      <span style={{ color: "var(--text-dim)", fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {buy && sell ? (
          <>
            <b style={{ color: "var(--pos)", fontWeight: 600 }}>{isApr ? "롱" : "매수"}</b> {vlabel(buy.venue)}
            <span style={{ color: "var(--text-mute)", margin: "0 7px" }}>→</span>
            <b style={{ color: "var(--neg)", fontWeight: 600 }}>{isApr ? "숏" : "매도"}</b> {vlabel(sell.venue)}
            {o.transfer?.blocked && (
              <span style={{ color: "var(--neg)", marginLeft: 8, fontSize: 11, fontWeight: 600 }}>중단</span>
            )}
          </>
        ) : "—"}
      </span>

      <span className="tnum" style={{ textAlign: "right", color: "var(--text-dim)" }}>
        {pct(gross, false)}{isApr ? " APR" : ""}
      </span>
      <span className="tnum" style={{ textAlign: "right", color: "var(--text-mute)" }}>
        −{o.costPct.toFixed(2)}%
      </span>
      <span
        className="tnum"
        style={{
          justifySelf: "end",
          background: net > 0 ? "var(--pos-soft)" : net < 0 ? "var(--neg-soft)" : "transparent",
          color: netTone, fontWeight: 700, borderRadius: 7, padding: "3px 8px",
        }}
      >
        {pct(net)}
      </span>
      <span className="tnum" style={{ textAlign: "right", color: "var(--text-dim)" }}>
        {isApr
          ? (o.fundingMeta ? <FundingCountdown meta={o.fundingMeta} /> : "—")
          : usd(o.notionalCapUsd)}
      </span>

      {/* execute */}
      {showExecute && (
        <button
          type="button"
          disabled={!o.executable}
          onClick={() => onExecute(o)}
          style={{
            justifySelf: "end",
            borderRadius: 8, padding: "7px 14px", fontSize: 12.5, fontWeight: 600,
            cursor: o.executable ? "pointer" : "not-allowed",
            border: o.executable ? "none" : "1px solid var(--border-strong)",
            background: o.executable ? "var(--brand-grad)" : "transparent",
            color: o.executable ? "#181a20" : "var(--text-mute)",
            boxShadow: "none",
          }}
        >
          실행
        </button>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ padding: "56px 18px", textAlign: "center", color: "var(--text-mute)", fontSize: 14 }}>
      {text}
    </div>
  );
}

// ── Execute modal ─────────────────────────────────────────────────────────────
function ExecuteModal({ opp, onClose, isMobile, initialRunId }: { opp: Opportunity; onClose: () => void; isMobile?: boolean; initialRunId?: string | null }) {
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
    setQuoting(true);
    const t = setTimeout(async () => {
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
        if (!cancelled) setQuote(null);
      } finally {
        if (!cancelled) setQuoting(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [opp, sizeUsd]);

  const overCap = quote != null && quote.maxSizeUsd > 0 && sizeUsd > quote.maxSizeUsd;

  // The run lives in the background store, so closing just hides the view — the
  // run keeps going and stays visible in the 실행 탭. No confirm needed.
  const guardedClose = () => onClose();

  return (
    <div
      onClick={guardedClose}
      style={{
        position: "fixed", inset: 0, zIndex: 50,
        background: "rgba(6,8,13,0.66)", backdropFilter: "blur(4px)",
        display: "flex", alignItems: isMobile ? "flex-end" : "center",
        justifyContent: "center", padding: isMobile ? 0 : 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: isMobile ? "100%" : 480, maxWidth: "100%",
          maxHeight: isMobile ? "92dvh" : "90dvh", overflowY: "auto",
          background: "var(--card)", border: "1px solid var(--border-strong)",
          borderRadius: isMobile ? "16px 16px 0 0" : "var(--radius)",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 18px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: km.color }} />
          <span style={{ fontWeight: 700, fontSize: 15 }}>실행 · {opp.base}</span>
          <span style={{ color: "var(--text-mute)", fontSize: 12 }}>{km.label}</span>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={guardedClose} style={xBtn}>✕</button>
        </div>

        <div style={{ padding: 18 }}>
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
                  borderRadius: 999, padding: "1px 8px",
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
                borderRadius: 999, padding: "5px 14px", fontSize: 12, fontWeight: 700,
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

          {/* Size — USD or coin quantity */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14 }}>
            <label style={{ color: "var(--text-dim)", fontSize: 12, fontWeight: 500 }}>
              수량 ({unit === "usd" ? "USD" : opp.base})
            </label>
            <div style={{ display: "inline-flex", gap: 2, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 999, padding: 2 }}>
              {(["usd", "coin"] as const).map((u) => (
                <button
                  key={u}
                  type="button"
                  disabled={running}
                  onClick={() => switchUnit(u)}
                  style={{
                    border: "none", cursor: "pointer", borderRadius: 999, padding: "3px 11px",
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

          {phase === "error" && error && <Warn text={error} />}
          {startErr && <Warn text={startErr} />}

          {/* Run controls */}
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            {phase === "idle" || phase === "done" ? (
              <button
                type="button"
                onClick={() => {
                  if (run) { cancelRun(run.id); } // clear a finished run before a fresh one
                  const res = startRun({ opp, sizeUsd, hedge: hedgeOn, autoLevel });
                  if ("error" in res) { setStartErr(res.error); return; }
                  setStartErr(null);
                  setRunId(res.id);
                }}
                disabled={sizeUsd <= 0 || store.killed}
                style={{
                  flex: 1, padding: 12, borderRadius: "var(--radius-sm)", border: "none",
                  background: store.killed ? "var(--card-3)" : "var(--brand-grad)",
                  color: store.killed ? "var(--text-mute)" : "#181a20", fontWeight: 700, fontSize: 14,
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
                    background: "var(--brand-grad)", color: "#181a20", fontWeight: 700, fontSize: 14, cursor: "pointer",
                  }}
                >
                  {plan[pauseAt]?.id === "withdraw" ? "출금 승인 →"
                    : plan[pauseAt]?.id === "sell" ? "매도 진행 →"
                    : "다음 단계 →"}
                </button>
                <button
                  type="button"
                  onClick={() => { if (runId) { cancelRun(runId); setRunId(null); } }}
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
                  onClick={() => runId && retryRun(runId)}
                  style={{
                    flex: 1, padding: 12, borderRadius: "var(--radius-sm)", border: "none",
                    background: "var(--brand-grad)", color: "#181a20", fontWeight: 700, fontSize: 14, cursor: "pointer",
                  }}
                >
                  실패 지점부터 재시도
                </button>
                <button
                  type="button"
                  onClick={() => { if (runId) { cancelRun(runId); setRunId(null); } }}
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

          {/* Position / smart unwind — once a position exists (buy filled) and
              the run isn't full-auto. Store-backed → survives modal close. */}
          {run && statuses.buy === "done" && run.autoLevel !== "auto" && (
            <PositionPanel run={run} />
          )}

          <p style={{ marginTop: 12, color: "var(--text-mute)", fontSize: 11.5, lineHeight: 1.5 }}>
            {store.killed
              ? "킬 스위치가 활성화되어 신규 실행이 차단됩니다. 해제하려면 상단 정지 버튼을 누르세요."
              : "실행은 백그라운드에서 돌아갑니다 — 이 창을 닫아도 계속 진행되며 '실행' 탭에서 상태를 볼 수 있습니다. 현재 DRY-RUN(시뮬)."}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Control tower — runs dashboard + risk limits + kill + tool suggestions ────
type RiskState = { day: string; realizedPnlUsd: number; maxPerTradeUsd: number; maxInFlightUsd: number; maxDailyLossUsd: number };

function ControlPanel({ runs, killed, onOpen }: { runs: RunView[]; killed: boolean; onOpen: (r: RunView) => void }) {
  const inFlight = inFlightUsd();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingBottom: 40 }}>
      <KillCard killed={killed} />
      <RiskCard inFlight={inFlight} />
      {runs.length > 0
        ? <RunsDashboard runs={runs} onOpen={onOpen} onClearDone={() => {}} />
        : <div style={{ color: "var(--text-mute)", fontSize: 12.5, textAlign: "center", padding: "18px 0", border: "1px dashed var(--border)", borderRadius: "var(--radius)" }}>진행 중인 실행 없음 — 실행 탭에서 시작하면 여기에 표시됩니다</div>}
      <GatesCard />
      <ToolsCard />
    </div>
  );
}

function KillCard({ killed }: { killed: boolean }) {
  return (
    <div style={{ background: killed ? "var(--neg-soft)" : "var(--card)", border: `1px solid ${killed ? "var(--neg)" : "var(--border)"}`, borderRadius: "var(--radius)", padding: "12px 14px", display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: killed ? "var(--neg)" : "var(--text)" }}>{killed ? "전체 중단됨" : "킬 스위치"}</div>
        <div style={{ fontSize: 11.5, color: "var(--text-mute)", marginTop: 2 }}>
          {killed ? "모든 실행 중단 + 신규 차단 중" : "누르면 진행 중인 모든 실행을 멈추고 신규를 차단합니다"}
        </div>
      </div>
      <button
        type="button"
        onClick={() => setKillSwitch(!killed)}
        style={{
          border: "none", borderRadius: "var(--radius-sm)", padding: "10px 18px", cursor: "pointer",
          fontWeight: 800, fontSize: 13,
          background: killed ? "var(--pos)" : "var(--neg)", color: "#0b0e11",
        }}
      >
        {killed ? "해제" : "전체 중단"}
      </button>
    </div>
  );
}

function RiskCard({ inFlight }: { inFlight: number }) {
  const [rs, setRs] = useState<RiskState | null>(null);
  const [draft, setDraft] = useState<{ perTrade: string; inFlight: string; dailyLoss: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    try {
      const j = (await (await fetch("/api/risk", { cache: "no-store" })).json()) as RiskState;
      setRs(j);
      setInFlightLimit(j.maxInFlightUsd);
      setDraft({ perTrade: String(j.maxPerTradeUsd), inFlight: String(j.maxInFlightUsd), dailyLoss: String(j.maxDailyLossUsd) });
    } catch { /* keep */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const body = { maxPerTradeUsd: Number(draft.perTrade) || 0, maxInFlightUsd: Number(draft.inFlight) || 0, maxDailyLossUsd: Number(draft.dailyLoss) || 0 };
      const j = (await (await fetch("/api/risk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as RiskState;
      setRs(j);
      setInFlightLimit(j.maxInFlightUsd);
    } finally { setSaving(false); }
  };

  const loss = rs ? Math.max(0, -rs.realizedPnlUsd) : 0;
  const lossPct = rs && rs.maxDailyLossUsd > 0 ? Math.min(100, (loss / rs.maxDailyLossUsd) * 100) : 0;
  const flightPct = rs && rs.maxInFlightUsd > 0 ? Math.min(100, (inFlight / rs.maxInFlightUsd) * 100) : 0;
  const field = (label: string, key: "perTrade" | "inFlight" | "dailyLoss") => (
    <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 10.5, color: "var(--text-mute)" }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 4, border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", background: "var(--bg)" }}>
        <span style={{ color: "var(--text-mute)", fontSize: 12 }}>$</span>
        <input
          className="tnum"
          inputMode="numeric"
          value={draft?.[key] ?? ""}
          onChange={(e) => setDraft((d) => (d ? { ...d, [key]: e.target.value.replace(/[^\d]/g, "") } : d))}
          style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", color: "var(--text)", fontSize: 13, outline: "none" }}
        />
      </div>
    </label>
  );

  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 14px" }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>리스크 한도</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        {field("1회 최대", "perTrade")}
        {field("총 노출", "inFlight")}
        {field("일일 손실", "dailyLoss")}
      </div>
      <button
        type="button"
        onClick={save}
        disabled={saving}
        style={{ marginTop: 10, width: "100%", border: "none", borderRadius: "var(--radius-sm)", padding: 9, background: "var(--brand-grad)", color: "#181a20", fontWeight: 700, fontSize: 12.5, cursor: "pointer" }}
      >
        {saving ? "저장 중…" : "한도 저장"}
      </button>

      {rs && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-dim)" }}>
              <span>총 노출 (진행 중)</span>
              <span className="tnum">{usd(inFlight)} / {usd(rs.maxInFlightUsd)}</span>
            </div>
            <div style={{ height: 5, borderRadius: 999, background: "var(--bg)", overflow: "hidden", marginTop: 4 }}>
              <div style={{ width: `${flightPct}%`, height: "100%", background: flightPct > 90 ? "var(--neg)" : "var(--brand)" }} />
            </div>
          </div>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-dim)" }}>
              <span>오늘 실현 손익</span>
              <span className="tnum" style={{ color: rs.realizedPnlUsd >= 0 ? "var(--pos)" : "var(--neg)" }}>
                {rs.realizedPnlUsd >= 0 ? "+" : "−"}${Math.abs(rs.realizedPnlUsd).toFixed(2)}
              </span>
            </div>
            <div style={{ height: 5, borderRadius: 999, background: "var(--bg)", overflow: "hidden", marginTop: 4 }}>
              <div style={{ width: `${lossPct}%`, height: "100%", background: lossPct > 80 ? "var(--neg)" : "var(--amber)" }} />
            </div>
            <div style={{ fontSize: 10, color: "var(--text-mute)", marginTop: 3 }}>손실 한도까지 {usd(Math.max(0, rs.maxDailyLossUsd - loss))} 남음</div>
          </div>
        </div>
      )}
    </div>
  );
}

// Deposit/withdraw gate lookup across venues (pre-trade settlement check).
type GateRow = { base: string; venues: Record<string, { deposit: boolean; withdraw: boolean } | null> };
function GatesCard() {
  const [q, setQ] = useState("");
  const [data, setData] = useState<{ venues: string[]; rows: GateRow[] } | null>(null);
  useEffect(() => {
    fetch("/api/gates", { cache: "no-store" }).then((r) => r.json()).then(setData).catch(() => {});
  }, []);
  const rows = useMemo(() => {
    if (!data) return [];
    const term = q.trim().toUpperCase();
    const list = term ? data.rows.filter((r) => r.base.includes(term)) : data.rows;
    return list.slice(0, term ? 30 : 12);
  }, [data, q]);
  const cell = (s: { deposit: boolean; withdraw: boolean } | null) => {
    if (!s) return <span style={{ fontSize: 10.5, color: "var(--text-mute)" }}>키필요</span>;
    const tag = (on: boolean, t: string) => (
      <span style={{ fontSize: 10.5, fontWeight: 700, color: on ? "var(--pos)" : "var(--neg)" }}>{t}</span>
    );
    return <span style={{ display: "inline-flex", gap: 4 }}>{tag(s.deposit, "입")}{tag(s.withdraw, "출")}</span>;
  };
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 14px" }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 3 }}>입출금 게이트 조회</div>
      <div style={{ fontSize: 11, color: "var(--text-mute)", marginBottom: 8 }}>실행 전 코인의 거래소별 입금·출금 열림 여부 확인 (<span style={{ color: "var(--pos)" }}>입/출</span> = 열림, <span style={{ color: "var(--neg)" }}>빨강</span> = 중단)</div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="코인 검색 (예: XRP)"
        style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px", color: "var(--text)", fontSize: 13, outline: "none", marginBottom: 8 }}
      />
      {!data ? (
        <div style={{ color: "var(--text-mute)", fontSize: 12, padding: "8px 0" }}>조회 중…</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: `64px repeat(${data.venues.length}, 1fr)`, gap: "6px 10px", fontSize: 12, minWidth: 60 + data.venues.length * 70 }}>
            <span style={{ fontSize: 10.5, color: "var(--text-mute)" }}>코인</span>
            {data.venues.map((v) => <span key={v} style={{ fontSize: 10.5, color: "var(--text-mute)" }}>{VENUE_LABEL[v] ?? v}</span>)}
            {rows.map((r) => (
              <Fragment key={r.base}>
                <span style={{ fontWeight: 700 }}>{r.base}</span>
                {data.venues.map((v) => <span key={v}>{cell(r.venues[v])}</span>)}
              </Fragment>
            ))}
          </div>
          {rows.length === 0 && <div style={{ color: "var(--text-mute)", fontSize: 12, padding: "6px 0" }}>결과 없음</div>}
        </div>
      )}
    </div>
  );
}

function ToolsCard() {
  const tools = [
    { t: "긴급 청산·헷지 정리", d: "열린 포지션을 즉시 시장가 청산 / 헷지만 정리" },
    { t: "KRW 리패트리에이션", d: "원화 회수(오프램프) 한도·환전 비용 추적" },
    { t: "알림(텔레그램)", d: "임계 순수익 돌파·입출금 중단·에러를 폰으로" },
    { t: "거래·P&L 기록", d: "탐지 엣지 vs 실제 포착, 실수수료 대조, 히트율" },
  ];
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 14px" }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>도구 (추천)</div>
      <div style={{ fontSize: 11, color: "var(--text-mute)", marginBottom: 10 }}>더 붙이면 좋은 관제 도구들 — 원하는 걸 만들어 드립니다</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {tools.map((x) => (
          <div key={x.t} style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
            <span style={{ marginTop: 5, width: 5, height: 5, borderRadius: 999, background: "var(--brand)", flex: "0 0 auto" }} />
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{x.t}</div>
              <div style={{ fontSize: 11, color: "var(--text-mute)" }}>{x.d}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Active runs dashboard — background runs, their live progress + controls ────
function RunsDashboard({ runs, onOpen }: {
  runs: RunView[];
  onOpen: (r: RunView) => void;
  onClearDone: () => void;
}) {
  const hasDone = runs.some((r) => r.phase === "done");
  const phaseLabel: Record<string, { t: string; c: string }> = {
    running: { t: "실행 중", c: "var(--amber)" },
    paused: { t: "확인 대기", c: "var(--brand-2)" },
    error: { t: "중단/오류", c: "var(--neg)" },
    done: { t: "완료", c: "var(--pos)" },
    idle: { t: "대기", c: "var(--text-mute)" },
  };
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "0 2px 6px" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-dim)" }}>실행 현황 · {runs.length}</span>
        {hasDone && (
          <button type="button" onClick={() => clearFinished()} style={{ background: "transparent", border: "none", color: "var(--text-mute)", fontSize: 11, cursor: "pointer" }}>
            완료 정리
          </button>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {runs.map((r) => {
          const total = r.plan.length;
          const doneCount = r.plan.filter((s) => r.statuses[s.id] === "done").length;
          const cur = r.plan[r.pauseAt] ?? r.plan.find((s) => r.statuses[s.id] === "running") ?? r.plan[doneCount];
          const ph = phaseLabel[r.phase] ?? phaseLabel.idle;
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => onOpen(r)}
              style={{
                display: "block", width: "100%", textAlign: "left", cursor: "pointer",
                background: "var(--card)", border: `1px solid ${r.phase === "error" ? "var(--neg)" : r.phase === "paused" ? "var(--brand)" : "var(--border)"}`,
                borderRadius: "var(--radius)", padding: "10px 12px", color: "var(--text)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 6, height: 6, borderRadius: 999, background: ph.c, boxShadow: r.phase === "running" ? `0 0 6px ${ph.c}` : "none" }} />
                <span style={{ fontWeight: 700, fontSize: 13.5 }}>{r.base}</span>
                <span style={{ fontSize: 11, color: "var(--text-mute)" }}>{r.route}</span>
                <span style={{ flex: 1 }} />
                <span className="tnum" style={{ fontSize: 11, color: "var(--text-dim)" }}>{usd(r.sizeUsd)}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: ph.c }}>{ph.t}</span>
              </div>
              {/* progress */}
              <div style={{ display: "flex", height: 5, borderRadius: 999, overflow: "hidden", background: "var(--bg)", marginTop: 8 }}>
                <div style={{ width: `${total ? (doneCount / total) * 100 : 0}%`, background: r.phase === "error" ? "var(--neg)" : "var(--brand)", transition: "width 200ms" }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 10.5, color: "var(--text-mute)" }}>
                <span>{doneCount}/{total} · {cur ? cur.label : "—"}</span>
                {r.pnlUsd !== 0 && <span className="tnum" style={{ color: r.pnlUsd >= 0 ? "var(--pos)" : "var(--neg)" }}>실현 {r.pnlUsd >= 0 ? "+" : "−"}${Math.abs(r.pnlUsd).toFixed(2)}</span>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Execution flow timeline ───────────────────────────────────────────────────
function StepTimeline({
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
                marginTop: 4, width: 8, height: 8, borderRadius: 999, background: color,
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
                    borderRadius: 4, padding: "2px 7px",
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
function PositionPanel({ run }: { run: RunView }) {
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
      <div style={{ height: 8, borderRadius: 999, background: "var(--bg)", border: "1px solid var(--border)", overflow: "hidden" }}>
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
              border: "1px solid var(--border-strong)", borderRadius: 8, padding: "8px 4px",
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
function QuotePanel({
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
          <span style={{ width: 6, height: 6, borderRadius: 999, background: quoting ? "var(--amber)" : "var(--pos)" }} />
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
          <Line label={`${opp.base} 출금비`} value={`−${quote.withdrawalPct.toFixed(2)}%`} dim />
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

function Line({
  label, value, valueColor, strong, dim,
}: {
  label: string;
  value: string;
  valueColor?: string;
  strong?: boolean;
  dim?: boolean;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: 13 }}>
      <span style={{ color: dim ? "var(--text-mute)" : "var(--text-dim)", fontWeight: strong ? 600 : 400 }}>{label}</span>
      <span className="tnum" style={{ color: valueColor ?? (dim ? "var(--text-mute)" : "var(--text)"), fontWeight: strong ? 700 : 500 }}>
        {value}
      </span>
    </div>
  );
}

function Warn({ text }: { text: string }) {
  return (
    <div style={{ marginTop: 8, padding: "7px 10px", borderRadius: 8, background: "var(--neg-soft)", color: "var(--neg)", fontSize: 11.5, fontWeight: 500 }}>
      {text}
    </div>
  );
}

// Withdraw/deposit leg: status on top, its transfer network (+ confirms) beneath.
function LegRow({
  label, statusText, statusColor, chain, confirms,
}: {
  label: string;
  statusText: string;
  statusColor: string;
  chain?: string;
  confirms?: number;
}) {
  return (
    <div style={{ padding: "4px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
        <span style={{ color: "var(--text-dim)" }}>{label}</span>
        <span className="tnum" style={{ color: statusColor, fontWeight: 500 }}>{statusText}</span>
      </div>
      {chain && (
        <div style={{ fontSize: 11, color: "var(--text-mute)", marginTop: 1 }}>
          {chain}
          {confirms ? ` · 컨펌 ${confirms}회` : ""}
        </div>
      )}
    </div>
  );
}

// ── Transfer / settlement gate panel ──────────────────────────────────────────
const VENUE_LABEL: Record<string, string> = {
  binance: "Binance", upbit: "Upbit", bithumb: "Bithumb",
  bybit: "Bybit", okx: "OKX", uniswap: "Uniswap",
  hyperliquid: "Hyperliquid", lighter: "Lighter", dex: "DEX",
};
const vlabel = (v?: string) => (v ? VENUE_LABEL[v] ?? v : "—");
const WL_KEY = "ac.whitelist.v1";

function statusChip(enabled: boolean | null): { t: string; c: string } {
  if (enabled === true) return { t: "가능", c: "var(--pos)" };
  if (enabled === false) return { t: "중단", c: "var(--neg)" };
  return { t: "키 필요", c: "var(--text-mute)" };
}

function TransferPanel({ opp }: { opp: Opportunity }) {
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
            borderRadius: 999, padding: "3px 11px", fontSize: 12, fontWeight: 600,
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
function FundingCountdown({ meta }: { meta: NonNullable<Opportunity["fundingMeta"]> }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((v) => v + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!meta.nextTs) return null;
  const left = meta.nextTs - Date.now();
  if (left <= 0) return null;
  const h = Math.floor(left / 3600_000);
  const m = Math.floor((left % 3600_000) / 60_000);
  const soon = left < 30 * 60_000; // <30m — entering now captures this window
  return (
    <span
      className="tnum"
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        fontSize: 10.5, fontWeight: 600,
        color: soon ? "var(--amber)" : "var(--text-mute)",
      }}
    >
      다음 정산 {h > 0 ? `${h}h ` : ""}{m}m{soon ? " · 임박" : ""}
    </span>
  );
}

// Gap persistence chip — how long the edge has held (flicker vs sustained).
function PersistChip({ p }: { p?: Opportunity["persistence"] }) {
  if (!p || p.samples < 2) return null;
  const held = p.heldSec;
  const sustained = held >= 24;
  const label = held >= 60 ? `${Math.floor(held / 60)}m${held % 60 ? ` ${held % 60}s` : ""}` : `${held}s`;
  const tone = held <= 0 ? "var(--text-mute)" : sustained ? "var(--pos)" : "var(--amber)";
  return (
    <span
      className="tnum"
      title={`지속 ${label} · 적중률 ${p.hitRatePct}%`}
      style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 600, color: tone }}
    >
      <span style={{ width: 4, height: 4, borderRadius: 999, background: tone }} />
      {held <= 0 ? "신규" : `지속 ${label}`}
    </span>
  );
}

// Board freshness: live WS overlay active, or seconds since the last scan.
function ScanAge({ ts, live }: { ts: number; live: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const age = ts ? Math.max(0, Math.round((Date.now() - ts) / 1000)) : null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, color: "var(--text-mute)" }}>
      {live && (
        <>
          <span style={{ width: 5, height: 5, borderRadius: 999, background: "var(--pos)" }} />
          <span style={{ color: "var(--pos)", fontWeight: 600 }}>실시간</span>
          <span>·</span>
        </>
      )}
      <span className="tnum">{age == null ? "스캔 대기" : `스캔 ${age}s 전`}</span>
    </span>
  );
}

// ── small bits ────────────────────────────────────────────────────────────────
// Venue chips with data freshness (var1 idea) — "몇 초 전 데이터인가"가 아비에선
// 연결 여부보다 중요한 신호다.
function LiveDots({ status, ages, isMobile }: { status: LiveStatus; ages: LiveAges; isMobile?: boolean }) {
  const chip = (on: boolean, age: number | null, label: string) => {
    const fresh = on && age != null && age <= 5;
    const tone = fresh ? "var(--pos)" : on ? "var(--amber)" : "var(--text-mute)";
    return (
      <span
        key={label}
        title={`${label} · ${age != null ? age + "s 전" : "미수신"}`}
        style={{
          display: "inline-flex", alignItems: "center", gap: 4,
          border: "1px solid var(--border)", borderRadius: 4,
          padding: isMobile ? "2px 5px" : "2px 7px",
          background: "var(--card)",
        }}
      >
        <span style={{ width: 5, height: 5, borderRadius: 999, background: tone }} />
        <span className="tnum" style={{ fontSize: 10, fontWeight: 600, color: on ? "var(--text-dim)" : "var(--text-mute)" }}>
          {label}
          {!isMobile && age != null && <span style={{ color: "var(--text-mute)", fontWeight: 400 }}> {age}s</span>}
        </span>
      </span>
    );
  };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginRight: 2 }}>
      {chip(status.binance, ages.binance, "BN")}
      {chip(status.upbit, ages.upbit, "UP")}
      {chip(status.bithumb, ages.bithumb, "BT")}
    </span>
  );
}

function Pill({
  text, tone, soft, dot,
}: {
  text: string;
  tone: string;
  soft?: boolean;
  dot?: boolean;
}) {
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        border: `1px solid ${soft ? "transparent" : tone}`,
        background: soft ? "color-mix(in srgb, " + tone + " 14%, transparent)" : "transparent",
        color: tone, fontSize: 12, fontWeight: 600, borderRadius: 999, padding: "5px 11px",
      }}
    >
      {dot && <span style={{ width: 7, height: 7, borderRadius: 999, background: tone }} />}
      {text}
    </span>
  );
}

const xBtn: React.CSSProperties = {
  background: "transparent", border: "1px solid var(--border-strong)",
  color: "var(--text-dim)", fontSize: 13, borderRadius: 8, padding: "4px 9px", cursor: "pointer",
};
