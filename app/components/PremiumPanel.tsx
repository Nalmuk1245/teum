"use client";

// 프리미엄 차트 — 두 거래소의 가격을 같은 축에 겹치고, 그 갭(%)을 아래 패널에.
//
// 위: A·B의 USD 환산 가격(선). 아래: 갭 % + 0선 + 비용선.
// 비용선이 이 화면의 핵심이다 — "갭이 몇 %냐"가 아니라 "비용을 넘겼냐"가
// 판단이라서, 임의 목표선 대신 실제 왕복비용(수수료·출금비·환전 스프레드)을
// 긋는다. 선 위로 올라간 구간만 진짜 기회다.
//
// 데이터는 요청 시점에 공개 캔들 API에서 만든다(저장 안 함) — lib/premiumSeries.ts.
// 과거 구간은 종가 기준이라 호가를 가로지르는 진입/청산갭과는 다르다.

import React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createChart, ColorType, LineStyle, type IChartApi, type ISeriesApi, type Time } from "lightweight-charts";
import { VENUE_LABEL } from "./cockpit-ui";

type Market = "spot" | "futures";
type Spec = { venue: string; market: Market };
type Point = { t: number; a: number; b: number; prem: number };
type Series = {
  coin: string; a: Spec; b: Spec; unit: number;
  points: Point[];
  stats: { n: number; hi: number; lo: number; avg: number; cur: number } | null;
  note: string;
};

const UNITS: { u: number; label: string }[] = [
  { u: 1, label: "1분" }, { u: 3, label: "3분" }, { u: 5, label: "5분" }, { u: 15, label: "15분" },
  { u: 30, label: "30분" }, { u: 60, label: "1시간" }, { u: 240, label: "4시간" }, { u: 1440, label: "1일" },
];

// 레퍼런스의 프리셋 — 자주 보는 A/B 조합을 한 번에.
const PRESETS: { label: string; a: Spec; b: Spec }[] = [
  { label: "김프(현물)", a: { venue: "upbit", market: "spot" }, b: { venue: "binance", market: "spot" } },
  { label: "김프(선물)", a: { venue: "upbit", market: "spot" }, b: { venue: "binance", market: "futures" } },
  { label: "빗썸 김프", a: { venue: "bithumb", market: "spot" }, b: { venue: "binance", market: "spot" } },
  { label: "국내갭", a: { venue: "upbit", market: "spot" }, b: { venue: "bithumb", market: "spot" } },
  { label: "현선갭 Binance", a: { venue: "binance", market: "spot" }, b: { venue: "binance", market: "futures" } },
  { label: "현선갭 Bybit", a: { venue: "bybit", market: "spot" }, b: { venue: "bybit", market: "futures" } },
  { label: "거래소갭 현물", a: { venue: "binance", market: "spot" }, b: { venue: "bybit", market: "spot" } },
  { label: "거래소갭 선물", a: { venue: "binance", market: "futures" }, b: { venue: "bybit", market: "futures" } },
];

const KR = (v: string) => v === "upbit" || v === "bithumb";
const specLabel = (s: Spec) => `${VENUE_LABEL[s.venue] ?? s.venue} ${s.market === "futures" ? "선물" : "현물"}`;
const specParam = (s: Spec) => `${s.venue}:${s.market}`;

const SEL: React.CSSProperties = {
  background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8,
  color: "var(--text)", padding: "5px 8px", fontSize: 12, outline: "none",
};
const CHIP = (on: boolean): React.CSSProperties => ({
  border: "none", borderRadius: 7, padding: "4px 10px", fontSize: 11.5, fontWeight: 700, cursor: "pointer",
  background: on ? "var(--brand-soft)" : "transparent", color: on ? "var(--brand-2)" : "var(--text-mute)",
});

