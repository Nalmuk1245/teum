"use client";

import React from "react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Opportunity, Quote, StrategyKind } from "@/lib/types";
import { pct, usd, price, dur } from "@/lib/format";
import { type LiveAges, type LiveGap, type LiveStatus } from "@/lib/useLivePrices";
import { buildPlan, type AutoLevel, type ExecStep, type StepPhase } from "@/lib/execPlan";
import { useRuns, startRun, confirmRun, retryRun, cancelRun, unwindRun, clearFinished, setKillSwitch, inFlightUsd, setInFlightLimit, type RunView } from "@/lib/runStore";

export const KIND_META: Record<StrategyKind, { label: string; color: string }> = {
  kimchi: { label: "김프", color: "var(--brand-2)" },
  "cross-cex": { label: "크로스", color: "var(--sky)" },
  "funding-basis": { label: "펀딩", color: "var(--amber)" },
  "cex-dex": { label: "CEX-DEX", color: "var(--teal)" },
};

export const KINDS = Object.keys(KIND_META) as StrategyKind[];

// 김프/역프 방향 라벨 — kimchi 전략은 방향이 둘이다: 해외 매수 → KR(업비트·빗썸)
// 매도 = 김프, KR 매수 → 해외 매도 = 역프. 다른 전략은 KIND_META 라벨 그대로.
export const KR_VENUES = new Set(["upbit", "bithumb"]);
export function kindLabel(kind: string, buyVenue?: string, sellVenue?: string): string {
  if (kind === "kimchi") return buyVenue && KR_VENUES.has(buyVenue) ? "역프" : "김프";
  return KIND_META[kind as StrategyKind]?.label ?? kind;
}
/** 김프·역프는 방향이 반대라 색도 나눈다. 다른 전략은 KIND_META 색. */
export function kindColor(kind: string, buyVenue?: string): string {
  if (kind === "kimchi") return buyVenue && KR_VENUES.has(buyVenue) ? "var(--rkimchi)" : "var(--kimchi)";
  return KIND_META[kind as StrategyKind]?.color ?? "var(--text-dim)";
}
export function oppKindColor(o: Opportunity): string {
  return kindColor(o.kind, o.legs.find((l) => l.side === "buy")?.venue);
}
export function oppKindLabel(o: Opportunity): string {
  return kindLabel(
    o.kind,
    o.legs.find((l) => l.side === "buy")?.venue,
    o.legs.find((l) => l.side === "sell")?.venue,
  );
}
// Funding has its own tab — the gap board/filter only covers one-shot strategies.

export const GAP_KINDS = KINDS.filter((k) => k !== "funding-basis");

// Live net crossing this fires the spike alert (beep + notification + flash).

export const ALERT_NET_PCT = 0.5;

// Short attention beep via WebAudio — no asset file needed.

export function beep() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.36);
    osc.onended = () => void ctx.close();
  } catch { /* audio blocked until first user gesture — fine */ }
}

export function Tile({
  label, value, sub, tone, compact,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
  compact?: boolean;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)", padding: compact ? "10px 11px" : "12px 14px",
      }}
    >
      <div
        className="tnum"
        style={{ color: tone ?? "var(--text)", fontSize: compact ? 20 : 22, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1 }}
      >
        {value}
      </div>
      <div style={{ color: "var(--text-mute)", fontSize: 10.5, fontWeight: 500, letterSpacing: "0.04em", marginTop: 7, whiteSpace: "nowrap" }}>
        {label}{sub ? <span style={{ opacity: 0.8 }}> · {sub}</span> : null}
      </div>
    </div>
  );
}

// ── Board ─────────────────────────────────────────────────────────────────────

export const COLS = "108px minmax(0,1fr) minmax(0,1.5fr) 74px 66px 64px 84px 84px 104px";

/** 우측 검사창이 열려 표 폭이 ~800px일 때 — 총차익·비용·추이는 검사창(분해·30분 히스토리)이
 *  보여주니 뺀다. 경로가 잘리면 표가 쓸모없어진다. */
export const COLS_NARROW = "44px minmax(150px,1fr) minmax(190px,1.25fr) 76px 92px 72px";

