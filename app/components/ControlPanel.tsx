"use client";

import React from "react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Opportunity, Quote, StrategyKind } from "@/lib/types";
import { pct, usd, price, dur } from "@/lib/format";
import { type LiveAges, type LiveGap, type LiveStatus } from "@/lib/useLivePrices";
import { buildPlan, type AutoLevel, type ExecStep, type StepPhase } from "@/lib/execPlan";
import { useRuns, startRun, confirmRun, retryRun, cancelRun, unwindRun, clearFinished, setKillSwitch, inFlightUsd, setInFlightLimit, authHeaders, type RunView } from "@/lib/runStore";
import { EpisodeChart } from "./EpisodeChart";
import { PnlCalendar } from "./PnlCalendar";
import { longestWindowSec, longestProfitableRunSec, mergeWindows, outlastsEta } from "@/lib/episodeStats";
import { KIND_META, KINDS, GAP_KINDS, ALERT_NET_PCT, beep, Tile, COLS, COLS_MON, Empty, Metric, Line, Warn, LegRow, VENUE_LABEL, vlabel, WL_KEY, statusChip, FundingCountdown, PersistChip, ScanAge, LiveDots, Pill, xBtn, oppKindLabel, kindLabel } from "./cockpit-ui";

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
        <StatusCard runs={runs} killed={killed} inFlight={inFlight} />
        {runsBlock}
        <SectionLabel>안전장치</SectionLabel>
        <KillCard killed={killed} />
        {autoEntry && onAutoEntry && <AutoEntryCard cfg={autoEntry} onChange={onAutoEntry} killed={killed} />}
        <SectionLabel>실행 현황</SectionLabel>
        <PnlCard />
        <ExecQualityCard />
        <SectionLabel>실행 도구</SectionLabel>
        <SellTriggerCard />
        <GatesCard />
        <HoldingsCard />
      </div>
    );
  }
  // PC: 현황 풀폭 + 3컬럼, 성격별 그룹 — ① 안전장치(킬·리스크·자동진입)
  // ② 활동·기록(실행 현황·거래손익) ③ 연결·도구(TG·입출금·도구).
  // 컬럼 높이가 비슷해지도록 긴 목록(입출금)은 카드 안에서 스크롤.
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingBottom: 40 }}>
      <StatusCard runs={runs} killed={killed} inFlight={inFlight} />
      {/* 진행 중 실행 = 최우선 — 풀폭 히어로로 크게 */}
      {runs.length > 0 && <RunsDashboard runs={runs} onOpen={onOpen} onClearDone={() => {}} hero />}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.1fr 1.1fr", gap: 12, alignItems: "start" }}>
        {/* ① 안전장치 */}
        <div style={col}>
          <SectionLabel>안전장치</SectionLabel>
          <KillCard killed={killed} />
          {/* 리스크 한도 편집은 ⚙ 설정 모달에 있다 (운영자 결정 2026-08-22 —
              한도는 자주 만지는 값이 아니라 탭 자리를 안 준다). 대시보드
              "한도 조정 →"이 설정 모달을 바로 연다. */}
          {autoEntry && onAutoEntry && <AutoEntryCard cfg={autoEntry} onChange={onAutoEntry} killed={killed} />}
        </div>
        {/* ② 실행 현황·기록 */}
        <div style={col}>
          <SectionLabel>실행 현황</SectionLabel>
          {runs.length === 0 && runsBlock}
          <PnlCard />
          <ExecQualityCard />
        </div>
        {/* ③ 실행 도구 — 자동매도·입출금 게이트·핫월렛 */}
        <div style={col}>
          <SectionLabel>실행 도구</SectionLabel>
          <SellTriggerCard />
          <GatesCard />
          <HoldingsCard />
        </div>
      </div>
    </div>
  );
}

// ── 운영 현황 스트립 — 지금 시스템이 뭘 하고 있는지 한 줄 요약 ────────────────
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
      <span style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-mute)", fontWeight: 700 }}>{children}</span>
      <span style={{ flex: 1, borderBottom: "1px solid var(--border)" }} />
    </div>
  );
}

