"use client";

import React from "react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Opportunity, Quote, StrategyKind } from "@/lib/types";
import { pct, usd, price } from "@/lib/format";
import { type LiveAges, type LiveGap, type LiveStatus } from "@/lib/useLivePrices";
import { buildPlan, type AutoLevel, type ExecStep, type StepPhase } from "@/lib/executionPlan";
import { useRuns, startRun, confirmRun, retryRun, cancelRun, unwindRun, clearFinished, setKillSwitch, inFlightUsd, setInFlightLimit, type RunView } from "@/lib/runStore";
import { KIND_META, KINDS, GAP_KINDS, ALERT_NET_PCT, beep, Tile, COLS, COLS_MON, Empty, Metric, Line, Warn, LegRow, VENUE_LABEL, vlabel, WL_KEY, statusChip, FundingCountdown, PersistChip, ScanAge, LiveDots, Pill, xBtn } from "./cockpit-ui";

export type RiskState = { day: string; realizedPnlUsd: number; maxPerTradeUsd: number; maxInFlightUsd: number; maxDailyLossUsd: number };

export type AutoEntryCfg = { armed: boolean; minNet: number; minHeld: number; sizeUsd: number };
export function ControlPanel({ runs, killed, onOpen, autoEntry, onAutoEntry, wide }: { runs: RunView[]; killed: boolean; onOpen: (r: RunView) => void; autoEntry?: AutoEntryCfg; onAutoEntry?: (v: AutoEntryCfg) => void; wide?: boolean }) {
  const inFlight = inFlightUsd();
  const runsBlock = runs.length > 0
    ? <RunsDashboard runs={runs} onOpen={onOpen} onClearDone={() => {}} />
    : <div style={{ color: "var(--text-mute)", fontSize: 12.5, textAlign: "center", padding: "18px 0", border: "1px dashed var(--border)", borderRadius: "var(--radius)" }}>진행 중인 실행 없음 — 갭 탭에서 시작하면 여기에 표시됩니다</div>;
  const col: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 12, minWidth: 0 };
  if (!wide) {
    return (
      <div style={{ ...col, paddingBottom: 40 }}>
        <StatusCard runs={runs} killed={killed} inFlight={inFlight} autoArmed={autoEntry?.armed} />
        {runsBlock}
        <KillCard killed={killed} />
        {autoEntry && onAutoEntry && <AutoEntryCard cfg={autoEntry} onChange={onAutoEntry} killed={killed} />}
        <PnlCard />
        <GatesCard />
      </div>
    );
  }
  // PC: 현황 풀폭 + 3컬럼, 성격별 그룹 — ① 안전장치(킬·리스크·자동진입)
  // ② 활동·기록(실행 현황·거래손익) ③ 연결·도구(TG·입출금·도구).
  // 컬럼 높이가 비슷해지도록 긴 목록(입출금)은 카드 안에서 스크롤.
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingBottom: 40 }}>
      <StatusCard runs={runs} killed={killed} inFlight={inFlight} autoArmed={autoEntry?.armed} />
      {/* 진행 중 실행 = 최우선 — 풀폭 히어로로 크게 */}
      {runs.length > 0 && <RunsDashboard runs={runs} onOpen={onOpen} onClearDone={() => {}} hero />}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.15fr 1fr", gap: 12, alignItems: "start" }}>
        <div style={col}>
          <KillCard killed={killed} />
          {autoEntry && onAutoEntry && <AutoEntryCard cfg={autoEntry} onChange={onAutoEntry} killed={killed} />}
        </div>
        <div style={col}>
          {runs.length === 0 && runsBlock}
          <PnlCard />
        </div>
        <div style={col}>
          <GatesCard />
        </div>
      </div>
    </div>
  );
}