export function PremiumPanel({ mobile }: { mobile?: boolean }) {
  const [coin, setCoin] = useState("BTC");
  const [draft, setDraft] = useState("BTC");
  const [a, setA] = useState<Spec>({ venue: "upbit", market: "spot" });
  const [b, setB] = useState<Spec>({ venue: "binance", market: "spot" });
  const [unit, setUnit] = useState(3);
  const [data, setData] = useState<Series | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 왕복비용(%) — 스캔 보드가 이 코인에 쓰는 실제 비용. 없으면 선을 안 긋는다. */
  const [costPct, setCostPct] = useState<number | null>(null);

  const load = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const q = `coin=${encodeURIComponent(coin)}&a=${specParam(a)}&b=${specParam(b)}&unit=${unit}&count=${unit >= 240 ? 500 : 400}`;
      const j = await (await fetch(`/api/premium?${q}`, { cache: "no-store" })).json();
      if (j.error) { setErr(j.error); setData(null); } else { setData(j); }
    } catch { setErr("조회 실패"); setData(null); }
    finally { setBusy(false); }
  }, [coin, a, b, unit]);
  useEffect(() => { void load(); }, [load]);

  // 비용선 — 현재 스캔 스냅샷에서 같은 코인의 비용을 가져온다 (김프 조합일 때만
  // 의미가 있다: 보드의 비용 모델이 KR↔글로벌 전송형 기준이라서).
  const costRelevant = KR(a.venue) !== KR(b.venue);
  useEffect(() => {
    if (!costRelevant) { setCostPct(null); return; }
    let stop = false;
    fetch("/api/scan", { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (stop) return;
      const hit = (j.opportunities ?? []).find(
        (o: { base: string; kind: string; costPct: number; mock?: boolean }) =>
          !o.mock && o.base === coin && o.kind === "kimchi",
      );
      setCostPct(hit ? hit.costPct : null);
    }).catch(() => {});
    return () => { stop = true; };
  }, [coin, costRelevant]);

  // ── 차트 ──
  const priceRef = useRef<HTMLDivElement>(null);
  const premRef = useRef<HTMLDivElement>(null);
  const charts = useRef<{ price?: IChartApi; prem?: IChartApi; aS?: ISeriesApi<"Line">; bS?: ISeriesApi<"Line">; pS?: ISeriesApi<"Area"> }>({});

  useEffect(() => {
    if (!priceRef.current || !premRef.current) return;
    const css = getComputedStyle(document.documentElement);
    const v = (n: string, f: string) => css.getPropertyValue(n).trim() || f;
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
    const price = createChart(priceRef.current, { ...base, height: mobile ? 180 : 300 });
    const prem = createChart(premRef.current, { ...base, height: mobile ? 150 : 210 });
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

    charts.current = { price, prem, aS, bS, pS };
    const ro = new ResizeObserver(() => {
      if (priceRef.current) price.applyOptions({ width: priceRef.current.clientWidth });
      if (premRef.current) prem.applyOptions({ width: premRef.current.clientWidth });
    });
    ro.observe(priceRef.current); ro.observe(premRef.current);
    return () => { ro.disconnect(); price.remove(); prem.remove(); charts.current = {}; };
  }, [mobile, unit]);

  // 데이터 주입
  useEffect(() => {
    const c = charts.current;
    if (!c.aS || !c.bS || !c.pS || !data) return;
    const toT = (t: number) => t as unknown as Time;
    c.aS.setData(data.points.map((p) => ({ time: toT(p.t), value: p.a })));
    c.bS.setData(data.points.map((p) => ({ time: toT(p.t), value: p.b })));
    c.pS.setData(data.points.map((p) => ({ time: toT(p.t), value: p.prem })));
    c.aS.applyOptions({ title: specLabel(data.a) });
    c.bS.applyOptions({ title: specLabel(data.b) });
    c.price?.timeScale().fitContent();
    c.prem?.timeScale().fitContent();
  }, [data]);

  // 0선 + 비용선
  useEffect(() => {
    const pS = charts.current.pS;
    if (!pS) return;
    const lines: ReturnType<ISeriesApi<"Area">["createPriceLine"]>[] = [];
    const css = getComputedStyle(document.documentElement);
    lines.push(pS.createPriceLine({
      price: 0, color: css.getPropertyValue("--border-strong").trim() || "rgba(255,255,255,0.2)",
      lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "0%",
    }));
    if (costPct != null) {
      // 왕복비용 — 이 선 위로 올라간 구간만 실제로 먹을 수 있는 갭이다.
      for (const p of [costPct, -costPct]) {
        lines.push(pS.createPriceLine({
          price: Math.round(p * 100) / 100,
          color: css.getPropertyValue("--amber").trim() || "#e8b04c",
          lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true,
          title: p > 0 ? "비용" : "비용(역)",
        }));
      }
    }
    return () => { lines.forEach((l) => { try { pS.removePriceLine(l); } catch { /* 차트가 이미 사라짐 */ } }); };
  }, [costPct, data]);

  const st = data?.stats;
  const tone = (v: number) => (v > 0 ? "var(--pos)" : v < 0 ? "var(--neg)" : "var(--text)");
  const preset = useMemo(
    () => PRESETS.findIndex((p) => p.a.venue === a.venue && p.a.market === a.market && p.b.venue === b.venue && p.b.market === b.market),
    [a, b],
  );

  const venueSelect = (cur: Spec, set: (s: Spec) => void) => (
    <>
      <select value={cur.venue} onChange={(e) => {
        const venue = e.target.value;
        set({ venue, market: KR(venue) ? "spot" : cur.market });
      }} style={SEL}>
        {["upbit", "bithumb", "binance", "bybit"].map((v) => <option key={v} value={v}>{VENUE_LABEL[v] ?? v}</option>)}
      </select>
      <select value={cur.market} onChange={(e) => set({ ...cur, market: e.target.value as Market })} style={{ ...SEL, opacity: KR(cur.venue) ? 0.5 : 1 }} disabled={KR(cur.venue)}>
        <option value="spot">현물</option>
        <option value="futures">선물</option>
      </select>
    </>
  );

  return (
    <div style={{ paddingBottom: 40 }}>
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: mobile ? "12px 12px" : "14px 16px" }}>
        {/* 헤더 — 현재값 */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 700 }}>프리미엄 차트</span>
          {data && (
            <span className="tnum" style={{ fontSize: 11.5, color: "var(--text-mute)" }}>
              {specLabel(data.a)} <span style={{ color: "var(--text-dim)" }}>vs</span> {specLabel(data.b)}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {st && (
            <span className="tnum" style={{ fontSize: 15, fontWeight: 800, color: tone(st.cur), border: `1px solid ${tone(st.cur)}`, borderRadius: 8, padding: "2px 10px" }}>
              {st.cur >= 0 ? "+" : ""}{st.cur.toFixed(3)}%
            </span>
          )}
        </div>

        {/* 컨트롤 */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === "Enter") setCoin(draft.trim().toUpperCase()); }}
            placeholder="코인"
            style={{ ...SEL, width: 88, fontWeight: 700 }}
          />
          <span style={{ fontSize: 11, color: "var(--text-mute)" }}>A</span>
          {venueSelect(a, setA)}
          <span style={{ fontSize: 11, color: "var(--text-mute)" }}>vs B</span>
          {venueSelect(b, setB)}
          <button type="button" onClick={() => { setCoin(draft.trim().toUpperCase()); void load(); }}
            style={{ border: "none", borderRadius: 8, padding: "6px 14px", background: "var(--brand)", color: "var(--brand-ink)", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
            {busy ? "조회 중…" : "조회"}
          </button>
        </div>

        {/* 타임프레임 */}
        <div style={{ display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap", marginBottom: 8 }}>
          {UNITS.map((x) => (
            <button key={x.u} type="button" onClick={() => setUnit(x.u)} style={CHIP(unit === x.u)}>{x.label}</button>
          ))}
        </div>

        {/* 프리셋 */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", marginBottom: 10 }}>
          <span style={{ fontSize: 10.5, color: "var(--text-mute)", marginRight: 2 }}>프리셋</span>
          {PRESETS.map((p, i) => (
            <button key={p.label} type="button" onClick={() => { setA(p.a); setB(p.b); }}
              style={{ ...CHIP(preset === i), border: "1px solid var(--border)", fontWeight: 600 }}>
              {p.label}
            </button>
          ))}
        </div>

        {err && <div style={{ fontSize: 12, color: "var(--neg)", padding: "8px 0" }}>{err}</div>}

        {/* 가격 패널 */}
        <div style={{ position: "relative" }}>
          <div ref={priceRef} style={{ width: "100%" }} />
          <div style={{ position: "absolute", left: 8, top: 4, display: "flex", gap: 10, fontSize: 10, pointerEvents: "none" }}>
            <span style={{ color: "var(--brand-2)", fontWeight: 700 }}>■ {specLabel(a)}</span>
            <span style={{ color: "var(--amber)", fontWeight: 700 }}>■ {specLabel(b)}</span>
            <span style={{ color: "var(--text-mute)" }}>USD 환산</span>
          </div>
        </div>

        {/* 갭 패널 */}
        <div style={{ position: "relative", marginTop: 4, borderTop: "1px solid var(--border)", paddingTop: 4 }}>
          <div ref={premRef} style={{ width: "100%" }} />
          <div style={{ position: "absolute", left: 8, top: 8, fontSize: 10, color: "var(--text-mute)", pointerEvents: "none" }}>
            갭 % (A − B){costPct != null ? ` · 비용선 ±${costPct.toFixed(2)}%` : ""}
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
          ) : !err && <span>불러오는 중…</span>}
        </div>
      </div>
    </div>
  );
}

export default PremiumPanel;