function StatusCard({ runs, killed, inFlight }: { runs: RunView[]; killed: boolean; inFlight: number }) {
  const [risk, setRisk] = useState<RiskState | null>(null);
  useEffect(() => {
    const load = () => fetch("/api/risk", { cache: "no-store" }).then((r) => r.json()).then(setRisk).catch(() => {});
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, []);
  const running = runs.filter((r) => r.phase === "running").length;
  const paused = runs.filter((r) => r.phase === "paused").length;
  const errored = runs.filter((r) => r.phase === "error").length;
  const pnl = risk?.realizedPnlUsd ?? 0;
  const cell = (label: string, value: React.ReactNode, tone?: string) => (
    <div style={{ padding: "10px 12px", borderRight: "1px solid var(--border)", minWidth: 0 }}>
      <div className="tnum" style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.1, color: tone ?? "var(--text)", whiteSpace: "nowrap" }}>{value}</div>
      <div style={{ marginTop: 5, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-mute)", whiteSpace: "nowrap" }}>{label}</div>
    </div>
  );
  return (
    <div style={{ border: `1px solid ${killed ? "var(--neg)" : "var(--border)"}`, borderRadius: "var(--radius)", overflow: "hidden" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))" }}>
        {/* 셀은 4개로 끝낸다 — "자동 진입"은 바로 아래 AutoEntryCard가, "상장
            감시"는 대시보드 감시 카드가 담당한다. 같은 상태를 두 번 찍는 셀은
            밀도만 높이고 정보를 안 늘린다. */}
        {cell("상태", killed ? "중단됨" : errored > 0 ? "오류" : running > 0 ? "실행 중" : "대기", killed ? "var(--neg)" : errored > 0 ? "var(--amber)" : running > 0 ? "var(--pos)" : undefined)}
        {cell("실행 · 대기 · 오류", `${running} · ${paused} · ${errored}`, errored > 0 ? "var(--amber)" : undefined)}
        {cell("노출", risk ? `$${inFlight.toFixed(0)} / $${(risk.maxInFlightUsd / 1000).toFixed(0)}K` : `$${inFlight.toFixed(0)}`)}
        {cell("오늘 실현 손익", `${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(2)}`, pnl > 0 ? "var(--pos)" : pnl < 0 ? "var(--neg)" : undefined)}
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
  const [saveErr, setSaveErr] = useState<string | null>(null);
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
      // authHeaders: 토큰이 있으면 실어 보낸다. 이 라우트 자체는 요구하지 않고,
      // 브라우저발 CSRF는 미들웨어(lib/originGuard)가 막는다.
      const res = await fetch("/api/risk", { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
      const j = (await res.json()) as RiskState & { message?: string };
      if (!res.ok) { setSaveErr(j.message ?? "한도 변경 실패"); return; }
      setSaveErr(null);
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
      {saveErr && (
        <div style={{ marginTop: 6, fontSize: 11, color: "var(--neg)" }}>{saveErr}</div>
      )}

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

// ── 자동 매도 트리거 — 입금 도착 시 즉시 매도 ────────────────────────────────
type SellTrig = {
  id: string; venue: string; base: string; mode: string; fire: string;
  targetPrice?: number; floorPrice?: number; expectQty?: number; repeat: boolean;
  status: string; soldQty: number; proceeds: number; attempts: number; lastMsg?: string; dry: boolean;
};
export function SellTriggerCard() {
  const [list, setList] = useState<SellTrig[]>([]);
  const [dry, setDry] = useState(true);
  const [f, setF] = useState({ venue: "upbit", base: "", mode: "market", fire: "hybrid", targetPrice: "", floorPrice: "", expectQty: "", repeat: false });
  const [msg, setMsg] = useState<string | null>(null);
  // 폼은 접어둔다 — 대부분의 시간 이 카드의 용건은 "지금 무장된 트리거가
  // 뭐고 어떤 상태인가"지 등록이 아니다. 입력 6칸이 상시 펼쳐져 있으면
  // 운영 탭이 설정 페이지처럼 읽힌다.
  const [formOpen, setFormOpen] = useState(false);
  const load = () => fetch("/api/sell-trigger", { cache: "no-store" }).then((r) => r.json())
    .then((j) => { setList(j.triggers ?? []); setDry(!!j.dryRun); }).catch(() => {});
  useEffect(() => { load(); const id = setInterval(load, 3000); return () => clearInterval(id); }, []);

  const submit = async () => {
    setMsg(null);
    const body: Record<string, unknown> = { venue: f.venue, base: f.base, mode: f.mode, fire: f.fire, repeat: f.repeat };
    if (f.mode === "limit") body.targetPrice = Number(f.targetPrice);
    if ((f.mode === "market" || f.mode === "bid") && f.floorPrice) body.floorPrice = Number(f.floorPrice);
    if (f.fire === "hammer" && f.expectQty) body.expectQty = Number(f.expectQty);
    try {
      const j = await (await fetch("/api/sell-trigger", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
      if (j.ok) { setF({ ...f, base: "", targetPrice: "", floorPrice: "", expectQty: "" }); setFormOpen(false); load(); }
      else setMsg(j.error ?? "등록 실패");
    } catch { setMsg("요청 실패"); }
  };
  const cancel = (id: string) => fetch(`/api/sell-trigger?id=${id}`, { method: "DELETE" }).then(load).catch(() => {});
  const modeKo: Record<string, string> = { market: "시장가", bid: "호가", limit: "지정가" };
  const statusKo: Record<string, string> = { waiting: "대기(입금 감시)", working: "매도 중", done: "완료", cancelled: "취소", error: "오류", arming: "준비" };
  const statusColor = (st: string) => st === "working" ? "var(--amber)" : st === "done" ? "var(--pos)" : st === "error" ? "var(--neg)" : "var(--text-dim)";

  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>자동 매도 트리거</span>
        <span style={{ fontSize: 10.5, color: "var(--text-mute)" }}>입금 도착 시 즉시 매도{dry ? " · 페이퍼" : ""}</span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => setFormOpen((v) => !v)}
          style={{ border: `1px solid ${formOpen ? "var(--border-strong)" : "var(--brand)"}`, background: "transparent", color: formOpen ? "var(--text-dim)" : "var(--brand-2)", borderRadius: 9, padding: "4px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
          {formOpen ? "닫기" : "+ 등록"}
        </button>
      </div>
      {formOpen && (
        <div style={{ marginTop: 6 }}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)", gap: 6, marginBottom: 6 }}>
            <select value={f.venue} onChange={(e) => setF({ ...f, venue: e.target.value })} style={SEL}>
              {["upbit", "bithumb", "binance"].map((v) => <option key={v} value={v}>{VENUE_LABEL[v] ?? v}</option>)}
            </select>
            <input value={f.base} onChange={(e) => setF({ ...f, base: e.target.value.toUpperCase() })} placeholder="코인" style={INP} />
            <select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })} style={SEL}>
              <option value="market">시장가</option><option value="bid">호가</option><option value="limit">지정가</option>
            </select>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 6, marginBottom: 6 }}>
            <select value={f.fire} onChange={(e) => setF({ ...f, fire: e.target.value })} style={SEL} title="hybrid: 잔고확인 후 주문(안전) · hammer: 계속 던짐(최속)">
              <option value="hybrid">하이브리드 (안전)</option><option value="hammer">해머 (최속)</option>
            </select>
            {f.mode === "limit"
              ? <input value={f.targetPrice} onChange={(e) => setF({ ...f, targetPrice: e.target.value })} placeholder="목표가" inputMode="decimal" style={INP} />
              : <input value={f.floorPrice} onChange={(e) => setF({ ...f, floorPrice: e.target.value })} placeholder="바닥가 (선택)" inputMode="decimal" style={INP} />}
          </div>
          {f.fire === "hammer" && (
            <input value={f.expectQty} onChange={(e) => setF({ ...f, expectQty: e.target.value })} placeholder="예상 수량 (해머는 잔고 안 읽음)" inputMode="decimal" style={{ ...INP, width: "100%", marginBottom: 6 }} />
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-dim)", cursor: "pointer" }}>
              <input type="checkbox" checked={f.repeat} onChange={(e) => setF({ ...f, repeat: e.target.checked })} /> 반복 (팔고 또 입금오면 재무장)
            </label>
            <span style={{ flex: 1 }} />
            <button type="button" onClick={() => void submit()} disabled={!f.base.trim()}
              style={{ border: "none", borderRadius: 9, padding: "7px 14px", background: "var(--brand)", color: "var(--brand-ink)", fontWeight: 700, fontSize: 12, cursor: "pointer", opacity: f.base.trim() ? 1 : 0.5 }}>
              트리거 등록
            </button>
          </div>
        </div>
      )}
      {msg && <div style={{ fontSize: 11, color: "var(--neg)", marginBottom: 6 }}>{msg}</div>}
      {list.length === 0 && !formOpen && (
        <div style={{ fontSize: 11.5, color: "var(--text-mute)", padding: "6px 0 2px" }}>무장된 트리거 없음 — "+ 등록"으로 만듭니다</div>
      )}
      {list.length > 0 && (
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 4, marginTop: formOpen ? 0 : 4 }}>
          {list.map((t) => (
            <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", fontSize: 11.5, borderTop: "1px solid var(--border)" }}>
              <b>{t.base}</b>
              <span style={{ fontSize: 10, color: "var(--text-mute)" }}>{VENUE_LABEL[t.venue] ?? t.venue} · {modeKo[t.mode]}{t.fire === "hammer" ? "·해머" : ""}{t.repeat ? "·반복" : ""}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10, color: "var(--text-mute)" }}>{t.lastMsg}</span>
              <span className="tnum" style={{ fontSize: 10.5, fontWeight: 700, color: statusColor(t.status) }}>{statusKo[t.status] ?? t.status}</span>
              {(t.status === "waiting" || t.status === "working") && (
                <button type="button" onClick={() => void cancel(t.id)} style={{ border: "none", background: "transparent", color: "var(--text-mute)", cursor: "pointer", fontSize: 12 }}>✕</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
const SEL: React.CSSProperties = { background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 9, padding: "7px 8px", color: "var(--text)", fontSize: 12, minWidth: 0 };
const INP: React.CSSProperties = { background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 9, padding: "7px 10px", color: "var(--text)", fontSize: 12, outline: "none", minWidth: 0 };

// ── 기회 복기 — 지난 에피소드(임계 위 구간)를 다시 본다 ──────────────────────// ── 기회 복기 — 지난 에피소드(임계 위 구간)를 다시 본다 ──────────────────────
// "어제 그 김프, 얼마나 지속됐고 왜 못 먹었나"의 답. 데이터는 스캔 루프가
// data/episodes.jsonl에 적재한 것(lib/episodes.ts) — 여긴 읽기만 한다.
type Episode = {
  id: string; base: string; kind: string; buyVenue: string; sellVenue: string;
  startTs: number; endTs: number; durationSec: number;
  peakNetPct: number; peakTs: number; avgNetPct: number;
  endReason: "decayed" | "vanished";
  curve: [number, number, number, number][];
  atPeak: { costPct: number; notionalCapUsd: number | null; executable: boolean; blockReason?: string; etaMin?: number; hedgeCostPct?: number };
  executed?: { runId: string; dry: boolean; ts: number };
};

/** 읽을 때 인접 구간을 묶는 창 — 적재 쪽 EPISODE_MERGE_GAP_SEC과 같은 값. */
const UI_MERGE_GAP_MS = 12 * 60_000;

export function EpisodeCard() {
  const [eps, setEps] = useState<Episode[]>([]);
  const [activeN, setActiveN] = useState(0);
  const [q, setQ] = useState("");
  // 두 단계로 편다: 기회(그룹) → 그 기회의 개별 구간.
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [openEp, setOpenEp] = useState<string | null>(null);
  useEffect(() => {
    const load = () => fetch(`/api/episodes${q.trim() ? `?base=${encodeURIComponent(q.trim().toUpperCase())}` : ""}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { setEps(j.episodes ?? []); setActiveN((j.active ?? []).length); })
      .catch(() => {});
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [q]);

  const when = (ts: number) => {
    const m = Math.round((Date.now() - ts) / 60_000);
    return m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : new Date(ts).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
  };

  // ── 같은 기회로 묶는다 ──────────────────────────────────────────────────────
  // 목록이 290줄인데 실제로는 8개 기회였다 (RED 하나가 82줄). 한 기회가 0%
  // 근처에서 깜빡일 때마다 구간이 새로 열리기 때문인데, 적재 쪽에 병합 창을
  // 넣어도(lib/episodes.ts) 몇 시간 뒤 다시 뜨는 건 여전히 별개 구간이다.
  // 그건 맞는 기록이고, 대신 **읽을 때** 묶는다: 같은 코인·같은 경로면 한 줄.
  const groups = useMemo(() => {
    const m = new Map<string, { key: string; base: string; kind: string; buyVenue: string; sellVenue: string; items: Episode[] }>();
    for (const e of eps) {
      const key = `${e.id}|${e.buyVenue}|${e.sellVenue}`;
      let g = m.get(key);
      if (!g) { g = { key, base: e.base, kind: e.kind, buyVenue: e.buyVenue, sellVenue: e.sellVenue, items: [] }; m.set(key, g); }
      g.items.push(e);
    }
    return [...m.values()].map((g) => {
      const items = [...g.items].sort((a, b) => b.endTs - a.endTs);
      // 인접 구간을 창 안에서 하나로 본다 — 적재 쪽 병합(MERGE_GAP)이 생기기
      // 전에 쌓인 기록도 같은 잣대로 읽히게. 안 하면 옛 데이터만 조각으로 남아
      // "최장 연속"이 파편 길이를 말한다.
      const windows = mergeWindows(items, UI_MERGE_GAP_MS);
      // 화면에 얼마나 오래 걸쳐 있었나 — 목록에서 규모를 가늠하는 용도.
      const spanSec = longestWindowSec(items, UI_MERGE_GAP_MS);
      // ETA 판정의 근거는 이것 하나다: 순수익이 **끊김 없이** 0 위였던 최장 시간.
      // spanSec을 쓰면 묶는 창(12분)만큼의 구멍을 "연속"으로 삼켜서, 도착 시점이
      // 하필 그 구멍이면 손실인 기회를 "실현 가능"으로 표시하게 된다.
      const longestSec = Math.max(...items.map((e) => longestProfitableRunSec(e.curve)));
      // 전송 ETA — 이 기회를 실제로 먹으려면 갭이 이만큼은 살아 있어야 한다.
      const etaMin = items.find((e) => e.atPeak.etaMin != null)?.atPeak.etaMin ?? null;
      return {
        ...g, items,
        windowN: windows.length,
        longestSec, spanSec,
        peak: Math.max(...items.map((e) => e.peakNetPct)),
        lastTs: items[0].endTs,
        executedN: items.filter((e) => e.executed).length,
        etaMin,
        // 이 카드가 답해야 하는 진짜 질문: 전송이 끝나기 전에 갭이 사라졌나.
        // 최장 연속 창이 ETA에 못 미치면 애초에 못 먹는 기회다 — 순수익이
        // 아무리 높아도. null(ETA 미상)이면 판정하지 않는다.
        outlastsEta: outlastsEta(longestSec, etaMin),
      };
    })
      // 실현 가능했던 것을 위로 — 복기의 목적은 "뭘 먹을 수 있었나"지
      // "뭐가 최근인가"가 아니다. 같은 등급 안에서는 최신순.
      .sort((a, b) => Number(b.outlastsEta === true) - Number(a.outlastsEta === true) || b.lastTs - a.lastTs);
  }, [eps]);

  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 3 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>기회 복기</span>
        {/* 헤드라인은 "몇 건 쌓였나"가 아니라 "그중 실제로 잡을 수 있었던 게
            몇 건인가"다. 실측에서 293건 중 ETA를 넘긴 건 1건이었다. */}
        <span style={{ fontSize: 10.5, color: "var(--text-mute)" }}>
          기회 {groups.length}건 · ETA 넘긴 건{" "}
          <b style={{ color: groups.some((g) => g.outlastsEta === true) ? "var(--pos)" : "var(--text-mute)" }}>
            {groups.filter((g) => g.outlastsEta === true).length}건
          </b>
          {activeN > 0 ? ` · 진행 중 ${activeN}` : ""}
        </span>
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="코인 필터 (예: XRP)"
        style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 9, padding: "7px 10px", color: "var(--text)", fontSize: 12.5, outline: "none", marginBottom: 6 }} />
      {groups.length === 0 ? (
        <div style={{ fontSize: 11.5, color: "var(--text-mute)", padding: "8px 0" }}>
          아직 기록 없음 — 순수익이 임계(기본 0%)를 넘는 기회가 생기면 자동으로 쌓입니다
        </div>
      ) : (
        <div style={{ maxHeight: 340, overflowY: "auto" }}>
          {groups.slice(0, 40).map((g) => {
            const gOpen = openGroup === g.key;
            return (
              <div key={g.key} style={{ borderTop: "1px solid var(--border)" }}>
                {/* 기회 한 줄.
                    두 줄로 끝낸다: 위는 결론(어떤 기회 / 먹을 수 있었나 / 얼마나
                    컸나), 아래는 맥락 전부를 muted 한 줄로. 배지를 하나씩 얹다가
                    한 줄에 뱃지 5개 + 같은 숫자("흑자 3분")가 칩과 우측 열에
                    두 번 찍히는 상태가 됐었다. 판정은 테두리 친 칩 대신 색만
                    입힌 평문으로 — 다섯 토막짜리 문장에 상자까지 두르면 그게
                    곧 잡음이다. */}
                <div onClick={() => { setOpenGroup(gOpen ? null : g.key); setOpenEp(null); }}
                  style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto auto", gap: 8, alignItems: "center", padding: "7px 0", fontSize: 11.5, cursor: "pointer" }}>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "flex", alignItems: "baseline", gap: 7, flexWrap: "wrap" }}>
                      <b>{g.base}</b>
                      {/* 판정 표기는 "잡을 수 있었던" 기회에만 — 못 먹은 게 대다수라
                          (실측 293건 중 1건) 행마다 빨간 공식을 찍으면 목록 전체가
                          경고판이 된다. 부정 판정은 정렬(잡을 수 있던 게 맨 위)·
                          헤드라인 집계·펼친 상세가 이미 말해준다. */}
                      {g.outlastsEta === true && (
                        <span
                          title={`순수익이 끊김 없이 0% 위에 머문 가장 긴 시간(${dur(g.longestSec)})이 전송 ETA(${g.etaMin}분)보다 깁니다 — 매수해서 코인이 도착할 때까지 갭이 살아 있었을 공산이 큽니다.`}
                          className="tnum"
                          style={{ fontSize: 10.5, fontWeight: 700, color: "var(--pos)" }}>
                          잡을 수 있었음 · 흑자 {dur(g.longestSec)}
                        </span>
                      )}
                      {g.executedN > 0 && <span style={{ fontSize: 9.5, fontWeight: 700, color: "var(--pos)" }}>실행 {g.executedN}</span>}
                    </span>
                    <span style={{ display: "block", fontSize: 10, color: "var(--text-mute)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 }}>
                      {kindLabel(g.kind, g.buyVenue, g.sellVenue)} · {vlabel(g.buyVenue) ?? g.buyVenue} → {vlabel(g.sellVenue) ?? g.sellVenue}
                      {g.windowN > 1 ? ` · ${g.windowN}회` : ""} · {when(g.lastTs)}
                    </span>
                  </span>
                  <span className="tnum" style={{ color: "var(--text-dim)" }}>피크 +{g.peak.toFixed(2)}%</span>
                  <span style={{ fontSize: 9, color: "var(--text-mute)" }}>{gOpen ? "▲" : "▼"}</span>
                </div>
                {/* 펼치면 그 기회의 개별 구간들 */}
                {gOpen && (
                  <div style={{ margin: "0 0 8px", paddingLeft: 10, borderLeft: "2px solid var(--border)" }}>
                    <div style={{ fontSize: 10, color: "var(--text-mute)", padding: "2px 0 4px" }}>
                      {g.outlastsEta == null
                        ? "전송 ETA 미상 — 도착 시점 판정 불가"
                        : `끊김 없이 흑자 ${dur(g.longestSec)} ${g.outlastsEta ? "≥" : "<"} 전송 ETA ${g.etaMin}분 · 화면에 걸친 시간 ${dur(g.spanSec)}`}
                      {g.items.length > g.windowN && ` · 기록 ${g.items.length}건`}
                    </div>
                    {g.items.map((e) => {
                      const key = `${e.id}:${e.startTs}`;
                      const eOpen = openEp === key;
                      return (
                        <div key={key}>
                          <div onClick={() => setOpenEp(eOpen ? null : key)}
                            style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto auto", gap: 8, alignItems: "center", padding: "5px 0", fontSize: 11, cursor: "pointer", color: "var(--text-dim)" }}>
                            <span className="tnum" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {new Date(e.startTs).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false })}
                              <span style={{ color: "var(--text-mute)" }}> · {dur(e.durationSec)}</span>
                              {e.executed && <span style={{ marginLeft: 6, fontSize: 9.5, fontWeight: 700, color: e.executed.dry ? "var(--sky)" : "var(--pos)" }}>{e.executed.dry ? "페이퍼" : "실행"}</span>}
                            </span>
                            <span className="tnum" style={{ color: "var(--pos)" }}>+{e.peakNetPct.toFixed(2)}%</span>
                            <span style={{ fontSize: 9, color: "var(--text-mute)" }}>{eOpen ? "▲" : "▼"}</span>
                          </div>
                          {eOpen && (
                            <div style={{ margin: "2px 0 8px", padding: "8px 12px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 9 }}>
                              <EpisodeChart curve={e.curve} peak={{ ts: e.peakTs, net: e.peakNetPct }} />
                              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 10.5, color: "var(--text-dim)", marginTop: 6 }} className="tnum">
                                <span>평균 {e.avgNetPct >= 0 ? "+" : ""}{e.avgNetPct.toFixed(2)}%</span>
                                <span>비용 {e.atPeak.costPct.toFixed(2)}%</span>
                                {e.atPeak.notionalCapUsd != null && <span>호가 한도 ${Math.round(e.atPeak.notionalCapUsd).toLocaleString()}</span>}
                                {e.atPeak.etaMin != null && <span>ETA {e.atPeak.etaMin}분</span>}
                                <span>{e.endReason === "vanished" ? "소멸로 종료" : "감쇠로 종료"}</span>
                              </div>
                              <div style={{ marginTop: 5, fontSize: 11, fontWeight: 600, color: e.executed ? (e.executed.dry ? "var(--sky)" : "var(--pos)") : e.atPeak.executable ? "var(--amber)" : "var(--neg)" }}>
                                {e.executed
                                  ? (e.executed.dry ? "페이퍼 실행함 — 운영 탭 거래 기록 참조" : "실행함 — 거래 기록 참조")
                                  : e.atPeak.executable
                                    ? "실행 가능했지만 안 함 (놓친 기회)"
                                    : `막혀 있었음: ${e.atPeak.blockReason ?? "사유 미상"}`}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


const MANUAL_CHAINS = ["ethereum", "bsc", "base", "arbitrum", "optimism", "polygon", "avalanche"];

export function ManualTokenCard() {
  type Row = { base: string; chain: string; entry: { address: string; decimals: number; symbol: string | null; verified: boolean; addedAt: number } };
  const [rows, setRows] = useState<Row[]>([]);
  const [form, setForm] = useState({ base: "", chain: "ethereum", address: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [needForce, setNeedForce] = useState<string | null>(null); // 서버가 알려준 불일치 사유

  const load = () => fetch("/api/manual-token", { cache: "no-store" }).then((r) => r.json())
    .then((j) => setRows(j.tokens ?? [])).catch(() => {});
  useEffect(() => { load(); }, []);

  const submit = async (force: boolean) => {
    setBusy(true); setMsg(null);
    try {
      const j = await (await fetch("/api/manual-token", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, force }),
      })).json();
      if (j.ok) {
        setMsg(`✓ 등록됨 — 온체인 ${j.symbol ?? "?"} · ${j.decimals} decimals${j.verified ? "" : " (심볼 미일치 — 강제)"}`);
        setNeedForce(null); setForm({ base: "", chain: form.chain, address: "" }); load();
      } else if (j.foundSymbol !== undefined) {
        setNeedForce(j.message); // 심볼 불일치 — 강제 등록 버튼 노출
      } else { setMsg(`✗ ${j.message ?? "등록 실패"}`); setNeedForce(null); }
    } catch { setMsg("✗ 요청 실패"); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 14px" }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 3 }}>수동 컨트랙트 등록</div>
      <div style={{ fontSize: 11, color: "var(--text-mute)", marginBottom: 8 }}>
        자동 교차 확인(CoinGecko·온체인)이 못 잡는 극신생 코인의 공식 컨트랙트를 직접 등록 — 전송 경로가 최우선으로 사용
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 6, marginBottom: 6 }}>
        <input value={form.base} onChange={(e) => setForm({ ...form, base: e.target.value.toUpperCase() })} placeholder="코인 (예: EUL)"
          style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 9, padding: "7px 10px", color: "var(--text)", fontSize: 12.5, outline: "none", minWidth: 0 }} />
        <select value={form.chain} onChange={(e) => setForm({ ...form, chain: e.target.value })}
          style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 9, padding: "7px 8px", color: "var(--text)", fontSize: 12 }}>
          {MANUAL_CHAINS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="컨트랙트 주소 (0x…)"
        className="tnum"
        style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 9, padding: "7px 10px", color: "var(--text)", fontSize: 11.5, outline: "none", marginBottom: 6 }} />
      {needForce ? (
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 11, color: "var(--neg)", marginBottom: 6 }}>⚠ {needForce}</div>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" disabled={busy} onClick={() => void submit(true)}
              style={{ border: "1px solid var(--neg)", background: "transparent", color: "var(--neg)", borderRadius: 9, padding: "6px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>
              그래도 등록 (책임 확인)
            </button>
            <button type="button" disabled={busy} onClick={() => setNeedForce(null)}
              style={{ border: "1px solid var(--border-strong)", background: "transparent", color: "var(--text-dim)", borderRadius: 9, padding: "6px 12px", fontSize: 11.5, cursor: "pointer" }}>
              취소
            </button>
          </div>
        </div>
      ) : (
        <button type="button" disabled={busy || !form.base.trim() || !form.address.trim()} onClick={() => void submit(false)}
          style={{ width: "100%", border: "none", borderRadius: 9, padding: "8px 0", background: "var(--brand)", color: "var(--brand-ink)", fontWeight: 700, fontSize: 12, cursor: "pointer", opacity: busy || !form.base.trim() || !form.address.trim() ? 0.5 : 1, marginBottom: 6 }}>
          {busy ? "온체인 확인 중…" : "온체인 확인 후 등록"}
        </button>
      )}
      {msg && <div style={{ fontSize: 11, color: msg.startsWith("✓") ? "var(--pos)" : "var(--neg)", marginBottom: 6 }}>{msg}</div>}
      {rows.length > 0 && (
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 6 }}>
          {rows.map((r) => (
            <div key={r.base + r.chain} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 11.5 }}>
              <b>{r.base}</b>
              <span style={{ fontSize: 10, color: "var(--text-mute)" }}>{r.chain}</span>
              {!r.entry.verified && <span style={{ fontSize: 9.5, fontWeight: 700, color: "var(--neg)" }}>심볼 미일치</span>}
              <span className="tnum" style={{ fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
                {r.entry.address}
              </span>
              <button type="button" title="삭제"
                onClick={() => { void fetch(`/api/manual-token?base=${r.base}&chain=${r.chain}`, { method: "DELETE" }).then(load); }}
                style={{ border: "none", background: "transparent", color: "var(--text-mute)", cursor: "pointer", fontSize: 12 }}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Deposit/withdraw gate lookup across venues (pre-trade settlement check).

export type GateRow = { base: string; venues: Record<string, { deposit: boolean; withdraw: boolean } | null> };

export function GatesCard() {
  const [q, setQ] = useState("");
  const [data, setData] = useState<{ venues: string[]; rows: GateRow[]; missing?: string[] } | null>(null);
  useEffect(() => {
    fetch("/api/gates", { cache: "no-store" }).then((r) => r.json()).then(setData).catch(() => {});
  }, []);
  // 기본은 **막힌 코인만**. 이 카드에 오는 이유는 "지금 뭐가 막혔나"인데,
  // 500행 전체를 항상 그리면 운영 탭이 데이터 덤프가 된다 — 대시보드도 이미
  // "중단 N종"만 요약한다. 특정 코인 확인은 검색으로(전체에서 찾음), 전체
  // 목록은 명시적 토글로 연다. 절단이 아니라 접힘이다 — 개수는 항상 보인다.
  // (전체 모드에선 예전 결정 유지: 자르지 않고 다 보여주고 컨테이너가 스크롤.)
  const [showAll, setShowAll] = useState(false);
  const isBlocked = (r: GateRow) => Object.values(r.venues).some((s) => s && (!s.deposit || !s.withdraw));
  const rows = useMemo(() => {
    if (!data) return [];
    const term = q.trim().toUpperCase();
    let list = term ? data.rows.filter((r) => r.base.includes(term)) : data.rows.slice();
    if (!term && !showAll) list = list.filter(isBlocked);
    // 막힌 것 먼저 — 가나다순 500줄 속에서 막힌 코인은 영영 눈에 안 띈다.
    return list.sort((a, b) => (isBlocked(b) ? 1 : 0) - (isBlocked(a) ? 1 : 0) || a.base.localeCompare(b.base));
  }, [data, q, showAll]);
  // 집계는 표시 목록이 아니라 전체 기준 — 접힘 상태에서도 참이어야 한다.
  const blockedCount = useMemo(() => (data ? data.rows.filter(isBlocked).length : 0), [data]);
  const cell = (s: { deposit: boolean; withdraw: boolean } | null) => {
    if (!s) return <span style={{ fontSize: 10.5, color: "var(--text-mute)" }}>키필요</span>;
    const tag = (on: boolean, t: string) => (
      <span style={{ fontSize: 10.5, fontWeight: 700, color: on ? "var(--pos)" : "var(--neg)" }}>{t}</span>
    );
    return <span style={{ display: "inline-flex", gap: 4 }}>{tag(s.deposit, "입")}{tag(s.withdraw, "출")}</span>;
  };

  // 행 펼침 — 어떤 체인이 열리고 막혔는지. "코인이 열렸다"는 요약은 어느 한
  // 체인만 열려 있어도 참이라, 실제 전송 경로를 고르려면 체인 단위가 필요하다.
  const [openBase, setOpenBase] = useState<string | null>(null);
  type NetRow = { net: string; deposit: boolean; withdraw: boolean; feeCoin?: number; isDefault?: boolean };
  const [nets, setNets] = useState<Record<string, Record<string, NetRow[]>>>({});
  const toggleRow = (base: string) => {
    const next = openBase === base ? null : base;
    setOpenBase(next);
    if (next && !nets[next]) {
      fetch(`/api/gate-networks?coin=${encodeURIComponent(next)}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => setNets((p) => ({ ...p, [next]: j.networks ?? {} })))
        .catch(() => {});
    }
  };
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 14px" }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 3 }}>입출금 상태 조회</div>
      <div style={{ fontSize: 11, color: "var(--text-mute)", marginBottom: 8 }}>실행 전 코인의 거래소별 입금·출금 열림 여부 확인 (<span style={{ color: "var(--pos)" }}>입/출</span> = 열림, <span style={{ color: "var(--neg)" }}>빨강</span> = 중단)</div>
      {data && (data.missing?.length ?? 0) > 0 && (
        <div style={{ fontSize: 10.5, color: "var(--amber)", marginBottom: 8 }}>
          {data.missing!.map((v) => VENUE_LABEL[v] ?? v).join("·")}는 인증 API라 키 등록 후 표시됩니다 — 헤더 ⚙ 설정에서 입력 (빗썸만 공개 API)
        </div>
      )}
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="코인 검색 (예: XRP)"
        style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 9, padding: "8px 10px", color: "var(--text)", fontSize: 13, outline: "none", marginBottom: 6 }}
      />
      {data && (
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 10.5, color: "var(--text-mute)", marginBottom: 6 }}>
          <span>
            {q.trim()
              ? `${rows.length}개 표시 (전체 ${data.rows.length})`
              : showAll
                ? `전체 ${rows.length}개`
                : blockedCount > 0
                  ? <span style={{ color: "var(--neg)", fontWeight: 700 }}>중단 {blockedCount}개</span>
                  : "지금 막힌 코인 없음"}
          </span>
          <span style={{ flex: 1 }} />
          {!q.trim() && (
            <button type="button" onClick={() => setShowAll((v) => !v)}
              style={{ border: "none", background: "transparent", color: "var(--brand-2)", fontSize: 10.5, fontWeight: 600, cursor: "pointer", padding: 0 }}>
              {showAll ? "막힌 것만" : `전체 ${data.rows.length}개 보기`}
            </button>
          )}
        </div>
      )}
      {!data ? (
        <div style={{ color: "var(--text-mute)", fontSize: 12, padding: "8px 0" }}>조회 중…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: "var(--text-mute)", fontSize: 12, padding: "8px 0" }}>
          {q.trim() ? "검색 결과 없음" : "확인 가능한 거래소 기준 중단된 코인이 없습니다 — 특정 코인은 검색으로"}
        </div>
      ) : (
        <div style={{ overflowX: "auto", maxHeight: 240, overflowY: "auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: `64px repeat(${data.venues.length}, 1fr)`, gap: "6px 10px", fontSize: 12, minWidth: 60 + data.venues.length * 70 }}>
            <span style={{ fontSize: 10.5, color: "var(--text-mute)" }}>코인</span>
            {data.venues.map((v) => <span key={v} style={{ fontSize: 10.5, color: "var(--text-mute)" }}>{VENUE_LABEL[v] ?? v}</span>)}
            {rows.map((r) => (
              <Fragment key={r.base}>
                <span onClick={() => toggleRow(r.base)}
                  style={{ fontWeight: 700, cursor: "pointer", color: openBase === r.base ? "var(--brand-2)" : undefined }}>
                  {r.base} <span style={{ fontSize: 9, color: "var(--text-mute)" }}>{openBase === r.base ? "▲" : "▼"}</span>
                </span>
                {data.venues.map((v) => <span key={v} onClick={() => toggleRow(r.base)} style={{ cursor: "pointer" }}>{cell(r.venues[v])}</span>)}
                {openBase === r.base && (
                  <div style={{ gridColumn: "1 / -1", margin: "2px 0 6px", padding: "8px 12px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 9 }}>
                    {!nets[r.base] ? (
                      <span style={{ fontSize: 11, color: "var(--text-mute)" }}>체인 조회 중…</span>
                    ) : Object.keys(nets[r.base]).length === 0 ? (
                      <span style={{ fontSize: 11, color: "var(--text-mute)" }}>
                        체인 상세 없음 — 빗썸 공개 API는 코인 단위만 제공하고, 나머지 거래소는 키 등록 후 체인별 상태가 보입니다
                      </span>
                    ) : (
                      Object.entries(nets[r.base]).map(([venue, list]) => (
                        <div key={venue} style={{ padding: "3px 0" }}>
                          <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-dim)", marginRight: 8 }}>{VENUE_LABEL[venue] ?? venue}</span>
                          <span style={{ display: "inline-flex", gap: 10, flexWrap: "wrap" }}>
                            {list.map((n) => (
                              <span key={n.net} className="tnum" style={{ fontSize: 10.5, whiteSpace: "nowrap" }}>
                                <b style={{ color: n.isDefault ? "var(--text)" : "var(--text-dim)" }}>{n.net}</b>
                                {" "}
                                <span style={{ fontWeight: 700, color: n.deposit ? "var(--pos)" : "var(--neg)" }}>입</span>
                                <span style={{ fontWeight: 700, color: n.withdraw ? "var(--pos)" : "var(--neg)" }}>출</span>
                                {n.feeCoin != null && <span style={{ color: "var(--text-mute)" }}> 수수료 {n.feeCoin}</span>}
                              </span>
                            ))}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                )}
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
  hedged?: boolean; status?: string;
  timeline?: { step: string; label: string; at: number; sec: number; ok: boolean; kind?: "wait" | "retry" | "rollback"; tries?: number; message?: string }[];
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

  // 전략별 분해 — 실거래 합계 + 탐지→실현 누수 (없으면 모의 포함 표기).
  const byKind = useMemo(() => {
    const m = new Map<string, { pnl: number; n: number; real: boolean; leakSum: number; leakN: number }>();
    for (const t of trades) {
      const real = !t.dryRun && t.realizedPnlUsd != null;
      const k = t.kind === "kimchi" ? kindLabel(t.kind, t.route?.split(" → ")[0]) : t.kind === "cross-cex" ? "크로스" : t.kind === "listing" ? "상장" : t.kind;
      const e = m.get(k) ?? { pnl: 0, n: 0, real: false, leakSum: 0, leakN: 0 };
      e.n++;
      if (real) { e.pnl += t.realizedPnlUsd!; e.real = true; }
      // 누수 = 실현 − 탐지 (모의 포함 — 페이퍼도 같은 정의라 실전 전환 후 비교 가능)
      if (t.realizedNetPct != null && t.detectedNetPct != null) { e.leakSum += t.realizedNetPct - t.detectedNetPct; e.leakN++; }
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
              {k} {v.n}건{v.real ? <b style={{ marginLeft: 5, color: v.pnl >= 0 ? "var(--pos)" : "var(--neg)" }}>{v.pnl >= 0 ? "+" : "−"}${Math.abs(v.pnl).toFixed(2)}</b> : <span style={{ marginLeft: 5, color: "var(--text-mute)" }}>페이퍼</span>}{v.leakN > 0 && <span title="실현 − 탐지 순수익 평균 (음수 = 탐지보다 실현이 나쁨)" style={{ marginLeft: 5, color: v.leakSum / v.leakN < -0.1 ? "var(--amber)" : "var(--text-mute)" }}>누수 {(v.leakSum / v.leakN).toFixed(2)}%p</span>}
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
  // 인덱스가 아니라 거래 자체를 키로 잡는다. /api/trades는 15초마다 폴링되고
  // 최신이 **앞에** 붙으므로, 인덱스로 열어두면 새 거래가 하나 들어올 때마다
  // 펼쳐진 칸이 다른 거래의 타임라인·손익·tx를 보여준다. 이번에 그 안에 넣은
  // 내용이 정확히 오귀속되면 안 되는 것들이다.
  const [open, setOpen] = useState<string | null>(null);
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
      {trades.slice(0, 10).map((t, i) => {
        const totalSec = t.durationsSec ? Object.values(t.durationsSec).reduce((s, v) => s + v, 0) : 0;
        const agoMin = Math.round((Date.now() - t.ts) / 60_000);
        const kindKo = t.kind === "kimchi" ? kindLabel(t.kind, t.route?.split(" → ")[0]) : t.kind === "cross-cex" ? "크로스" : t.kind === "cex-dex" ? "CEX-DEX" : t.kind;
        const rid = `${t.ts}:${t.base}`;
        return (
        <div key={rid} style={{ borderTop: "1px solid var(--border)" }}>
          <div
            onClick={() => setOpen(open === rid ? null : rid)}
            style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "center", padding: "6px 0", fontSize: 11.5, cursor: "pointer" }}
          >
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}>
                <b>{t.base}</b>
                <span style={{ fontSize: 9.5, fontWeight: 700, color: "var(--brand-2)" }}>{kindKo}</span>
                {t.dryRun && <span style={{ fontSize: 9.5, fontWeight: 700, color: "var(--sky)", border: "1px solid var(--sky)", borderRadius: 8, padding: "0 4px" }}>페이퍼</span>}
                {t.status && t.status !== "done" && <span style={{ fontSize: 9.5, fontWeight: 700, color: "var(--neg)" }}>{t.status}</span>}
              </span>
              <span style={{ display: "block", fontSize: 10, color: "var(--text-mute)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1 }}>
                {t.route} · {usd(t.sizeUsd)}{totalSec > 0 ? ` · ${dur(totalSec)} 소요` : ""} · {agoMin < 60 ? `${agoMin}분 전` : agoMin < 1440 ? `${Math.round(agoMin / 60)}시간 전` : `${Math.round(agoMin / 1440)}일 전`}
              </span>
            </span>
            <span style={{ textAlign: "right" }}>
              <span className="tnum" style={{ display: "block", fontWeight: 700, color: (t.realizedNetPct ?? t.detectedNetPct) >= 0 ? "var(--pos)" : "var(--neg)" }}>
                {t.realizedNetPct != null ? `${t.realizedNetPct >= 0 ? "+" : ""}${t.realizedNetPct.toFixed(2)}%` : `~${t.detectedNetPct.toFixed(2)}%`}
              </span>
              <span className="tnum" style={{ display: "block", fontSize: 10, color: t.realizedPnlUsd == null ? "var(--text-mute)" : t.realizedPnlUsd >= 0 ? "var(--pos)" : "var(--neg)" }}>
                {t.realizedPnlUsd != null ? `${t.realizedPnlUsd >= 0 ? "+" : "−"}$${Math.abs(t.realizedPnlUsd).toFixed(2)}` : "미실현"}
              </span>
            </span>
          </div>
          {open === rid && (
            <div style={{ margin: "2px 0 8px", padding: "8px 12px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}>
              {dLine("시각", new Date(t.ts).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }))}
              {/* 감지 대비 실현 — 이 차이(누수)가 곧 비용 모델의 오차라 캘리브레이션의
                  근거다. 보드가 약속한 것과 실제로 남은 것의 간격을 숨기면 안 된다. */}
              {dLine("감지 순수익", `${t.detectedNetPct >= 0 ? "+" : ""}${t.detectedNetPct.toFixed(2)}%`)}
              {t.realizedNetPct != null && dLine(
                "실현 순수익 (누수)",
                <>{`${t.realizedNetPct >= 0 ? "+" : ""}${t.realizedNetPct.toFixed(2)}%`}<span style={{ color: (t.realizedNetPct - t.detectedNetPct) >= 0 ? "var(--pos)" : "var(--neg)", marginLeft: 6 }}>({(t.realizedNetPct - t.detectedNetPct) >= 0 ? "+" : ""}{(t.realizedNetPct - t.detectedNetPct).toFixed(2)}%p)</span></>,
              )}
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
              {/* 진행 타임라인 — 언제 어떤 단계가 돌았고 얼마 걸렸는지. 재시도·대기·
                  롤백도 각각 한 줄이다(단계별 합산 소요로는 안 보이던 것들). */}
              {t.timeline && t.timeline.length > 0 ? (
                <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid var(--border)" }}>
                  <div style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-mute)", marginBottom: 4 }}>진행 타임라인</div>
                  {t.timeline.map((e, k) => {
                    const prev = k > 0 ? t.timeline![k - 1] : null;
                    const gapSec = prev ? Math.round((e.at - (prev.at + prev.sec * 1000)) / 1000) : 0;
                    const tone = !e.ok ? (e.kind === "wait" ? "var(--amber)" : "var(--neg)") : e.kind === "rollback" ? "var(--amber)" : "var(--pos)";
                    return (
                      <div key={k} style={{ display: "grid", gridTemplateColumns: "auto 10px 1fr auto", gap: 7, alignItems: "baseline", fontSize: 10.5, padding: "1.5px 0" }}>
                        <span className="tnum" style={{ color: "var(--text-mute)" }}>
                          {new Date(e.at).toLocaleTimeString("ko-KR", { hour12: false })}
                        </span>
                        <span style={{ color: tone, fontWeight: 700, textAlign: "center" }}>
                          {e.ok ? "●" : e.kind === "wait" ? "◌" : "✕"}
                        </span>
                        <span style={{ color: "var(--text-dim)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                          {e.label}
                          {e.kind === "retry" && <span style={{ color: "var(--amber)", marginLeft: 4 }}>재시도</span>}
                          {e.kind === "wait" && <span style={{ color: "var(--amber)", marginLeft: 4 }}>대기{e.tries && e.tries > 1 ? ` ×${e.tries}` : ""}</span>}
                          {e.kind === "rollback" && <span style={{ color: "var(--amber)", marginLeft: 4 }}>롤백</span>}
                          {e.message && <span style={{ color: "var(--text-mute)", marginLeft: 5 }}>{e.message}</span>}
                          {/* 단계 사이의 빈 시간 — 승인 대기나 폴링 간격이 여기 드러난다 */}
                          {gapSec >= 5 && <span style={{ color: "var(--text-mute)", marginLeft: 5 }}>(+{dur(gapSec)} 유휴)</span>}
                        </span>
                        <span className="tnum" style={{ color: "var(--text-mute)" }}>{dur(e.sec)}</span>
                      </div>
                    );
                  })}
                </div>
              ) : t.durationsSec && Object.keys(t.durationsSec).length > 0 ? dLine(
                // 구버전 레코드 — 타임라인 없이 단계별 합산만 있다.
                "단계 소요",
                Object.entries(t.durationsSec).map(([k, v]) => `${k} ${v}s`).join(" · "),
              ) : null}
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
              {t.hedged != null && dLine("헷지", t.hedged ? "퍼프 숏 병행" : "무헷지", t.hedged ? undefined : "var(--amber)")}
              {t.note && <div style={{ marginTop: 4, fontSize: 10, color: "var(--text-mute)" }}>{t.note}</div>}
            </div>
          )}
        </div>
        );
      })}
    </div>
  );
}


// ── 실행 품질 — 거래소별 Order-to-Ack · 슬리피지 (DRY 포함: 페이퍼 트레이딩 데이터) ──
// 페이퍼와 실전이 같은 스키마로 쌓여, 실전 전환 후 "모의가 얼마나 정확했나"를
// 같은 표에서 비교한다. 데이터는 execStep이 주문마다 남긴다 (exec-metrics.jsonl).
export function ExecQualityCard() {
  type Ack = { venue: string; op: string; n: number; dryN: number; okPct: number; p50Ms: number | null; p95Ms: number | null };
  type Slip = { venue: string; n: number; meanPct: number; p90Pct: number; worstPct: number };
  const [data, setData] = useState<{ total: number; dryN: number; ack: Ack[]; slip: Slip[] } | null>(null);
  useEffect(() => {
    const load = () => fetch("/api/exec-metrics", { cache: "no-store" }).then((r) => r.json()).then(setData).catch(() => {});
    void load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);
  const ms = (v: number | null) => (v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);
  const OP_KO: Record<string, string> = { buy: "매수", sell: "매도", hedge: "헷지", close: "청산", withdraw: "출금" };
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>실행 품질</span>
        {data && data.total > 0 && <span style={{ fontSize: 10, color: "var(--text-mute)" }}>{data.total}주문{data.dryN > 0 ? ` · 페이퍼 ${data.dryN}` : ""}</span>}
      </div>
      {!data || data.total === 0 ? (
        <div style={{ color: "var(--text-mute)", fontSize: 12 }}>기록 없음 — 주문(모의 포함)이 나가면 Order-to-Ack·슬리피지가 여기 쌓입니다</div>
      ) : (
        <>
          <div style={{ ...({ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-mute)" } as React.CSSProperties), marginBottom: 4 }}>Order-to-Ack (거래소 × 단계)</div>
          <div style={{ marginBottom: 10 }}>
            {data.ack.slice(0, 8).map((a) => (
              <div key={`${a.venue}:${a.op}`} className="tnum" style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px solid var(--border)", fontSize: 11.5 }}>
                <span style={{ color: "var(--text-dim)", minWidth: 0 }}>{vlabel(a.venue)} {OP_KO[a.op] ?? a.op}</span>
                {a.okPct < 100 && <span style={{ color: "var(--amber)", fontSize: 10 }}>성공 {a.okPct}%</span>}
                <span style={{ flex: 1 }} />
                <span style={{ color: "var(--text-mute)", fontSize: 10.5 }}>{a.n}건</span>
                <span>p50 <b>{ms(a.p50Ms)}</b></span>
                <span style={{ color: "var(--text-dim)" }}>p95 {ms(a.p95Ms)}</span>
              </div>
            ))}
          </div>
          {data.slip.length > 0 && (
            <>
              <div style={{ ...({ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-mute)" } as React.CSSProperties), marginBottom: 4 }}>슬리피지 (스냅샷가 대비 · +가 불리)</div>
              {data.slip.map((sl) => (
                <div key={sl.venue} className="tnum" style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px solid var(--border)", fontSize: 11.5 }}>
                  <span style={{ color: "var(--text-dim)" }}>{vlabel(sl.venue)}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ color: "var(--text-mute)", fontSize: 10.5 }}>{sl.n}건</span>
                  <span>평균 <b style={{ color: Math.abs(sl.meanPct) > 0.3 ? "var(--amber)" : "var(--text)" }}>{sl.meanPct >= 0 ? "+" : ""}{sl.meanPct.toFixed(2)}%</b></span>
                  <span style={{ color: "var(--text-dim)" }}>p90 {sl.p90Pct >= 0 ? "+" : ""}{sl.p90Pct.toFixed(2)}%</span>
                  <span style={{ color: Math.abs(sl.worstPct) > 1 ? "var(--neg)" : "var(--text-mute)" }}>최악 {sl.worstPct >= 0 ? "+" : ""}{sl.worstPct.toFixed(2)}%</span>
                </div>
              ))}
            </>
          )}
        </>
      )}
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
        {st && st.dryCount > 0 && <span style={{ fontSize: 10, color: "var(--text-mute)" }}>페이퍼 {st.dryCount}건 포함</span>}
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
          {/* 손익 캘린더 — 일별 정리는 여기. 최근 목록(아래)은 흐름, 캘린더는 리듬. */}
          <PnlCalendar />
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
  venues: { venue: string; hot: number; cold: number; hotUsd: number | null; coldUsd: number | null; addresses: number; hotDeltaPerMin: number | null; hotInPerMin: number | null; hotOutPerMin: number | null }[];
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
      // pending = 서버가 뒤에서 구축 중 (연결을 오래 잡지 않는 API). 여기는
      // 사용자가 버튼을 눌러 기다리는 화면이라 3초 간격으로 될 때까지 다시 묻는다.
      for (;;) {
        const j = await (await fetch(`/api/exchange-holdings?symbol=${encodeURIComponent(q)}`, { cache: "no-store" })).json();
        if (j.stats) setStats(j.stats);
        if (j.pending) { await new Promise((r) => setTimeout(r, 3000)); continue; }
        if (j.error) { setErr(j.error); setData(null); }
        else setData(j.holdings);
        break;
      }
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
            <span style={{ color: "var(--text-mute)", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", textAlign: "right" }}>유입/유출 ·분</span>
            {data.venues.filter((v) => v.hot + v.cold > 0 || v.addresses > 0).map((v) => (
              <Fragment key={v.venue}>
                <span style={{ fontWeight: 600 }}>{vlabel(v.venue as never) ?? v.venue}<span style={{ color: "var(--text-mute)", fontWeight: 400 }}> ·{v.addresses}주소</span></span>
                <span className="tnum" style={{ textAlign: "right" }}>
                  {fmtQty(v.hot)}{v.hotUsd != null && v.hotUsd > 0 ? <span style={{ color: "var(--text-mute)" }}> (${fmtQty(v.hotUsd)})</span> : null}
                </span>
                <span className="tnum" style={{ textAlign: "right", color: "var(--text-dim)" }}>{fmtQty(v.cold)}</span>
                <span className="tnum" style={{ textAlign: "right" }}>
                  {/* 유입·유출을 각각 — 순 Δ만 보면 +10k 입금과 −8k 출금이 "+2k"로
                      뭉개져 덤핑 재고 유입 신호가 사라진다. */}
                  {v.hotInPerMin != null && v.hotOutPerMin != null ? (
                    <>
                      <span style={{ color: v.hotInPerMin > 0 ? "var(--pos)" : "var(--text-mute)" }}>
                        +{data.priceUsd != null ? `$${fmtQty(v.hotInPerMin * data.priceUsd)}` : fmtQty(v.hotInPerMin)}
                      </span>
                      <span style={{ color: "var(--text-mute)" }}> / </span>
                      <span style={{ color: v.hotOutPerMin > 0 ? "var(--neg)" : "var(--text-mute)" }}>
                        −{data.priceUsd != null ? `$${fmtQty(v.hotOutPerMin * data.priceUsd)}` : fmtQty(v.hotOutPerMin)}
                      </span>
                    </>
                  ) : v.hotDeltaPerMin == null ? "—"
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
