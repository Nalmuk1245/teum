"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Opportunity, Quote, StrategyKind } from "@/lib/types";
import { pct, usd, price } from "@/lib/format";
import { useLivePrices, type LiveAges, type LiveGap, type LiveStatus } from "@/lib/useLivePrices";
import { buildPlan, type AutoLevel, type ExecStep, type StepPhase } from "@/lib/execPlan";
import { useRuns, startRun, confirmRun, retryRun, cancelRun, unwindRun, clearFinished, setKillSwitch, inFlightUsd, setInFlightLimit, type RunView } from "@/lib/runStore";
import AssetsPanel, { AssetSummary } from "./components/InventoryPanel";
import CockpitBoard from "./components/CockpitBoard";
import ExecuteModal from "./components/ExecuteModal";
import RunDock from "./components/RunDock";
import ControlPanel from "./components/ControlPanel";
import { ListingPanel } from "./components/ListingPanel";
import { GapInspect } from "./components/GapInspect";
import { DashboardPanel } from "./components/DashboardPanel";
import { PremiumPanel } from "./components/PremiumPanel";
import { SettingsModal, type SettingsTab } from "./components/SettingsModal";
import { KIND_META, KINDS, GAP_KINDS, ALERT_NET_PCT, beep, Tile, Pill, ScanAge, LiveDots } from "./components/cockpit-ui";
import { useIsMobile } from "./mobile";
import { isLocked } from "@/lib/gateState";
import { CoinSheet } from "./components/CoinSheet";
import { CoinSheetCtx } from "./components/coinSheetCtx";
import { PnlCard, RunsDashboard, EpisodeCard } from "./components/ControlPanel";
import { BacktestCard } from "./components/BacktestCard";

// 모바일 판정은 app/mobile.tsx의 단일 소스 (서버 UA로 첫 페인트부터 맞추고
// 마운트 후 matchMedia가 정정 — 이유는 그 파일 주석 참고).

const ICON_BTN: React.CSSProperties = {
  border: "1px solid var(--border)", background: "transparent", color: "var(--text-dim)",
  borderRadius: 6, width: 28, height: 28, boxSizing: "border-box",
  display: "grid", placeItems: "center", cursor: "pointer", padding: 0,
};

/** How often row ORDER may change. Values still update at the 600ms WS cadence;
 *  only the ranking is throttled, so rows don't shuffle under the cursor. */
const RANK_THROTTLE_MS = 2500;
/** How long a threshold-crossing row stays highlighted. */
const FLASH_MS = 4000;

/** A snapshot of the overlay that only advances every `ms`. */
function useRankSnapshot(overlay: Record<string, LiveGap>, ms: number) {
  const [snap, setSnap] = useState(overlay);
  const latest = useRef(overlay);
  latest.current = overlay;
  useEffect(() => {
    const id = setInterval(() => setSnap(latest.current), ms);
    return () => clearInterval(id);
  }, [ms]);
  // Adopt immediately when the set of ids changes (new/removed opportunity) —
  // that's a structural change, not a value wiggle, and waiting looks broken.
  const ids = Object.keys(overlay).length;
  const prevIds = useRef(ids);
  useEffect(() => {
    if (prevIds.current !== ids) { prevIds.current = ids; setSnap(latest.current); }
  }, [ids]);
  return snap;
}

