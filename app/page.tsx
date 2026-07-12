"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Opportunity, Quote, StrategyKind } from "@/lib/types";
import { pct, usd, price } from "@/lib/format";
import { useLivePrices, type LiveGap, type LiveStatus } from "@/lib/useLivePrices";
import { buildPlan, useFlowRunner, type AutoLevel, type ExecStep, type StepPhase, type StepId, type StepResult } from "@/lib/executionPlan";
import InventoryPanel from "./components/InventoryPanel";

const KIND_META: Record<StrategyKind, { label: string; color: string }> = {
  kimchi: { label: "김프", color: "var(--brand-2)" },
  "cross-cex": { label: "거래소간", color: "var(--sky)" },
  "funding-basis": { label: "펀딩", color: "var(--amber)" },
  "cex-dex": { label: "CEX-DEX", color: "var(--teal)" },
};
const KINDS = Object.keys(KIND_META) as StrategyKind[];

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
  // Two separated tools: "monitor" = gap viewing only (no execute), "execute" = trading.
  const [mode, setMode] = useState<"monitor" | "execute">("monitor");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/scan", { cache: "no-store" });
      const j = await res.json();
      setOpps(j.opportunities ?? []);
      setMeta(j.meta ?? null);
    } catch {
      /* keep stale */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [load]);

  const rows = useMemo(
    () => (filter === "all" ? opps : opps.filter((o) => o.kind === filter)),
    [opps, filter],
  );
  const positive = opps.filter((o) => o.netPct > 0).length;
  const bestEdge = opps.length ? Math.max(...opps.map((o) => o.netPct)) : null;
  const isMobile = useIsMobile();
  // Real-time overlay — client WebSockets recompute premium/net sub-second.
  const { overlay: liveOverlay, status: liveStatus } = useLivePrices(opps, true);

  return (
    <main style={{ minHeight: "100dvh" }}>
      {/* ── Header ─────────────────────────────────────────────── */}
      <header
        style={{
          position: "sticky", top: 0, zIndex: 20,
          display: "flex", alignItems: "center", gap: isMobile ? 10 : 14,
          padding: isMobile ? "11px 14px" : "14px 24px",
          borderBottom: "1px solid var(--border)",
          background: "rgba(10,13,20,0.72)",
          backdropFilter: "blur(12px)",
        }}
      >
        <div
          style={{
            width: 30, height: 30, borderRadius: 9,
            background: "var(--brand-grad)",
            boxShadow: "0 4px 14px rgba(124,108,255,0.45)",
            display: "grid", placeItems: "center",
            color: "#fff", fontWeight: 800, fontSize: 15,
          }}
        >
          ⇄
        </div>
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.15 }}>
          <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em" }}>
            Arb Cockpit
          </span>
          {!isMobile && (
            <span style={{ color: "var(--text-mute)", fontSize: 11 }}>
              반자동 · 개인용
            </span>
          )}
        </div>
        <span style={{ flex: 1 }} />
        <LiveDots status={liveStatus} isMobile={isMobile} />
        {meta?.mock && !isMobile && <Pill text="목업" tone="var(--sky)" soft />}
        <Pill
          text={meta?.dryRun ? "모의(Dry-run)" : "실주문"}
          tone={meta?.dryRun ? "var(--pos)" : "var(--neg)"}
          soft
          dot
        />
      </header>

      <div style={{ maxWidth: 1180, margin: "0 auto", padding: isMobile ? "14px 12px" : "24px" }}>
        {/* ── Mode: gap monitor (view-only) vs execution (trade) ── */}
        <div
          style={{
            display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6,
            padding: 4, marginBottom: isMobile ? 14 : 18,
            background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12,
          }}
        >
          {([
            { k: "monitor", label: "📈 갭 모니터", sub: "보기 전용" },
            { k: "execute", label: "⚡ 실행", sub: "주문 실행" },
          ] as const).map((m) => {
            const active = mode === m.k;
            return (
              <button
                key={m.k}
                type="button"
                onClick={() => {
                  setMode(m.k);
                  if (m.k === "monitor") setSelected(null);
                }}
                style={{
                  border: "none", cursor: "pointer", borderRadius: 9, padding: "9px 8px",
                  background: active ? "var(--brand-soft)" : "transparent",
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 1,
                }}
              >
                <span style={{ fontSize: 14, fontWeight: 700, color: active ? "var(--brand-2)" : "var(--text-dim)" }}>
                  {m.label}
                </span>
                <span style={{ fontSize: 11, color: active ? "var(--brand)" : "var(--text-mute)" }}>
                  {m.sub}
                </span>
              </button>
            );
          })}
        </div>

        {/* ── Balances / inventory (global vs KR capital skew) ── */}
        <InventoryPanel isMobile={isMobile} />

        {/* ── KPI tiles ────────────────────────────────────────── */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: isMobile ? 8 : 14,
            marginBottom: isMobile ? 14 : 20,
          }}
        >
          <Tile label="기회" value={String(opps.length)} sub={`전략 ${KINDS.length}종`} compact={isMobile} />
          <Tile label="수익 기회" value={String(positive)} sub="비용 넘김" tone="var(--pos)" compact={isMobile} />
          <Tile
            label="최고 수익"
            value={bestEdge == null ? "—" : pct(bestEdge)}
            sub="수수료 반영"
            tone={bestEdge && bestEdge > 0 ? "var(--pos)" : "var(--text)"}
            compact={isMobile}
          />
        </div>

        {/* ── Segmented filter (scrolls horizontally on mobile) ── */}
        <div style={{ overflowX: "auto", marginBottom: 16, maxWidth: "100%", WebkitOverflowScrolling: "touch" }}>
        <div
          style={{
            display: "inline-flex", gap: 4, padding: 4,
            background: "var(--card)", border: "1px solid var(--border)",
            borderRadius: 999,
          }}
        >
          {(["all", ...KINDS] as const).map((k) => {
            const active = filter === k;
            const label = k === "all" ? "전체" : KIND_META[k].label;
            const n = k === "all" ? opps.length : opps.filter((o) => o.kind === k).length;
            return (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                style={{
                  border: "none", cursor: "pointer", borderRadius: 999,
                  padding: "7px 14px", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap",
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

        {/* ── Board ────────────────────────────────────────────── */}
        <Board rows={rows} loading={loading} onExecute={setSelected} mobile={isMobile} showExecute={mode === "execute"} live={liveOverlay} />

        <p style={{ color: "var(--text-mute)", fontSize: 12, marginTop: 14 }}>
          순수익 = 총차익 − 예상 왕복비용. 김프는 실데이터 연동, 거래소간/펀딩/CEX-DEX는
          목업 스텁입니다.
        </p>
      </div>

      {selected && mode === "execute" && (
        <ExecuteModal opp={selected} onClose={() => setSelected(null)} isMobile={isMobile} />
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
        borderRadius: "var(--radius)", padding: compact ? "12px 12px" : "16px 18px",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div style={{ color: "var(--text-dim)", fontSize: compact ? 11 : 12, fontWeight: 500, whiteSpace: "nowrap" }}>{label}</div>
      <div
        className="tnum"
        style={{ color: tone ?? "var(--text)", fontSize: compact ? 20 : 26, fontWeight: 700, letterSpacing: "-0.02em", marginTop: compact ? 3 : 4 }}
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
  rows, loading, onExecute, mobile, showExecute, live,
}: {
  rows: Opportunity[];
  loading: boolean;
  onExecute: (o: Opportunity) => void;
  mobile?: boolean;
  showExecute?: boolean;
  live?: Record<string, LiveGap>;
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
            padding: "12px 18px", color: "var(--text-mute)", fontSize: 11,
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
            <OppCard key={o.id} o={o} onExecute={onExecute} showExecute={showExecute} live={live?.[o.id]} />
          ) : (
            <Row key={o.id} o={o} onExecute={onExecute} showExecute={showExecute} live={live?.[o.id]} />
          ),
        )
      )}
    </div>
  );
}

// Mobile opportunity card — stacked layout instead of the wide desktop table.
function OppCard({ o, onExecute, showExecute, live }: { o: Opportunity; onExecute: (o: Opportunity) => void; showExecute?: boolean; live?: LiveGap }) {
  const km = KIND_META[o.kind];
  const net = live?.netPct ?? o.netPct;
  const gross = live?.grossPct ?? o.grossPct;
  const netTone = net > 0 ? "var(--pos)" : net < 0 ? "var(--neg)" : "var(--text-dim)";
  const [buy, sell] = o.legs;
  return (
    <div style={{ padding: "13px 14px", borderBottom: "1px solid var(--border)" }}>
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
        <span
          className="tnum"
          style={{
            background: net > 0 ? "var(--pos-soft)" : net < 0 ? "var(--neg-soft)" : "transparent",
            color: netTone, fontWeight: 800, fontSize: 16, borderRadius: 8, padding: "3px 9px", flex: "0 0 auto",
          }}
        >
          {pct(net)}
        </span>
      </div>

      <div style={{ color: "var(--text-dim)", fontSize: 12.5, margin: "9px 0 10px" }}>
        {buy && sell ? (
          <>
            <b style={{ color: "var(--pos)", fontWeight: 600 }}>매수</b> {buy.venue}
            <span style={{ color: "var(--text-mute)", margin: "0 6px" }}>→</span>
            <b style={{ color: "var(--neg)", fontWeight: 600 }}>매도</b> {sell.venue}
          </>
        ) : "—"}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <span className="tnum" style={{ color: "var(--text-mute)", fontSize: 12 }}>
            총차익 {pct(gross, false)} · 비용 −{o.costPct.toFixed(2)}%
            {o.notionalCapUsd ? ` · 한도 ${usd(o.notionalCapUsd)}` : ""}
          </span>
          {o.transfer?.blocked && (
            <span style={{ color: "var(--neg)", fontSize: 11, fontWeight: 600 }}>⛔ 입출금 중단</span>
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
              boxShadow: o.executable ? "0 4px 12px rgba(124,108,255,0.3)" : "none",
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

function Row({ o, onExecute, showExecute, live }: { o: Opportunity; onExecute: (o: Opportunity) => void; showExecute?: boolean; live?: LiveGap }) {
  const km = KIND_META[o.kind];
  const [hover, setHover] = useState(false);
  const net = live?.netPct ?? o.netPct;
  const gross = live?.grossPct ?? o.grossPct;
  const netTone = net > 0 ? "var(--pos)" : net < 0 ? "var(--neg)" : "var(--text-dim)";
  const [buy, sell] = o.legs;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "grid", gridTemplateColumns: showExecute ? COLS : COLS_MON, gap: 10, alignItems: "center",
        padding: "13px 18px", borderBottom: "1px solid var(--border)", fontSize: 13,
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
        {o.mock && (
          <span style={{ color: "var(--text-mute)", fontSize: 10, border: "1px solid var(--border)", borderRadius: 5, padding: "0 4px" }}>
            mock
          </span>
        )}
      </span>

      {/* route */}
      <span style={{ color: "var(--text-dim)", fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {buy && sell ? (
          <>
            <b style={{ color: "var(--pos)", fontWeight: 600 }}>매수</b> {buy.venue}
            <span style={{ color: "var(--text-mute)", margin: "0 7px" }}>→</span>
            <b style={{ color: "var(--neg)", fontWeight: 600 }}>매도</b> {sell.venue}
            {o.transfer?.blocked && (
              <span style={{ color: "var(--neg)", marginLeft: 8, fontSize: 11, fontWeight: 600 }}>⛔ 중단</span>
            )}
          </>
        ) : "—"}
      </span>

      <span className="tnum" style={{ textAlign: "right", color: "var(--text-dim)" }}>
        {pct(gross, false)}
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
        {usd(o.notionalCapUsd)}
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
            color: o.executable ? "#fff" : "var(--text-mute)",
            boxShadow: o.executable ? "0 4px 12px rgba(124,108,255,0.3)" : "none",
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
function ExecuteModal({ opp, onClose, isMobile }: { opp: Opportunity; onClose: () => void; isMobile?: boolean }) {
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
  const plan = useMemo(() => buildPlan(opp, hedgeOn), [opp, hedgeOn]);
  // Each step runs server-side (orders/withdraw stubs + real personal-wallet send),
  // DRY-RUN by default. sizeUsd resolved below.
  const runStep = useCallback(
    async (stepId: StepId, opts?: { rollback?: boolean }): Promise<StepResult> => {
      try {
        const res = await fetch("/api/exec-step", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ stepId, opportunity: opp, sizeUsd, rollback: opts?.rollback }),
        });
        const j = await res.json();
        return { ok: !!j.ok, message: j.message };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : "요청 실패" };
      }
    },
    [opp, sizeUsd],
  );
  const runner = useFlowRunner(plan, autoLevel, runStep);

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

  return (
    <div
      onClick={onClose}
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
          <button type="button" onClick={onClose} style={xBtn}>✕</button>
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
              disabled={!opp.hasPerp}
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
              ⚠ 선물 없음 — 무헷지(전송 중 가격 노출). 빠른 코인 소액만 권장.
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
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
              {([
                { k: "manual", label: "수동", sub: "단계마다" },
                { k: "beforeWithdraw", label: "출금 전까지", sub: "권장" },
                { k: "auto", label: "전자동", sub: "끝까지" },
              ] as const).map((a) => {
                const on = autoLevel === a.k;
                return (
                  <button
                    key={a.k}
                    type="button"
                    onClick={() => setAutoLevel(a.k)}
                    disabled={runner.phase === "running"}
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

          <StepTimeline steps={plan} statuses={runner.statuses} messages={runner.messages} pauseAt={runner.pauseAt} />

          {runner.phase === "error" && runner.error && <Warn text={runner.error} />}

          {/* Run controls */}
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            {runner.phase === "idle" || runner.phase === "done" ? (
              <button
                type="button"
                onClick={runner.start}
                disabled={sizeUsd <= 0}
                style={{
                  flex: 1, padding: 12, borderRadius: "var(--radius-sm)", border: "none",
                  background: "var(--brand-grad)", color: "#fff", fontWeight: 700, fontSize: 14,
                  cursor: "pointer", boxShadow: "0 6px 18px rgba(124,108,255,0.35)",
                }}
              >
                {runner.phase === "done" ? "다시 실행" : "실행 시작 →"}
              </button>
            ) : runner.phase === "paused" ? (
              <>
                <button
                  type="button"
                  onClick={runner.confirmContinue}
                  style={{
                    flex: 1, padding: 12, borderRadius: "var(--radius-sm)", border: "none",
                    background: "var(--brand-grad)", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer",
                  }}
                >
                  {plan[runner.pauseAt]?.id === "withdraw" ? "⚠ 출금 승인 →" : "다음 단계 →"}
                </button>
                <button
                  type="button"
                  onClick={runner.reset}
                  style={{
                    padding: "12px 16px", borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--border-strong)", background: "transparent",
                    color: "var(--text-dim)", fontWeight: 600, cursor: "pointer",
                  }}
                >
                  중단
                </button>
              </>
            ) : runner.phase === "error" ? (
              <button
                type="button"
                onClick={runner.reset}
                style={{
                  flex: 1, padding: 12, borderRadius: "var(--radius-sm)", border: "none",
                  background: "var(--brand-grad)", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer",
                }}
              >
                다시 시작
              </button>
            ) : (
              <button
                type="button"
                disabled
                style={{
                  flex: 1, padding: 12, borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--border-strong)", background: "transparent",
                  color: "var(--text-dim)", fontWeight: 700, fontSize: 14,
                }}
              >
                실행 중…
              </button>
            )}
          </div>

          {/* Position / smart unwind — partial exit on remaining qty */}
          <PositionPanel opp={opp} sizeUsd={sizeUsd} />

          <p style={{ marginTop: 12, color: "var(--text-mute)", fontSize: 11.5, lineHeight: 1.5 }}>
            DRY-RUN 상태머신입니다 — 각 단계는 시뮬레이션이며 실주문은 나가지 않습니다. API 키를
            넣고 각 단계에 실제 주문/출금을 배선하면 그대로 작동합니다 (lib/executionPlan.ts).
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Execution flow timeline ───────────────────────────────────────────────────
function StepTimeline({
  steps, statuses, messages, pauseAt,
}: {
  steps: ExecStep[];
  statuses: Record<string, StepPhase>;
  messages: Record<string, string>;
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
          : st === "done" ? "var(--pos)"
          : st === "running" ? "var(--amber)"
          : paused ? "var(--brand-2)" : "var(--text-mute)";
        const sub = messages[s.id] ?? s.desc;
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
                {st === "done" ? " ✓" : st === "running" ? " …" : st === "error" ? " ✕" : paused ? " · 확인 대기" : ""}
              </div>
              <div style={{ fontSize: 11, color: st === "error" ? "var(--neg)" : "var(--text-mute)" }}>{sub}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Position / smart unwind (남은 물량 기준 부분 청산) ──────────────────────────
function PositionPanel({ opp, sizeUsd }: { opp: Opportunity; sizeUsd: number }) {
  const price = opp.legs.find((l) => l.venue === "binance")?.price ?? 0;
  const totalQty = price ? sizeUsd / price : 0;
  const [remaining, setRemaining] = useState(totalQty);
  const [pnl, setPnl] = useState(0);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  useEffect(() => {
    setRemaining(totalQty);
    setPnl(0);
    setLog([]);
  }, [opp, totalQty]);

  const doUnwind = async (fraction: number) => {
    if (remaining <= 0 || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/unwind", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ opportunity: opp, remainingQty: remaining, fraction }),
      });
      const j = await res.json();
      const r = j.result as { remainingQty: number; pnlUsd: number; log: string[] } | undefined;
      if (r) {
        setRemaining(r.remainingQty);
        setPnl((p) => p + r.pnlUsd);
        setLog((l) => ["──", ...r.log, ...l].slice(0, 24));
      }
    } finally {
      setBusy(false);
    }
  };

  const pctLeft = totalQty > 0 ? (remaining / totalQty) * 100 : 0;
  const done = remaining <= totalQty * 1e-6;

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
      ⚠ {text}
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
};
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

// ── small bits ────────────────────────────────────────────────────────────────
function LiveDots({ status, isMobile }: { status: LiveStatus; isMobile?: boolean }) {
  const any = status.binance || status.upbit || status.bithumb;
  const dot = (on: boolean, label: string) => (
    <span key={label} title={label} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
      <span
        style={{
          width: 6, height: 6, borderRadius: 999,
          background: on ? "var(--pos)" : "var(--text-mute)",
          boxShadow: on ? "0 0 6px var(--pos)" : "none",
        }}
      />
      {!isMobile && <span style={{ fontSize: 10, color: on ? "var(--text-dim)" : "var(--text-mute)" }}>{label}</span>}
    </span>
  );
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: isMobile ? 6 : 9, marginRight: 2 }}>
      {!isMobile && (
        <span style={{ fontSize: 11, fontWeight: 600, color: any ? "var(--pos)" : "var(--text-mute)" }}>
          {any ? "실시간" : "연결 중"}
        </span>
      )}
      {dot(status.binance, "BN")}
      {dot(status.upbit, "UP")}
      {dot(status.bithumb, "BT")}
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
