"use client";

// 코인 상세 패널 — "이 코인 지금 어떤 상태냐"를 한 곳에서.
//
// 입출금 상태와 거래소 온체인 보유량은 특정 탭의 도구가 아니다. 갭 실행 전(보내도 되나),
// 상장 매도 전(입금되나), 재개 대응(열렸나), 프리미엄 붕괴 예측(국내 입금 지갑으로 물량이
// 몰리나) 어디서나 필요하다. 그래서 카드로 한 탭에 박지 않고 코인 단위 패널로 묶어,
// 헤더 🔍나 코인 이름을 눌러 어느 탭에서든 연다.
//
// base가 비어 있으면 검색 + "지금 막힌 코인" 목록 화면이다 (예전 입출금 조회 카드의 전체 보기).

import React from "react";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { Opportunity } from "@/lib/types";
import { pct, usd } from "@/lib/format";
import { VENUE_LABEL, oppKindLabel, oppKindColor } from "./cockpit-ui";
import { HoldingsCard, type GateRow } from "./ControlPanel";

type NetRow = { net: string; chainKey?: string; deposit: boolean; withdraw: boolean; feeCoin?: number; isDefault?: boolean };
const vl = (v: string) => VENUE_LABEL[v] ?? v;
const isBlocked = (r: GateRow) => Object.values(r.venues).some((s) => s && (!s.deposit || !s.withdraw));

export function CoinSheet({ base, opps, mobile, onClose, onOpenCoin, onInspect }: {
  base: string;
  opps: Opportunity[];
  mobile?: boolean;
  onClose: () => void;
  onOpenCoin: (base: string) => void;
  /** 갭 보드로 가서 그 기회 검사창 열기 */
  onInspect: (o: Opportunity) => void;
}) {
  const [q, setQ] = useState(base);
  useEffect(() => setQ(base), [base]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay-in" onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(0,0,0,0.45)", display: "flex", justifyContent: "flex-end" }}>
      <div className="panel-in glass" onClick={(e) => e.stopPropagation()}
        style={{ width: mobile ? "100%" : 480, maxWidth: "100%", height: "100%", overflowY: "auto", background: "var(--header-bg)", borderLeft: "1px solid var(--border-strong)", boxShadow: "var(--shadow-lg)", padding: mobile ? "12px 12px 40px" : "16px 18px 40px" }}>
        {/* 헤더 — 검색이 곧 제목 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, position: "sticky", top: 0, paddingBottom: 10, background: "var(--header-bg)", zIndex: 1 }}>
          <input autoFocus={!base} value={q} placeholder="코인 검색 (예: XRP)"
            onChange={(e) => setQ(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === "Enter") onOpenCoin(q.trim()); }}
            style={{ flex: 1, minWidth: 0, background: "var(--bg)", border: "1px solid var(--border-strong)", borderRadius: 10, padding: "8px 12px", color: "var(--text)", fontSize: 15, fontWeight: 700, outline: "none" }} />
          <button type="button" onClick={() => onOpenCoin(q.trim())}
            style={{ border: "none", borderRadius: 6, padding: "8px 14px", background: "var(--brand)", color: "var(--brand-ink)", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>조회</button>
          <button type="button" onClick={onClose} aria-label="닫기"
            style={{ border: "1px solid var(--border-strong)", background: "transparent", color: "var(--text-dim)", borderRadius: 6, padding: "7px 10px", fontSize: 12, cursor: "pointer" }}>✕</button>
        </div>
        {base ? <CoinDetail key={base} base={base} opps={opps} onInspect={onInspect} /> : <BlockedList onOpenCoin={onOpenCoin} />}
      </div>
    </div>
  );
}

const SEC: React.CSSProperties = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 14px", marginTop: 10 };
const H = ({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) => (
  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
    <span style={{ fontSize: 13, fontWeight: 700 }}>{children}</span>
    <span style={{ flex: 1 }} />
    {right}
  </div>
);

function CoinDetail({ base, opps, onInspect }: { base: string; opps: Opportunity[]; onInspect: (o: Opportunity) => void }) {
  const mine = useMemo(() => opps.filter((o) => o.base === base && !o.mock).sort((a, b) => b.netPct - a.netPct), [opps, base]);
  return (
    <>
      {/* 1) 지금 이 코인의 갭 */}
      <div style={SEC}>
        <H right={<span style={{ fontSize: 11, color: "var(--text-mute)" }}>{mine.length}개 경로</span>}>지금 갭</H>
        {mine.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--text-mute)" }}>스캔에 잡힌 경로 없음 — 유동성·스프레드 필터 밖이거나 한쪽에만 상장</div>
        ) : mine.slice(0, 6).map((o) => {
          const [buy, sell] = o.legs;
          const locked = o.gate === "closed" ? "🔒 닫힘" : o.gate === "suspect" ? "🔒 정지 의심" : null;
          return (
            <button key={o.id} type="button" onClick={() => onInspect(o)}
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", background: "transparent", border: "none", borderBottom: "1px solid var(--border)", padding: "8px 0", color: "var(--text)", cursor: "pointer", fontSize: 12.5 }}>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: oppKindColor(o), minWidth: 40 }}>{o.kind === "kimchi" ? oppKindLabel(o) : o.kind === "cross-cex" ? "크로스" : o.kind === "cex-dex" ? "DEX" : "펀딩"}</span>
              <span style={{ color: "var(--text-dim)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{buy ? vl(buy.venue) : "?"} → {sell ? vl(sell.venue) : "?"}</span>
              {locked && <span style={{ fontSize: 10.5, fontWeight: 700, color: o.gate === "closed" ? "var(--neg)" : "var(--amber)" }}>{locked}</span>}
              <span style={{ flex: 1 }} />
              {o.depth && <span className="tnum" style={{ fontSize: 11, color: "var(--text-mute)" }}>{usd(o.depth.maxSizeUsd)}</span>}
              <span className="tnum" style={{ fontWeight: 700, color: o.netPct > 0 ? "var(--pos)" : "var(--neg)" }}>{pct(o.netPct)}</span>
            </button>
          );
        })}
        {mine[0]?.transfer?.network && (
          <div style={{ fontSize: 11, color: "var(--text-mute)", marginTop: 8 }}>전송 체인: {mine[0].transfer.network.chain} · {mine[0].transfer.network.reason}</div>
        )}
      </div>
      {/* 2) 입출금 — 거래소·체인별 */}
      <GatesDetail base={base} />
      {/* 3) 거래소 온체인 보유량 */}
      <div style={{ marginTop: 10 }}><HoldingsCard base={base} /></div>
    </>
  );
}

