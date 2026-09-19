"use client";

import React from "react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Opportunity, Quote, StrategyKind } from "@/lib/types";
import { pct, usd, price } from "@/lib/format";
import { type LiveAges, type LiveGap, type LiveStatus } from "@/lib/useLivePrices";
import { buildPlan, type AutoLevel, type ExecStep, type StepPhase } from "@/lib/execPlan";
import { useRuns, startRun, confirmRun, retryRun, cancelRun, unwindRun, clearFinished, setKillSwitch, inFlightUsd, setInFlightLimit, type RunView } from "@/lib/runStore";
import { KIND_META, KINDS, GAP_KINDS, ALERT_NET_PCT, beep, Tile, COLS, COLS_MON, Empty, Metric, Line, Warn, LegRow, VENUE_LABEL, vlabel, WL_KEY, statusChip, FundingCountdown, PersistChip, ScanAge, LiveDots, Pill, Spark, xBtn, oppKindLabel, kindLabel } from "./cockpit-ui";
import { isLocked } from "@/lib/gateState";

// 게이트 배지 — 닫힌 갭은 지우지 않고 "왜 지금 못 잡나"를 붙인다. 열린 직후 5분은 열림 강조.
const REOPEN_FLASH_MS = 5 * 60_000;
function GateBadge({ o, compact }: { o: Opportunity; compact?: boolean }) {
  const reopened = o.reopenedAt && Date.now() - o.reopenedAt < REOPEN_FLASH_MS;
  const base: React.CSSProperties = { fontSize: compact ? 10.5 : 11, fontWeight: 700, borderRadius: 999, padding: "1px 7px", whiteSpace: "nowrap", flex: "0 0 auto" };
  if (reopened) return <span className="spike-flash" title="닫혀 있던 입출금이 방금 열렸습니다 — 지속되던 갭이 있으면 지금이 기회" style={{ ...base, color: "var(--pos)", background: "var(--pos-soft)" }}>🔓 열림</span>;
  // 재개 예정 시각(공지)이 있으면 카운트다운을 배지에 붙인다 — 5분 전부터 감시가 2초로 당겨진다.
  const eta = o.reopenAt ? Math.round((o.reopenAt - Date.now()) / 60_000) : null;
  const etaTxt = eta == null ? "" : eta > 0 ? ` · 재개 ${eta}분 후` : eta > -60 ? ` · 재개 예정 ${-eta}분 지남` : "";
  const etaTitle = o.reopenAt ? ` · 재개 공지 ${new Date(o.reopenAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}` : "";
  if (o.gate === "closed") return <span title={`입출금 정지 확인 — ${o.transfer?.network?.reason ?? "매수 출금 또는 매도 입금이 막힘"}${etaTitle}`} style={{ ...base, color: "var(--neg)", background: "var(--neg-soft)" }}>🔒 닫힘{etaTxt}</span>;
  if (o.gate === "suspect") return <span title={`큰 갭이 30분 넘게 유지 — 대개 입출금 정지가 원인 (키가 있으면 확인됨)${etaTitle}`} style={{ ...base, color: "var(--amber)", background: "color-mix(in srgb, var(--amber) 14%, transparent)" }}>🔒 정지 의심{etaTxt}</span>;
  return null;
}

/** 깊이 사다리 툴팁 문구 — ≥5% $a · ≥3% $b · ≥1% $c · >0% $d · 총 이익 $e */
function ladderText(o: Opportunity): string {
  const d = o.depth;
  if (!d) return "최우선호가 한 칸 기준 한도 — 상위 기회는 호가를 걸어 내려간 사다리로 바뀝니다";
  const parts = d.tiers.map((t) => `${t.minNet > 0 ? "≥" + t.minNet + "%" : ">0%"} ${usd(t.sizeUsd)}`);
  return `구간별 규모: ${parts.join(" · ")} · 총 이익 ${usd(d.profitUsd)}`;
}