// ── 운영 현황 스트립 — 지금 시스템이 뭘 하고 있는지 한 줄 요약 ────────────────
function StatusCard({ runs, killed, inFlight, autoArmed }: { runs: RunView[]; killed: boolean; inFlight: number; autoArmed?: boolean }) {
  const [risk, setRisk] = useState<RiskState | null>(null);
  const [watch, setWatch] = useState<{ plays: number; annBlocked: boolean; annOkAgoSec: number | null; tgConfigured: boolean; tgOkAgoSec: number | null } | null>(null);
  useEffect(() => {
    const load = () => {
      fetch("/api/risk", { cache: "no-store" }).then((r) => r.json()).then(setRisk).catch(() => {});
      fetch("/api/listings", { cache: "no-store" }).then((r) => r.json()).then((j) => setWatch(j.watch ?? null)).catch(() => {});
    };
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, []);
  const running = runs.filter((r) => r.phase === "running").length;
  const paused = runs.filter((r) => r.phase === "paused").length;
  const errored = runs.filter((r) => r.phase === "error").length;
  const pnl = risk?.realizedPnlUsd ?? 0;
  const listingWatchOk = watch != null && (!watch.annBlocked || (watch.tgConfigured && watch.tgOkAgoSec != null));
  const cell = (label: string, value: React.ReactNode, tone?: string) => (
    <div style={{ padding: "10px 12px", borderRight: "1px solid var(--border)", minWidth: 0 }}>
      <div className="tnum" style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.1, color: tone ?? "var(--text)", whiteSpace: "nowrap" }}>{value}</div>
      <div style={{ marginTop: 5, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-mute)", whiteSpace: "nowrap" }}>{label}</div>
    </div>
  );
  return (
    <div style={{ border: `1px solid ${killed ? "var(--neg)" : "var(--border)"}`, borderRadius: "var(--radius)", overflow: "hidden" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))" }}>
        {cell("상태", killed ? "중단됨" : errored > 0 ? "오류" : running > 0 ? "실행 중" : "대기", killed ? "var(--neg)" : errored > 0 ? "var(--amber)" : running > 0 ? "var(--pos)" : undefined)}
        {cell("실행 · 대기 · 오류", `${running} · ${paused} · ${errored}`, errored > 0 ? "var(--amber)" : undefined)}
        {cell("노출", risk ? `$${inFlight.toFixed(0)} / $${(risk.maxInFlightUsd / 1000).toFixed(0)}K` : `$${inFlight.toFixed(0)}`)}
        {cell("오늘 실현 손익", `${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(2)}`, pnl > 0 ? "var(--pos)" : pnl < 0 ? "var(--neg)" : undefined)}
        {cell("자동 진입", autoArmed ? "켜짐" : "꺼짐", autoArmed ? "var(--amber)" : undefined)}
        {cell("상장 감시", watch == null ? "—" : listingWatchOk ? `정상 · ${watch.plays}건` : "차단/꺼짐", watch == null ? undefined : listingWatchOk ? "var(--pos)" : "var(--amber)")}
      </div>
    </div>
  );
}

export function KillCard({ killed }: { killed: boolean }) {
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
          background: killed ? "var(--pos)" : "var(--neg)", color: "var(--brand-ink)",
        }}
      >
        {killed ? "해제" : "전체 중단"}
      </button>
    </div>
  );
}

export function RiskCard({ inFlight }: { inFlight: number }) {
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
      <div style={{ display: "flex", alignItems: "center", gap: 4, border: "1px solid var(--border)", borderRadius: 9, padding: "6px 8px", background: "var(--bg)" }}>
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
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8 }}>
        {field("1회 최대", "perTrade")}
        {field("총 노출", "inFlight")}
        {field("일일 손실", "dailyLoss")}
      </div>
      <button
        type="button"
        onClick={save}
        disabled={saving}
        style={{ marginTop: 10, width: "100%", border: "none", borderRadius: "var(--radius-sm)", padding: 9, background: "var(--brand-grad)", color: "var(--brand-ink)", fontWeight: 700, fontSize: 12.5, cursor: "pointer" }}
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
            <div style={{ height: 5, borderRadius: 9, background: "var(--bg)", overflow: "hidden", marginTop: 4 }}>
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
            <div style={{ height: 5, borderRadius: 9, background: "var(--bg)", overflow: "hidden", marginTop: 4 }}>
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

export type GateRow = { base: string; venues: Record<string, { deposit: boolean; withdraw: boolean } | null> };