function GatesDetail({ base }: { base: string }) {
  const [row, setRow] = useState<GateRow | null | undefined>(undefined);
  const [missing, setMissing] = useState<string[]>([]);
  const [nets, setNets] = useState<Record<string, NetRow[]>>({});
  const [stale, setStale] = useState<string[]>([]);
  useEffect(() => {
    let stop = false;
    fetch(`/api/gates?coin=${encodeURIComponent(base)}`, { cache: "no-store" }).then((r) => r.json())
      .then((j: { rows: GateRow[]; missing?: string[] }) => { if (!stop) { setRow(j.rows?.[0] ?? null); setMissing(j.missing ?? []); } })
      .catch(() => { if (!stop) setRow(null); });
    fetch(`/api/gate-networks?coin=${encodeURIComponent(base)}`, { cache: "no-store" }).then((r) => r.json())
      .then((j: { networks?: Record<string, NetRow[]>; staleVenues?: string[] }) => { if (!stop) { setNets(j.networks ?? {}); setStale(j.staleVenues ?? []); } })
      .catch(() => {});
    return () => { stop = true; };
  }, [base]);
  const tag = (on: boolean, t: string) => <span style={{ fontSize: 10.5, fontWeight: 700, color: on ? "var(--pos)" : "var(--neg)" }}>{t}</span>;
  const venues = row ? Object.keys(row.venues) : [];
  return (
    <div style={SEC}>
      <H right={missing.length ? <span style={{ fontSize: 10.5, color: "var(--amber)" }}>{missing.map(vl).join("·")} 키 필요</span> : undefined}>입출금</H>
      {row === undefined ? <div style={{ fontSize: 12, color: "var(--text-mute)" }}>불러오는 중…</div>
        : !row ? <div style={{ fontSize: 12, color: "var(--text-mute)" }}>이 코인의 입출금 정보 없음 (미상장 또는 키 필요)</div>
        : (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(64px,auto) auto minmax(0,1fr)", gap: "6px 12px", alignItems: "start", fontSize: 12 }}>
            {venues.map((v) => {
              const s = row.venues[v];
              const chains = nets[v] ?? [];
              return (
                <Fragment key={v}>
                  <span style={{ fontWeight: 600 }}>{vl(v)}{stale.includes(v) && <span style={{ color: "var(--amber)", fontSize: 10 }}> 낡음</span>}</span>
                  <span style={{ display: "inline-flex", gap: 4 }}>{s ? <>{tag(s.deposit, "입")}{tag(s.withdraw, "출")}</> : <span style={{ fontSize: 10.5, color: "var(--text-mute)" }}>키필요</span>}</span>
                  <span style={{ display: "flex", flexWrap: "wrap", gap: 4, minWidth: 0 }}>
                    {chains.length === 0 ? <span style={{ fontSize: 10.5, color: "var(--text-mute)" }}>{v === "bithumb" ? "체인별 정보 없음(공개 API)" : "—"}</span>
                      : chains.map((n) => (
                        <span key={n.net} title={`${n.net}${n.chainKey ? ` → ${n.chainKey}` : " (미매핑)"}${n.feeCoin != null ? ` · 수수료 ${n.feeCoin}` : ""}`}
                          style={{ fontSize: 10.5, borderRadius: 7, padding: "1px 6px", border: `1px solid ${n.deposit && n.withdraw ? "var(--border)" : "var(--neg)"}`, color: n.deposit && n.withdraw ? "var(--text-dim)" : "var(--neg)" }}>
                          {n.net}{!(n.deposit && n.withdraw) && ` ${n.deposit ? "" : "입✕"}${n.withdraw ? "" : "출✕"}`}
                        </span>
                      ))}
                  </span>
                </Fragment>
              );
            })}
          </div>
        )}
    </div>
  );
}