export const COLS_MON = "108px minmax(0,1fr) minmax(0,1.5fr) 74px 66px 64px 84px 84px"; // monitor: no execute column

/** 행 스파크라인 — 30분 net% 추이 (gross 시계열 − 현재 비용 근사).
 *  숫자 하나(순수익)는 "지금"만 말한다. 이 갭이 커지는 중인지 무너지는 중인지는
 *  모양이 말해주고, 그게 실행/관망 판단의 절반이다. 0선을 함께 그려 흑자 구간이
 *  한눈에 보이게 한다. */
export function Spark({ data, costPct }: { data?: number[]; costPct: number }) {
  if (!data || data.length < 2) return <span style={{ color: "var(--text-mute)", fontSize: 10, textAlign: "right", display: "block" }}>—</span>;
  const W = 56, HGT = 18, PAD = 1.5;
  const net = data.map((g) => g - costPct);
  let min = Math.min(...net, 0), max = Math.max(...net, 0);
  if (max - min < 0.1) { const mid = (max + min) / 2; min = mid - 0.05; max = mid + 0.05; } // 평평한 시계열도 선이 보이게
  const y = (v: number) => PAD + (HGT - 2 * PAD) * (1 - (v - min) / (max - min));
  const x = (i: number) => PAD + (W - 2 * PAD) * (i / (net.length - 1));
  const pts = net.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = net[net.length - 1];
  const tone = last > 0 ? "var(--pos)" : "var(--text-mute)";
  return (
    <svg width={W} height={HGT} viewBox={`0 0 ${W} ${HGT}`} style={{ display: "block", justifySelf: "end" }} aria-hidden>
      {/* 0선 — 이 위가 흑자 */}
      <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="var(--border-strong)" strokeWidth={1} strokeDasharray="2 3" />
      <polyline points={pts} fill="none" stroke={tone} strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />
      <circle cx={x(net.length - 1)} cy={y(last)} r={1.8} fill={tone} />
    </svg>
  );
}

export function Empty({ text, hint }: { text: string; hint?: string }) {
  return (
    <div style={{ padding: "48px 18px", textAlign: "center", color: "var(--text-dim)", fontSize: 14 }}>
      <div>{text}</div>
      {hint && <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-mute)" }}>{hint}</div>}
    </div>
  );
}

// ── Execute modal ─────────────────────────────────────────────────────────────

export function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px" }}>
      <div style={{ fontSize: 10, color: "var(--text-mute)" }}>{label}</div>
      <div className="tnum" style={{ fontSize: 15, fontWeight: 800, color: tone ?? "var(--text)" }}>{value}</div>
      {sub && <div style={{ fontSize: 9.5, color: "var(--text-mute)" }}>{sub}</div>}
    </div>
  );
}

export function Line({
  label, value, valueColor, strong, dim,
}: {
  label: string;
  value: string;
  valueColor?: string;
  strong?: boolean;
  dim?: boolean;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: 13 }}>
      <span style={{ color: dim ? "var(--text-mute)" : "var(--text-dim)", fontWeight: strong ? 600 : 400 }}>{label}</span>
      <span className="tnum" style={{ color: valueColor ?? (dim ? "var(--text-mute)" : "var(--text)"), fontWeight: strong ? 700 : 500 }}>
        {value}
      </span>
    </div>
  );
}

export function Warn({ text }: { text: string }) {
  return (
    <div style={{ marginTop: 8, padding: "7px 10px", borderRadius: 6, background: "var(--neg-soft)", color: "var(--neg)", fontSize: 11.5, fontWeight: 500 }}>
      {text}
    </div>
  );
}

// Withdraw/deposit leg: status on top, its transfer network (+ confirms) beneath.

