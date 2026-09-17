"use client";

// 프리미엄 차트 탭 — 코인·A/B 거래소·타임프레임 선택기 + 프리미엄 차트 코어.
//
// 차트 자체(가격 2선 / 갭% + 비용선 / 호버 리드아웃)는 PremiumChart로 뺐다 —
// 갭 검사창(GapInspect)이 같은 코어를 기회에서 자동 파라미터화해 재사용한다.
// 여긴 그 코어를 감싸는 선택 UI만 가진다.
//
// 데이터는 요청 시점에 공개 캔들 API에서 만든다(저장 안 함) — lib/premiumSeries.ts.
// 과거 구간은 종가 기준이라 호가를 가로지르는 진입/청산갭과는 다르다.

import React from "react";
import { useMemo, useState } from "react";
import { VENUE_LABEL } from "./cockpit-ui";
import { PremiumChart, specLabel, type Spec, type Market } from "./PremiumChart";

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

const SEL: React.CSSProperties = {
  background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8,
  color: "var(--text)", padding: "5px 8px", fontSize: 12, outline: "none",
};
// 칩 하나의 모양은 하나 — 타임프레임·프리셋이 같은 세그먼트 셸(GROUP) 안에서 같은 칩(CHIP)을 쓴다.
// 예전엔 타임프레임은 맨칩, 프리셋은 테두리칩이라 한 툴바에 컨트롤 양식이 셋이었다.
const GROUP: React.CSSProperties = {
  display: "inline-flex", gap: 2, padding: 3, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 9,
};
const CHIP = (on: boolean): React.CSSProperties => ({
  border: "none", borderRadius: 7, padding: "4px 10px", fontSize: 11.5, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
  background: on ? "var(--brand-soft)" : "transparent", color: on ? "var(--brand-2)" : "var(--text-dim)",
  transition: "background 120ms, color 120ms",
});

export function PremiumPanel({ mobile }: { mobile?: boolean }) {
  const [coin, setCoin] = useState("BTC");
  const [draft, setDraft] = useState("BTC");
  const [a, setA] = useState<Spec>({ venue: "upbit", market: "spot" });
  const [b, setB] = useState<Spec>({ venue: "binance", market: "spot" });
  const [unit, setUnit] = useState(3);
  const [busy, setBusy] = useState(false);

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
        {/* 헤더 */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 700 }}>프리미엄 차트</span>
          <span className="tnum" style={{ fontSize: 11.5, color: "var(--text-mute)" }}>
            {specLabel(a)} <span style={{ color: "var(--text-dim)" }}>vs</span> {specLabel(b)}
          </span>
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
          <button type="button" onClick={() => setCoin(draft.trim().toUpperCase())}
            style={{ border: "none", borderRadius: 8, padding: "6px 14px", background: "var(--brand)", color: "var(--brand-ink)", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
            {busy ? "조회 중…" : "조회"}
          </button>
        </div>

        {/* 타임프레임 · 프리셋 — 같은 세그먼트 셸, 라벨은 왼쪽에 작게 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          <span style={{ fontSize: 10.5, color: "var(--text-mute)", minWidth: 34 }}>주기</span>
          <div className="no-bar" style={{ ...GROUP, overflowX: "auto", maxWidth: "100%" }}>
            {UNITS.map((x) => (
              <button key={x.u} type="button" onClick={() => setUnit(x.u)} style={CHIP(unit === x.u)}>{x.label}</button>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <span style={{ fontSize: 10.5, color: "var(--text-mute)", minWidth: 34 }}>프리셋</span>
          <div className="no-bar" style={{ ...GROUP, overflowX: "auto", maxWidth: "100%" }}>
            {PRESETS.map((p, i) => (
              <button key={p.label} type="button" onClick={() => { setA(p.a); setB(p.b); }} style={CHIP(preset === i)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* 차트 코어 — 비용선은 스캔에서 자동 조회(costPct 미지정) */}
        <PremiumChart coin={coin} a={a} b={b} unit={unit} mobile={mobile} onBusy={setBusy} />
      </div>
    </div>
  );
}

export default PremiumPanel;