export function GatesCard() {
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
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 3 }}>입출금 상태 조회</div>
      <div style={{ fontSize: 11, color: "var(--text-mute)", marginBottom: 8 }}>실행 전 코인의 거래소별 입금·출금 열림 여부 확인 (<span style={{ color: "var(--pos)" }}>입/출</span> = 열림, <span style={{ color: "var(--neg)" }}>빨강</span> = 중단)</div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="코인 검색 (예: XRP)"
        style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 9, padding: "8px 10px", color: "var(--text)", fontSize: 13, outline: "none", marginBottom: 8 }}
      />
      {!data ? (
        <div style={{ color: "var(--text-mute)", fontSize: 12, padding: "8px 0" }}>조회 중…</div>
      ) : (
        <div style={{ overflowX: "auto", maxHeight: 240, overflowY: "auto" }}>
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

export type TradeRec = {
  ts: number; base: string; route: string; sizeUsd: number; detectedNetPct: number;
  realizedNetPct: number | null; realizedPnlUsd: number | null; dryRun: boolean; kind: string;
  qty?: number | null; entryPriceUsd?: number | null; exitPriceUsd?: number | null;
  buyUsd?: number | null; sellUsd?: number | null; spotPnlUsd?: number | null; hedgePnlUsd?: number | null;
  durationsSec?: Record<string, number>; txs?: { step: string; hash: string; url: string | null }[]; note?: string;
};

export type TradeStats = { count: number; wins: number; hitRatePct: number; realizedPnlUsd: number; avgSlipPct: number; dryCount: number };

// ── 손익 시각화 — 누적 곡선 + 전략별 분해 + 시간대 히트맵 ────────────────────
function PnlViz({ trades }: { trades: TradeRec[] }) {
  const [heat, setHeat] = useState<{ scans: number; open: number }[] | null>(null);
  useEffect(() => {
    const load = () => fetch("/api/stats", { cache: "no-store" }).then((r) => r.json()).then((j) => setHeat(j.heat ?? null)).catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  // 누적 곡선 — 실거래(realized)만, 오래된 것부터.
  const curve = useMemo(() => {
    const real = trades.filter((t) => !t.dryRun && t.realizedPnlUsd != null).slice().reverse();
    let acc = 0;
    return real.map((t) => (acc += t.realizedPnlUsd!));
  }, [trades]);

  // 전략별 분해 — 실거래 합계 (없으면 모의 포함 표기).
  const byKind = useMemo(() => {
    const m = new Map<string, { pnl: number; n: number; real: boolean }>();
    for (const t of trades) {
      const real = !t.dryRun && t.realizedPnlUsd != null;
      const k = t.kind === "kimchi" ? "김프" : t.kind === "cross-cex" ? "크로스" : t.kind === "listing" ? "상장" : t.kind;
      const e = m.get(k) ?? { pnl: 0, n: 0, real: false };
      e.n++;
      if (real) { e.pnl += t.realizedPnlUsd!; e.real = true; }
      m.set(k, e);
    }
    return [...m.entries()];
  }, [trades]);

  const maxRatio = heat ? Math.max(...heat.map((h) => (h.scans > 0 ? h.open / h.scans : 0)), 0.01) : 0.01;

  return (
    <div style={{ marginBottom: 10 }}>
      {/* 누적 곡선 */}
      {curve.length >= 2 ? (
        (() => {
          const W = 560, H = 46;
          const lo = Math.min(...curve, 0), hi = Math.max(...curve, 0);
          const pad = Math.max((hi - lo) * 0.1, 0.5);
          const x = (i: number) => (i / (curve.length - 1)) * W;
          const y = (v: number) => H - ((v - (lo - pad)) / (hi + pad - (lo - pad))) * H;
          const last = curve[curve.length - 1];
          return (
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9.5, color: "var(--text-mute)", marginBottom: 2 }}>
                <span>누적 실현 손익 ({curve.length}건)</span>
                <span className="tnum" style={{ color: last >= 0 ? "var(--pos)" : "var(--neg)", fontWeight: 700 }}>{last >= 0 ? "+" : "−"}${Math.abs(last).toFixed(2)}</span>
              </div>
              <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 46, display: "block" }} preserveAspectRatio="none">
                <line x1="0" y1={y(0)} x2={W} y2={y(0)} stroke="var(--border-strong)" strokeDasharray="3 3" strokeWidth="1" />
                <polyline points={curve.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")} fill="none" stroke={last >= 0 ? "var(--pos)" : "var(--neg)"} strokeWidth="1.5" />
              </svg>
            </div>
          );
        })()
      ) : (
        <div style={{ marginBottom: 8, fontSize: 10.5, color: "var(--text-mute)" }}>누적 곡선 — 실거래 2건부터 표시</div>
      )}

      {/* 전략별 분해 */}
      {byKind.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          {byKind.map(([k, v]) => (
            <span key={k} className="tnum" style={{ fontSize: 10.5, border: "1px solid var(--border)", borderRadius: 9, padding: "3px 9px", color: "var(--text-dim)" }}>
              {k} {v.n}건{v.real ? <b style={{ marginLeft: 5, color: v.pnl >= 0 ? "var(--pos)" : "var(--neg)" }}>{v.pnl >= 0 ? "+" : "−"}${Math.abs(v.pnl).toFixed(2)}</b> : <span style={{ marginLeft: 5, color: "var(--text-mute)" }}>모의</span>}
            </span>
          ))}
        </div>
      )}

      {/* 시간대 히트맵 (KST) — 언제 수익 갭이 열리나 */}
      {heat && heat.some((h) => h.scans > 0) && (
        <div>
          <div style={{ fontSize: 9.5, color: "var(--text-mute)", marginBottom: 3 }}>수익 갭 열림 시간대 (KST · 열림 스캔 비율)</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(24, 1fr)", gap: 2 }}>
            {heat.map((h, i) => {
              const ratio = h.scans > 0 ? h.open / h.scans : 0;
              return (
                <div
                  key={i}
                  title={`${i}시 — 열림 ${h.open}/${h.scans} 스캔 (${(ratio * 100).toFixed(0)}%)`}
                  style={{
                    height: 16, borderRadius: 3,
                    background: h.scans === 0 ? "var(--card-3)" : `color-mix(in srgb, var(--pos) ${Math.round((ratio / maxRatio) * 85)}%, var(--card-3))`,
                  }}
                />
              );
            })}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8.5, color: "var(--text-mute)", marginTop: 2 }}>
            <span>0시</span><span>6시</span><span>12시</span><span>18시</span><span>23시</span>
          </div>
        </div>
      )}
    </div>
  );
}

