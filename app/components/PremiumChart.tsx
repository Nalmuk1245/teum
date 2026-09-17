"use client";

// 프리미엄 차트 코어 — 두 거래소 가격(위)과 그 갭%(아래)를 재구성해 그린다.
// 프리미엄 탭(선택기 딸림)과 갭 검사창(기회에서 자동 파라미터화) 둘 다 이걸 쓴다.
// 선택기·프리셋·타임프레임 UI는 부모가 가진다 — 여긴 (coin, a, b, unit)을 받아
// /api/premium을 조회하고 차트만 그린다.
//
// 비용선이 핵심이다 — "갭이 몇 %냐"가 아니라 "왕복비용을 넘겼냐"가 판단이라,
// 실제 비용(costPct) 위로 올라간 구간만 진짜 기회다.
//   costPct === undefined → 스캔 보드에서 이 코인 비용을 스스로 가져온다(김프일 때)
//   costPct === number    → 그 값을 그대로 쓴다 (검사창은 opp.costPct를 넘긴다)
//   costPct === null      → 비용선 없음

import React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createChart, ColorType, LineStyle, type IChartApi, type ISeriesApi, type Time } from "lightweight-charts";
import { VENUE_LABEL } from "./cockpit-ui";

export type Market = "spot" | "futures";
export type Spec = { venue: string; market: Market };
type Point = { t: number; a: number; b: number; prem: number };
type Series = {
  coin: string; a: Spec; b: Spec; unit: number;
  points: Point[];
  stats: { n: number; hi: number; lo: number; avg: number; cur: number } | null;
  note: string;
};

const KR = (v: string) => v === "upbit" || v === "bithumb";
export const specLabel = (s: Spec) => `${VENUE_LABEL[s.venue] ?? s.venue} ${s.market === "futures" ? "선물" : "현물"}`;
const specParam = (s: Spec) => `${s.venue}:${s.market}`;