export default function Cockpit() {
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [meta, setMeta] = useState<{ dryRun: boolean; mock: boolean; calPct?: number; calSamples?: number } | null>(null);
  const [loading, setLoading] = useState(true);
  // "locked" = 입출금 닫힘/정지 의심 — 지우지 않고 따로 모아 본다 (열리면 기회).
  const [filter, setFilter] = useState<StrategyKind | "all" | "locked">("all");
  // 수익만 — hide net≤0 rows (they're the honest-cost-model majority and mostly
  // noise; the toggle brings them back for gap-watching). Persisted.
  const [plusOnly, setPlusOnly] = useState(true);
  useEffect(() => {
    try { const v = localStorage.getItem("arb.plusOnly"); if (v != null) setPlusOnly(v === "1"); } catch { /* private mode */ }
  }, []);
  const togglePlusOnly = () =>
    setPlusOnly((p) => {
      try { localStorage.setItem("arb.plusOnly", p ? "0" : "1"); } catch { /* private mode */ }
      return !p;
    });
  const [selected, setSelected] = useState<Opportunity | null>(null);
  // Tabs: monitor = one-shot gaps, funding = APR yields, execute = launch
  // trades, control = ops (runs dashboard + risk + kill), assets = balances.
  const [mode, setMode] = useState<"home" | "monitor" | "premium" | "funding" | "listing" | "control" | "assets">("home");
  // 새로고침해도 보던 탭 유지 — 상시 띄워 두는 화면이라 리셋되면 매번 다시 찾아간다.
  useEffect(() => {
    try {
      const v = localStorage.getItem("ac.mode");
      if (v && ["home", "monitor", "premium", "funding", "listing", "control", "assets"].includes(v)) setMode(v as typeof mode);
    } catch { /* private mode */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem("ac.mode", mode); } catch { /* private mode */ }
  }, [mode]);
  // PC: 보드 행 클릭 → 우측 상세(차트·히스토리·실행) 검사창.
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null); // 딥링크용 초기 탭
  // 테마는 다크 고정 — 상시 트레이딩 화면이라 라이트 토글은 2026-09-21 제거.

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
    // Pause polling while the tab is hidden (and refetch immediately on return).
    // The scan keeps running server-side, so nothing is missed — this only stops
    // the browser from fetching a board nobody is looking at.
    let id: ReturnType<typeof setInterval> | null = setInterval(load, 3000);
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        if (id) { clearInterval(id); id = null; }
      } else if (!id) {
        void load();
        id = setInterval(load, 3000);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      if (id) clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
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
  // top immediately instead of waiting for the next scan's ordering.
  //
  // But ranking is decoupled from the 600ms value cadence on purpose. Two coins
  // within noise of each other used to swap places up to 100×/min, and the user
  // clicks 실행 on this board: a row moving between aiming and clicking executes
  // the WRONG trade. So the order is recomputed from a throttled snapshot of the
  // overlay, and frozen entirely while the pointer is over the board.
  const rankOverlay = useRankSnapshot(liveOverlay, RANK_THROTTLE_MS);
  const [orderFrozen, setOrderFrozen] = useState(false);
  const frozenRows = useRef<Opportunity[] | null>(null);
  const rows = useMemo(() => {
    const base = funding || filter === "all" ? pool
      : filter === "locked" ? pool.filter((o) => isLocked(o.gate))
      : pool.filter((o) => o.kind === filter);
    if (funding) return base;
    const rankNet = (o: Opportunity) => rankOverlay[o.id]?.netPct ?? o.netPct;
    const sorted = [...base].sort((a, b) => rankNet(b) - rankNet(a));
    // The +/- filter still uses the LIVE value: hiding a row that just went
    // negative is safe (it can't be mis-clicked), reordering is not.
    const liveNet = (o: Opportunity) => liveOverlay[o.id]?.netPct ?? o.netPct;
    return plusOnly ? sorted.filter((o) => liveNet(o) > 0) : sorted;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- liveOverlay only gates visibility, not order
  }, [pool, filter, funding, rankOverlay, plusOnly, liveOverlay]);
  // Stable handler identities — passing fresh arrows every render defeats
  // React.memo on the rows entirely (they'd re-render 100×/min regardless).
  const onExecute = useCallback((o: Opportunity) => { setOpenRunId(null); setSelected(o); }, []);
  // PC 검사창은 상시 — 행 클릭은 선택만 바꾼다(토글 아님). 닫기(✕)로 숨긴 뒤 행을 누르면 다시 열린다.
  const [inspectHidden, setInspectHidden] = useState(false);
  const onInspect = useCallback((o: Opportunity) => {
    setInspectId(o.id);
    setInspectHidden(false);
  }, []);
  // While hovering, keep the exact row order the user is looking at.
  const displayRows = useMemo(() => {
    if (!orderFrozen) { frozenRows.current = rows; return rows; }
    const frozen = frozenRows.current;
    if (!frozen) return rows;
    // Keep frozen order, but drop rows that no longer exist and append new ones.
    const byId = new Map(rows.map((o) => [o.id, o]));
    const kept = frozen.map((o) => byId.get(o.id)).filter((o): o is Opportunity => !!o);
    const keptIds = new Set(kept.map((o) => o.id));
    // New rows go to the TOP, not the bottom: a freshly-opened top opportunity
    // appended at the end looked like it was ranked last.
    return [...rows.filter((o) => !keptIds.has(o.id)), ...kept];
  }, [rows, orderFrozen]);
  // What the 수익만 filter is hiding right now (for the empty-state message).
  const hiddenNeg = useMemo(() => {
    if (funding || !plusOnly) return 0;
    const base = filter === "all" ? pool : filter === "locked" ? pool.filter((o) => isLocked(o.gate)) : pool.filter((o) => o.kind === filter);
    return base.filter((o) => (liveOverlay[o.id]?.netPct ?? o.netPct) <= 0).length;
  }, [pool, filter, funding, plusOnly, liveOverlay]);
  // KPI는 실데이터만 — mock이 "최고 수익"을 오염시키면 보드를 못 믿게 된다.
  const livePool = useMemo(() => pool.filter((o) => !o.mock), [pool]);
  const positive = livePool.filter((o) => o.netPct > 0).length;
  // "최고"는 지금 잡을 수 있는 것 중에서 — 입출금 닫힘/정지 의심(LSK 49% 같은)이 1등을 차지하면
  // KPI가 거짓말이 된다. 잠긴 갭은 보드에 남되 최고값 집계에서는 뺀다.
  const openPool = useMemo(() => livePool.filter((o) => !isLocked(o.gate)), [livePool]);
  const bestEdge = openPool.length ? Math.max(...openPool.map((o) => o.netPct)) : null;

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
  const flashUntil = useRef<Map<string, number>>(new Map()); // id → expiry ts
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
    // Expire each flash on its OWN schedule, tracked in a ref. The old version
    // armed `setTimeout(..., 4000)` and returned `clearTimeout` as the effect
    // cleanup — but this effect re-runs on every overlay tick (600ms), so React
    // cancelled the timer long before it fired. `flashIds` therefore never
    // cleared and grew for the whole session, and one expiry also wiped flashes
    // armed later.
    const until = Date.now() + FLASH_MS;
    for (const c of crossed) flashUntil.current.set(c.id, until);
    setFlashIds(new Set(flashUntil.current.keys()));
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
  }, [liveOverlay, gapOpps, alertsOn]);
  // One owned sweeper drops expired flashes — independent of the effect above,
  // so its lifetime isn't tied to the 600ms dependency churn.
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [fid, until] of flashUntil.current) {
        if (until <= now) { flashUntil.current.delete(fid); changed = true; }
      }
      if (changed) setFlashIds(new Set(flashUntil.current.keys()));
    }, 1000);
    return () => clearInterval(id);
  }, []);
  // Best live opportunity in the current pool (for the sticky summary bar).
  const best = useMemo(() => {
    let top: { o: Opportunity; net: number } | null = null;
    for (const o of pool) {
      if (o.mock || isLocked(o.gate)) continue; // 잠긴 갭은 알림·하단 바의 "최고"가 아니다
      const net = liveOverlay[o.id]?.netPct ?? o.netPct;
      if (!top || net > top.net) top = { o, net };
    }
    return top;
  }, [pool, liveOverlay]);

  // Background runs + kill switch (survive modal close; shown in the 실행 탭).
  const runsStore = useRuns();
  const runList = Object.values(runsStore.runs).sort((a, b) => b.startedAt - a.startedAt);
  // 코인 상세 패널 — null 닫힘, "" 검색·막힌 코인 목록, "XRP" 그 코인. 어느 탭에서든 연다.
  const [coinSheet, setCoinSheet] = useState<string | null>(null);
  const openCoin = useCallback((b: string) => setCoinSheet(b.trim().toUpperCase()), []);
  const activeRuns = runList.filter((r) => r.phase === "running" || r.phase === "paused").length;
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  // On first client mount, sync the kill flag from the server.
  useEffect(() => {
    fetch("/api/kill").then((r) => r.json()).then((s) => { if (s.killed) void setKillSwitch(true); }).catch(() => {});
  }, []);

  // ── 조건부 자동 진입 (opt-in) — browser must be open (engine is client-side).
  // Enters automatically when a gap meets ALL of: executable (live gates),
   // 브라우저 자동 진입(탭이 열려 있어야 도는 방식)은 2026-09-21 제거 — 서버 쪽 재개 자동 실행(lib/reopen.ts)이 대체한다.

  // 탭 — 한 줄 라벨. 부제(요약·차익·실행…)는 매번 읽히는 소음이라 뺐다.
  const tabBar = (
    <nav style={{ display: "flex", alignItems: "stretch", height: isMobile ? 38 : 46, gap: isMobile ? 0 : 2 }}>
      {([
        { k: "home", label: "대시보드" },
        { k: "monitor", label: "갭" },
        { k: "premium", label: "프리미엄" },
        { k: "funding", label: "펀딩" },
        { k: "listing", label: "상장" },
        { k: "control", label: "운영" },
        { k: "assets", label: "자산·기록" },
      ] as const).map((m) => {
        const active = mode === m.k;
        return (
          <button
            key={m.k}
            type="button"
            onClick={() => {
              // Runs persist in the background store now, so leaving the
              // execute view never kills anything — just close the modal.
              if (m.k !== "monitor") { setSelected(null); setInspectId(null); }
              setMode(m.k);
            }}
            style={{
              border: "none", cursor: "pointer", borderRadius: 0, background: "transparent",
              padding: isMobile ? "0 12px" : "0 12px", flex: "0 0 auto",
              borderBottom: active ? "2px solid var(--brand)" : "2px solid transparent",
              borderTop: "2px solid transparent",
              display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap",
              fontSize: 13, fontWeight: active ? 700 : 500, color: active ? "var(--text)" : "var(--text-mute)",
            }}
          >
            {m.label}
            {m.k === "control" && activeRuns > 0 && (
              <span className="tnum" style={{ fontSize: 10, fontWeight: 700, color: "var(--brand-ink)", background: "var(--brand)", borderRadius: 6, padding: "0 5px", minWidth: 14, textAlign: "center" }}>
                {activeRuns}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );

  return (
    <CoinSheetCtx.Provider value={openCoin}>
    {/* PC 확대 — 인라인 px가 수백 곳이라 base font로는 못 키운다. zoom은
        레이아웃까지 스케일하는 표준 속성(FF 126+)이라 밀도 비율이 유지된다.
        QHD(2560)에서 1.15배 → 콘텐츠 폭 1680이 물리 ~1930px로 렌더. */}
    <main style={{ minHeight: "100dvh", zoom: isMobile ? undefined : 1.15 }}>
      {/* ── Header — PC는 로고·탭·상태·스위치를 한 줄에 (예전엔 헤더 + 두 줄 탭바로 ~110px).
          모바일은 헤더 한 줄 + 가로 스크롤 탭 한 줄. ─────────────────────────── */}
      <header
        style={{
          position: "sticky", top: 0, zIndex: 20,
          background: "var(--header-bg)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 6 : 10, padding: isMobile ? "0 10px" : "0 16px", height: isMobile ? 44 : 46 }}>
          <span style={{ fontWeight: 800, fontSize: 14.5, letterSpacing: "-0.02em", whiteSpace: "nowrap", marginRight: isMobile ? 0 : 10 }}>
            Teum
          </span>
          {!isMobile && tabBar}
          <span style={{ flex: 1 }} />
          <LiveDots status={liveStatus} ages={liveAges} isMobile={isMobile} />
          {/* 모드 — 페이퍼/실주문 하나로. 목업은 거기에 붙인다 (배지 두 개가 따로 놀았다). */}
          {meta && (
            <Pill
              text={meta.dryRun ? (meta.mock ? "페이퍼 · 목업" : "페이퍼") : "실주문"}
              tone={meta.dryRun ? "var(--amber)" : "var(--neg)"}
              soft
            />
          )}
          <button type="button" onClick={() => openCoin("")} title="코인 조회 — 입출금(체인별)·온체인 보유량·지금 갭" style={ICON_BTN}>
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M10.4 10.4 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
          <button type="button" onClick={() => setSettingsOpen(true)} title="설정 — API 키·리스크 한도·알림" style={ICON_BTN}>
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><circle cx="5" cy="4" r="1.6" fill="var(--header-bg)" stroke="currentColor" strokeWidth="1.4" /><circle cx="11" cy="8" r="1.6" fill="var(--header-bg)" stroke="currentColor" strokeWidth="1.4" /><circle cx="6.5" cy="12" r="1.6" fill="var(--header-bg)" stroke="currentColor" strokeWidth="1.4" /></svg>
          </button>
          {/* Kill switch — halt all runs + block new ones. Always reachable.
              항상 "빨간 것"으로 읽혀야 한다 — 평소 붉은 윤곽, 작동 중 붉은 채움. 맨 오른쪽 끝 고정. */}
          <button
            type="button"
            onClick={() => setKillSwitch(!runsStore.killed)}
            title={runsStore.killed ? "킬 스위치 활성 — 눌러서 해제" : "전체 중단 (킬 스위치)"}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              border: `1px solid ${runsStore.killed ? "var(--neg)" : "color-mix(in srgb, var(--neg) 55%, transparent)"}`,
              background: runsStore.killed ? "var(--neg)" : "var(--neg-soft)",
              color: runsStore.killed ? "#fff" : "var(--neg)",
              borderRadius: 6, padding: "0 10px", height: 28, boxSizing: "border-box",
              fontSize: 11, fontWeight: 800, letterSpacing: "0.04em", cursor: "pointer",
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: 6, background: runsStore.killed ? "#fff" : "var(--neg)" }} />
            {runsStore.killed ? "중단됨" : "STOP"}
          </button>
        </div>
        {isMobile && <div className="no-bar" style={{ overflowX: "auto", WebkitOverflowScrolling: "touch", borderTop: "1px solid var(--border)", padding: "0 4px" }}>{tabBar}</div>}
      </header>

      <div style={{ maxWidth: 1680, margin: "0 auto", padding: isMobile ? "10px 10px" : "14px 20px" }}>
        {/* ── Assets: one-line summary on trading tabs; full panel on 자산 ── */}
        {mode === "assets" ? (
          // 자산·기록 — "지금 얼마 있나"(잔고)와 "어떻게 변했나"(손익·끝난 런·기회 복기)를 한 탭에.
          <div style={{ display: "flex", flexDirection: "column", gap: isMobile ? 10 : 14, paddingBottom: 40 }}>
            <AssetsPanel isMobile={isMobile} />
            <PnlCard />
            {runList.some((r) => r.phase === "done") && (
              <RunsDashboard runs={runList.filter((r) => r.phase === "done")} onOpen={(r) => { setOpenRunId(r.id); setSelected(r.opp); }} onClearDone={() => {}} />
            )}
            <EpisodeCard />
            <BacktestCard />
          </div>
        ) : mode === "control" || mode === "listing" || mode === "home" ? null : (
          <AssetSummary isMobile={isMobile} onOpen={() => setMode("assets")} />
        )}

        {/* ── 상장 대시보드: 상장따리 감시 + 온체인 물량 신호 ── */}
        {mode === "listing" && <ListingPanel wide={!isMobile} />}

        {/* ── 대시보드: 시안의 요약 화면을 실데이터로 ── */}
        {mode === "home" && (
          <DashboardPanel
            opps={gapOpps}
            liveOverlay={liveOverlay}
            mobile={isMobile}
            onGoTab={(t) => setMode(t)}
            onExecute={(o) => { setOpenRunId(null); setSelected(o); }}
            onInspect={(o) => { setMode("monitor"); if (!isMobile) { setInspectId(o.id); setInspectHidden(false); } }}
            onOpenSettings={(t) => { setSettingsTab(t ?? null); setSettingsOpen(true); }}
          />
        )}

        {/* ── 프리미엄 차트 — 두 거래소 갭의 시계열(레퍼런스 툴 구성) ── */}
        {mode === "premium" && <PremiumPanel mobile={isMobile} />}

        {/* ── Control tower: runs dashboard + risk limits + tools ── */}
        {mode === "control" && (
          <ControlPanel
            runs={runList}
            killed={runsStore.killed}
            onOpen={(r) => { setOpenRunId(r.id); setSelected(r.opp); }}
            wide={!isMobile}
          />
        )}

        {(mode === "monitor" || mode === "funding") && (<>
        {/* ── Segmented filter (gap modes only — funding is a single strategy) ── */}
        {/* 필터·수익만·알림·스캔 시각을 한 줄에. 예전 KPI 타일 3개(기회·수익 기회·최고)는
            칩 숫자와 하단 바가 이미 말하고 있어 뺐다. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, maxWidth: "100%", flexWrap: isMobile ? "wrap" : "nowrap" }}>
        {!funding && (<>
        <div style={{ overflowX: "auto", minWidth: 0, WebkitOverflowScrolling: "touch" }}>
        <div
          style={{
            display: "inline-flex", gap: 2, padding: 3,
            background: "var(--card)", border: "1px solid var(--border)",
            borderRadius: 6,
          }}
        >
          {(["all", ...GAP_KINDS, "locked"] as const).map((k) => {
            const active = filter === k;
            const label = k === "all" ? "전체" : k === "locked" ? "🔒 대기" : k === "kimchi" ? "김프·역프" : KIND_META[k].label;
            const n = k === "all" ? pool.length : k === "locked" ? pool.filter((o) => isLocked(o.gate)).length : pool.filter((o) => o.kind === k).length;
            return (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                style={{
                  border: "none", cursor: "pointer", borderRadius: 4,
                  padding: "4px 10px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
                  background: active ? "var(--brand-soft)" : "transparent",
                  color: active ? "var(--brand-2)" : "var(--text-dim)",
                  transition: "background 120ms, color 120ms",
                }}
              >
                {k === "kimchi"
                  ? <><span style={{ color: "var(--kimchi)" }}>김프</span><span style={{ color: "var(--text-mute)" }}>·</span><span style={{ color: "var(--rkimchi)" }}>역프</span></>
                  : label}
                <span style={{ color: active ? "var(--brand)" : "var(--text-mute)", marginLeft: 6, fontWeight: 500 }}>
                  {n}
                </span>
              </button>
            );
          })}
        </div>
        </div>
        {/* Always visible (outside the scrollable chip strip) — but styled as the
            strip's sibling: same shell, same chip shape. The old green outline made it
            look like a third kind of control next to the filter group. */}
        <div style={{ display: "inline-flex", padding: 3, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 6, flex: "0 0 auto" }}>
          <button
            type="button"
            onClick={togglePlusOnly}
            title="순수익 마이너스(비용 못 넘는) 갭 숨기기"
            aria-pressed={plusOnly}
            style={{
              border: "none", cursor: "pointer", borderRadius: 4,
              padding: "4px 10px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
              background: plusOnly ? "var(--pos-soft)" : "transparent",
              color: plusOnly ? "var(--pos)" : "var(--text-dim)",
              transition: "background 120ms, color 120ms",
            }}
          >
            수익만
            <span style={{ marginLeft: 6, fontWeight: 500, color: plusOnly ? "var(--pos)" : "var(--text-mute)" }}>{positive}</span>
          </button>
        </div>
        </>)}
        {funding && (
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-dim)" }}>
            펀딩 스프레드 (숏 받는쪽 → 롱 내는쪽) · <span className="tnum">{livePool.length}</span>건
            {bestEdge != null && <> · 최고 <b className="tnum" style={{ color: bestEdge > 0 ? "var(--pos)" : "var(--text)" }}>{pct(bestEdge)}</b> APR</>}
          </span>
        )}
        <span style={{ flex: 1 }} />
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
                borderRadius: 6, padding: "3px 8px", fontSize: 11, fontWeight: 700, cursor: "pointer",
              }}
            >
              <span style={{ width: 5, height: 5, borderRadius: 6, background: alertsOn ? "var(--brand)" : "var(--text-mute)" }} />
              알림 {alertsOn ? "ON" : "OFF"}
            </button>
          )}
          <ScanAge ts={scanTs} live={Object.keys(liveOverlay).length > 0} />
        </span>
        </div>

        {/* Runs live on the 운영 tab now — nudge there when any are active. */}
        {mode === "monitor" && activeRuns > 0 && (
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
            실행 중 {activeRuns}건 — 운영 탭에서 현황 보기 →
          </button>
        )}

        {(() => {
          // PC 검사창 — inspectId의 최신 스냅샷(스캔마다 갱신)을 우측에.
          // 선택이 없거나 사라졌으면 최상단 행 — 우측이 빈 채로 남지 않게 (선택 고정은 아래 effect).
          const inspectOpp = !isMobile && !funding && !inspectHidden
            ? ((inspectId ? gapOpps.find((o) => o.id === inspectId) : null) ?? displayRows[0] ?? null)
            : null;
          const board = (
            <CockpitBoard
              rows={displayRows} loading={loading}
              onExecute={onExecute}
              onFreezeOrder={setOrderFrozen}
              mobile={isMobile} showExecute={!funding} live={liveOverlay} flash={flashIds}
              onInspect={!isMobile && !funding ? onInspect : undefined}
              narrow={!isMobile && !funding && !inspectHidden && displayRows.length > 0}
              inspectedId={inspectHidden ? null : (inspectId && gapOpps.some((o) => o.id === inspectId) ? inspectId : displayRows[0]?.id ?? null)}
              lastColLabel={funding ? "다음 정산" : undefined}
              emptyText={hiddenNeg > 0
                ? `비용 넘는 갭 없음 — 마이너스 ${hiddenNeg}건 숨김${bestEdge != null ? ` (최고 ${bestEdge.toFixed(2)}%)` : ""} · '수익만' 해제 시 전체 표시`
                : undefined}
            />
          );
          if (!inspectOpp) return board;
          return (
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 500px", gap: 12, alignItems: "start" }}>
              <div style={{ minWidth: 0 }}>{board}</div>
              <div style={{ position: "sticky", top: 58 }}>
                <GapInspect
                  opp={inspectOpp}
                  live={liveOverlay[inspectOpp.id]}
                  onExecute={(o) => { setOpenRunId(null); setSelected(o); }}
                  onClose={() => setInspectHidden(true)}
                />
              </div>
            </div>
          );
        })()}

        <p style={{ color: "var(--text-mute)", fontSize: 11, marginTop: 10, paddingBottom: isMobile ? 56 : 24 }}>
          {funding
            ? "APR = 8h 정규화 펀딩 스프레드의 연환산 (바낸·바이비트는 다음 주기 예측). 정산 시점에만 지급 — 카운트다운 참고. 실행 배선 전, 모니터링 전용."
            : `순수익 = 총차익 − 예상 왕복비용${meta?.calPct ? ` − 자동보정 ${meta.calPct.toFixed(2)}%p (실거래 ${meta.calSamples}건 누수 반영)` : ""}. 김프·크로스(거래소 갭)는 실데이터 연동, CEX-DEX는 목업 스텁입니다.`}
        </p>
        </>)}
      </div>

      {/* ── Sticky summary bar (var1) — best live opportunity at a glance ── */}
      {/* PC는 뺀다 — 갭 탭은 표·검사창이, 대시보드는 기회 카드가 이미 같은 걸 보여준다. */}
      {isMobile && mode !== "assets" && best && (
        <div
          style={{
            position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 30,
            display: "flex", alignItems: "center", gap: 10,
            padding: "9px 14px",
            background: "var(--header-bg)",
            borderTop: "1px solid var(--border)",
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: 6, background: best.net > 0 ? "var(--pos)" : "var(--text-mute)" }} />
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
          {mode === "monitor" && best.o.executable && (
            <button
              type="button"
              onClick={() => setSelected(best.o)}
              style={{
                border: "none", borderRadius: "var(--radius-sm)", padding: "6px 14px",
                background: "var(--brand-grad)", color: "var(--brand-ink)",
                fontWeight: 700, fontSize: 12, cursor: "pointer",
              }}
            >
              실행
            </button>
          )}
        </div>
      )}

      {selected && (
        <ExecuteModal opp={selected} initialRunId={openRunId} onClose={() => { setSelected(null); setOpenRunId(null); }} isMobile={isMobile} />
      )}
      {/* 우하단 실행 독 — 모달을 접어도(닫아도) 진행 중인 런이 시야에 남는다 */}
      <RunDock
        runs={runList}
        hidden={!!selected}
        isMobile={isMobile}
        onOpen={(r) => { setOpenRunId(r.id); setSelected(r.opp); }}
        onMore={() => setMode("control")}
      />
      {settingsOpen && <SettingsModal onClose={() => { setSettingsOpen(false); setSettingsTab(null); }} initialTab={settingsTab ?? undefined} />}
      {coinSheet != null && (
        <CoinSheet
          base={coinSheet}
          opps={opps}
          mobile={isMobile}
          onClose={() => setCoinSheet(null)}
          onOpenCoin={openCoin}
          onInspect={(o) => { setCoinSheet(null); setMode("monitor"); if (!isMobile) { setInspectId(o.id); setInspectHidden(false); } }}
        />
      )}
    </main>
    </CoinSheetCtx.Provider>
  );
}

// ── KPI tile ──────────────────────────────────────────────────────────────────
