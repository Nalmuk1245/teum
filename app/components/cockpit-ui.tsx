"use client";

import React from "react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Opportunity, Quote, StrategyKind } from "@/lib/types";
import { pct, usd, price } from "@/lib/format";
import { type LiveAges, type LiveGap, type LiveStatus } from "@/lib/useLivePrices";
import { buildPlan, type AutoLevel, type ExecStep, type StepPhase } from "@/lib/executionPlan";
import { useRuns, startRun, confirmRun, retryRun, cancelRun, unwindRun, clearFinished, setKillSwitch, inFlightUsd, setInFlightLimit, type RunView } from "@/lib/runStore";

export const KIND_META: Record<StrategyKind, { label: string; color: string }> = {
  kimchi: { label: "김프", color: "var(--brand-2)" },
  "cross-cex": { label: "크로스", color: "var(--sky)" },
  "funding-basis": { label: "펀딩", color: "var(--amber)" },
  "cex-dex": { label: "CEX-DEX", color: "var(--teal)" },
};

export const KINDS = Object.keys(KIND_META) as StrategyKind[];
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
        background: "var(--card)", border: "1px solid var(--border)",
        borderRadius: "var(--radius)", padding: compact ? "8px 10px" : "10px 14px",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div style={{ color: "var(--text-dim)", fontSize: compact ? 11 : 12, fontWeight: 500, whiteSpace: "nowrap" }}>{label}</div>
      <div
        className="tnum"
        style={{ color: tone ?? "var(--text)", fontSize: compact ? 17 : 20, fontWeight: 700, letterSpacing: "-0.02em", marginTop: compact ? 3 : 4 }}
      >
        {value}
      </div>
      {sub && <div style={{ color: "var(--text-mute)", fontSize: compact ? 10 : 11, marginTop: 2, whiteSpace: "nowrap" }}>{sub}</div>}
    </div>
  );
}

// ── Board ─────────────────────────────────────────────────────────────────────

export const COLS = "108px minmax(0,1fr) minmax(0,1.5fr) 74px 66px 84px 84px 104px";

export const COLS_MON = "108px minmax(0,1fr) minmax(0,1.5fr) 74px 66px 84px 84px"; // monitor: no execute column

export function Empty({ text }: { text: string }) {
  return (
    <div style={{ padding: "56px 18px", textAlign: "center", color: "var(--text-mute)", fontSize: 14 }}>
      {text}
    </div>
  );
}

// ── Execute modal ─────────────────────────────────────────────────────────────

export function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px" }}>
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
    <div style={{ marginTop: 8, padding: "7px 10px", borderRadius: 8, background: "var(--neg-soft)", color: "var(--neg)", fontSize: 11.5, fontWeight: 500 }}>
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
  const label = held >= 60 ? `${Math.floor(held / 60)}m${held % 60 ? ` ${held % 60}s` : ""}` : `${held}s`;
  const tone = held <= 0 ? "var(--text-mute)" : sustained ? "var(--pos)" : "var(--amber)";
  return (
    <span
      className="tnum"
      title={`지속 ${label} · 적중률 ${p.hitRatePct}%`}
      style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 600, color: tone }}
    >
      <span style={{ width: 4, height: 4, borderRadius: 999, background: tone }} />
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
          <span style={{ width: 5, height: 5, borderRadius: 999, background: "var(--pos)" }} />
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
    return (
      <span
        key={label}
        title={`${label} · ${age != null ? age + "s 전" : "미수신"}`}
        style={{
          display: "inline-flex", alignItems: "center", gap: 4,
          border: "1px solid var(--border)", borderRadius: 4,
          padding: isMobile ? "2px 5px" : "2px 7px",
          background: "var(--card)",
        }}
      >
        <span style={{ width: 5, height: 5, borderRadius: 999, background: tone }} />
        <span className="tnum" style={{ fontSize: 10, fontWeight: 600, color: on ? "var(--text-dim)" : "var(--text-mute)" }}>
          {label}
          {!isMobile && age != null && <span style={{ color: "var(--text-mute)", fontWeight: 400 }}> {age}s</span>}
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
        color: tone, fontSize: 12, fontWeight: 600, borderRadius: 999, padding: "5px 11px",
      }}
    >
      {dot && <span style={{ width: 7, height: 7, borderRadius: 999, background: tone }} />}
      {text}
    </span>
  );
}

export const xBtn: React.CSSProperties = {
  background: "transparent", border: "1px solid var(--border-strong)",
  color: "var(--text-dim)", fontSize: 13, borderRadius: 8, padding: "4px 9px", cursor: "pointer",
};
