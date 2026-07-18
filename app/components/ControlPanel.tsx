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

export function ControlPanel({ runs, killed, onOpen }: { runs: RunView[]; killed: boolean; onOpen: (r: RunView) => void }) {
  const inFlight = inFlightUsd();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingBottom: 40 }}>
      <KillCard killed={killed} />
      <RiskCard inFlight={inFlight} />
      {runs.length > 0
        ? <RunsDashboard runs={runs} onOpen={onOpen} onClearDone={() => {}} />
        : <div style={{ color: "var(--text-mute)", fontSize: 12.5, textAlign: "center", padding: "18px 0", border: "1px dashed var(--border)", borderRadius: "var(--radius)" }}>진행 중인 실행 없음 — 실행 탭에서 시작하면 여기에 표시됩니다</div>}
      <ListingsCard />
      <PnlCard />
      <TelegramCard />
      <GatesCard />
      <ToolsCard />
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
          background: killed ? "var(--pos)" : "var(--neg)", color: "#0b0e11",
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

export type TradeRec = { ts: number; base: string; route: string; sizeUsd: number; detectedNetPct: number; realizedNetPct: number | null; realizedPnlUsd: number | null; dryRun: boolean; kind: string };

export type TradeStats = { count: number; wins: number; hitRatePct: number; realizedPnlUsd: number; avgSlipPct: number; dryCount: number };

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
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
            <Metric label="실현 손익" value={`${st.realizedPnlUsd >= 0 ? "+" : "−"}$${Math.abs(st.realizedPnlUsd).toFixed(2)}`} tone={st.realizedPnlUsd >= 0 ? "var(--pos)" : "var(--neg)"} />
            <Metric label="히트율" value={`${st.hitRatePct}%`} sub={`${st.wins}/${st.count - st.dryCount || st.count}`} />
            <Metric label="탐지 vs 실현" value={`−${st.avgSlipPct.toFixed(2)}%`} sub="평균 누수" tone={st.avgSlipPct > 0.3 ? "var(--amber)" : "var(--text)"} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {data.trades.slice(0, 8).map((t, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 8, alignItems: "center", padding: "4px 0", borderTop: "1px solid var(--border)", fontSize: 11.5 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <b>{t.base}</b> <span style={{ color: "var(--text-mute)" }}>{t.route}{t.dryRun ? " · 모의" : ""}</span>
                </span>
                <span className="tnum" style={{ color: "var(--text-mute)" }}>{usd(t.sizeUsd)}</span>
                <span className="tnum" style={{ minWidth: 60, textAlign: "right", color: (t.realizedNetPct ?? t.detectedNetPct) >= 0 ? "var(--pos)" : "var(--neg)" }}>
                  {t.realizedNetPct != null ? `${t.realizedNetPct >= 0 ? "+" : ""}${t.realizedNetPct.toFixed(2)}%` : `~${t.detectedNetPct.toFixed(2)}%`}
                </span>
              </div>
            ))}
          </div>
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
        <span style={{ width: 6, height: 6, borderRadius: 999, background: on ? "var(--pos)" : "var(--text-mute)" }} />
        <span style={{ fontSize: 11, color: on ? "var(--pos)" : "var(--text-mute)" }}>{on ? "연결됨" : "키 필요"}</span>
        <span style={{ flex: 1 }} />
        {on && (
          <button type="button" onClick={test} disabled={busy} style={{ border: "1px solid var(--border-strong)", background: "transparent", color: "var(--text-dim)", borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
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

type Listing = { base: string; venue: string; announcedAt: number; overseas: boolean; opened: boolean; globalVenue?: string; globalPrice?: number; title?: string };
function ListingsCard() {
  const [rows, setRows] = useState<Listing[]>([]);
  const [buying, setBuying] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ base: string; text: string } | null>(null);
  const buyUsd = 500; // LISTING_BUY_USD 서버 기본과 일치
  const quickBuy = async (base: string) => {
    setBuying(base); setMsg(null);
    try {
      const j = await (await fetch("/api/listing-buy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ base, sizeUsd: buyUsd }) })).json();
      setMsg({ base, text: `${j.ok ? "✓" : "✗"} ${j.message ?? ""}${j.venue ? ` (${j.venue})` : ""}` });
    } catch { setMsg({ base, text: "요청 실패" }); }
    finally { setBuying(null); }
  };
  useEffect(() => {
    const load = () => fetch("/api/listings", { cache: "no-store" }).then((r) => r.json()).then((j) => setRows(j.listings ?? [])).catch(() => {});
    void load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);
  return (
    <div style={{ background: "var(--card)", border: `1px solid ${rows.length ? "var(--amber)" : "var(--border)"}`, borderRadius: "var(--radius)", padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: rows.length ? 8 : 0 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>상장따리 — 최근 신규 상장</span>
        <span style={{ width: 6, height: 6, borderRadius: 999, background: rows.length ? "var(--amber)" : "var(--text-mute)" }} />
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 11.5, color: "var(--text-mute)" }}>감시 중 — 업비트 상장 공지 2.5s·마켓 3s 폴링. 공지 뜨면 해외 매수처와 함께 텔레그램·보드 최상단. (공지 API는 KR IP에서 동작)</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {rows.map((l) => {
            const age = Math.round((Date.now() - l.announcedAt) / 1000);
            return (
              <div key={l.base + l.venue} style={{ borderTop: "1px solid var(--border)", paddingTop: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                  <span style={{ fontWeight: 800 }}>{l.base}</span>
                  <span style={{ fontSize: 9.5, fontWeight: 700, color: "#181a20", background: l.opened ? "var(--pos)" : "var(--amber)", borderRadius: 4, padding: "1px 5px" }}>
                    {l.opened ? "거래 개시" : "공지(선점)"}
                  </span>
                  <span style={{ color: "var(--text-mute)", fontSize: 11 }}>{l.venue === "upbit" ? "업비트" : "빗썸"} · {age < 60 ? `${age}s` : `${Math.floor(age / 60)}m`} 전</span>
                  <span style={{ flex: 1 }} />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, marginTop: 2 }}>
                  <span style={{ color: l.overseas ? "var(--pos)" : "var(--text-mute)" }}>
                    {l.overseas
                      ? `해외 매수: ${l.globalVenue} @ ${l.globalPrice} — 거래개시 전 선점`
                      : "해외 미상장 (김프 아님 · 상장 펌핑만)"}
                  </span>
                  <span style={{ flex: 1 }} />
                  {l.overseas && (
                    <button
                      type="button"
                      disabled={buying === l.base}
                      onClick={() => void quickBuy(l.base)}
                      style={{ border: "none", borderRadius: 6, padding: "5px 12px", background: "var(--brand-grad)", color: "#181a20", fontWeight: 800, fontSize: 11, cursor: "pointer" }}
                    >
                      {buying === l.base ? "…" : `$${buyUsd} 매수`}
                    </button>
                  )}
                </div>
                {msg?.base === l.base && <div style={{ fontSize: 10.5, color: "var(--brand-2)", marginTop: 2 }}>{msg.text}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ToolsCard() {
  const tools = [
    { t: "긴급 청산·헷지 정리", d: "열린 포지션을 즉시 시장가 청산 / 헷지만 정리" },
    { t: "KRW 리패트리에이션", d: "원화 회수(오프램프) 한도·환전 비용 추적" },
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

export function RunsDashboard({ runs, onOpen }: {
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
export default ControlPanel;
