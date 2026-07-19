"use client";

// 갭 상세 패널 (PC) — 보드 행을 클릭하면 우측에 뜨는 검사창.
// 양쪽 거래소 차트(TradingView) + net% 히스토리 스파크라인(30분) + 비용 분해 +
// 지속성/전송 리스크 + 실행 버튼. 데이터는 이미 보드가 든 opp + 히스토리 API.

import React from "react";
import { useEffect, useMemo, useState } from "react";
import type { Opportunity } from "@/lib/types";
import { pct, usd } from "@/lib/format";
import type { LiveGap } from "@/lib/useLivePrices";
import { KIND_META, vlabel, PersistChip } from "./cockpit-ui";
import { TransferPanel } from "./ExecuteModal";
import { TV_SYMBOL } from "./ListingPanel";

const CAP: React.CSSProperties = { fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-mute)" };

// ── net% 스파크라인 — /api/gap-history의 gross 시계열 − 현재 비용 ──────────────
function Sparkline({ oppId, costPct }: { oppId: string; costPct: number }) {
  const [samples, setSamples] = useState<{ ts: number; gross: number }[]>([]);
  useEffect(() => {
    let stop = false;
    const load = () => fetch(`/api/gap-history?id=${encodeURIComponent(oppId)}`, { cache: "no-store" })
      .then((r) => r.json()).then((j) => { if (!stop) setSamples(j.samples ?? []); }).catch(() => {});
    load();
    const id = setInterval(load, 10_000);
    return () => { stop = true; clearInterval(id); };
  }, [oppId]);

  const view = useMemo(() => {
    if (samples.length < 2) return null;
    const nets = samples.map((s) => s.gross - costPct);
    const t0 = samples[0].ts, t1 = samples[samples.length - 1].ts;
    const lo = Math.min(...nets, 0), hi = Math.max(...nets, 0);
    const pad = Math.max((hi - lo) * 0.1, 0.02);
    const W = 560, H = 64;
    const x = (ts: number) => (t1 === t0 ? 0 : ((ts - t0) / (t1 - t0)) * W);
    const y = (v: number) => H - ((v - (lo - pad)) / (hi + pad - (lo - pad))) * H;
    const pts = samples.map((s, i) => `${x(s.ts).toFixed(1)},${y(nets[i]).toFixed(1)}`).join(" ");
    const last = nets[nets.length - 1];
    return { pts, zeroY: y(0), W, H, last, lo, hi, spanMin: Math.round((t1 - t0) / 60_000) };
  }, [samples, costPct]);

  if (!view) return <div style={{ fontSize: 10.5, color: "var(--text-mute)", padding: "8px 0" }}>히스토리 수집 중… (스캔 몇 틱 필요)</div>;
  return (
    <div>
      <svg viewBox={`0 0 ${view.W} ${view.H}`} style={{ width: "100%", height: 64, display: "block" }} preserveAspectRatio="none">
        <line x1="0" y1={view.zeroY} x2={view.W} y2={view.zeroY} stroke="var(--border-strong)" strokeDasharray="3 3" strokeWidth="1" />
        <polyline points={view.pts} fill="none" stroke={view.last > 0 ? "var(--pos)" : "var(--neg)"} strokeWidth="1.5" />
      </svg>
      <div className="tnum" style={{ display: "flex", justifyContent: "space-between", fontSize: 9.5, color: "var(--text-mute)", marginTop: 2 }}>
        <span>−{view.spanMin}분</span>
        <span>범위 {view.lo.toFixed(2)}% ~ {view.hi.toFixed(2)}%</span>
        <span>지금 <b style={{ color: view.last > 0 ? "var(--pos)" : "var(--neg)" }}>{view.last.toFixed(2)}%</b></span>
      </div>
    </div>
  );
}

