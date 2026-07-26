"use client";

// 대시보드 탭 — 글래스 시안의 요약 화면을 실데이터로.
// 구성: 감시 상태(감지 소스·프로세스) · 리스크 현황(게이지) · KPI 4장(세션 미니바) ·
// 자금 배분(세그먼트 바) · 실시간 기회. 전부 기존 API에서 읽는다.

import React from "react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Opportunity, Portfolio } from "@/lib/types";
import { pct, usd } from "@/lib/format";
import type { LiveGap } from "@/lib/useLivePrices";
import { vlabel } from "./cockpit-ui";
import { inFlightUsd } from "@/lib/runStore";
import type { RiskState } from "./ControlPanel";

const CAP: React.CSSProperties = { fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-mute)" };
const CARD: React.CSSProperties = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", boxShadow: "var(--shadow-sm)"  }

// 세션 동안 쌓는 미니 바차트 (숫자에 맥락 부여 — 시안의 vertical bars)
function MiniBars({ series, color }: { series: number[]; color?: string }) {
  const max = Math.max(...series, 1);
  const view = series.slice(-14);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 34, marginTop: 10 }}>
      {view.length < 2 ? (
        <span style={{ fontSize: 9.5, color: "var(--text-mute)" }}>세션 데이터 수집 중…</span>
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
            fontSize: compact ? 19 : 24, fontWeight: 700, letterSpacing: "-0.02em",
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
        <div style={{ marginTop: 3, fontSize: compact ? 10 : 10.5, color: "var(--text-mute)", minWidth: 0, overflowWrap: "anywhere" }}>{sub}</div>
      )}
      <MiniBars series={series} color={tone} />
    </div>
  );
}

