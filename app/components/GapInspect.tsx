"use client";

// 갭 상세 패널 (PC) — 보드 행을 클릭하면 우측에 뜨는 검사창.
// 양쪽 거래소 차트(TradingView) + net% 히스토리 스파크라인(30분) + 비용 분해 +
// 지속성/전송 리스크 + 실행 버튼. 데이터는 이미 보드가 든 opp + 히스토리 API.

import React from "react";
import { useEffect, useMemo, useState } from "react";
import type { Opportunity } from "@/lib/types";
import { pct, usd } from "@/lib/format";
import type { LiveGap } from "@/lib/useLivePrices";
import { KIND_META, vlabel, PersistChip, VenueLink } from "./cockpit-ui";
import { TransferPanel } from "./ExecuteModal";
import { TV_SYMBOL } from "./ListingPanel";

const CAP: React.CSSProperties = { fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-mute)" };

// ── net% 히스토리 차트 — /api/gap-history의 gross 시계열 − 현재 비용 ──────────
// 이 차트의 질문은 "지금 갭이 커지는 중인가, 그리고 지난 30분 중 얼마나
// 흑자였나"다. 그래서 극성(0 기준)이 1급 인코딩이다: 선은 중립색 하나로 두고
// 0선 위/아래를 옅은 면으로 채워 흑자 구간이 면적으로 읽히게 한다.
// (예전엔 선 전체를 '마지막 값'의 색으로 칠했다 — 30분 내내 흑자다가 방금
// 음수로 꺾인 기회가 통째로 빨간 선이 되는, 마지막 틱의 거짓말이었다.)
function Sparkline({ oppId, costPct }: { oppId: string; costPct: number }) {
  const [samples, setSamples] = useState<{ ts: number; gross: number }[]>([]);
  const [hover, setHover] = useState<number | null>(null); // sample index
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
    const pad = Math.max((hi - lo) * 0.12, 0.02);
    const W = 560, H = 96;
    const x = (ts: number) => (t1 === t0 ? 0 : ((ts - t0) / (t1 - t0)) * W);
    const y = (v: number) => H - ((v - (lo - pad)) / (hi + pad - (lo - pad))) * H;
    const pts = samples.map((s, i) => `${x(s.ts).toFixed(1)},${y(nets[i]).toFixed(1)}`).join(" ");
    const zeroY = y(0);
    // 0선 기준 면 채움용 닫힌 경로 — 위/아래는 clipPath로 갈라 칠한다.
    const area = `M ${x(t0).toFixed(1)},${zeroY.toFixed(1)} L ${pts.split(" ").join(" L ")} L ${x(t1).toFixed(1)},${zeroY.toFixed(1)} Z`;
    // 10분 간격 시간 그리드 (지금 기준 역산).
    const gridX: { px: number; label: string }[] = [];
    for (let m = 10; m <= 30; m += 10) {
      const ts = t1 - m * 60_000;
      if (ts > t0) gridX.push({ px: x(ts), label: `−${m}분` });
    }
    const last = nets[nets.length - 1];
    return { pts, area, zeroY, W, H, last, lo, hi, t0, t1, x, y, nets, gridX, spanMin: Math.round((t1 - t0) / 60_000) };
  }, [samples, costPct]);

  if (!view) return <div style={{ fontSize: 10.5, color: "var(--text-mute)", padding: "8px 0" }}>히스토리 수집 중… (스캔 몇 틱 필요)</div>;

  // clipPath id — opp id의 콜론(kimchi:XRP)이 url(#…) 참조를 깨지 않게 정리.
  const cid = oppId.replace(/[^a-zA-Z0-9_-]/g, "-");

  // 호버 → 가장 가까운 샘플 (컨테이너 가로 비율 → 시간 → 이분 탐색 근사).
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ts = view.t0 + ((e.clientX - rect.left) / rect.width) * (view.t1 - view.t0);
    let best = 0, bestD = Infinity;
    for (let i = 0; i < samples.length; i++) {
      const d = Math.abs(samples[i].ts - ts);
      if (d < bestD) { bestD = d; best = i; }
    }
    setHover(best);
  };
  const h = hover != null && samples[hover] ? { ts: samples[hover].ts, net: view.nets[hover] } : null;
  const agoSec = h ? Math.max(0, Math.round((view.t1 - h.ts) / 1000)) : 0;
  const hLeftPct = h ? (view.x(h.ts) / view.W) * 100 : 0;
  // 축 라벨 세로 위치(%) — 0선과 겹치면 0선 라벨을 생략.
  const hiPct = (view.y(view.hi) / view.H) * 100;
  const loPct = (view.y(view.lo) / view.H) * 100;
  const zeroPct = (view.zeroY / view.H) * 100;
  const zeroLabelOk = Math.abs(zeroPct - hiPct) > 12 && Math.abs(zeroPct - loPct) > 12;
  const axisLabel: React.CSSProperties = { position: "absolute", right: 2, transform: "translateY(-50%)", fontSize: 9, color: "var(--text-mute)", background: "var(--card)", padding: "0 3px", pointerEvents: "none", lineHeight: 1.4 };

  return (
    <div>
      <div style={{ position: "relative" }} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${view.W} ${view.H}`} style={{ width: "100%", height: view.H, display: "block" }} preserveAspectRatio="none" aria-label={`30분 순수익 히스토리 · 지금 ${view.last.toFixed(2)}%`}>
          <defs>
            <clipPath id={`above-${cid}`}><rect x="0" y="0" width={view.W} height={Math.max(0, view.zeroY)} /></clipPath>
            <clipPath id={`below-${cid}`}><rect x="0" y={view.zeroY} width={view.W} height={Math.max(0, view.H - view.zeroY)} /></clipPath>
          </defs>
          {/* 시간 그리드 (10분 간격) */}
          {view.gridX.map((gx) => (
            <line key={gx.label} x1={gx.px} x2={gx.px} y1={0} y2={view.H} stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          ))}
          {/* 흑자/적자 면 — 같은 경로를 0선 위/아래로 갈라 칠한다 */}
          <path d={view.area} fill="var(--pos-soft)" clipPath={`url(#above-${cid})`} />
          <path d={view.area} fill="var(--neg-soft)" clipPath={`url(#below-${cid})`} />
          {/* 0선 — 이 위가 흑자 */}
          <line x1="0" y1={view.zeroY} x2={view.W} y2={view.zeroY} stroke="var(--border-strong)" strokeDasharray="3 3" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          {/* 시리즈 선 — 중립색 하나. 극성은 위치·면이 이미 말한다 */}
          <polyline points={view.pts} fill="none" stroke="var(--text-dim)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          {/* 현재값 점 — '지금'만 상태색 */}
          <circle cx={view.x(view.t1)} cy={view.y(view.last)} r="2.6" fill={view.last > 0 ? "var(--pos)" : "var(--neg)"} />
          {/* 호버 크로스헤어 + 마커 */}
          {h && (
            <>
              <line x1={view.x(h.ts)} x2={view.x(h.ts)} y1={0} y2={view.H} stroke="var(--text-mute)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              <circle cx={view.x(h.ts)} cy={view.y(h.net)} r="3" fill="var(--card)" stroke={h.net > 0 ? "var(--pos)" : "var(--neg)"} strokeWidth="1.6" />
            </>
          )}
        </svg>
        {/* y축 라벨 — svg가 가로로 늘어나므로 글자는 HTML 오버레이로 */}
        <span className="tnum" style={{ ...axisLabel, top: `${hiPct}%` }}>{view.hi.toFixed(2)}%</span>
        <span className="tnum" style={{ ...axisLabel, top: `${loPct}%` }}>{view.lo.toFixed(2)}%</span>
        {zeroLabelOk && <span className="tnum" style={{ ...axisLabel, right: undefined, left: 2, top: `${zeroPct}%` }}>0</span>}
        {view.gridX.map((gx) => (
          <span key={gx.label} className="tnum" style={{ position: "absolute", left: `${(gx.px / view.W) * 100}%`, bottom: 1, transform: "translateX(-50%)", fontSize: 8.5, color: "var(--text-mute)", pointerEvents: "none" }}>{gx.label}</span>
        ))}
        {/* 툴팁 */}
        {h && (
          <div className="tnum" style={{
            position: "absolute", top: -4, left: `${hLeftPct}%`,
            transform: `translate(${hLeftPct > 82 ? "-100%" : hLeftPct < 18 ? "0" : "-50%"}, -100%)`,
            background: "var(--card-2)", border: "1px solid var(--border-strong)", borderRadius: 7,
            padding: "3px 8px", fontSize: 10.5, whiteSpace: "nowrap", pointerEvents: "none", boxShadow: "var(--shadow-sm)", zIndex: 2,
          }}>
            {agoSec < 60 ? `${agoSec}초 전` : `${Math.floor(agoSec / 60)}분 ${agoSec % 60}초 전`} ·{" "}
            <b style={{ color: h.net > 0 ? "var(--pos)" : "var(--neg)" }}>{h.net >= 0 ? "+" : ""}{h.net.toFixed(2)}%</b>
          </div>
        )}
      </div>
      <div className="tnum" style={{ display: "flex", justifyContent: "space-between", fontSize: 9.5, color: "var(--text-mute)", marginTop: 3 }}>
        <span>−{view.spanMin}분 → 지금</span>
        <span>지금 <b style={{ color: view.last > 0 ? "var(--pos)" : "var(--neg)" }}>{view.last >= 0 ? "+" : ""}{view.last.toFixed(2)}%</b></span>
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
    // 패널은 화면 높이를 넘지 않는다 — 내용이 길면 안에서 스크롤하고, 실행
    // 버튼은 하단 푸터로 상시 노출 (페이지 스크롤 없이 클릭→실행이 끝나야 한다).
    // 128px = 상단 헤더/sticky 오프셋(60+14) + 하단 요약바(~46) + 여유.
    <div className="panel-in" style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden", display: "flex", flexDirection: "column", maxHeight: "calc(100dvh - 128px)" }}>
      {/* 헤더 */}
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontWeight: 700, fontSize: 15 }}>{opp.base}</span>
        <span style={{ color: km.color, fontSize: 9, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase" }}>{km.label}</span>
        <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
          {buy && sell ? <>매수 <VenueLink venue={buy.venue} base={opp.base} /> <span style={{ color: "var(--text-mute)" }}>→</span> 매도 <VenueLink venue={sell.venue} base={opp.base} /></> : null}
        </span>
        <span style={{ flex: 1 }} />
        <span className="tnum" style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-0.03em", color: net > 0 ? "var(--pos)" : "var(--neg)" }}>{pct(net)}</span>
        <button type="button" onClick={onClose} style={{ border: "1px solid var(--border-strong)", background: "transparent", color: "var(--text-dim)", borderRadius: 9, padding: "4px 10px", fontSize: 11, cursor: "pointer" }}>닫기</button>
      </div>

      <div style={{ padding: "10px 14px 14px", overflowY: "auto", minHeight: 0, flex: 1 }}>
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
                    borderRadius: 9, padding: "3px 9px", fontSize: 10.5, fontWeight: 600, cursor: "pointer",
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
                style={{ width: "100%", height: 300, border: "1px solid var(--border)", borderRadius: 9, background: "#0e0f12" }}
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
          {/* 헷지 내역. 비용은 테이커 왕복 + (창 안) 펀딩뿐이다 — 진입 베이시스는
              무기한물 단기 보유에서 회수를 기대할 근거가 없어 비용에 넣지 않고
              참고로만 보여준다(근거: lib/hedgeCost.ts 상단). */}
          {opp.hedge && (
            <div style={{ padding: "2px 0 4px 10px", borderLeft: "2px solid var(--border)", margin: "2px 0 4px" }}>
              {line("├ 퍼프 테이커 왕복", `−${opp.hedge.takerPct.toFixed(3)}%`, "var(--text-mute)")}
              {line(
                "├ 펀딩",
                opp.hedge.settlesInWindow
                  ? opp.hedge.fundingPct > 0
                    ? `−${opp.hedge.fundingPct.toFixed(3)}% (창 안 정산)`
                    : `+${Math.abs(opp.hedge.fundingPct).toFixed(3)}% 수령 예상 (비용 미반영)`
                  : "0% (정산 안 지남)",
                !opp.hedge.settlesInWindow ? "var(--text-mute)"
                  : opp.hedge.fundingPct <= 0 ? "var(--pos)" : "var(--neg)",
              )}
              {opp.hedge.basisSuspect
                ? line("└ 현·선 괴리", "확인 불가 (마크·현물 차이 과대)", "var(--amber)")
                : line(
                    `└ 현·선 괴리 (${opp.hedge.basisPct >= 0 ? "콘탱고" : "백워데이션"}, 비용 미반영)`,
                    `${opp.hedge.basisPct >= 0 ? "+" : "−"}${Math.abs(opp.hedge.basisPct).toFixed(3)}%`,
                    Math.abs(opp.hedge.basisPct) > 0.5 ? "var(--amber)" : "var(--text-mute)",
                  )}
            </div>
          )}
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
      </div>

      {/* 실행 — 스크롤 영역 밖 고정 푸터. 패널이 길어도 항상 보인다. */}
      <div style={{ padding: "10px 14px 12px", borderTop: "1px solid var(--border)", background: "var(--card)", flex: "0 0 auto" }}>
        <button
          type="button"
          disabled={!opp.executable}
          onClick={() => onExecute(opp)}
          style={{
            width: "100%", border: "none", borderRadius: 9, padding: "11px 0",
            background: opp.executable ? "var(--brand)" : "var(--card-3)",
            color: opp.executable ? "var(--brand-ink)" : "var(--text-mute)",
            fontWeight: 700, fontSize: 13.5, cursor: opp.executable ? "pointer" : "not-allowed",
          }}
        >
          {opp.executable ? "실행 시작 →"
            : opp.transfer?.blocked ? "입출금 중단 — 실행 불가"
            : opp.transfer ? "실행 불가 (입출금 미확인)"
            : "실행 불가 (순수익 ≤ 0)"}
        </button>
      </div>
    </div>
  );
}

export default GapInspect;