export function GapInspect({ opp, live, onExecute, onClose }: {
  opp: Opportunity;
  live?: LiveGap;
  onExecute: (o: Opportunity) => void;
  onClose: () => void;
}) {
  const km = KIND_META[opp.kind];
  const net = live?.netPct ?? opp.netPct;
  const gross = live?.grossPct ?? opp.grossPct;
  const [buy, sell] = opp.legs;

  // 차트 탭 — 양쪽 다리의 CEX만 (DEX 다리는 TV 심볼 없음).
  const chartOpts = opp.legs
    .filter((l) => TV_SYMBOL[l.venue])
    .map((l) => ({
      key: l.venue,
      label: `${l.side === "buy" ? "매수" : "매도"} ${vlabel(l.venue) ?? l.venue}`,
      src: `https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(TV_SYMBOL[l.venue](opp.base))}&interval=5&theme=dark&style=1&locale=kr&hide_side_toolbar=1&allow_symbol_change=0&save_image=0&withdateranges=0`,
    }));
  const [chart, setChart] = useState<string | null>(null);
  const activeChart = chartOpts.find((c) => c.key === chart) ?? chartOpts[0];

  const line = (label: string, value: React.ReactNode, tone?: string) => (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0" }}>
      <span style={{ color: "var(--text-mute)" }}>{label}</span>
      <span className="tnum" style={{ color: tone ?? "var(--text)", fontWeight: 600 }}>{value}</span>
    </div>
  );

  return (
    <div className="panel-in" style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
      {/* 헤더 */}
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontWeight: 700, fontSize: 15 }}>{opp.base}</span>
        <span style={{ color: km.color, fontSize: 9, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase" }}>{km.label}</span>
        <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
          {buy && sell ? <>매수 {vlabel(buy.venue)} <span style={{ color: "var(--text-mute)" }}>→</span> 매도 {vlabel(sell.venue)}</> : null}
        </span>
        <span style={{ flex: 1 }} />
        <span className="tnum" style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-0.03em", color: net > 0 ? "var(--pos)" : "var(--neg)" }}>{pct(net)}</span>
        <button type="button" onClick={onClose} style={{ border: "1px solid var(--border-strong)", background: "transparent", color: "var(--text-dim)", borderRadius: 2, padding: "4px 10px", fontSize: 11, cursor: "pointer" }}>닫기</button>
      </div>

      <div style={{ padding: "10px 14px 14px" }}>
        {/* 차트 */}
        {chartOpts.length > 0 && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <span style={CAP}>차트</span>
              {chartOpts.map((c) => (
                <button
                  key={c.key} type="button" onClick={() => setChart(c.key)}
                  style={{
                    border: `1px solid ${activeChart?.key === c.key ? "var(--brand)" : "var(--border)"}`,
                    background: activeChart?.key === c.key ? "var(--brand-soft)" : "transparent",
                    color: activeChart?.key === c.key ? "var(--brand-2)" : "var(--text-dim)",
                    borderRadius: 2, padding: "3px 9px", fontSize: 10.5, fontWeight: 600, cursor: "pointer",
                  }}
                >
                  {c.label}
                </button>
              ))}
            </div>
            {activeChart && (
              <iframe
                key={activeChart.key}
                src={activeChart.src}
                title={`${opp.base} — ${activeChart.label}`}
                style={{ width: "100%", height: 300, border: "1px solid var(--border)", borderRadius: 2, background: "#0e0f12" }}
                loading="lazy"
              />
            )}
          </>
        )}

        {/* net 히스토리 */}
        <div style={{ margin: "12px 0 4px", ...CAP, color: "var(--text-dim)" }}>순수익 히스토리 (실호가 기준, 30분)</div>
        <Sparkline oppId={opp.id} costPct={opp.costPct} />

        {/* 수치 분해 */}
        <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
          {line("총차익 (실호가)", pct(gross))}
          {line("예상 왕복비용", `−${opp.costPct.toFixed(2)}%`, "var(--text-dim)")}
          {line("순수익", pct(net), net > 0 ? "var(--pos)" : "var(--neg)")}
          {opp.notionalCapUsd != null && line("호가 한도", usd(opp.notionalCapUsd))}
          {opp.persistence && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0" }}>
              <span style={{ fontSize: 12, color: "var(--text-mute)" }}>지속성</span>
              <PersistChip p={opp.persistence} />
            </div>
          )}
          {opp.transferRisk && line(
            "전송 중 변동 위험",
            `±${opp.transferRisk.driftPct.toFixed(2)}% · ETA ${opp.transferRisk.etaMin}분${opp.transferRisk.hedgeAdvised ? " · 헷지 권장" : ""}`,
            opp.transferRisk.hedgeAdvised ? "var(--amber)" : undefined,
          )}
        </div>

        {/* 입출금 게이트 / 전송 경로 */}
        <TransferPanel opp={opp} />

        {/* 실행 */}
        <button
          type="button"
          disabled={!opp.executable}
          onClick={() => onExecute(opp)}
          style={{
            marginTop: 12, width: "100%", border: "none", borderRadius: 2, padding: "11px 0",
            background: opp.executable ? "var(--brand)" : "var(--card-3)",
            color: opp.executable ? "#10141a" : "var(--text-mute)",
            fontWeight: 700, fontSize: 13.5, cursor: opp.executable ? "pointer" : "not-allowed",
          }}
        >
          {opp.executable ? "실행 시작 →" : opp.transfer?.blocked ? "입출금 중단 — 실행 불가" : "실행 불가 (게이트 미확인)"}
        </button>
      </div>
    </div>
  );
}

export default GapInspect;
