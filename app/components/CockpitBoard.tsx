"use client";

import React from "react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Opportunity, Quote, StrategyKind } from "@/lib/types";
import { pct, usd, price } from "@/lib/format";
import { type LiveAges, type LiveGap, type LiveStatus } from "@/lib/useLivePrices";
import { buildPlan, type AutoLevel, type ExecStep, type StepPhase } from "@/lib/executionPlan";
import { useRuns, startRun, confirmRun, retryRun, cancelRun, unwindRun, clearFinished, setKillSwitch, inFlightUsd, setInFlightLimit, type RunView } from "@/lib/runStore";
import { KIND_META, KINDS, GAP_KINDS, ALERT_NET_PCT, beep, Tile, COLS, COLS_MON, Empty, Metric, Line, Warn, LegRow, VENUE_LABEL, vlabel, WL_KEY, statusChip, FundingCountdown, PersistChip, ScanAge, LiveDots, Pill, xBtn } from "./cockpit-ui";

export function Board({
  rows, loading, onExecute, mobile, showExecute, live, flash,
}: {
  rows: Opportunity[];
  loading: boolean;
  onExecute: (o: Opportunity) => void;
  mobile?: boolean;
  showExecute?: boolean;
  live?: Record<string, LiveGap>;
  flash?: Set<string>;
}) {
  return (
    <div
      style={{
        background: "var(--card)", border: "1px solid var(--border)",
        borderRadius: "var(--radius)", overflow: "hidden", boxShadow: "var(--shadow-sm)",
      }}
    >
      {!mobile && (
        <div
          style={{
            display: "grid", gridTemplateColumns: showExecute ? COLS : COLS_MON, gap: 10,
            padding: "7px 12px", color: "var(--text-mute)", fontSize: 10.5,
            fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span>전략</span>
          <span>종목</span>
          <span>경로</span>
          <span style={{ textAlign: "right" }}>총차익</span>
          <span style={{ textAlign: "right" }}>비용</span>
          <span style={{ textAlign: "right" }}>순수익</span>
          <span style={{ textAlign: "right" }}>한도</span>
          {showExecute && <span />}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <Empty text="시장 스캔 중…" />
      ) : rows.length === 0 ? (
        <Empty text="기회 없음" />
      ) : (
        rows.map((o) =>
          mobile ? (
            <OppCard key={o.id} o={o} onExecute={onExecute} showExecute={showExecute} live={live?.[o.id]} flashing={flash?.has(o.id)} />
          ) : (
            <Row key={o.id} o={o} onExecute={onExecute} showExecute={showExecute} live={live?.[o.id]} flashing={flash?.has(o.id)} />
          ),
        )
      )}
    </div>
  );
}

// Mobile opportunity card — stacked layout instead of the wide desktop table.

export function OppCard({ o, onExecute, showExecute, live, flashing }: { o: Opportunity; onExecute: (o: Opportunity) => void; showExecute?: boolean; live?: LiveGap; flashing?: boolean }) {
  const km = KIND_META[o.kind];
  const net = live?.netPct ?? o.netPct;
  const gross = live?.grossPct ?? o.grossPct;
  const netTone = net > 0 ? "var(--pos)" : net < 0 ? "var(--neg)" : "var(--text-dim)";
  const [buy, sell] = o.legs;
  const isApr = o.rateBasis === "apr";
  return (
    <div className={flashing ? "spike-flash" : undefined} style={{ padding: "9px 11px 9px 9px", borderBottom: "1px solid var(--border)", borderLeft: `3px solid ${km.color}` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          <span
            style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              background: "color-mix(in srgb, " + km.color + " 14%, transparent)",
              color: km.color, borderRadius: 999, padding: "3px 8px", fontSize: 10, fontWeight: 600,
              flex: "0 0 auto",
            }}
          >
            <span style={{ width: 5, height: 5, borderRadius: 999, background: km.color }} />
            {km.label}
          </span>
          <span style={{ fontWeight: 700, fontSize: 15 }}>{o.base}</span>
          {o.mock && <span style={{ color: "var(--text-mute)", fontSize: 9, border: "1px solid var(--border)", borderRadius: 4, padding: "0 3px" }}>mock</span>}
          {o.newListing && <span title={`상장 ${o.newListing.ageSec}s 전 · ${o.newListing.overseas ? "해외 상장 있음(김프 가능)" : "해외 미상장"}`} style={{ fontSize: 9, fontWeight: 800, color: "#181a20", background: o.newListing.opened ? "var(--pos)" : "var(--amber)", borderRadius: 4, padding: "1px 5px" }}>{o.newListing.opened ? "상장" : "공지"}</span>}
        </span>
        <span style={{ textAlign: "right", flex: "0 0 auto" }}>
          <span
            className="tnum"
            style={{
              display: "inline-block",
              background: net > 0 ? "var(--pos-soft)" : net < 0 ? "var(--neg-soft)" : "transparent",
              color: netTone, fontWeight: 800, fontSize: 16, borderRadius: 6, padding: "2px 8px",
            }}
          >
            {pct(net)}
          </span>
          <span className="tnum" style={{ display: "block", fontSize: 10, color: "var(--text-mute)", marginTop: 1 }}>
            {isApr ? "APR · " : ""}≈{usd(Math.abs((net / 100) * 1000))}/{isApr ? "yr" : "1k"}
          </span>
        </span>
      </div>

      <div style={{ color: "var(--text-dim)", fontSize: 12.5, margin: "9px 0 10px", display: "flex", alignItems: "center", gap: 8 }}>
        {buy && sell ? (
          <span>
            <b style={{ color: "var(--pos)", fontWeight: 600 }}>{isApr ? "롱" : "매수"}</b> {vlabel(buy.venue)}
            <span style={{ color: "var(--text-mute)", margin: "0 6px" }}>→</span>
            <b style={{ color: "var(--neg)", fontWeight: 600 }}>{isApr ? "숏" : "매도"}</b> {vlabel(sell.venue)}
          </span>
        ) : <span>—</span>}
        {!isApr && <PersistChip p={o.persistence} />}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <span className="tnum" style={{ color: "var(--text-mute)", fontSize: 12 }}>
            {isApr
              ? `펀딩 스프레드 ${pct(gross, false)} APR · 진입 −${o.costPct.toFixed(2)}%`
              : `총차익 ${pct(gross, false)} · 비용 −${o.costPct.toFixed(2)}%${o.notionalCapUsd ? ` · 한도 ${usd(o.notionalCapUsd)}` : ""}`}
          </span>
          {o.note && isApr && (
            <span style={{ color: "var(--text-mute)", fontSize: 11 }}>{o.note}</span>
          )}
          {isApr && o.fundingMeta && <FundingCountdown meta={o.fundingMeta} />}
          {o.transferRisk && o.transferRisk.hedgeAdvised && (
            <span style={{ color: "var(--amber)", fontSize: 11, fontWeight: 600 }}>
              전송 변동 ±{o.transferRisk.driftPct.toFixed(2)}% · 헷지 권장
            </span>
          )}
          {o.transfer?.blocked && (
            <span style={{ color: "var(--neg)", fontSize: 11, fontWeight: 600 }}>입출금 중단</span>
          )}
        </div>
        {showExecute && (
          <button
            type="button"
            disabled={!o.executable}
            onClick={() => onExecute(o)}
            style={{
              borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 600,
              cursor: o.executable ? "pointer" : "not-allowed",
              border: o.executable ? "none" : "1px solid var(--border-strong)",
              background: o.executable ? "var(--brand-grad)" : "transparent",
              color: o.executable ? "#fff" : "var(--text-mute)",
              boxShadow: "none",
              flex: "0 0 auto",
            }}
          >
            실행
          </button>
        )}
      </div>
    </div>
  );
}

export function Row({ o, onExecute, showExecute, live, flashing }: { o: Opportunity; onExecute: (o: Opportunity) => void; showExecute?: boolean; live?: LiveGap; flashing?: boolean }) {
  const km = KIND_META[o.kind];
  const [hover, setHover] = useState(false);
  const net = live?.netPct ?? o.netPct;
  const gross = live?.grossPct ?? o.grossPct;
  const netTone = net > 0 ? "var(--pos)" : net < 0 ? "var(--neg)" : "var(--text-dim)";
  const [buy, sell] = o.legs;
  const isApr = o.rateBasis === "apr";
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={flashing ? "spike-flash" : undefined}
      style={{
        display: "grid", gridTemplateColumns: showExecute ? COLS : COLS_MON, gap: 10, alignItems: "center",
        padding: "8px 12px", borderBottom: "1px solid var(--border)", fontSize: 12.5,
        background: hover ? "var(--card-2)" : "transparent",
        transition: "background 100ms",
      }}
    >
      {/* strategy pill */}
      <span
        style={{
          justifySelf: "start",
          display: "inline-flex", alignItems: "center", gap: 6,
          background: "color-mix(in srgb, " + km.color + " 14%, transparent)",
          color: km.color, borderRadius: 999, padding: "3px 9px",
          fontSize: 11, fontWeight: 600,
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: 999, background: km.color }} />
        {km.label}
      </span>

      {/* pair */}
      <span style={{ display: "flex", alignItems: "baseline", gap: 7, minWidth: 0 }}>
        <span style={{ fontWeight: 700, letterSpacing: "-0.01em" }}>{o.base}</span>
        {o.newListing && <span title={`상장 ${o.newListing.ageSec}s 전 · ${o.newListing.overseas ? "해외 상장 있음(김프 가능)" : "해외 미상장"}`} style={{ fontSize: 9, fontWeight: 800, color: "#181a20", background: o.newListing.opened ? "var(--pos)" : "var(--amber)", borderRadius: 4, padding: "1px 5px" }}>{o.newListing.opened ? "상장" : "공지"}</span>}
        {o.mock ? (
          <span style={{ color: "var(--text-mute)", fontSize: 10, border: "1px solid var(--border)", borderRadius: 5, padding: "0 4px" }}>
            mock
          </span>
        ) : !isApr && <PersistChip p={o.persistence} />}
      </span>

      {/* route */}
      <span style={{ color: "var(--text-dim)", fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {buy && sell ? (
          <>
            <b style={{ color: "var(--pos)", fontWeight: 600 }}>{isApr ? "롱" : "매수"}</b> {vlabel(buy.venue)}
            <span style={{ color: "var(--text-mute)", margin: "0 7px" }}>→</span>
            <b style={{ color: "var(--neg)", fontWeight: 600 }}>{isApr ? "숏" : "매도"}</b> {vlabel(sell.venue)}
            {o.transfer?.blocked && (
              <span style={{ color: "var(--neg)", marginLeft: 8, fontSize: 11, fontWeight: 600 }}>중단</span>
            )}
          </>
        ) : "—"}
      </span>

      <span className="tnum" style={{ textAlign: "right", color: "var(--text-dim)" }}>
        {pct(gross, false)}{isApr ? " APR" : ""}
      </span>
      <span className="tnum" style={{ textAlign: "right", color: "var(--text-mute)" }}>
        −{o.costPct.toFixed(2)}%
      </span>
      <span
        className="tnum"
        style={{
          justifySelf: "end",
          background: net > 0 ? "var(--pos-soft)" : net < 0 ? "var(--neg-soft)" : "transparent",
          color: netTone, fontWeight: 700, borderRadius: 7, padding: "3px 8px",
        }}
      >
        {pct(net)}
      </span>
      <span className="tnum" style={{ textAlign: "right", color: "var(--text-dim)" }}>
        {isApr
          ? (o.fundingMeta ? <FundingCountdown meta={o.fundingMeta} /> : "—")
          : usd(o.notionalCapUsd)}
      </span>

      {/* execute */}
      {showExecute && (
        <button
          type="button"
          disabled={!o.executable}
          onClick={() => onExecute(o)}
          style={{
            justifySelf: "end",
            borderRadius: 8, padding: "7px 14px", fontSize: 12.5, fontWeight: 600,
            cursor: o.executable ? "pointer" : "not-allowed",
            border: o.executable ? "none" : "1px solid var(--border-strong)",
            background: o.executable ? "var(--brand-grad)" : "transparent",
            color: o.executable ? "#181a20" : "var(--text-mute)",
            boxShadow: "none",
          }}
        >
          실행
        </button>
      )}
    </div>
  );
}
export default Board;