export function Board({
  rows, loading, onExecute, mobile, showExecute, live, flash, emptyText, onInspect, inspectedId, lastColLabel,
  onFreezeOrder,
}: {
  rows: Opportunity[];
  loading: boolean;
  onExecute: (o: Opportunity) => void;
  mobile?: boolean;
  showExecute?: boolean;
  live?: Record<string, LiveGap>;
  flash?: Set<string>;
  emptyText?: string;
  /** PC: 행 클릭 → 우측 상세 패널 */
  onInspect?: (o: Opportunity) => void;
  inspectedId?: string | null;
  lastColLabel?: string;
  /** 포인터가 보드 안에 있는 동안 행 순서를 동결한다 (오발주 방지). */
  onFreezeOrder?: (frozen: boolean) => void;
}) {
  return (
    <div
      onPointerEnter={onFreezeOrder ? () => onFreezeOrder(true) : undefined}
      onPointerLeave={onFreezeOrder ? () => onFreezeOrder(false) : undefined}
      style={{
        background: "var(--card)", border: "1px solid var(--border)",
        borderRadius: "var(--radius)", overflow: "hidden", boxShadow: "var(--shadow-sm)",
        // NOTE: no backdrop-filter here on purpose. This container wraps every
        // row, and a blurred layer forces the compositor to re-sample its
        // backdrop whenever the subtree changes — with live rows updating
        // continuously that was constant GPU work (and the main source of scroll
        // jank on mobile). Blur is kept where it does visual work over moving
        // content: the sticky header and the modal overlay.
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
          <span style={{ textAlign: "right" }}>추이</span>
          <span style={{ textAlign: "right" }}>순수익</span>
          <span style={{ textAlign: "right" }} title="상위 기회: 호가를 걸어 내려가 순수익>0인 규모와 그때의 총 이익. 나머지: 최우선호가 한 칸 한도">{lastColLabel ?? "규모 · 이익"}</span>
          {showExecute && <span />}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <Empty text="시장 스캔 중…" hint="첫 스캔은 몇 초 걸립니다 — 기회가 잡히면 여기 줄이 생깁니다" />
      ) : rows.length === 0 ? (
        <Empty text={emptyText ?? "기회 없음"} />
      ) : (
        rows.map((o) =>
          mobile ? (
            <OppCard key={o.id} o={o} onExecute={onExecute} showExecute={showExecute} live={live?.[o.id]} flashing={flash?.has(o.id)} />
          ) : (
            <Row key={o.id} o={o} onExecute={onExecute} showExecute={showExecute} live={live?.[o.id]} flashing={flash?.has(o.id)} onInspect={onInspect} inspected={inspectedId === o.id} />
          ),
        )
      )}
    </div>
  );
}

// Mobile opportunity card — stacked layout instead of the wide desktop table.