// 거래 목록 — 행 클릭 시 상세(수량·진입/청산가·손익 분해·단계 소요·tx) 펼침.
function TradeList({ trades }: { trades: TradeRec[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const px = (n: number | null | undefined) =>
    n == null ? "—" : n >= 100 ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 1 })}` : n >= 0.01 ? `$${n.toFixed(4)}` : `$${n.toPrecision(3)}`;
  const money = (n: number | null | undefined) =>
    n == null ? "—" : `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(2)}`;
  const dLine = (label: string, value: React.ReactNode, tone?: string) => (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "2.5px 0" }}>
      <span style={{ color: "var(--text-mute)" }}>{label}</span>
      <span className="tnum" style={{ color: tone ?? "var(--text-dim)", fontWeight: 600 }}>{value}</span>
    </div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {trades.slice(0, 10).map((t, i) => (
        <div key={i} style={{ borderTop: "1px solid var(--border)" }}>
          <div
            onClick={() => setOpen(open === i ? null : i)}
            style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 8, alignItems: "center", padding: "5px 0", fontSize: 11.5, cursor: "pointer" }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              <b>{t.base}</b> <span style={{ color: "var(--text-mute)" }}>{t.route}{t.dryRun ? " · 모의" : ""}</span>
            </span>
            <span className="tnum" style={{ color: "var(--text-mute)" }}>{usd(t.sizeUsd)}</span>
            <span className="tnum" style={{ minWidth: 60, textAlign: "right", color: (t.realizedNetPct ?? t.detectedNetPct) >= 0 ? "var(--pos)" : "var(--neg)" }}>
              {t.realizedNetPct != null ? `${t.realizedNetPct >= 0 ? "+" : ""}${t.realizedNetPct.toFixed(2)}%` : `~${t.detectedNetPct.toFixed(2)}%`}
            </span>
          </div>
          {open === i && (
            <div style={{ margin: "2px 0 8px", padding: "8px 12px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}>
              {dLine("시각", new Date(t.ts).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }))}
              {t.qty != null && dLine("수량", `${t.qty.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${t.base}`)}
              {t.entryPriceUsd != null && dLine("평균 진입가", px(t.entryPriceUsd))}
              {t.exitPriceUsd != null && dLine(
                "평균 청산가",
                <>{px(t.exitPriceUsd)}{t.entryPriceUsd ? <span style={{ color: (t.exitPriceUsd - t.entryPriceUsd) >= 0 ? "var(--pos)" : "var(--neg)", marginLeft: 6 }}>({(((t.exitPriceUsd - t.entryPriceUsd) / t.entryPriceUsd) * 100).toFixed(2)}%)</span> : null}</>,
              )}
              {t.buyUsd != null && dLine("매수 체결", `$${t.buyUsd.toFixed(2)}`)}
              {t.sellUsd != null && dLine("매도 체결", `$${t.sellUsd.toFixed(2)}`)}
              {t.spotPnlUsd != null && dLine("현물 손익", money(t.spotPnlUsd), t.spotPnlUsd >= 0 ? "var(--pos)" : "var(--neg)")}
              {t.hedgePnlUsd != null && dLine("헷지 손익", money(t.hedgePnlUsd), t.hedgePnlUsd >= 0 ? "var(--pos)" : "var(--neg)")}
              {t.realizedPnlUsd != null && dLine("합계", money(t.realizedPnlUsd), t.realizedPnlUsd >= 0 ? "var(--pos)" : "var(--neg)")}
              {t.durationsSec && Object.keys(t.durationsSec).length > 0 && dLine(
                "단계 소요",
                Object.entries(t.durationsSec).map(([k, v]) => `${k} ${v}s`).join(" · "),
              )}
              {t.txs && t.txs.length > 0 && (
                <div style={{ marginTop: 5, paddingTop: 5, borderTop: "1px solid var(--border)" }}>
                  {t.txs.map((x, j) => (
                    <div key={j} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 10.5, padding: "2px 0" }}>
                      <span style={{ color: "var(--text-mute)", flex: "0 0 auto" }}>{x.step}</span>
                      {x.url ? (
                        <a href={x.url} target="_blank" rel="noreferrer" className="tnum" style={{ color: "var(--brand-2)", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {x.hash.slice(0, 14)}…{x.hash.slice(-8)} ↗
                        </a>
                      ) : (
                        <span
                          className="tnum"
                          title="클릭 = 복사"
                          onClick={() => void navigator.clipboard?.writeText(x.hash)}
                          style={{ color: "var(--text-dim)", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        >
                          {x.hash.slice(0, 14)}…{x.hash.length > 22 ? x.hash.slice(-8) : ""}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {t.note && <div style={{ marginTop: 4, fontSize: 10, color: "var(--text-mute)" }}>{t.note}</div>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function PnlCard() {
  const [data, setData] = useState<{ trades: TradeRec[]; stats: TradeStats } | null>(null);
  useEffect(() => {
    const load = () => fetch("/api/trades", { cache: "no-store" }).then((r) => r.json()).then(setData).catch(() => {});
    void load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);
  const st = data?.stats;
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>거래 · 손익</span>
        {st && st.dryCount > 0 && <span style={{ fontSize: 10, color: "var(--text-mute)" }}>모의 {st.dryCount}건 포함</span>}
      </div>
      {!st || st.count === 0 ? (
        <div style={{ color: "var(--text-mute)", fontSize: 12 }}>기록된 거래 없음 — 실행이 정산되면 여기에 쌓입니다</div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8, marginBottom: 10 }}>
            <Metric label="실현 손익" value={`${st.realizedPnlUsd >= 0 ? "+" : "−"}$${Math.abs(st.realizedPnlUsd).toFixed(2)}`} tone={st.realizedPnlUsd >= 0 ? "var(--pos)" : "var(--neg)"} />
            <Metric label="히트율" value={`${st.hitRatePct}%`} sub={`${st.wins}/${st.count - st.dryCount || st.count}`} />
            <Metric label="탐지 vs 실현" value={`−${st.avgSlipPct.toFixed(2)}%`} sub="평균 누수" tone={st.avgSlipPct > 0.3 ? "var(--amber)" : "var(--text)"} />
          </div>
          <PnlViz trades={data.trades} />
          <TradeList trades={data.trades} />
        </>
      )}
    </div>
  );
}

export function TelegramCard() {
  const [state, setState] = useState<{ configured: boolean } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { fetch("/api/telegram-test").then((r) => r.json()).then(setState).catch(() => {}); }, []);
  const test = async () => {
    setBusy(true); setMsg(null);
    try {
      const j = await (await fetch("/api/telegram-test", { method: "POST" })).json();
      setMsg(j.ok ? "전송됨 — 텔레그램 확인" : j.error ?? "실패");
    } finally { setBusy(false); }
  };
  const on = state?.configured;
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>텔레그램 알림</span>
        <span style={{ width: 6, height: 6, borderRadius: 9, background: on ? "var(--pos)" : "var(--text-mute)" }} />
        <span style={{ fontSize: 11, color: on ? "var(--pos)" : "var(--text-mute)" }}>{on ? "연결됨" : "키 필요"}</span>
        <span style={{ flex: 1 }} />
        {on && (
          <button type="button" onClick={test} disabled={busy} style={{ border: "1px solid var(--border-strong)", background: "transparent", color: "var(--text-dim)", borderRadius: 9, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
            {busy ? "…" : "테스트 발송"}
          </button>
        )}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-mute)", marginTop: 6 }}>
        {on
          ? "임계 순수익 돌파·입출금 중단·실행 에러를 폰으로 — 사이트를 안 켜둬도 서버가 감시합니다."
          : ".env.local에 TELEGRAM_BOT_TOKEN·TELEGRAM_CHAT_ID를 넣으면 켜집니다 (@BotFather로 봇 생성)."}
      </div>
      {msg && <div style={{ fontSize: 11, color: "var(--brand-2)", marginTop: 6 }}>{msg}</div>}
    </div>
  );
}

function AutoEntryCard({ cfg, onChange, killed }: { cfg: AutoEntryCfg; onChange: (v: AutoEntryCfg) => void; killed: boolean }) {
  const num = (v: string) => Number(v.replace(/[^\d.]/g, "")) || 0;
  const field = (label: string, key: "minNet" | "minHeld" | "sizeUsd", suffix: string) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 10.5, color: "var(--text-mute)" }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 4, border: "1px solid var(--border)", borderRadius: 9, padding: "6px 8px", background: "var(--bg)" }}>
        <input className="tnum" inputMode="decimal" value={String(cfg[key])} disabled={cfg.armed}
          onChange={(e) => onChange({ ...cfg, [key]: num(e.target.value) })}
          style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", color: "var(--text)", fontSize: 13, outline: "none" }} />
        <span style={{ color: "var(--text-mute)", fontSize: 11 }}>{suffix}</span>
      </div>
    </label>
  );
  return (
    <div style={{ background: cfg.armed ? "var(--brand-soft)" : "var(--card)", border: `1px solid ${cfg.armed ? "var(--brand)" : "var(--border)"}`, borderRadius: "var(--radius)", padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>조건부 자동 진입</span>
        <span style={{ width: 6, height: 6, borderRadius: 9, background: cfg.armed ? "var(--pos)" : "var(--text-mute)" }} />
        <span style={{ fontSize: 11, color: cfg.armed ? "var(--pos)" : "var(--text-mute)" }}>{cfg.armed ? "켜짐" : "꺼짐"}</span>
        <span style={{ flex: 1 }} />
        <button type="button" disabled={killed} onClick={() => onChange({ ...cfg, armed: !cfg.armed })}
          style={{ border: "none", borderRadius: "var(--radius-sm)", padding: "7px 14px", fontWeight: 800, fontSize: 12, cursor: "pointer",
            background: cfg.armed ? "var(--neg)" : "var(--brand-grad)", color: cfg.armed ? "#fff" : "var(--brand-ink)" }}>
          {cfg.armed ? "끄기" : "켜기"}
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8, marginTop: 10 }}>
        {field("최소 순수익", "minNet", "%")}
        {field("최소 지속", "minHeld", "s")}
        {field("규모", "sizeUsd", "$")}
      </div>
      <div style={{ fontSize: 10.5, color: "var(--text-mute)", marginTop: 8, lineHeight: 1.5 }}>
        조건 충족 시 자동으로 매수+헷지까지 진입하고 <b>출금 직전에 멈춥니다</b>(승인 필요). 동시 1건 ·
        코인당 30분 쿨다운 · 킬스위치 하위 · 브라우저가 열려 있어야 동작. 켜짐 상태는 저장되지 않음(세션마다 직접 켜기).
      </div>
    </div>
  );
}


// ── 거래소 온체인 보유량 (상장따리 물량 신호) ─────────────────────────────────
type HoldingsData = {
  symbol: string; name: string; priceUsd: number | null; volumeUsd: number | null;
  chains: string[]; globalHotUsd: number | null; dumpRatioPct: number | null; note?: string;
  venues: { venue: string; hot: number; cold: number; hotUsd: number | null; coldUsd: number | null; addresses: number; hotDeltaPerMin: number | null }[];
};

function fmtQty(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n >= 1 ? n.toFixed(1) : n > 0 ? n.toFixed(4) : "0";
}

export function HoldingsCard() {
  const [sym, setSym] = useState("");
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<HoldingsData | null>(null);
  const [stats, setStats] = useState<Record<string, { hot: number; cold: number }> | null>(null);

  const lookup = async (s: string) => {
    const q = s.trim().toUpperCase();
    if (!q) return;
    setBusy(true); setErr(null);
    try {
      const j = await (await fetch(`/api/exchange-holdings?symbol=${encodeURIComponent(q)}`, { cache: "no-store" })).json();
      if (j.stats) setStats(j.stats);
      if (j.error) { setErr(j.error); setData(null); }
      else setData(j.holdings);
    } catch { setErr("조회 실패"); }
    finally { setBusy(false); }
  };
  const runImport = async () => {
    setImporting(true); setErr(null);
    try {
      const j = await (await fetch("/api/exchange-holdings", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "import" }),
      })).json();
      if (j.error) setErr(`임포트 실패: ${j.error}`);
      else setErr(`✓ 라벨 가져오기 완료: ${Object.entries(j.counts as Record<string, number>).map(([v, n]) => `${v} ${n}`).join(" · ")}`);
    } catch { setErr("임포트 요청 실패"); }
    finally { setImporting(false); }
  };
  const totalAddrs = stats ? Object.values(stats).reduce((s, v) => s + v.hot + v.cold, 0) : null;

  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap" }}>거래소 온체인 보유량</span>
        <span style={{ fontSize: 10.5, color: "var(--text-mute)" }}>상장따리 물량 신호 · ETH/BSC/Base</span>
        <span style={{ flex: 1 }} />
        <button
          type="button" disabled={importing} onClick={() => void runImport()}
          title="Etherscan 공개 라벨 덤프에서 거래소 지갑 주소를 가져옵니다 (1회, ~22MB)"
          style={{ border: "1px solid var(--border-strong)", background: "transparent", color: "var(--text-dim)", borderRadius: 9, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", flex: "0 0 auto" }}
        >
          {importing ? "임포트 중…" : `라벨 가져오기${totalAddrs != null ? ` (${totalAddrs})` : ""}`}
        </button>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={sym}
          onChange={(e) => setSym(e.target.value.toUpperCase())}
          onKeyDown={(e) => { if (e.key === "Enter") void lookup(sym); }}
          placeholder="티커 (예: PYR)"
          style={{ flex: 1, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 9, color: "var(--text)", padding: "7px 10px", fontSize: 12.5, outline: "none" }}
        />
        <button
          type="button" disabled={busy || !sym.trim()} onClick={() => void lookup(sym)}
          style={{ border: "none", borderRadius: 9, padding: "7px 16px", background: "var(--brand)", color: "var(--brand-ink)", fontWeight: 700, fontSize: 12, cursor: "pointer" }}
        >
          {busy ? "…" : "조회"}
        </button>
      </div>
      {err && <div style={{ marginTop: 8, fontSize: 11.5, color: err.startsWith("✓") ? "var(--pos)" : "var(--amber)" }}>{err}</div>}
      {data && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 6 }}>
            <b style={{ color: "var(--text)" }}>{data.symbol}</b> ({data.name}) · {data.chains.join("/")}
            {data.priceUsd != null && <span className="tnum"> · ${data.priceUsd < 0.01 ? data.priceUsd.toPrecision(3) : data.priceUsd.toLocaleString()}</span>}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(70px,auto) 1fr 1fr auto", gap: "4px 12px", fontSize: 11.5 }}>
            <span style={{ color: "var(--text-mute)", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase" }}>거래소</span>
            <span style={{ color: "var(--text-mute)", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", textAlign: "right" }}>핫월렛</span>
            <span style={{ color: "var(--text-mute)", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", textAlign: "right" }}>콜드</span>
            <span style={{ color: "var(--text-mute)", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", textAlign: "right" }}>핫 Δ/분</span>
            {data.venues.filter((v) => v.hot + v.cold > 0 || v.addresses > 0).map((v) => (
              <Fragment key={v.venue}>
                <span style={{ fontWeight: 600 }}>{vlabel(v.venue as never) ?? v.venue}<span style={{ color: "var(--text-mute)", fontWeight: 400 }}> ·{v.addresses}주소</span></span>
                <span className="tnum" style={{ textAlign: "right" }}>
                  {fmtQty(v.hot)}{v.hotUsd != null && v.hotUsd > 0 ? <span style={{ color: "var(--text-mute)" }}> (${fmtQty(v.hotUsd)})</span> : null}
                </span>
                <span className="tnum" style={{ textAlign: "right", color: "var(--text-dim)" }}>{fmtQty(v.cold)}</span>
                <span className="tnum" style={{ textAlign: "right", color: v.hotDeltaPerMin == null || v.hotDeltaPerMin === 0 ? "var(--text-mute)" : v.hotDeltaPerMin > 0 ? "var(--pos)" : "var(--neg)" }}>
                  {v.hotDeltaPerMin == null ? "—"
                    : v.hotDeltaPerMin === 0 ? "0"
                    : data.priceUsd != null
                      ? `${v.hotDeltaPerMin > 0 ? "+$" : "−$"}${fmtQty(Math.abs(v.hotDeltaPerMin * data.priceUsd))}`
                      : `${v.hotDeltaPerMin > 0 ? "+" : "−"}${fmtQty(Math.abs(v.hotDeltaPerMin))}`}
                </span>
              </Fragment>
            ))}
          </div>
          {data.globalHotUsd != null && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border)", fontSize: 11.5 }}>
              <span style={{ color: "var(--text-dim)" }}>즉시 유입가능(글로벌 핫 합계) </span>
              <b className="tnum">${fmtQty(data.globalHotUsd)}</b>
              {data.dumpRatioPct != null && (
                <span style={{ marginLeft: 8, color: data.dumpRatioPct > 50 ? "var(--amber)" : "var(--pos)", fontWeight: 600 }}>
                  = 24h 거래량의 {data.dumpRatioPct.toFixed(0)}% {data.dumpRatioPct > 50 ? "⚠ 덤핑 압력 큼 → 펌핑 짧을 확률" : "→ 유입 압력 낮음"}
                </span>
              )}
            </div>
          )}
          {data.note && <div style={{ marginTop: 4, fontSize: 10.5, color: "var(--text-mute)" }}>{data.note}</div>}
        </div>
      )}
      {!data && !err && (
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-mute)" }}>
          상장 공지가 뜨면 텔레그램 알림에 자동 포함됩니다. 여기선 아무 티커나 수동 조회. 최초 1회 라벨 가져오기 필요.
        </div>
      )}
    </div>
  );
}


// ── Active runs dashboard — background runs, their live progress + controls ────

export function RunsDashboard({ runs, onOpen, hero }: {
  runs: RunView[];
  onOpen: (r: RunView) => void;
  onClearDone: () => void;
  /** 진행 중 실행이 있을 때 풀폭 히어로 — 카드가 크고 그리드로 퍼진다. */
  hero?: boolean;
}) {
  const hasDone = runs.some((r) => r.phase === "done");
  const phaseLabel: Record<string, { t: string; c: string }> = {
    running: { t: "실행 중", c: "var(--amber)" },
    paused: { t: "확인 대기", c: "var(--brand-2)" },
    error: { t: "중단/오류", c: "var(--neg)" },
    done: { t: "완료", c: "var(--pos)" },
    idle: { t: "대기", c: "var(--text-mute)" },
  };
  const active = runs.filter((r) => r.phase === "running" || r.phase === "paused").length;
  return (
    <div style={{ marginBottom: hero ? 0 : 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "0 2px 6px" }}>
        <span style={{ fontSize: hero ? 14 : 12, fontWeight: 700, color: hero ? "var(--text)" : "var(--text-dim)" }}>
          {hero ? `진행 중인 실행 ${active}건` : `실행 현황 · ${runs.length}`}
        </span>
        {hero && <span style={{ width: 7, height: 7, borderRadius: 9, background: "var(--amber)", boxShadow: "0 0 8px var(--amber)" }} />}
        <span style={{ flex: 1 }} />
        {hasDone && (
          <button type="button" onClick={() => clearFinished()} style={{ background: "transparent", border: "none", color: "var(--text-mute)", fontSize: 11, cursor: "pointer" }}>
            완료 정리
          </button>
        )}
      </div>
      <div style={hero
        ? { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 10 }
        : { display: "flex", flexDirection: "column", gap: 6 }}>
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
                borderRadius: "var(--radius)", padding: hero ? "14px 16px" : "10px 12px", color: "var(--text)", boxShadow: hero ? "var(--shadow-sm)" : undefined,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 6, height: 6, borderRadius: 9, background: ph.c, boxShadow: r.phase === "running" ? `0 0 6px ${ph.c}` : "none" }} />
                <span style={{ fontWeight: 700, fontSize: hero ? 16 : 13.5 }}>{r.base}</span>
                <span style={{ fontSize: 11, color: "var(--text-mute)" }}>{r.route}</span>
                <span style={{ flex: 1 }} />
                <span className="tnum" style={{ fontSize: 11, color: "var(--text-dim)" }}>{usd(r.sizeUsd)}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: ph.c }}>{ph.t}</span>
              </div>
              {/* progress */}
              <div style={{ display: "flex", height: hero ? 8 : 5, borderRadius: 9, overflow: "hidden", background: "var(--bg)", marginTop: hero ? 10 : 8 }}>
                <div style={{ width: `${total ? (doneCount / total) * 100 : 0}%`, background: r.phase === "error" ? "var(--neg)" : "var(--brand)", transition: "width 200ms" }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: hero ? 6 : 4, fontSize: hero ? 12 : 10.5, color: hero ? "var(--text-dim)" : "var(--text-mute)" }}>
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
export default ControlPanel;