export function LegRow({
  label, statusText, statusColor, chain, confirms,
}: {
  label: string;
  statusText: string;
  statusColor: string;
  chain?: string;
  confirms?: number;
}) {
  return (
    <div style={{ padding: "4px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
        <span style={{ color: "var(--text-dim)" }}>{label}</span>
        <span className="tnum" style={{ color: statusColor, fontWeight: 500 }}>{statusText}</span>
      </div>
      {chain && (
        <div style={{ fontSize: 11, color: "var(--text-mute)", marginTop: 1 }}>
          {chain}
          {confirms ? ` · 컨펌 ${confirms}회` : ""}
        </div>
      )}
    </div>
  );
}

// ── Transfer / settlement gate panel ──────────────────────────────────────────

export const VENUE_LABEL: Record<string, string> = {
  binance: "Binance", upbit: "Upbit", bithumb: "Bithumb",
  bybit: "Bybit", okx: "OKX", uniswap: "Uniswap",
  hyperliquid: "Hyperliquid", lighter: "Lighter", dex: "DEX",
};

export const vlabel = (v?: string) => (v ? VENUE_LABEL[v] ?? v : "—");

// ── 거래소 딥링크 — 그 코인의 거래 화면을 바로 연다 ──────────────────────────
// 수동 매매는 결국 거래소 화면에서 하게 되는데, 매번 앱을 열고 검색하는 왕복이
// 상장 순간엔 곧 놓친 시간이다. 표준 웹 URL이라 폰에선 유니버설 링크로 앱이
// 열리고, PC에선 새 탭이다. 지원 안 하는 venue는 null — 호출부가 링크를 안 단다.
export function venueTradeUrl(venue: string, base: string): string | null {
  const b = base.toUpperCase();
  switch (venue) {
    case "upbit": return `https://upbit.com/exchange?code=CRIX.UPBIT.KRW-${b}`;
    case "bithumb": return `https://www.bithumb.com/react/trade/order/${b}-KRW`;
    case "binance": return `https://www.binance.com/en/trade/${b}_USDT`;
    case "bybit": return `https://www.bybit.com/en/trade/spot/${b}/USDT`;
    case "okx": return `https://www.okx.com/trade-spot/${b.toLowerCase()}-usdt`;
    default: return null;
  }
}

/** 거래소명 + ↗ 링크. url이 없으면 라벨만 (링크 없는 척 안 한다). */
export function VenueLink({ venue, base, label: labelOverride, style }: { venue: string; base: string; label?: string; style?: React.CSSProperties }) {
  const url = venueTradeUrl(venue, base);
  const label = labelOverride ?? vlabel(venue) ?? venue;
  if (!url) return <span style={style}>{label}</span>;
  return (
    <a href={url} target="_blank" rel="noreferrer" title={`${label}에서 ${base.toUpperCase()} 거래 화면 열기`}
      // 클릭이 행 선택 등 부모 핸들러로 번지지 않게 — 링크는 링크만 한다.
      onClick={(e) => e.stopPropagation()}
      style={{ color: "inherit", textDecoration: "none", ...style }}>
      {label}<span style={{ fontSize: "0.85em", opacity: 0.6, marginLeft: 2 }}>↗</span>
    </a>
  );
}

export const WL_KEY = "ac.whitelist.v1";

export function statusChip(enabled: boolean | null): { t: string; c: string } {
  if (enabled === true) return { t: "가능", c: "var(--pos)" };
  if (enabled === false) return { t: "중단", c: "var(--neg)" };
  return { t: "키 필요", c: "var(--text-mute)" };
}

export function FundingCountdown({ meta }: { meta: NonNullable<Opportunity["fundingMeta"]> }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((v) => v + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!meta.nextTs) return null;
  const left = meta.nextTs - Date.now();
  if (left <= 0) return null;
  const h = Math.floor(left / 3600_000);
  const m = Math.floor((left % 3600_000) / 60_000);
  const soon = left < 30 * 60_000; // <30m — entering now captures this window
  return (
    <span
      className="tnum"
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        fontSize: 10.5, fontWeight: 600,
        color: soon ? "var(--amber)" : "var(--text-mute)",
      }}
    >
      다음 정산 {h > 0 ? `${h}h ` : ""}{m}m{soon ? " · 임박" : ""}
    </span>
  );
}

// Gap persistence chip — how long the edge has held (flicker vs sustained).