function OppCardImpl({ o, onExecute, showExecute, live, flashing }: { o: Opportunity; onExecute: (o: Opportunity) => void; showExecute?: boolean; live?: LiveGap; flashing?: boolean }) {
  const km = KIND_META[o.kind];
  const net = live?.netPct ?? o.netPct;
  const gross = live?.grossPct ?? o.grossPct;
  const netTone = net > 0 ? "var(--pos)" : net < 0 ? "var(--neg)" : "var(--text-dim)";
  const [buy, sell] = o.legs;
  const isApr = o.rateBasis === "apr";
  return (
    <div className={flashing ? "spike-flash" : undefined} style={{ padding: "12px 12px", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <span style={{ display: "inline-flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 14.5, letterSpacing: "0.01em" }}>{o.base}</span>
          <span style={{ color: km.color, fontSize: 9, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", flex: "0 0 auto" }}>
            {oppKindLabel(o)}
          </span>
          {o.mock && <span style={{ color: "var(--text-mute)", fontSize: 9, border: "1px solid var(--border)", borderRadius: 9, padding: "0 3px" }}>mock</span>}
          {o.newListing && <span title={`상장 ${o.newListing.ageSec}s 전 · ${o.newListing.overseas ? "해외 상장 있음(김프 가능)" : "해외 미상장"}`} style={{ fontSize: 9, fontWeight: 800, color: "var(--brand-ink)", background: o.newListing.opened ? "var(--pos)" : "var(--amber)", borderRadius: 9, padding: "1px 5px" }}>{o.newListing.opened ? "상장" : "공지"}</span>}
        </span>
        <span style={{ textAlign: "right", flex: "0 0 auto" }}>
          <span
            className="tnum"
            style={{ display: "inline-block", color: netTone, fontWeight: 700, fontSize: 19, letterSpacing: "-0.03em", lineHeight: 1 }}
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
        {!isApr && o.spark && o.spark.length >= 2 && (
          <span style={{ marginLeft: "auto", flex: "0 0 auto" }}><Spark data={o.spark} costPct={o.costPct} /></span>
        )}
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
          {(isLocked(o.gate) || o.reopenedAt) && <span><GateBadge o={o} compact /></span>}
          {o.depth && (
            <span className="tnum" title={ladderText(o)} style={{ color: "var(--text-mute)", fontSize: 11 }}>
              규모 {usd(o.depth.maxSizeUsd)} · 이익 <b style={{ color: o.depth.profitUsd > 0 ? "var(--pos)" : "var(--text-mute)" }}>{usd(o.depth.profitUsd)}</b>
            </span>
          )}
        </div>
        {showExecute && (
          <button
            type="button"
            disabled={!o.executable}
            onClick={() => onExecute(o)}
            style={{
              borderRadius: 9, padding: "8px 16px", fontSize: 13, fontWeight: 600,
              cursor: o.executable ? "pointer" : "not-allowed",
              border: o.executable ? "none" : "1px solid var(--border-strong)",
              background: o.executable ? "var(--brand)" : "transparent",
              color: o.executable ? "var(--brand-ink)" : "var(--text-mute)",
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

function RowImpl({ o, onExecute, showExecute, live, flashing, onInspect, inspected }: { o: Opportunity; onExecute: (o: Opportunity) => void; showExecute?: boolean; live?: LiveGap; flashing?: boolean; onInspect?: (o: Opportunity) => void; inspected?: boolean }) {
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
      onClick={onInspect ? () => onInspect(o) : undefined}
      className={flashing ? "spike-flash" : undefined}
      style={{
        display: "grid", gridTemplateColumns: showExecute ? COLS : COLS_MON, gap: 10, alignItems: "center",
        padding: "8px 12px", borderBottom: "1px solid var(--border)", fontSize: 12.5,
        background: inspected ? "var(--brand-soft)" : hover ? "var(--card-2)" : "transparent",
        cursor: onInspect ? "pointer" : undefined,
        boxShadow: inspected ? "inset 2px 0 0 var(--brand)" : undefined,
        transition: "background 100ms",
      }}
    >
      {/* strategy label — plain small-caps text, no chip box */}
      <span
        style={{
          justifySelf: "start",
          color: km.color, fontSize: 10, fontWeight: 600,
          letterSpacing: "0.1em", textTransform: "uppercase",
        }}
      >
        {oppKindLabel(o)}
      </span>

      {/* pair */}
      <span style={{ display: "flex", alignItems: "baseline", gap: 7, minWidth: 0 }}>
        <span style={{ fontWeight: 700, letterSpacing: "-0.01em" }}>{o.base}</span>
        {o.suspectApr && (
          <span title="APR 스파이크 — 신규상장/얇은 OI로 실체결 용량이 없을 확률이 높음" style={{ fontSize: 9, fontWeight: 700, color: "var(--amber)", border: "1px solid var(--amber)", borderRadius: 9, padding: "0 4px" }}>
            스파이크?
          </span>
        )}
        {o.newListing && <span title={`상장 ${o.newListing.ageSec}s 전 · ${o.newListing.overseas ? "해외 상장 있음(김프 가능)" : "해외 미상장"}`} style={{ fontSize: 9, fontWeight: 800, color: "var(--brand-ink)", background: o.newListing.opened ? "var(--pos)" : "var(--amber)", borderRadius: 9, padding: "1px 5px" }}>{o.newListing.opened ? "상장" : "공지"}</span>}
        {o.mock ? (
          <span style={{ color: "var(--text-mute)", fontSize: 10, border: "1px solid var(--border)", borderRadius: 9, padding: "0 4px" }}>
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
            {(isLocked(o.gate) || o.reopenedAt) && <span style={{ marginLeft: 8 }}><GateBadge o={o} /></span>}
          </>
        ) : "—"}
      </span>

      <span className="tnum" style={{ textAlign: "right", color: "var(--text-dim)" }}>
        {pct(gross, false)}{isApr ? " APR" : ""}
      </span>
      <span className="tnum" style={{ textAlign: "right", color: "var(--text-mute)" }}>
        −{o.costPct.toFixed(2)}%
      </span>
      {/* 30분 추이 — APR 행은 스파크 없음(서버가 안 붙임) → "—" */}
      <span style={{ justifySelf: "end" }}>
        <Spark data={o.spark} costPct={o.costPct} />
      </span>
      <span
        className="tnum"
        style={{ justifySelf: "end", color: netTone, fontWeight: 700, fontSize: 14 }}
      >
        {pct(net)}
      </span>
      <span className="tnum" title={isApr ? undefined : ladderText(o)} style={{ textAlign: "right", color: "var(--text-dim)", lineHeight: 1.2 }}>
        {isApr
          ? (o.fundingMeta ? <FundingCountdown meta={o.fundingMeta} /> : "—")
          : o.depth
            ? <>
                <div>{usd(o.depth.maxSizeUsd)}</div>
                <div style={{ fontSize: 11, fontWeight: 700, color: o.depth.profitUsd > 0 ? "var(--pos)" : "var(--text-mute)" }}>+{usd(o.depth.profitUsd)}</div>
              </>
            : usd(o.notionalCapUsd)}
      </span>

      {/* execute */}
      {showExecute && (
        <button
          type="button"
          disabled={!o.executable}
          onClick={(e) => { e.stopPropagation(); onExecute(o); }}
          style={{
            justifySelf: "end",
            borderRadius: 9, padding: "7px 14px", fontSize: 12.5, fontWeight: 600,
            cursor: o.executable ? "pointer" : "not-allowed",
            border: o.executable ? "none" : "1px solid var(--border-strong)",
            background: o.executable ? "var(--brand-grad)" : "transparent",
            color: o.executable ? "var(--brand-ink)" : "var(--text-mute)",
            boxShadow: "none",
          }}
        >
          실행
        </button>
      )}
    </div>
  );
}

// Rows are memoized on the values they actually render. Without this, every row
// re-rendered on each 600ms overlay tick — ~64 rows × 12-15 inline style objects
// each, roughly 100k short-lived objects a minute to redraw mostly-identical
// numbers. Only the rows whose live numbers moved re-render now.
//
// The comparator ignores `o` identity: /api/scan returns fresh objects every 3s,
// so comparing by reference would defeat the memo. The fields below are the ones
// the row displays; the live gap is compared at display precision (2 decimals).
const sameGap = (a?: LiveGap, b?: LiveGap) =>
  (!a && !b) ||
  (!!a && !!b &&
    Math.round(a.netPct * 100) === Math.round(b.netPct * 100) &&
    Math.round(a.grossPct * 100) === Math.round(b.grossPct * 100));

// Spark arrays are fresh objects every scan — compare by shape (length + ends),
// which is what the 56px polyline can actually show.
const sameSpark = (a?: number[], b?: number[]) =>
  (!a?.length && !b?.length) ||
  (!!a && !!b && a.length === b.length && a[a.length - 1] === b[b.length - 1] && a[0] === b[0]);

const sameOpp = (a: Opportunity, b: Opportunity) =>
  a.id === b.id && a.netPct === b.netPct && a.grossPct === b.grossPct &&
  sameSpark(a.spark, b.spark) &&
  a.costPct === b.costPct && a.notionalCapUsd === b.notionalCapUsd &&
  a.executable === b.executable && a.hasPerp === b.hasPerp &&
  a.transfer?.blocked === b.transfer?.blocked &&
  a.gate === b.gate && a.reopenedAt === b.reopenedAt && a.reopenAt === b.reopenAt &&
  a.depth?.ts === b.depth?.ts &&
  a.newListing?.opened === b.newListing?.opened &&
  a.persistence?.heldSec === b.persistence?.heldSec &&
  a.transferRisk?.hedgeAdvised === b.transferRisk?.hedgeAdvised &&
  a.fundingMeta?.nextTs === b.fundingMeta?.nextTs &&
  a.note === b.note && a.unverified === b.unverified && a.suspectApr === b.suspectApr;

export const OppCard = React.memo(OppCardImpl, (p, n) =>
  sameOpp(p.o, n.o) && sameGap(p.live, n.live) &&
  p.flashing === n.flashing && p.showExecute === n.showExecute && p.onExecute === n.onExecute,
);
export const Row = React.memo(RowImpl, (p, n) =>
  sameOpp(p.o, n.o) && sameGap(p.live, n.live) &&
  p.flashing === n.flashing && p.showExecute === n.showExecute &&
  p.inspected === n.inspected && p.onExecute === n.onExecute && p.onInspect === n.onInspect,
);

export default Board;