export function DashboardPanel({ opps, liveOverlay, onGoTab, onExecute, mobile }: {
  opps: Opportunity[];
  mobile?: boolean;
  liveOverlay: Record<string, LiveGap>;
  onGoTab: (tab: "monitor" | "funding" | "listing" | "control" | "assets") => void;
  onExecute: (o: Opportunity) => void;
}) {
  const [risk, setRisk] = useState<RiskState | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [trades, setTrades] = useState<{ base: string; kind: string; route: string; realizedPnlUsd: number | null; dryRun: boolean; ts: number }[]>([]);
  const [listWatch, setListWatch] = useState<{ plays: { base: string; venue: string; opensAt?: number; opened: boolean }[]; watching: boolean } | null>(null);
  // 감시 상태 카드 데이터 — 전부 기존 API에서 읽는다.
  const [health, setHealth] = useState<{ ok: boolean; scanAgeSec: number | null; killed: boolean; dryRun: boolean; loopLagMs?: { worstMs: number; worstAgoSec: number | null } } | null>(null);
  const [watch, setWatch] = useState<{ annOkAgoSec: number | null; annBlocked: boolean; mktOkAgoSec: number | null; tgConfigured: boolean; tgOkAgoSec: number | null } | null>(null);
  const [gatesBlocked, setGatesBlocked] = useState<number | null>(null);
  /** 키가 없어 일부 거래소 상태를 못 본 상태 — "중단 없음"이라고 단정할 수 없다. */
  const [gatesPartial, setGatesPartial] = useState(false);
  const [tradeCount, setTradeCount] = useState<number | null>(null);
  const [mock, setMock] = useState(true);

  useEffect(() => {
    const load = () => {
      fetch("/api/risk", { cache: "no-store" }).then((r) => r.json()).then(setRisk).catch(() => {});
      fetch("/api/balances", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j.portfolio) { setPortfolio(j.portfolio); setMock(!!j.portfolio.mock); } }).catch(() => {});
      fetch("/api/health", { cache: "no-store" }).then((r) => r.json()).then(setHealth).catch(() => {});
    };
    load();
    const id = setInterval(load, 15_000);
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
    return () => { clearInterval(id); clearInterval(fid); clearInterval(gid); };
  }, []);

  // 실데이터 지표 (mock 제외)
  const live = useMemo(() => opps.filter((o) => !o.mock && o.kind !== "funding-basis"), [opps]);
  const liveNet = useCallback(
    (o: Opportunity) => liveOverlay[o.id]?.netPct ?? o.netPct,
    [liveOverlay],
  );
  // Memoized: this is the DEFAULT tab, and `positive`/`best` each walked the
  // whole list on every render — 600ms overlay ticks made that ~100×/min, twice.
  const positive = useMemo(() => live.filter((o) => liveNet(o) > 0).length, [live, liveNet]);
  const best = useMemo(
    () => (live.length ? [...live].reduce((top, o) => (liveNet(o) > liveNet(top) ? o : top)) : null),
    [live, liveNet],
  );
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
  const srcRows: { label: string; state: SrcState; text: string }[] = (() => {
    const rows: { label: string; state: SrcState; text: string }[] = [];
    const agoTxt = (s: number | null) => (s == null ? "수신 없음" : s < 90 ? `${s}초 전` : `${Math.round(s / 60)}분 전`);
    rows.push(!health
      ? { label: "스캔", state: "off", text: "…" }
      : health.scanAgeSec == null
        // 방금 기동해 첫 스캔이 아직 안 온 상태 — 고장이 아니다.
        ? { label: "스캔", state: "off", text: "첫 스캔 대기" }
        : health.scanAgeSec < 60
          ? { label: "스캔", state: "ok", text: `${health.scanAgeSec}초 전` }
          : { label: "스캔", state: "warn", text: `정지 ${agoTxt(health.scanAgeSec)} — 재시작 필요` });
    rows.push(!watch ? { label: "업비트 공지", state: "off", text: "…" }
      : watch.annBlocked ? { label: "업비트 공지", state: "warn", text: "차단 (비KR IP)" }
      : watch.annOkAgoSec != null ? { label: "업비트 공지", state: "ok", text: agoTxt(watch.annOkAgoSec) }
      : { label: "업비트 공지", state: "off", text: "수신 없음" });
    rows.push(!watch ? { label: "마켓 diff", state: "off", text: "…" }
      : watch.mktOkAgoSec != null && watch.mktOkAgoSec < 60 ? { label: "마켓 diff", state: "ok", text: agoTxt(watch.mktOkAgoSec) }
      : watch.mktOkAgoSec != null ? { label: "마켓 diff", state: "warn", text: `멈춤 (${agoTxt(watch.mktOkAgoSec)})` }
      : { label: "마켓 diff", state: "off", text: "대기" });
    rows.push(!watch ? { label: "텔레그램 감지", state: "off", text: "…" }
      : !watch.tgConfigured ? { label: "텔레그램 감지", state: "off", text: "미설정" }
      : watch.tgOkAgoSec != null ? { label: "텔레그램 감지", state: "ok", text: agoTxt(watch.tgOkAgoSec) }
      : { label: "텔레그램 감지", state: "off", text: "수신 대기" });
    const lag = health?.loopLagMs;
    rows.push(!lag ? { label: "프로세스", state: "off", text: "…" }
      : lag.worstMs >= 400
        ? { label: "프로세스", state: "warn", text: `멈춤 ${Math.round(lag.worstMs)}ms${lag.worstAgoSec != null ? ` (${agoTxt(lag.worstAgoSec)})` : ""} — 메모리 확인` }
        : { label: "프로세스", state: "ok", text: "정상 (10분 내 멈춤 없음)" });
    // 키가 없는 거래소는 상태가 null로 와서 집계에서 빠진다. 그걸 "없음"이라고
    // 초록으로 단정하면, 감시 카드가 모르는 것을 안다고 말하는 셈이 된다.
    rows.push(gatesBlocked == null ? { label: "입출금 중단", state: "off", text: "…" }
      : gatesBlocked > 0 ? { label: "입출금 중단", state: "warn", text: `${gatesBlocked}종` }
      : gatesPartial ? { label: "입출금 중단", state: "off", text: "일부 거래소만 확인 (키 필요)" }
      : { label: "입출금 중단", state: "ok", text: "없음" });
    return rows;
  })();
  const warnCount = srcRows.filter((r) => r.state === "warn").length;
  const unknownCount = srcRows.filter((r) => r.state === "off").length;

  // 스트림 — 상위 6개. `liveOverlay`가 의존성이라 600ms마다 무조건 재정렬됐다.
  // 표시는 소수 2자리이므로 그 해상도로 스냅샷을 떠서 정렬 빈도를 낮춘다.
  const rankKey = useMemo(
    () => live.map((o) => `${o.id}:${Math.round(liveNet(o) * 100)}`).join("|"),
    [live, liveNet],
  );
  const stream = useMemo(
    () => [...live].sort((a, b) => liveNet(b) - liveNet(a)).slice(0, 6),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rankKey collapses live+overlay to display precision
    [rankKey],
  );

  const secHd = (title: string, right?: React.ReactNode) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "13px 16px", borderBottom: "1px solid var(--border)" }}>
      <span style={{ fontSize: 13.5, fontWeight: 700 }}>{title}</span>
      <span style={{ flex: 1 }} />
      {right}
    </div>
  );

  // ── 자금 배분 카드 — 모바일은 compact: 총액·바·범례만 작게 ──
  const fundsCard = (compact: boolean) => (
    <div style={{ ...CARD, padding: compact ? "12px 14px" : "16px 18px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontSize: compact ? 12.5 : 13.5, fontWeight: 700 }}>자금 배분</span>
        {mock && <span style={{ fontSize: 9.5, fontWeight: 700, color: "var(--sky)", border: "1px solid var(--sky)", borderRadius: 999, padding: "1px 7px" }}>데모</span>}
        {compact && <span className="tnum" style={{ fontSize: 15, fontWeight: 700, marginLeft: 2 }}>{usd(totalCap)}</span>}
        <button type="button" onClick={() => onGoTab("assets")} style={{ marginLeft: "auto", border: "none", background: "transparent", color: "var(--brand-2)", fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}>상세 →</button>
      </div>
      {!compact && (
        <>
          <div className="tnum" style={{ marginTop: 8, fontSize: 30, fontWeight: 700, letterSpacing: "-0.02em" }}>{usd(totalCap)}</div>
          <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-mute)" }}>
            글로벌 {portfolio ? Math.round(portfolio.skewPct) : "—"} : KR {portfolio ? 100 - Math.round(portfolio.skewPct) : "—"}
          </div>
        </>
      )}
      <div style={{ marginTop: compact ? 10 : 16, display: "flex", height: compact ? 12 : 22, gap: 4 }}>
        {p(cash) > 0 && <div title={`가용 ${usd(cash)}`} style={{ width: `${p(cash)}%`, background: "var(--brand)", opacity: 0.75, borderRadius: 6 }} />}
        {p(coins) > 0 && <div title={`포지션 ${usd(coins)}`} style={{ width: `${p(coins)}%`, background: "var(--amber)", borderRadius: 6 }} />}
        {p(transit) > 0 && <div title={`전송 중 ${usd(transit)}`} style={{ width: `${Math.max(2, p(transit))}%`, background: "var(--pos)", borderRadius: 6 }} />}
      </div>
      <div style={{ display: "flex", gap: compact ? 12 : 16, marginTop: compact ? 8 : 12, fontSize: compact ? 10.5 : 11.5, color: "var(--text-dim)", flexWrap: "wrap" }}>
        <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 999, background: "var(--brand)", opacity: 0.75, marginRight: 6 }} />가용 <b className="tnum">{usd(cash)}</b> · {p(cash)}%</span>
        <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 999, background: "var(--amber)", marginRight: 6 }} />포지션 <b className="tnum">{usd(coins)}</b> · {p(coins)}%</span>
        <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 999, background: "var(--pos)", marginRight: 6 }} />전송 중 <b className="tnum">{usd(transit)}</b> · {p(transit)}%</span>
      </div>
    </div>
  );

  // ── 실시간 기회 카드 ──
  const streamCard = (
    <div style={{ ...CARD, padding: 0, minWidth: 0 }}>
      {secHd("실시간 기회", (
        <button type="button" onClick={() => onGoTab("monitor")} style={{ border: "none", background: "transparent", color: "var(--brand-2)", fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}>갭 보드 →</button>
      ))}
      {stream.length === 0 ? (
        <div style={{ padding: "22px 16px", fontSize: 12, color: "var(--text-mute)" }}>스캔 중 — 실데이터 기회가 잡히면 여기 표시됩니다.</div>
      ) : (
        <div style={{ padding: "2px 16px 8px" }}>
          {stream.map((o) => {
            const net = liveNet(o);
            const held = o.persistence?.heldSec ?? 0;
            const [buy, sell] = o.legs;
            return (
              <div key={o.id} style={{ display: "grid", gridTemplateColumns: mobile ? "minmax(0,1fr) auto auto" : "minmax(0,1.4fr) auto auto auto", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid var(--border)", fontSize: 12.5 }}>
                <span style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{o.base}</div>
                  <div style={{ fontSize: 10.5, color: "var(--text-mute)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {o.kind === "kimchi" ? "김프" : o.kind === "cross-cex" ? "크로스" : "CEX-DEX"} · {buy ? vlabel(buy.venue) : "?"} → {sell ? vlabel(sell.venue) : "?"}
                  </div>
                </span>
                <span className="tnum" style={{ fontWeight: 700, color: net > 0 ? "var(--pos)" : "var(--neg)" }}>{pct(net)}</span>
                {/* 지속 열은 모바일에서 접는다 — 3열 템플릿에 자식이 4개면
                    마지막이 다음 줄로 밀려 레이아웃이 어긋난다. */}
                {!mobile && (
                  <span className="tnum" style={{ fontSize: 11, color: "var(--text-mute)" }}>{held > 0 ? `${Math.floor(held / 60)}m ${held % 60}s` : "신규"}</span>
                )}
                <span
                  onClick={() => o.executable && onExecute(o)}
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
    </div>
  );

  return (
    <div style={{ paddingBottom: 46 }}>
      {/* 모바일: 실시간 기회가 맨 위 — 폰으로 여는 순간은 "지금 뭐 있나"를 보러
          온 것이다. 그 아래 자금 요약(압축). 감시·KPI·리스크는 그다음. */}
      {mobile && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 12 }}>
          {streamCard}
          {fundsCard(true)}
        </div>
      )}
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
                {health.killed ? "킬스위치 ON" : health.dryRun ? "모의 (DRY)" : "라이브"}
              </span>
            )}
          </div>
          <div style={{ marginTop: 4, fontSize: 11, color: warnCount > 0 ? "var(--neg)" : "var(--text-mute)" }}>
            {warnCount > 0 ? `⚠ ${warnCount}개 항목 조치 필요`
              : unknownCount > 0 ? `${unknownCount}개 항목 확인 불가 (미설정·대기)`
              : "감지 소스·프로세스 전부 정상"}
          </div>
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column" }}>
            {srcRows.map((r) => (
              <div key={r.label} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--border)", fontSize: 12.5 }}>
                <span style={{
                  width: 8, height: 8, borderRadius: 999, flex: "0 0 auto",
                  background: r.state === "ok" ? "var(--pos)" : r.state === "warn" ? "var(--neg)" : "var(--border-strong)",
                }} />
                <span style={{ color: "var(--text-dim)" }}>{r.label}</span>
                <span style={{ flex: 1 }} />
                <span className="tnum" style={{ fontSize: 11.5, fontWeight: 600, color: r.state === "warn" ? "var(--neg)" : r.state === "ok" ? "var(--text)" : "var(--text-mute)" }}>
                  {r.text}
                </span>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => onGoTab("control")}
            style={{ marginTop: 12, width: "100%", border: "1px solid var(--border-strong)", background: "transparent", color: "var(--text-dim)", borderRadius: "var(--radius-sm)", padding: "8px 0", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
          >
            운영 탭에서 상세 →
          </button>
        </div>

        <Kpi label="기회" value={String(live.length)} sub="실데이터 · 전략 3종" series={hist.current.opp} compact={mobile} />
        <Kpi label="수익 기회" value={String(positive)} chip={positive > 0 ? "활성" : undefined} sub="비용 넘김 (실시간)" series={hist.current.posi} compact={mobile} />
        <Kpi
          label="최고 순수익"
          value={bestNet != null ? pct(bestNet) : "—"}
          sub={best ? `${best.base} · ${best.kind === "kimchi" ? "김프" : best.kind}${best.persistence?.heldSec ? ` · 지속 ${Math.round(best.persistence.heldSec / 60)}분` : ""}` : "스캔 중"}
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
          <div style={{ position: "relative", margin: "10px auto 0", width: 180, height: 106 }}>
            <svg viewBox="0 0 200 118" width="180" height="106" aria-label={`리스크 여유 ${headroom}%`}>
              <path d="M 18 108 A 84 84 0 0 1 60 36" fill="none" stroke="var(--amber)" strokeWidth="14" strokeLinecap="round" opacity={expoUse > 60 || lossUse > 60 ? 1 : 0.55} />
              <path d="M 74 26 A 84 84 0 0 1 140 30" fill="none" stroke="var(--pos)" strokeWidth="14" strokeLinecap="round" />
              <path d="M 154 40 A 84 84 0 0 1 182 108" fill="none" stroke="var(--brand)" strokeWidth="14" strokeLinecap="round" opacity={0.75} />
            </svg>
            <div style={{ position: "absolute", left: 0, right: 0, top: 48, textAlign: "center" }}>
              <div style={CAP}>리스크 여유</div>
              <div className="tnum" style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.02em", color: headroom < 30 ? "var(--neg)" : headroom < 60 ? "var(--amber)" : "var(--text)" }}>{headroom}%</div>
            </div>
          </div>
          <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", fontSize: 12 }}>
            {[
              { l: "노출", v: risk ? `$${inFlight.toFixed(0)} / $${(risk.maxInFlightUsd / 1000).toFixed(0)}K` : "—", warn: expoUse > 60 },
              { l: "일일 손실", v: risk ? `−$${Math.max(0, -pnl).toFixed(0)} / $${risk.maxDailyLossUsd}` : "—", warn: lossUse > 60 },
              { l: "1회 한도", v: risk ? `$${risk.maxPerTradeUsd.toLocaleString()}` : "—", warn: false },
            ].map((r) => (
              <div key={r.l} style={{ display: "flex", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                <span style={{ color: "var(--text-dim)" }}>{r.l}</span>
                <span className="tnum" style={{ marginLeft: "auto", fontWeight: 600, color: r.warn ? "var(--amber)" : "var(--text)" }}>{r.v}</span>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => onGoTab("control")}
            style={{ marginTop: "auto", paddingTop: 10, border: "none", background: "transparent", color: "var(--brand-2)", fontSize: 11.5, fontWeight: 600, cursor: "pointer", textAlign: "left" }}
          >
            한도 조정 →
          </button>
        </div>
      </div>

      {/* 하단: 자금 배분 | 기회 스트림 — 모바일에선 둘 다 이미 위에 있다 */}
      {!mobile && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(280px,0.9fr) minmax(0,1.1fr)", gap: 12, marginTop: 12 }}>
          {fundsCard(false)}
          {streamCard}
        </div>
      )}

      {/* 하단 2행: 상장 감시 | 최근 거래 */}
      <div style={{ display: "grid", gridTemplateColumns: mobile ? "minmax(0,1fr)" : "minmax(280px,0.9fr) minmax(0,1.1fr)", gap: 12, marginTop: 12 }}>
        {/* 상장 감시 */}
        <div style={{ ...CARD, padding: 0, minWidth: 0 }}>
          {secHd("상장 감시", (
            <button type="button" onClick={() => onGoTab("listing")} style={{ border: "none", background: "transparent", color: "var(--brand-2)", fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}>상장 탭 →</button>
          ))}
          {!listWatch ? (
            <div style={{ padding: "18px 16px", fontSize: 12, color: "var(--text-mute)" }}>불러오는 중…</div>
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
              <button type="button" onClick={() => onGoTab("control")} style={{ border: "none", background: "transparent", color: "var(--brand-2)", fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}>운영 탭 →</button>
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
                      <span style={{ marginLeft: 6, fontSize: 10.5, color: "var(--text-mute)" }}>{t.route}{t.dryRun ? " · 모의" : ""}</span>
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
