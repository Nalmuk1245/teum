"use client";

// 대시보드 탭 — 글래스 시안의 요약 화면을 실데이터로.
// 구성: 감시 상태(감지 소스·프로세스) · 리스크 현황(게이지) · KPI 4장(세션 미니바) ·
// 자금 배분(세그먼트 바) · 실시간 기회. 전부 기존 API에서 읽는다.

import React from "react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Opportunity, Portfolio } from "@/lib/types";
import { pct, usd, dur } from "@/lib/format";
import type { LiveGap } from "@/lib/useLivePrices";
import { vlabel, Spark, oppKindLabel, kindLabel } from "./cockpit-ui";
import { inFlightUsd } from "@/lib/runStore";
import { srcVerdict } from "@/lib/watchVerdict";
import type { RiskState } from "./ControlPanel";
import { useCoinSheet } from "./coinSheetCtx";
import { isLocked } from "@/lib/gateState";

const CAP: React.CSSProperties = { fontSize: 10, letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--text-mute)" };
const CARD: React.CSSProperties = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", boxShadow: "var(--shadow-sm)"  }
// 핵심 카드(실시간 기회) — 한 단계 밝은 표면·강한 테두리·깊은 그림자로 격자에서 떠오르게.
const CARD_HERO: React.CSSProperties = { ...CARD, background: "var(--card-2)", border: "1px solid var(--border-strong)", boxShadow: "var(--shadow)" };
// 카드 우상단 "… →" 이동 링크 — 대시보드 전체가 같은 모양을 쓴다.
const LINK: React.CSSProperties = { border: "none", background: "transparent", color: "var(--brand-2)", fontSize: 11.5, fontWeight: 600, cursor: "pointer", padding: 0 };
// 응답이 이 시간 넘게 안 오면 "불러오는 중"이 아니라 "응답 없음"이다.
const STALE_MS = 12_000;

// 세션 동안 쌓는 미니 바차트 (숫자에 맥락 부여 — 시안의 vertical bars)
function MiniBars({ series, color }: { series: number[]; color?: string }) {
  const max = Math.max(...series, 1);
  const view = series.slice(-14);
  return (
    <div
      title={view.length < 2 ? "세션 추이 — 스캔이 갱신될 때마다 8초 간격으로 쌓입니다" : undefined}
      style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 34, marginTop: 10 }}
    >
      {view.length < 2 ? (
        // 카드 4장에 같은 "수집 중…" 문장을 반복하지 않는다 — 빈 자리엔 자리표시 바만.
        Array.from({ length: 14 }, (_, i) => (
          <span key={i} style={{ flex: 1, borderRadius: 2, height: 3, background: "var(--border)" }} />
        ))
      ) : view.map((v, i) => (
        <span
          key={i}
          style={{
            flex: 1, borderRadius: 2, minHeight: 2,
            height: `${Math.max(6, (v / max) * 100)}%`,
            background: i === view.length - 1 ? (color ?? "var(--pos)") : "var(--pos-soft)",
            opacity: i === view.length - 1 ? 1 : 0.9,
          }}
        />
      ))}
    </div>
  );
}