/** 검색 전 화면 — 지금 막힌 코인 목록. 눌러서 상세로. */
function BlockedList({ onOpenCoin }: { onOpenCoin: (base: string) => void }) {
  const [data, setData] = useState<{ rows: GateRow[]; missing?: string[] } | null>(null);
  useEffect(() => { fetch("/api/gates", { cache: "no-store" }).then((r) => r.json()).then(setData).catch(() => {}); }, []);
  const blocked = useMemo(() => (data ? data.rows.filter(isBlocked) : []), [data]);
  return (
    <div style={SEC}>
      <H right={data ? <span style={{ fontSize: 11, color: "var(--text-mute)" }}>전체 {data.rows.length}개 중</span> : undefined}>
        지금 막힌 코인 {data ? <span style={{ color: "var(--neg)" }}>{blocked.length}</span> : ""}
      </H>
      {data && (data.missing?.length ?? 0) > 0 && (
        <div style={{ fontSize: 10.5, color: "var(--amber)", marginBottom: 8 }}>{data.missing!.map(vl).join("·")}는 키 등록 후 표시 (빗썸만 공개 API)</div>
      )}
      {!data ? <div style={{ fontSize: 12, color: "var(--text-mute)" }}>불러오는 중…</div> : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {blocked.map((r) => {
            const where = Object.entries(r.venues).filter(([, s]) => s && (!s.deposit || !s.withdraw)).map(([v, s]) => `${vl(v)} ${s!.deposit ? "" : "입"}${s!.withdraw ? "" : "출"}✕`);
            return (
              <button key={r.base} type="button" onClick={() => onOpenCoin(r.base)} title={where.join(" · ")}
                style={{ border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", borderRadius: 8, padding: "4px 9px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                {r.base}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