export function PersistChip({ p }: { p?: Opportunity["persistence"] }) {
  if (!p || p.samples < 2) return null;
  const held = p.heldSec;
  const sustained = held >= 24;
  const label = dur(held);
  const tone = held <= 0 ? "var(--text-mute)" : sustained ? "var(--pos)" : "var(--amber)";
  return (
    <span
      className="tnum"
      title={`지속 ${label} · 적중률 ${p.hitRatePct}%`}
      style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 600, color: tone, whiteSpace: "nowrap", flex: "0 0 auto" }}
    >
      <span style={{ width: 4, height: 4, borderRadius: 6, background: tone }} />
      {held <= 0 ? "신규" : `지속 ${label}`}
    </span>
  );
}

// Board freshness: live WS overlay active, or seconds since the last scan.

export function ScanAge({ ts, live }: { ts: number; live: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const age = ts ? Math.max(0, Math.round((Date.now() - ts) / 1000)) : null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, color: "var(--text-mute)" }}>
      {live && (
        <>
          <span style={{ width: 5, height: 5, borderRadius: 6, background: "var(--pos)" }} />
          <span style={{ color: "var(--pos)", fontWeight: 600 }}>실시간</span>
          <span>·</span>
        </>
      )}
      <span className="tnum">{age == null ? "스캔 대기" : `스캔 ${age}s 전`}</span>
    </span>
  );
}

// ── small bits ────────────────────────────────────────────────────────────────
// Venue chips with data freshness (var1 idea) — "몇 초 전 데이터인가"가 아비에선
// 연결 여부보다 중요한 신호다.

export function LiveDots({ status, ages, isMobile }: { status: LiveStatus; ages: LiveAges; isMobile?: boolean }) {
  const chip = (on: boolean, age: number | null, label: string) => {
    const fresh = on && age != null && age <= 5;
    const tone = fresh ? "var(--pos)" : on ? "var(--amber)" : "var(--text-mute)";
    const full = label === "BN" ? "Binance" : label === "UP" ? "Upbit" : "Bithumb";
    // 미연결 칩은 점만 회색으로 두지 않는다 — 점선 테두리 + "—"로 "데이터 없음"을 읽히게.
    return (
      <span
        key={label}
        title={on ? `${full} 시세 · ${age != null ? age + "초 전" : "수신 대기"}` : `${full} 미연결 — 웹소켓 끊김 또는 키 미설정`}
        style={{
          display: "inline-flex", alignItems: "center", gap: 4,
          border: `1px ${on ? "solid" : "dashed"} ${on ? "var(--border)" : "var(--border-strong)"}`, borderRadius: 6,
          padding: isMobile ? "2px 5px" : "2px 7px",
          background: on ? "var(--card)" : "transparent",
          opacity: on ? 1 : 0.75,
        }}
      >
        <span style={{ width: 5, height: 5, borderRadius: 6, background: tone }} />
        <span className="tnum" style={{ fontSize: 10, fontWeight: 600, color: on ? "var(--text-dim)" : "var(--text-mute)" }}>
          {label}
          {!isMobile && <span style={{ color: "var(--text-mute)", fontWeight: 400 }}> {on ? (age != null ? `${age}s` : "…") : "—"}</span>}
        </span>
      </span>
    );
  };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginRight: 2 }}>
      {chip(status.binance, ages.binance, "BN")}
      {chip(status.upbit, ages.upbit, "UP")}
      {chip(status.bithumb, ages.bithumb, "BT")}
    </span>
  );
}

export function Pill({
  text, tone, soft, dot,
}: {
  text: string;
  tone: string;
  soft?: boolean;
  dot?: boolean;
}) {
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        border: `1px solid ${soft ? "transparent" : tone}`,
        background: soft ? "color-mix(in srgb, " + tone + " 14%, transparent)" : "transparent",
        color: tone, fontSize: 11.5, fontWeight: 600, borderRadius: 6, padding: "4px 9px",
        // 헤더가 좁아져도 글자를 세로로 쪼개지 않는다 — 모바일에서 "페이퍼"가 3줄이 됐다.
        whiteSpace: "nowrap", flex: "0 0 auto",
      }}
    >
      {dot && <span style={{ width: 7, height: 7, borderRadius: 6, background: tone }} />}
      {text}
    </span>
  );
}

export const xBtn: React.CSSProperties = {
  background: "transparent", border: "1px solid var(--border-strong)",
  color: "var(--text-dim)", fontSize: 13, borderRadius: 6, padding: "4px 9px", cursor: "pointer",
};