function Kpi({ label, value, chip, sub, series, tone, compact }: {
  label: string; value: string; chip?: string; sub?: string; series: number[]; tone?: string;
  /** 2-column mobile grid — the card is ~130px wide, so the big number has to
   *  shrink or it pushes its grid track past the viewport. */
  compact?: boolean;
}) {
  return (
    <div style={{ ...CARD, padding: compact ? "12px 12px 10px" : "14px 16px 12px", minWidth: 0, overflow: "hidden" }}>
      <div style={{ fontSize: compact ? 11.5 : 12.5, color: "var(--text-dim)", fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</div>
      <div style={{ marginTop: compact ? 6 : 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
        <span
          className="tnum"
          style={{
            fontSize: compact ? 19 : 28, fontWeight: 700, letterSpacing: "-0.02em",
            color: tone ?? "var(--text)",
            // Last-resort break: a very large P&L must wrap inside the card
            // rather than widen the track and scroll the whole page sideways.
            minWidth: 0, overflowWrap: "anywhere",
          }}
        >
          {value}
        </span>
        {chip && <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 999, padding: "2px 8px", background: "var(--pos-soft)", color: "var(--pos)" }}>{chip}</span>}
      </div>
      {sub && (
        <div style={{ marginTop: 3, fontSize: compact ? 10.5 : 11, color: "var(--text-mute)", minWidth: 0, overflowWrap: "anywhere" }}>{sub}</div>
      )}
      <MiniBars series={series} color={tone} />
    </div>
  );
}

export function DashboardPanel({ opps, liveOverlay, onGoTab, onExecute, onInspect, onOpenSettings, mobile }: {
  opps: Opportunity[];
  mobile?: boolean;
  liveOverlay: Record<string, LiveGap>;
  onGoTab: (tab: "monitor" | "funding" | "listing" | "control" | "assets") => void;
  onExecute: (o: Opportunity) => void;
  /** 행 클릭 → 갭 보드의 그 기회 검사창으로 점프 (PC), 모바일은 보드 탭 이동. */
  onInspect?: (o: Opportunity) => void;
  /** ⚙ 설정 모달 열기 — "한도 조정 →"은 인자 없이, 감시 카드 조치는 탭 지정. */
  onOpenSettings?: (tab?: "keys" | "risk" | "alerts" | "tools") => void;
}) {
  const [risk, setRisk] = useState<RiskState | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [trades, setTrades] = useState<{ base: string; kind: string; route: string; realizedPnlUsd: number | null; dryRun: boolean; ts: number }[]>([]);
  const [listWatch, setListWatch] = useState<{ plays: { base: string; venue: string; opensAt?: number; opened: boolean }[]; watching: boolean } | null>(null);
  // 감시 상태 카드 데이터 — 전부 기존 API에서 읽는다.
  const [health, setHealth] = useState<{ ok: boolean; scanAgeSec: number | null; killed: boolean; dryRun: boolean; loopLagMs?: { worstMs: number; worstAgoSec: number | null }; srcHeat?: Record<string, { h: number; ok: number; n: number }[]> } | null>(null);
  const [watch, setWatch] = useState<{ annOkAgoSec: number | null; annBlocked: boolean; annLagP50Ms?: number | null; mktOkAgoSec: number | null; tgConfigured: boolean; tgOkAgoSec: number | null } | null>(null);
  const [gatesBlocked, setGatesBlocked] = useState<number | null>(null);
  /** 키가 없어 일부 거래소 상태를 못 본 상태 — "중단 없음"이라고 단정할 수 없다. */
  const [gatesPartial, setGatesPartial] = useState(false);
  const [tradeCount, setTradeCount] = useState<number | null>(null);
  const [mock, setMock] = useState(true);
  // 잔고 응답을 한 번이라도 받았나 — 데모 배너는 "키가 없다"를 확인한 뒤에만 띄운다.
  const [portfolioLoaded, setPortfolioLoaded] = useState(false);
  // 서버가 STALE_MS 안에 아무 응답도 안 줬다 — "불러오는 중"을 계속 보여주면 거짓말이다.
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const load = () => {
      fetch("/api/risk", { cache: "no-store" }).then((r) => r.json()).then(setRisk).catch(() => {});
      fetch("/api/balances", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j.portfolio) { setPortfolio(j.portfolio); setMock(!!j.portfolio.mock); } }).catch(() => {}).finally(() => setPortfolioLoaded(true));
      fetch("/api/health", { cache: "no-store" }).then((r) => r.json()).then(setHealth).catch(() => {});
    };
    load();
    const id = setInterval(load, 15_000);
    const sid = setTimeout(() => setStale(true), STALE_MS);
    const loadFeeds = () => {
      fetch("/api/trades", { cache: "no-store" }).then((r) => r.json()).then((j) => { setTradeCount(j.stats?.count ?? 0); setTrades((j.trades ?? []).slice(0, 6)); }).catch(() => {});
      fetch("/api/listings", { cache: "no-store" }).then((r) => r.json()).then((j) => {
        const plays = (j.listings ?? []).map((l: { base: string; venue: string; opensAt?: number; opened: boolean }) => ({ base: l.base, venue: l.venue, opensAt: l.opensAt, opened: l.opened }));
        setListWatch({ plays, watching: (j.watch?.plays ?? 0) >= 0 });
        if (j.watch) setWatch(j.watch);
      }).catch(() => {});
    };
    loadFeeds();
    const fid = setInterval(loadFeeds, 20_000);
    // 입출금 중단 수 — 느리게 변하는 값이라 5분이면 충분하다.
    const loadGates = () => fetch("/api/gates", { cache: "no-store" }).then((r) => r.json()).then((j) => {
      const rows = (j.rows ?? []) as { venues: Record<string, { deposit: boolean; withdraw: boolean } | null> }[];
      setGatesBlocked(rows.filter((r) => Object.values(r.venues).some((s) => s && (!s.deposit || !s.withdraw))).length);
      setGatesPartial((j.missing?.length ?? 0) > 0);
    }).catch(() => {});
    loadGates();
    const gid = setInterval(loadGates, 5 * 60_000);
    return () => { clearInterval(id); clearInterval(fid); clearInterval(gid); clearTimeout(sid); };
  }, []);
  // 응답이 오면 stale은 무의미 — 이후 폴링이 끊기는 건 health.scanAgeSec가 잡는다.
  const loading = (!health || !watch) && !stale;
  const pendingText = stale ? "응답 없음" : "불러오는 중…";

  // 실데이터 지표 (mock 제외)
  const live = useMemo(() => opps.filter((o) => !o.mock && o.kind !== "funding-basis"), [opps]);
  const liveNet = useCallback(
    (o: Opportunity) => liveOverlay[o.id]?.netPct ?? o.netPct,
    [liveOverlay],
  );
  // Memoized: this is the DEFAULT tab, and `positive`/`best` each walked the
  // whole list on every render — 600ms overlay ticks made that ~100×/min, twice.
  const positive = useMemo(() => live.filter((o) => liveNet(o) > 0).length, [live, liveNet]);
  // 잠긴 갭(닫힘·정지 의심)은 "최고 순수익" 후보에서 뺀다 — 잡을 수 없는 47%가 KPI를 차지하면 안 된다.
  const best = useMemo(() => {
    const open = live.filter((o) => !isLocked(o.gate));
    return open.length ? open.reduce((top, o) => (liveNet(o) > liveNet(top) ? o : top)) : null;
  }, [live, liveNet]);
  const bestNet = best ? liveNet(best) : null;
  const pnl = risk?.realizedPnlUsd ?? 0;

  // 세션 히스토리 — 스캔이 갱신될 때마다 샘플 (미니바 데이터)
  const hist = useRef<{ opp: number[]; posi: number[]; best: number[]; pnl: number[] }>({ opp: [], posi: [], best: [], pnl: [] });
  const lastTs = useRef(0);
  // Sampling happens in an EFFECT, not during render. Mutating a ref in the
  // render body double-pushed under StrictMode's double-invoke (duplicated
  // mini-bar points) and, because the array identity never changed, made the
  // charts impossible to memoize.
  const sample = { n: live.length, positive, bestNet: bestNet ?? 0, pnl };
  const sampleRef = useRef(sample);
  sampleRef.current = sample;
  useEffect(() => {
    const id = setInterval(() => {
      const s = sampleRef.current;
      if (!s.n) return;
      if (Date.now() - lastTs.current < 8000) return;
      lastTs.current = Date.now();
      const h = hist.current;
      h.opp.push(s.n); h.posi.push(s.positive);
      h.best.push(s.bestNet); h.pnl.push(s.pnl);
      for (const k of Object.keys(h) as (keyof typeof h)[]) if (h[k].length > 48) h[k].shift();
    }, 2000);
    return () => clearInterval(id);
  }, []);

  // 리스크 현황 — 사용률의 최대치 기준 여유
  const inFlight = inFlightUsd();
  const expoUse = risk && risk.maxInFlightUsd > 0 ? (inFlight / risk.maxInFlightUsd) * 100 : 0;
  const lossUse = risk && risk.maxDailyLossUsd > 0 ? (Math.max(0, -pnl) / risk.maxDailyLossUsd) * 100 : 0;
  const headroom = Math.max(0, Math.round(100 - Math.max(expoUse, lossUse)));
  // 한도가 하나도 없으면 "여유 100%"는 거짓 안심이다 — 게이지를 죽이고 미설정이라고 말한다.
  const riskConfigured = !!risk && (risk.maxInFlightUsd > 0 || risk.maxDailyLossUsd > 0 || risk.maxPerTradeUsd > 0);
  const gaugeTone = !riskConfigured ? "var(--text-mute)" : headroom < 30 ? "var(--neg)" : headroom < 60 ? "var(--amber)" : "var(--pos)";

  // 자금 배분 — 가용(현금) / 포지션(코인) / 전송 중(개인지갑 + 인플라이트)
  const cash = (portfolio?.venues ?? []).reduce((s, v) => s + v.cashUsd, 0);
  const coins = (portfolio?.venues ?? []).reduce((s, v) => s + v.coins.reduce((a, c) => a + c.usdValue, 0), 0);
  const transit = (portfolio?.wallet?.totalUsd ?? 0) + inFlight;
  const totalCap = cash + coins + transit;
  const p = (n: number) => (totalCap > 0 ? Math.round((n / totalCap) * 100) : 0);

  // 감시 상태 — "지금 감시가 제대로 돌고 있나"를 소스별로.
  // 이 앱의 가치는 상장 감지 지연(ms)인데, 감지 소스가 죽어도 화면은 조용하다 —
  // 그 침묵을 깨는 카드다. 상태는 3단계: ok(정상) / warn(고장·조치 필요) / off(미설정·대기).
  type SrcState = "ok" | "warn" | "off";
  type SrcSec = "감지 소스" | "시스템";
  type SrcRow = { label: string; sec: SrcSec; state: SrcState; text: string; action?: { label: string; onClick: () => void }; title?: string; heatKey?: string };
  // 스캔 재시작 — 멈춘 루프의 latch를 서버에서 강제 해제. 결과는 다음 health 폴링이 보여준다.
  const [kicking, setKicking] = useState(false);
  const kickScan = async () => {
    setKicking(true);
    try { await fetch("/api/scan-kick", { method: "POST" }); } catch { /* 다음 폴링이 진실 */ }
    setTimeout(() => setKicking(false), 3000);
  };
  const srcRows: SrcRow[] = (() => {
    const rows: SrcRow[] = [];
    const agoTxt = (s: number | null) => (s == null ? "수신 없음" : s < 90 ? `${s}초 전` : `${Math.round(s / 60)}분 전`);
    rows.push(!health
      ? { heatKey: "scan", label: "스캔", sec: "시스템", state: stale ? "warn" : "off", text: pendingText }
      : health.scanAgeSec == null
        // 방금 기동해 첫 스캔이 아직 안 온 상태 — 고장이 아니다.
        ? { heatKey: "scan", label: "스캔", sec: "시스템", state: "off", text: "첫 스캔 대기" }
        : health.scanAgeSec < 60
          ? { heatKey: "scan", label: "스캔", sec: "시스템", state: "ok", text: `${health.scanAgeSec}초 전` }
          : { heatKey: "scan", label: "스캔", sec: "시스템", state: "warn", text: `정지 ${agoTxt(health.scanAgeSec)}`, action: { label: kicking ? "재시작 중…" : "재시작", onClick: () => void kickScan() } });
    // 상태 판정식은 lib/watchVerdict.ts 하나를 서버(24h 스트립)와 공유한다 —
    // 따로 적어두면 점은 초록인데 바로 아래 스트립 칸은 빨강인 자기모순이 난다.
    const wi = { ...(watch ?? {}), lag: health?.loopLagMs ?? null };
    const annV = watch ? srcVerdict("ann", wi) : null;
    rows.push(!watch ? { heatKey: "ann", label: "업비트 공지", sec: "감지 소스", state: stale ? "warn" : "off", text: pendingText }
      : watch.annBlocked ? { heatKey: "ann", label: "업비트 공지", sec: "감지 소스", state: "warn", text: "차단 (비KR IP)", title: "업비트 공지 API는 KR IP에서만 응답합니다 — KR 박스 이전 시 해소" }
      : watch.annOkAgoSec == null ? { heatKey: "ann", label: "업비트 공지", sec: "감지 소스", state: "off", text: "수신 없음" }
      : {
          heatKey: "ann", label: "업비트 공지", sec: "감지 소스", state: annV ?? "off",
          text: `${annV === "warn" ? "멈춤 " : ""}${agoTxt(watch.annOkAgoSec)}${watch.annLagP50Ms != null ? ` · 감지 p50 ${(watch.annLagP50Ms / 1000).toFixed(1)}s` : ""}`,
        });
    const mktV = watch ? srcVerdict("mkt", wi) : null;
    rows.push(!watch ? { heatKey: "mkt", label: "마켓 diff", sec: "감지 소스", state: stale ? "warn" : "off", text: pendingText }
      : watch.mktOkAgoSec == null ? { heatKey: "mkt", label: "마켓 diff", sec: "감지 소스", state: "off", text: "수신 대기" }
      : { heatKey: "mkt", label: "마켓 diff", sec: "감지 소스", state: mktV ?? "off", text: mktV === "warn" ? `멈춤 (${agoTxt(watch.mktOkAgoSec)})` : agoTxt(watch.mktOkAgoSec) });
    const tgV = watch ? srcVerdict("tg", wi) : null;
    rows.push(!watch ? { heatKey: "tg", label: "텔레그램 감지", sec: "감지 소스", state: stale ? "warn" : "off", text: pendingText }
      : !watch.tgConfigured ? { heatKey: "tg", label: "텔레그램 감지", sec: "감지 소스", state: "off", text: "미설정", action: onOpenSettings ? { label: "설정", onClick: () => onOpenSettings("alerts") } : undefined }
      : watch.tgOkAgoSec == null ? { heatKey: "tg", label: "텔레그램 감지", sec: "감지 소스", state: "off", text: "수신 대기" }
      : { heatKey: "tg", label: "텔레그램 감지", sec: "감지 소스", state: tgV ?? "off", text: tgV === "warn" ? `조용함 (${agoTxt(watch.tgOkAgoSec)})` : agoTxt(watch.tgOkAgoSec) });
    const lag = health?.loopLagMs;
    const procV = srcVerdict("proc", wi);
    rows.push(!lag ? { heatKey: "proc", label: "프로세스", sec: "시스템", state: !health && stale ? "warn" : "off", text: health ? "측정 대기" : pendingText }
      : procV === "warn"
        ? { heatKey: "proc", label: "프로세스", sec: "시스템", state: "warn", text: `멈춤 ${Math.round(lag.worstMs)}ms${lag.worstAgoSec != null ? ` (${agoTxt(lag.worstAgoSec)})` : ""} — 메모리 확인` }
        : { heatKey: "proc", label: "프로세스", sec: "시스템", state: "ok", text: lag.worstMs >= 400 ? `회복됨 (최근 멈춤 ${Math.round(lag.worstMs)}ms)` : "정상 (10분 내 멈춤 없음)" });
    // 입출금 중단은 "우리 감시가 고장났나"가 아니라 시장 상태라 리스크 카드로 옮겼다.
    return rows;
  })();
  // 24h 업타임 스트립 셀 — 시간당 ok비율을 색으로, 표본 없는 시간은 빈 칸
  // (스캔이 죽어 있던 시간도 빈 칸으로 남는다 — 그것도 정보다).
  const heatCells = (src: string) => {
    const ring = health?.srcHeat?.[src];
    if (!ring) return null;
    const now = Date.now();
    const nowH = Math.floor(now / 3600_000);
    const byH = new Map(ring.map((c) => [c.h, c]));
    return Array.from({ length: 24 }, (_, i) => {
      const h = nowH - 23 + i;
      const c = byH.get(h);
      const hourLabel = `${new Date(h * 3600_000).getHours()}시`;
      if (!c || !c.n) return { color: "var(--card-3)", title: `${hourLabel} — 기록 없음` };
      // scan은 틱 존재 자체가 신호(표본은 항상 ok=1) — ok비율이 아니라
      // "그 시간에 틱이 얼마나 돌았나"(3초 주기 기준 커버리지)로 판정해야
      // 30분 죽었던 시간이 초록으로 안 보인다.
      let r = c.ok / c.n;
      if (src === "scan") {
        const hourMs = h === nowH ? now - h * 3600_000 : 3600_000;
        r = Math.min(1, c.n / Math.max(1, hourMs / 3000));
      }
      return {
        color: r >= 0.98 ? "var(--pos)" : r >= 0.8 ? "var(--amber)" : "var(--neg)",
        title: `${hourLabel} — 가동 ${(r * 100).toFixed(0)}%`,
      };
    });
  };
  const warnCount = srcRows.filter((r) => r.state === "warn").length;
  const unknownCount = srcRows.filter((r) => r.state === "off").length;

  // 스트림 — 상위 6개. `liveOverlay`가 의존성이라 600ms마다 무조건 재정렬됐다.
  // 표시는 소수 2자리이므로 그 해상도로 스냅샷을 떠서 정렬 빈도를 낮춘다.
  const rankKey = useMemo(
    () => live.map((o) => `${o.id}:${Math.round(liveNet(o) * 100)}:${o.gate ?? ""}`).join("|"),
    [live, liveNet],
  );
  // PC는 전폭 카드라 10행 — 모바일은 첫 화면 카드여서 6행 유지.
  // 플러스만: 상위 N개를 그냥 자르면 플러스가 N개보다 적을 때 마이너스가 목록을
  // 채운다 — 이 카드는 "지금 먹을 게 있나"라서 비용 못 넘는 행은 노이즈다.
  // (스캔/히스토리는 마이너스도 계속 기록한다 — 지속성·σ·복기가 그걸 먹는다.
  //  전체 우주는 갭 보드에서 "수익만" 토글을 끄면 보인다.)
  const stream = useMemo(
    () => [...live].filter((o) => liveNet(o) > 0 && !isLocked(o.gate)).sort((a, b) => liveNet(b) - liveNet(a)).slice(0, mobile ? 6 : 10),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rankKey collapses live+overlay to display precision
    [rankKey, mobile],
  );
  // 입출금 닫힘/정지 의심인데 갭은 살아 있는 것 — 지우지 않고 접어 둔다. 열리면 위로 올라온다.
  const waiting = useMemo(
    () => [...live].filter((o) => liveNet(o) > 0 && isLocked(o.gate)).sort((a, b) => liveNet(b) - liveNet(a)).slice(0, 8),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rankKey],
  );
  const [waitingOpen, setWaitingOpen] = useState(false);
  const openCoin = useCoinSheet();

  const secHd = (title: string, right?: React.ReactNode) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "13px 16px", borderBottom: "1px solid var(--border)" }}>
      <span style={{ fontSize: 13.5, fontWeight: 700 }}>{title}</span>
      <span style={{ flex: 1 }} />
      {right}
    </div>
  );

  // ── 자금 배분 — 모바일: compact 카드, PC: 최상단 슬림 스트립 ──
  // 잔고는 가장 느리게 변하는 정보라 두꺼운 히어로 카드를 줄 이유가 없다.
  // 한 줄 스트립으로 최상단에 두면 "얼마 있고 어디에 있나"가 첫 눈에 들어오고,
  // 감시 상태·실시간 기회(실제 용건)는 스크롤 없이 그대로 보인다.
  const segBar = (h: number) => (
    <div style={{ display: "flex", height: h, gap: 4 }}>
      {p(cash) > 0 && <div title={`가용 ${usd(cash)}`} style={{ width: `${p(cash)}%`, background: "var(--brand)", opacity: 0.75, borderRadius: 6 }} />}
      {p(coins) > 0 && <div title={`포지션 ${usd(coins)}`} style={{ width: `${p(coins)}%`, background: "var(--amber)", borderRadius: 6 }} />}
      {p(transit) > 0 && <div title={`전송 중 ${usd(transit)}`} style={{ width: `${Math.max(2, p(transit))}%`, background: "var(--pos)", borderRadius: 6 }} />}
    </div>
  );
  const legend = (fs: number, gap: number) => (
    <div style={{ display: "flex", gap, fontSize: fs, color: "var(--text-dim)", flexWrap: "wrap" }}>
      <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 999, background: "var(--brand)", opacity: 0.75, marginRight: 6 }} />가용 <b className="tnum">{usd(cash)}</b> · {p(cash)}%</span>
      <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 999, background: "var(--amber)", marginRight: 6 }} />포지션 <b className="tnum">{usd(coins)}</b> · {p(coins)}%</span>
      <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 999, background: "var(--pos)", marginRight: 6 }} />전송 중 <b className="tnum">{usd(transit)}</b> · {p(transit)}%</span>
    </div>
  );
  const fundsCardMobile = (
    <div style={{ ...CARD, padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>자금 배분</span>
        {mock && <span style={{ fontSize: 9.5, fontWeight: 700, color: "var(--sky)", border: "1px solid var(--sky)", borderRadius: 999, padding: "1px 7px" }}>데모</span>}
        <span className="tnum" style={{ fontSize: 15, fontWeight: 700, marginLeft: 2 }}>{usd(totalCap)}</span>
        <button type="button" onClick={() => onGoTab("assets")} style={{ ...LINK, marginLeft: "auto" }}>상세 →</button>
      </div>
      <div style={{ marginTop: 10 }}>{segBar(12)}</div>
      <div style={{ marginTop: 8 }}>{legend(10.5, 12)}</div>
    </div>
  );
  const fundsStrip = (
    <div style={{ ...CARD, padding: "12px 18px", display: "flex", alignItems: "center", gap: 20, marginBottom: 12 }}>
      <div style={{ flex: "0 0 auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span className="tnum" style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em" }}>{usd(totalCap)}</span>
          {mock && <span style={{ fontSize: 9.5, fontWeight: 700, color: "var(--sky)", border: "1px solid var(--sky)", borderRadius: 999, padding: "1px 7px" }}>데모</span>}
        </div>
        <div style={{ marginTop: 2, fontSize: 10.5, color: "var(--text-mute)" }}>
          총자본 · 글로벌 {portfolio ? Math.round(portfolio.skewPct) : "—"} : KR {portfolio ? 100 - Math.round(portfolio.skewPct) : "—"}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {segBar(14)}
        <div style={{ marginTop: 7 }}>{legend(11.5, 16)}</div>
      </div>
      <button type="button" onClick={() => onGoTab("assets")} style={{ ...LINK, flex: "0 0 auto" }}>상세 →</button>
    </div>
  );

  // ── 실시간 기회 카드 ──
  const streamCard = (
    <div style={{ ...CARD_HERO, padding: 0, minWidth: 0 }}>
      {secHd("실시간 기회", (
        <button type="button" onClick={() => onGoTab("monitor")} style={LINK}>갭 보드 →</button>
      ))}
      {stream.length === 0 ? (
        <div style={{ padding: "22px 16px", fontSize: 12.5, color: "var(--text-mute)" }}>
          {live.length > 0
            ? `지금은 비용을 넘는 기회 없음 — ${live.length}건 감시 중`
            : portfolioLoaded && mock
              ? "데모 모드 — 실데이터 기회는 거래소 키를 넣어야 잡힙니다."
              : "스캔 중 — 실데이터 기회가 잡히면 여기 표시됩니다."}
        </div>
      ) : (
        <div style={{ padding: "2px 16px 8px" }}>
          {stream.map((o) => {
            const net = liveNet(o);
            const held = o.persistence?.heldSec ?? 0;
            const [buy, sell] = o.legs;
            return (
              <div key={o.id} onClick={onInspect ? () => onInspect(o) : undefined}
                style={{ display: "grid", gridTemplateColumns: mobile ? "minmax(0,1fr) auto auto" : "minmax(0,1.4fr) auto auto auto auto auto", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid var(--border)", fontSize: 12.5, cursor: onInspect ? "pointer" : undefined }}>
                <span style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{o.base}</div>
                  <div style={{ fontSize: 10.5, color: "var(--text-mute)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {o.kind === "kimchi" ? oppKindLabel(o) : o.kind === "cross-cex" ? "크로스" : "CEX-DEX"} · {buy ? vlabel(buy.venue) : "?"} → {sell ? vlabel(sell.venue) : "?"}
                  </div>
                </span>
                {/* 30분 추이 — 전폭 승격으로 생긴 자리 (모바일은 3열 유지) */}
                {!mobile && <Spark data={o.spark} costPct={o.costPct} />}
                <span className="tnum" style={{ fontWeight: 700, color: net > 0 ? "var(--pos)" : "var(--neg)" }}>{pct(net)}</span>
                {/* 잡을 수 있는 돈 — 사다리가 있으면 총 이익, 없으면 최우선호가 한도 */}
                {!mobile && (
                  <span className="tnum" title={o.depth ? `순수익>0 규모 ${usd(o.depth.maxSizeUsd)} · 총 이익 ${usd(o.depth.profitUsd)}` : "최우선호가 한 칸 한도"} style={{ fontSize: 11, color: o.depth ? "var(--text-dim)" : "var(--text-mute)", textAlign: "right" }}>
                    {o.depth ? <>{usd(o.depth.maxSizeUsd)} · <b style={{ color: "var(--pos)" }}>+{usd(o.depth.profitUsd)}</b></> : o.notionalCapUsd != null ? usd(o.notionalCapUsd) : "—"}
                  </span>
                )}
                {/* 지속 열은 모바일에서 접는다 — 3열 템플릿에 자식이 4개면
                    마지막이 다음 줄로 밀려 레이아웃이 어긋난다. */}
                {!mobile && (
                  <span className="tnum" style={{ fontSize: 11, color: "var(--text-mute)" }}>{held > 0 ? dur(held) : "신규"}</span>
                )}
                <span
                  onClick={(e) => { e.stopPropagation(); if (o.executable) onExecute(o); }}
                  style={{
                    fontSize: 10.5, fontWeight: 700, borderRadius: 999, padding: "3px 11px", justifySelf: "end",
                    cursor: o.executable ? "pointer" : "default",
                    background: o.executable ? "var(--pos-soft)" : o.transfer?.blocked ? "transparent" : "var(--card-3)",
                    color: o.executable ? "var(--pos)" : o.transfer?.blocked ? "var(--neg)" : "var(--text-mute)",
                    border: o.transfer?.blocked ? "1px solid var(--neg-soft)" : "none",
                  }}
                >
                  {o.executable ? "Live" : o.transfer?.blocked ? "Closed" : "Wait"}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {waiting.length > 0 && (
        <div style={{ borderTop: "1px solid var(--border)" }}>
          <button type="button" onClick={() => setWaitingOpen((v) => !v)}
            style={{ width: "100%", textAlign: "left", background: "transparent", border: "none", cursor: "pointer", padding: "9px 16px", fontSize: 12, color: "var(--amber)", fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
            <span>🔒 입출금 열리면 기회 {waiting.length}건</span>
            {!mobile && <span style={{ color: "var(--text-mute)", fontWeight: 400 }}>— 닫힘·정지 의심 갭. 열리는 순간 위로 올라오고 알림이 갑니다</span>}
            <span style={{ marginLeft: "auto", color: "var(--text-mute)" }}>{waitingOpen ? "접기" : "펼치기"}</span>
          </button>
          {waitingOpen && (
            <div style={{ padding: "0 16px 8px" }}>
              {waiting.map((o) => {
                const [buy, sell] = o.legs;
                return (
                  <div key={o.id} onClick={() => openCoin(o.base)} title="코인 상세 — 체인별 입출금·온체인 보유량"
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: "1px solid var(--border)", fontSize: 12, cursor: "pointer", opacity: 0.85 }}>
                    <span style={{ fontWeight: 700 }}>{o.base}</span>
                    <span style={{ fontSize: 10.5, color: "var(--text-mute)" }}>{buy ? vlabel(buy.venue) : "?"} → {sell ? vlabel(sell.venue) : "?"}</span>
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: o.gate === "closed" ? "var(--neg)" : "var(--amber)" }}>{o.gate === "closed" ? "닫힘" : "정지 의심"}</span>
                    <span style={{ flex: 1 }} />
                    <span className="tnum" style={{ fontWeight: 700, color: "var(--text-dim)" }}>{pct(liveNet(o))}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div style={{ paddingBottom: 46 }}>
      {/* 모바일: 실시간 기회가 맨 위 — 폰으로 여는 순간은 "지금 뭐 있나"를 보러
          온 것이다. 그 아래 자금 요약(압축). 감시·KPI·리스크는 그다음. */}
      {mobile && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 12 }}>
          {streamCard}
          {fundsCardMobile}
        </div>
      )}
      {/* 데모 배너 — 키가 없으면 아래 카드 대부분이 빈 채로 남는다. 그 이유와 다음 행동을
          한 줄로. "확인 중"이 영영 안 끝나는 걸 사용자가 기다리게 두지 않는다. */}
      {portfolioLoaded && mock && (
        <div style={{ ...CARD, display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", marginBottom: 12, background: "var(--brand-soft)", border: "1px solid color-mix(in srgb, var(--brand) 40%, transparent)" }}>
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.06em", color: "var(--brand-ink)", background: "var(--brand)", borderRadius: 999, padding: "2px 8px", flex: "0 0 auto" }}>데모</span>
          <span style={{ fontSize: 12.5, color: "var(--text)", minWidth: 0 }}>
            거래소 API 키가 없어 <b>목업 데이터</b>로 표시 중입니다. 잔고·리스크·감지 소스는 키를 넣어야 채워집니다.
          </span>
          <span style={{ flex: 1 }} />
          {onOpenSettings && (
            <button type="button" onClick={() => onOpenSettings("keys")} style={{ ...LINK, fontSize: 12, whiteSpace: "nowrap" }}>키 설정 →</button>
          )}
        </div>
      )}
      {/* PC: 잔고 스트립이 맨 위 — "얼마 있고 어디에 있나" 한 줄 */}
      {!mobile && fundsStrip}
      {/* 상단 그리드: 감시 상태 | KPI 2×2 | 리스크 현황 */}
      <div style={{ display: "grid", gridTemplateColumns: mobile ? "minmax(0,1fr) minmax(0,1fr)" : "minmax(240px,1.15fr) minmax(0,1fr) minmax(0,1fr) minmax(230px,0.9fr)", gridTemplateRows: mobile ? "none" : "auto auto", gap: 12 }}>
        <div style={{ ...CARD, gridRow: mobile ? "auto" : "1 / 3", gridColumn: mobile ? "1 / -1" : undefined, padding: "16px 18px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13.5, fontWeight: 700 }}>감시 상태</span>
            <span style={{ flex: 1 }} />
            {health && (
              <span style={{
                fontSize: 10, fontWeight: 700, borderRadius: 999, padding: "2px 8px",
                background: health.killed ? "var(--neg)" : health.dryRun ? "var(--card-3)" : "var(--pos)",
                color: health.killed ? "#fff" : health.dryRun ? "var(--text-dim)" : "var(--brand-ink)",
              }}>
                {health.killed ? "킬스위치 ON" : health.dryRun ? "페이퍼" : "라이브"}
              </span>
            )}
          </div>
          <div style={{ marginTop: 4, fontSize: 11, color: warnCount > 0 ? "var(--neg)" : "var(--text-mute)" }}>
            {loading ? "상태 불러오는 중…"
              : warnCount > 0 ? `⚠ ${warnCount}개 항목 조치 필요`
              : unknownCount > 0 ? `${unknownCount}개 항목 확인 불가 (미설정·대기)`
              : "감지 소스·프로세스 전부 정상"}
          </div>
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column" }}>
            {(["감지 소스", "시스템"] as const).map((sec) => (
              <div key={sec}>
                <div style={{ ...CAP, padding: "8px 0 2px" }}>{sec}</div>
                {srcRows.filter((r) => r.sec === sec).map((r) => {
                  const cells = r.heatKey ? heatCells(r.heatKey) : null;
                  return (
                    <div key={r.label} title={r.title} style={{ padding: "7px 0 6px", borderBottom: "1px solid var(--border)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
                        <span style={{
                          width: 8, height: 8, borderRadius: 999, flex: "0 0 auto",
                          background: r.state === "ok" ? "var(--pos)" : r.state === "warn" ? "var(--neg)" : "var(--border-strong)",
                        }} />
                        <span style={{ color: "var(--text-dim)" }}>{r.label}</span>
                        <span style={{ flex: 1 }} />
                        <span className="tnum" style={{ fontSize: 11.5, fontWeight: 600, color: r.state === "warn" ? "var(--neg)" : r.state === "ok" ? "var(--text)" : "var(--text-mute)", textAlign: "right" }}>
                          {r.text}
                        </span>
                        {r.action && (
                          <button
                            type="button"
                            onClick={r.action.onClick}
                            style={{ border: "1px solid var(--border-strong)", borderRadius: 999, padding: "2px 9px", background: "transparent", color: "var(--brand-2)", fontSize: 10.5, fontWeight: 700, cursor: "pointer", flex: "0 0 auto" }}
                          >
                            {r.action.label}
                          </button>
                        )}
                      </div>
                      {/* 24h 업타임 스트립 — "지금 초록"이 아니라 "오늘 얼마나 초록이었나" */}
                      {cells && (
                        <div style={{ display: "flex", gap: 1.5, marginTop: 5, marginLeft: 18 }}>
                          {cells.map((c, i) => (
                            <span key={i} title={c.title} style={{ flex: 1, height: 4, borderRadius: 2, background: c.color }} />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {/* 이동 링크는 다른 카드와 같은 "… →" 텍스트 — 전폭 버튼은 주요 액션처럼 보였다. */}
          <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
            <button type="button" onClick={() => onGoTab("control")} style={LINK}>운영 탭 →</button>
          </div>
        </div>

        <Kpi label="기회" value={String(live.length)} sub="실데이터 · 전략 3종" series={hist.current.opp} compact={mobile} />
        <Kpi label="수익 기회" value={String(positive)} chip={positive > 0 ? "활성" : undefined} sub="비용 넘김 (실시간)" series={hist.current.posi} compact={mobile} />
        <Kpi
          label="최고 순수익"
          value={bestNet != null ? pct(bestNet) : "—"}
          sub={best ? `${best.base} · ${best.kind === "kimchi" ? oppKindLabel(best) : best.kind}${best.persistence?.heldSec ? ` · 지속 ${dur(best.persistence.heldSec)}` : ""}` : "스캔 중"}
          series={hist.current.best}
          compact={mobile}
          tone={bestNet != null && bestNet > 0 ? "var(--pos)" : "var(--neg)"}
        />
        <Kpi
          label="오늘 실현"
          value={`${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(2)}`}
          sub="정산 기준 · 자정 리셋"
          series={hist.current.pnl.map((v) => Math.abs(v))}
          compact={mobile}
          tone={pnl > 0 ? "var(--pos)" : pnl < 0 ? "var(--neg)" : undefined}
        />

        <div style={{ ...CARD, gridColumn: mobile ? "1 / -1" : "4", gridRow: mobile ? "auto" : "1 / 3", padding: "16px 18px", display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>리스크 현황</div>
          {/* 게이지는 값을 그린다 — 예전엔 세 색 호가 고정 장식이라 미설정에도 초록 100%였다.
              트랙 위에 여유율만큼만 채우고, 색은 여유 구간(초록/앰버/빨강)·미설정(회색)으로. */}
          <div style={{ position: "relative", margin: "10px auto 0", width: 180, height: 106 }}>
            <svg viewBox="0 0 200 118" width="180" height="106" aria-label={riskConfigured ? `리스크 여유 ${headroom}%` : "리스크 한도 미설정"}>
              <path d="M 16 108 A 84 84 0 0 1 184 108" fill="none" stroke="var(--card-3)" strokeWidth="14" strokeLinecap="round" />
              {riskConfigured && headroom > 0 && (
                <path
                  d="M 16 108 A 84 84 0 0 1 184 108" fill="none" stroke={gaugeTone} strokeWidth="14" strokeLinecap="round"
                  pathLength={100} strokeDasharray={`${headroom} 100`}
                  style={{ transition: "stroke-dasharray 400ms ease-out, stroke 300ms" }}
                />
              )}
            </svg>
            <div style={{ position: "absolute", left: 0, right: 0, top: 48, textAlign: "center" }}>
              <div style={CAP}>{riskConfigured ? "리스크 여유" : "리스크 한도"}</div>
              {riskConfigured ? (
                <div className="tnum" style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.02em", color: headroom < 30 ? "var(--neg)" : headroom < 60 ? "var(--amber)" : "var(--text)" }}>{headroom}%</div>
              ) : (
                <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text-dim)", marginTop: 6 }}>{risk ? "미설정" : stale ? "응답 없음" : "확인 중"}</div>
              )}
            </div>
          </div>
          <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", fontSize: 12 }}>
            {[
              { l: "노출", v: risk ? `$${inFlight.toFixed(0)} / $${(risk.maxInFlightUsd / 1000).toFixed(0)}K` : "—", warn: expoUse > 60 },
              { l: "일일 손실", v: risk ? `−$${Math.max(0, -pnl).toFixed(0)} / $${risk.maxDailyLossUsd}` : "—", warn: lossUse > 60 },
              { l: "1회 한도", v: risk ? `$${risk.maxPerTradeUsd.toLocaleString()}` : "—", warn: false },
              // 감시 카드에서 이사 — 시장 게이트 상태는 리스크의 일부다.
              {
                l: "입출금 중단",
                v: gatesBlocked == null ? (stale ? "응답 없음" : "불러오는 중…") : gatesBlocked > 0 ? `${gatesBlocked}종` : gatesPartial ? "일부만 확인 (키 필요)" : "없음",
                warn: (gatesBlocked ?? 0) > 0,
              },
            ].map((r) => (
              <div key={r.l} style={{ display: "flex", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                <span style={{ color: "var(--text-dim)" }}>{r.l}</span>
                <span className="tnum" style={{ marginLeft: "auto", fontWeight: 600, color: r.warn ? "var(--amber)" : "var(--text)" }}>{r.v}</span>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => (onOpenSettings ? onOpenSettings("risk") : onGoTab("control"))}
            style={{ ...LINK, marginTop: "auto", paddingTop: 10, textAlign: "left" }}
          >
            {riskConfigured ? "한도 조정 (설정) →" : "한도 설정하기 →"}
          </button>
        </div>
      </div>

      {/* 기회 스트림 — 자금이 스트립으로 올라가면서 전폭 승격 (모바일은 이미 위에) */}
      {!mobile && <div style={{ marginTop: 12 }}>{streamCard}</div>}

      {/* 기회 복기 — 지난 기회 구간(임계 위)을 다시 본다. 실행이 아니라 분석이라
          운영 탭이 아니라 여기(보는 화면)에 둔다. */}
      {/* 기회 복기는 자산·기록 탭으로 옮겼다 (분석이지 실시간 정보가 아니다) */}

      {/* 하단 2행: 상장 감시 | 최근 거래 */}
      <div style={{ display: "grid", gridTemplateColumns: mobile ? "minmax(0,1fr)" : "minmax(280px,0.9fr) minmax(0,1.1fr)", gap: 12, marginTop: 12 }}>
        {/* 상장 감시 */}
        <div style={{ ...CARD, padding: 0, minWidth: 0 }}>
          {secHd("상장 감시", (
            <button type="button" onClick={() => onGoTab("listing")} style={LINK}>상장 탭 →</button>
          ))}
          {!listWatch ? (
            <div style={{ padding: "18px 16px", fontSize: 12, color: stale ? "var(--neg)" : "var(--text-mute)" }}>{stale ? "응답 없음 — 서버 상태를 확인하세요" : "불러오는 중…"}</div>
          ) : listWatch.plays.length === 0 ? (
            <div style={{ padding: "18px 16px", fontSize: 12, color: "var(--text-mute)" }}>👀 감시 중 — 신규 상장이 감지되면 여기 뜹니다</div>
          ) : (
            <div style={{ padding: "2px 16px 8px" }}>
              {listWatch.plays.slice(0, 5).map((l) => {
                const mins = l.opensAt && !l.opened ? Math.round((l.opensAt - Date.now()) / 60_000) : null;
                return (
                  <div key={l.base + l.venue} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: "1px solid var(--border)", fontSize: 12.5 }}>
                    <span style={{ fontWeight: 700 }}>{l.base}</span>
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: l.venue === "upbit" ? "var(--brand-2)" : "var(--amber)" }}>{l.venue === "upbit" ? "업비트" : "빗썸"}</span>
                    <span style={{ flex: 1 }} />
                    <span className="tnum" style={{ fontSize: 11.5, fontWeight: 700, color: l.opened ? "var(--pos)" : "var(--amber)" }}>
                      {l.opened ? "개장됨" : mins != null ? (mins > 0 ? `개장 T−${mins}분` : "개장 임박") : "예정"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 최근 거래 */}
        <div style={{ ...CARD, padding: 0, minWidth: 0 }}>
          {secHd("최근 거래", (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              {tradeCount != null && <span style={{ fontSize: 11, color: "var(--text-mute)" }}>누적 {tradeCount}건</span>}
              <button type="button" onClick={() => onGoTab("control")} style={LINK}>운영 탭 →</button>
            </span>
          ))}
          {trades.length === 0 ? (
            <div style={{ padding: "18px 16px", fontSize: 12, color: "var(--text-mute)" }}>아직 거래 기록 없음 — 실행하면 여기 쌓입니다</div>
          ) : (
            <div style={{ padding: "2px 16px 8px" }}>
              {trades.map((t, i) => {
                const p2 = t.realizedPnlUsd;
                const ago = Math.round((Date.now() - t.ts) / 60_000);
                return (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: mobile ? "minmax(0,1fr) auto auto" : "minmax(0,1.4fr) auto auto", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: "1px solid var(--border)", fontSize: 12.5 }}>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ fontWeight: 700 }}>{t.base}</span>
                      <span style={{ marginLeft: 6, fontSize: 10.5, color: "var(--text-mute)" }}>{t.route}{t.dryRun ? " · 페이퍼" : ""}</span>
                    </span>
                    <span className="tnum" style={{ fontWeight: 700, color: p2 == null ? "var(--text-mute)" : p2 >= 0 ? "var(--pos)" : "var(--neg)" }}>
                      {p2 == null ? "—" : `${p2 >= 0 ? "+" : "−"}$${Math.abs(p2).toFixed(2)}`}
                    </span>
                    <span className="tnum" style={{ fontSize: 10.5, color: "var(--text-mute)", justifySelf: "end" }}>{ago < 60 ? `${ago}분 전` : `${Math.round(ago / 60)}시간 전`}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default DashboardPanel;