// CSS 변수 → 차트가 읽을 수 있는 색.
// 프로덕션 CSS 미니파이어가 rgba(255,255,255,.1)을 hsla(0,0%,100%,.1)로 줄이는데
// lightweight-charts는 hsla를 파싱하지 못해 "Cannot parse color"로 렌더가 통째로
// 죽는다(갭 패널이 빈 화면이었던 원인). 브라우저에 계산시켜 rgb(a)로 받아온다.
function cssColor(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return fallback;
  if (/^(#|rgb)/.test(raw)) return raw;
  try {
    const el = document.createElement("span");
    el.style.color = raw;
    el.style.display = "none";
    document.body.appendChild(el);
    const rgb = getComputedStyle(el).color;
    el.remove();
    return rgb || fallback;
  } catch { return fallback; }
}

/** 가격 자릿수 — 코인마다 스케일이 달라 고정 2자리면 0.088이 전부 "0.09"가 된다. */
function priceDigits(v: number): number {
  const a = Math.abs(v);
  return a >= 1000 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 5 : 8;
}
const fmtPrice = (v: number) => v.toFixed(priceDigits(v));

export function PremiumChart({
  coin, a, b, unit, costPct, mobile, compact, onBusy, onError,
}: {
  coin: string;
  a: Spec;
  b: Spec;
  unit: number;
  /** undefined=스캔에서 자동 조회 · number=지정 · null=비용선 없음 */
  costPct?: number | null;
  mobile?: boolean;
  compact?: boolean;
  onBusy?: (busy: boolean) => void;
  onError?: (err: string | null) => void;
}) {
  const [data, setData] = useState<Series | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoCost, setAutoCost] = useState<number | null>(null);
  const effectiveCost = costPct === undefined ? autoCost : costPct;

  const load = useCallback(async () => {
    onBusy?.(true); setLoading(true); setErr(null); onError?.(null);
    try {
      const q = `coin=${encodeURIComponent(coin)}&a=${specParam(a)}&b=${specParam(b)}&unit=${unit}&count=${unit >= 240 ? 500 : 400}`;
      const r = await fetch(`/api/premium?${q}`, { cache: "no-store" });
      const j = await r.json();
      if (j.error) { setErr(j.error); onError?.(j.error); setData(null); } else { setData(j); }
    } catch {
      // 네트워크·타임아웃 — "조회 실패" 두 글자로는 뭘 해야 할지 모른다.
      const m = "서버에서 캔들을 받지 못했습니다 — 네트워크나 거래소 API 지연일 수 있습니다";
      setErr(m); onError?.(m); setData(null);
    }
    finally { onBusy?.(false); setLoading(false); }
  }, [coin, a, b, unit, onBusy, onError]);
  useEffect(() => { void load(); }, [load]);

  // 비용선 자동 조회 — 부모가 costPct를 안 넘길 때만. 현재 스캔 스냅샷에서 같은
  // 코인의 비용을 가져온다 (김프 조합일 때만 의미: 비용 모델이 KR↔글로벌 전송형).
  const costRelevant = KR(a.venue) !== KR(b.venue);
  useEffect(() => {
    if (costPct !== undefined) return; // 부모가 통제
    if (!costRelevant) { setAutoCost(null); return; }
    let stop = false;
    fetch("/api/scan", { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (stop) return;
      const hit = (j.opportunities ?? []).find(
        (o: { base: string; kind: string; costPct: number; mock?: boolean }) =>
          !o.mock && o.base === coin && o.kind === "kimchi",
      );
      setAutoCost(hit ? hit.costPct : null);
    }).catch(() => {});
    return () => { stop = true; };
  }, [coin, costRelevant, costPct]);

  // ── 차트 ──
  const priceRef = useRef<HTMLDivElement>(null);
  const premRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const premLegendRef = useRef<HTMLDivElement>(null);
  const charts = useRef<{ price?: IChartApi; prem?: IChartApi; aS?: ISeriesApi<"Line">; bS?: ISeriesApi<"Line">; pS?: ISeriesApi<"Area"> }>({});

  useEffect(() => {
    if (!priceRef.current || !premRef.current) return;
    const v = cssColor;
    const text = v("--text-mute", "#8b93a7");
    const grid = v("--border", "rgba(255,255,255,0.08)");
    const base = {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: text, fontSize: 10 },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: grid },
      timeScale: { borderColor: grid, timeVisible: unit < 1440, secondsVisible: false },
      crosshair: { mode: 0 as const },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
    };
    const priceH = compact ? 160 : mobile ? 180 : 300;
    const premH = compact ? 116 : mobile ? 150 : 210;
    const price = createChart(priceRef.current, { ...base, height: priceH });
    const prem = createChart(premRef.current, { ...base, height: premH });
    const aS = price.addLineSeries({ color: v("--brand-2", "#8cc3f0"), lineWidth: 2, priceLineVisible: false, title: "A" });
    const bS = price.addLineSeries({ color: v("--amber", "#e8b04c"), lineWidth: 2, priceLineVisible: false, title: "B" });
    const pS = prem.addAreaSeries({
      lineColor: v("--pos", "#4cc46e"), lineWidth: 2,
      topColor: "rgba(76,196,110,0.22)", bottomColor: "rgba(76,196,110,0.02)",
      priceLineVisible: false,
      priceFormat: { type: "custom", formatter: (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}%` },
    });
    // 두 패널의 시간축을 묶는다 — 위아래가 따로 놀면 같은 순간을 못 본다.
    let syncing = false;
    const sync = (from: IChartApi, to: IChartApi) => (r: unknown) => {
      if (syncing || !r) return;
      syncing = true;
      to.timeScale().setVisibleLogicalRange(r as { from: number; to: number });
      syncing = false;
    };
    price.timeScale().subscribeVisibleLogicalRangeChange(sync(price, prem));
    prem.timeScale().subscribeVisibleLogicalRangeChange(sync(prem, price));

    // 호버 리드아웃 — 그 시점의 A·B 가격과 갭%를 직접 보여준다.
    // 리렌더를 유발하지 않게 DOM 텍스트만 갈아끼운다.
    const paint = (aV?: number, bV?: number, pV?: number) => {
      if (legendRef.current) {
        legendRef.current.textContent = aV != null && bV != null
          ? `A ${fmtPrice(aV)}  ·  B ${fmtPrice(bV)}`
          : "";
      }
      if (premLegendRef.current) {
        premLegendRef.current.textContent = pV != null ? `${pV >= 0 ? "+" : ""}${pV.toFixed(3)}%` : "";
        premLegendRef.current.style.color = pV == null ? "var(--text-mute)" : pV > 0 ? "var(--pos)" : "var(--neg)";
      }
    };
    const onMove = (param: { seriesData: Map<unknown, unknown> }) => {
      const num = (x: unknown) => (x && typeof x === "object" && "value" in x ? (x as { value: number }).value : undefined);
      paint(num(param.seriesData.get(aS)), num(param.seriesData.get(bS)), num(param.seriesData.get(pS)));
    };
    price.subscribeCrosshairMove(onMove);
    prem.subscribeCrosshairMove(onMove);

    charts.current = { price, prem, aS, bS, pS };
    const ro = new ResizeObserver(() => {
      if (priceRef.current) price.applyOptions({ width: priceRef.current.clientWidth });
      if (premRef.current) prem.applyOptions({ width: premRef.current.clientWidth });
    });
    ro.observe(priceRef.current); ro.observe(premRef.current);
    return () => { ro.disconnect(); price.remove(); prem.remove(); charts.current = {}; };
  }, [mobile, unit, compact]);

  // 데이터 주입
  useEffect(() => {
    const c = charts.current;
    if (!c.aS || !c.bS || !c.pS || !data) return;
    const toT = (t: number) => t as unknown as Time;
    c.aS.setData(data.points.map((p) => ({ time: toT(p.t), value: p.a })));
    c.bS.setData(data.points.map((p) => ({ time: toT(p.t), value: p.b })));
    c.pS.setData(data.points.map((p) => ({ time: toT(p.t), value: p.prem })));
    // 자릿수는 그 코인의 스케일에 맞춘다 — 기본 2자리면 0.088이 전부 0.09가 된다.
    const digits = priceDigits(data.points[data.points.length - 1]?.b ?? 1);
    const pf = { type: "price" as const, precision: digits, minMove: Math.pow(10, -digits) };
    c.aS.applyOptions({ title: specLabel(data.a), priceFormat: pf });
    c.bS.applyOptions({ title: specLabel(data.b), priceFormat: pf });
    c.price?.timeScale().fitContent();
    c.prem?.timeScale().fitContent();
  }, [data]);

  // 0선 + 비용선
  useEffect(() => {
    const pS = charts.current.pS;
    if (!pS) return;
    const lines: ReturnType<ISeriesApi<"Area">["createPriceLine"]>[] = [];
    // 여기도 cssColor를 거친다 — 원시 getPropertyValue는 프로덕션에서 hsla를 돌려줘
    // createPriceLine이 던지고, 그 뒤 갭 패널 전체가 빈 채로 남았다.
    lines.push(pS.createPriceLine({
      price: 0, color: cssColor("--border-strong", "rgba(255,255,255,0.2)"),
      lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "0%",
    }));
    if (effectiveCost != null) {
      // 왕복비용 — 이 선 위로 올라간 구간만 실제로 먹을 수 있는 갭이다.
      for (const p of [effectiveCost, -effectiveCost]) {
        lines.push(pS.createPriceLine({
          price: Math.round(p * 100) / 100,
          color: cssColor("--amber", "#e8b04c"),
          lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true,
          title: p > 0 ? "비용" : "비용(역)",
        }));
      }
    }
    return () => { lines.forEach((l) => { try { pS.removePriceLine(l); } catch { /* 차트가 이미 사라짐 */ } }); };
  }, [effectiveCost, data]);

  const st = data?.stats;
  const cur = data && data.points.length ? data.points[data.points.length - 1] : null;
  const tone = (v: number) => (v > 0 ? "var(--pos)" : v < 0 ? "var(--neg)" : "var(--text)");

  return (
    <div>
      {/* 현재값 스트립 — 현재 A·B 가격 + 갭 배지 */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
        {compact && (
          <span className="tnum" style={{ fontSize: 11, color: "var(--text-mute)" }}>
            {specLabel(a)} <span style={{ color: "var(--text-dim)" }}>vs</span> {specLabel(b)}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {cur && (
          <span className="tnum" style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
            {specLabel(a)} <b style={{ color: "var(--brand-2)" }}>{fmtPrice(cur.a)}</b>
            <span style={{ color: "var(--text-mute)" }}> · </span>
            {specLabel(b)} <b style={{ color: "var(--amber)" }}>{fmtPrice(cur.b)}</b>
          </span>
        )}
        {st && (
          <span className="tnum" style={{ fontSize: compact ? 13 : 15, fontWeight: 800, color: tone(st.cur), border: `1px solid ${tone(st.cur)}`, borderRadius: 8, padding: "2px 10px" }}>
            {st.cur >= 0 ? "+" : ""}{st.cur.toFixed(3)}%
          </span>
        )}
      </div>

      {/* 가격 패널 — 오류·로딩은 차트 영역 안에 겹쳐 보여준다. 빈 차트 두 장 위에
          빨간 한 줄만 있던 예전 화면은 "깨진 것"으로 읽혔다. 실패엔 재시도 버튼이 붙는다. */}
      <div style={{ position: "relative" }}>
        {(err || (loading && !data)) && (
          <div style={{
            position: "absolute", inset: 0, zIndex: 2, display: "grid", placeItems: "center",
            background: "color-mix(in srgb, var(--card) 70%, transparent)", borderRadius: 10,
          }}>
            {err ? (
              <div style={{ textAlign: "center", maxWidth: 360, padding: "0 16px" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--neg)" }}>{coin} {specLabel(a)} vs {specLabel(b)} 조회 실패</div>
                <div style={{ marginTop: 4, fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.5 }}>{err}</div>
                <button type="button" onClick={() => void load()}
                  style={{ marginTop: 10, border: "1px solid var(--border-strong)", background: "var(--card-2)", color: "var(--text)", borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                  다시 시도
                </button>
              </div>
            ) : (
              <div style={{ fontSize: 12.5, color: "var(--text-dim)" }}>캔들 불러오는 중…</div>
            )}
          </div>
        )}
        <div ref={priceRef} style={{ width: "100%" }} />
        <div style={{ position: "absolute", left: 8, top: 4, display: "flex", gap: 10, fontSize: 10, pointerEvents: "none" }}>
          <span style={{ color: "var(--brand-2)", fontWeight: 700 }}>■ {specLabel(a)}</span>
          <span style={{ color: "var(--amber)", fontWeight: 700 }}>■ {specLabel(b)}</span>
          {!compact && <span style={{ color: "var(--text-mute)" }}>USD 환산</span>}
          <span ref={legendRef} className="tnum" style={{ color: "var(--text)", fontWeight: 700 }} />
        </div>
      </div>

      {/* 갭 패널 */}
      <div style={{ position: "relative", marginTop: 4, borderTop: "1px solid var(--border)", paddingTop: 4 }}>
        <div ref={premRef} style={{ width: "100%" }} />
        <div style={{ position: "absolute", left: 8, top: 8, fontSize: 10, color: "var(--text-mute)", pointerEvents: "none" }}>
          갭 % (A − B){effectiveCost != null ? ` · 비용선 ±${effectiveCost.toFixed(2)}%` : ""}
          <span ref={premLegendRef} className="tnum" style={{ marginLeft: 8, fontWeight: 800, fontSize: 12 }} />
        </div>
      </div>

      {/* 통계 푸터 */}
      <div className="tnum" style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11, color: "var(--text-mute)", marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
        {st ? (
          <>
            <span>캔들 {st.n}개</span>
            <span>최고 <b style={{ color: "var(--pos)" }}>{st.hi >= 0 ? "+" : ""}{st.hi.toFixed(3)}%</b></span>
            <span>최저 <b style={{ color: "var(--neg)" }}>{st.lo.toFixed(3)}%</b></span>
            <span>평균 <b style={{ color: tone(st.avg) }}>{st.avg >= 0 ? "+" : ""}{st.avg.toFixed(3)}%</b></span>
            <span style={{ flex: 1 }} />
            <span>{data?.note}</span>
          </>
        ) : !err && <span>{loading ? "불러오는 중…" : "데이터 없음"}</span>}
      </div>
    </div>
  );
}

export default PremiumChart;
