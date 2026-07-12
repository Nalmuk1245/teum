"use client";

import { useEffect, useState } from "react";
import type { Portfolio, VenueBalance } from "@/lib/types";
import { usd } from "@/lib/format";

const VLABEL: Record<string, string> = { binance: "Binance", upbit: "Upbit", bithumb: "Bithumb", wallet: "개인지갑" };
const krw = (v: number) => `₩${Math.round(v).toLocaleString("en-US")}`;

function usePortfolio(): Portfolio | null {
  const [pf, setPf] = useState<Portfolio | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const j = await (await fetch("/api/balances", { cache: "no-store" })).json();
        if (alive) setPf(j.portfolio ?? null);
      } catch {
        /* keep stale */
      }
    };
    void load();
    const id = setInterval(load, 15000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return pf;
}

function derive(pf: Portfolio) {
  const g = Math.max(0, Math.min(100, pf.skewPct)); // global share %
  const skewed = g < 35 || g > 65;
  // 가용률 — 거래소 자본 중 즉시 주문 가능한 현금(USDT/KRW) 비중.
  const exchTotal = pf.venues.reduce((s, v) => s + v.totalUsd, 0);
  const cashTotal = pf.venues.reduce((s, v) => s + v.cashUsd, 0);
  const availPct = exchTotal > 0 ? (cashTotal / exchTotal) * 100 : 0;
  return { g, skewed, availPct };
}

/**
 * Compact one-line asset summary for the trading tabs — total, available cash
 * share, skew warning. Tap → the 자산 tab for the full breakdown.
 */
export function AssetSummary({ isMobile, onOpen }: { isMobile?: boolean; onOpen?: () => void }) {
  const pf = usePortfolio();
  if (!pf) return null;
  const { g, skewed, availPct } = derive(pf);
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        display: "flex", alignItems: "center", gap: 10, width: "100%",
        background: "var(--card)", border: "1px solid var(--border)",
        borderRadius: "var(--radius)", padding: isMobile ? "8px 11px" : "9px 14px",
        marginBottom: isMobile ? 10 : 14, cursor: onOpen ? "pointer" : "default",
        color: "var(--text)", textAlign: "left",
      }}
    >
      <span style={{ color: "var(--text-dim)", fontSize: 12, fontWeight: 600 }}>자산</span>
      <span className="tnum" style={{ fontSize: 14, fontWeight: 700 }}>{usd(pf.totalUsd)}</span>
      <span className="tnum" style={{ fontSize: 11, color: "var(--brand-2)" }}>가용 {availPct.toFixed(0)}%</span>
      {!isMobile && (
        <span className="tnum" style={{ fontSize: 11, color: "var(--text-mute)" }}>
          글로벌 {g.toFixed(0)} : {(100 - g).toFixed(0)} KR
        </span>
      )}
      {skewed && <span style={{ fontSize: 11, fontWeight: 600, color: "var(--neg)" }}>편중</span>}
      <span style={{ flex: 1 }} />
      {pf.mock && (
        <span style={{ fontSize: 9, fontWeight: 700, color: "var(--sky)", border: "1px solid var(--sky)", borderRadius: 999, padding: "1px 7px" }}>
          데모
        </span>
      )}
      <span style={{ color: "var(--text-mute)", fontSize: 12 }}>상세 ›</span>
    </button>
  );
}

/** Full asset breakdown — the 자산 tab. */
export default function AssetsPanel({ isMobile }: { isMobile?: boolean }) {
  const pf = usePortfolio();
  if (!pf) {
    return <div style={{ color: "var(--text-mute)", padding: 32, textAlign: "center" }}>잔고 조회 중…</div>;
  }
  const { g, skewed, availPct } = derive(pf);
  const allVenues = [...pf.venues, ...(pf.wallet ? [pf.wallet] : [])];

  // Aggregate holdings across every venue + the wallet (cash included).
  type Agg = { asset: string; amount: number; usdValue: number; where: string[] };
  const aggMap = new Map<string, Agg>();
  const add = (asset: string, amount: number, usdValue: number, where: string) => {
    const a = aggMap.get(asset) ?? { asset, amount: 0, usdValue: 0, where: [] };
    a.amount += amount; a.usdValue += usdValue;
    if (!a.where.includes(where)) a.where.push(where);
    aggMap.set(asset, a);
  };
  for (const v of allVenues) {
    if (!v.connected) continue;
    const label = VLABEL[v.venue] ?? v.venue;
    if (v.cashUsd > 0) add(v.cashLabel, v.cashRaw, v.cashUsd, label);
    for (const c of v.coins) add(c.asset, c.amount, c.usdValue, label);
  }
  const agg = [...aggMap.values()].sort((a, b) => b.usdValue - a.usdValue);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: isMobile ? 10 : 14 }}>
      {/* ── Headline ── */}
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: isMobile ? "12px 14px" : "14px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ color: "var(--text-dim)", fontSize: 12, fontWeight: 600 }}>총자본 (USD 환산)</span>
          {pf.mock && (
            <span style={{ fontSize: 9, fontWeight: 700, color: "var(--sky)", border: "1px solid var(--sky)", borderRadius: 999, padding: "1px 7px" }}>
              데모 — 키 넣으면 실잔고
            </span>
          )}
          <span style={{ flex: 1 }} />
          <span className="tnum" title="즉시 주문 가능한 현금 비중" style={{ fontSize: 12, color: "var(--brand-2)", fontWeight: 600 }}>
            가용 {availPct.toFixed(0)}%
          </span>
        </div>
        <div className="tnum" style={{ fontSize: 26, fontWeight: 800, marginTop: 4 }}>{usd(pf.totalUsd)}</div>
        <div className="tnum" style={{ fontSize: 11, color: "var(--text-mute)", marginTop: 2 }}>
          환율 ₩{Math.round(pf.usdKrw).toLocaleString("en-US")}/USDT 기준
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, margin: "14px 0 5px" }}>
          <span style={{ color: "var(--brand-2)" }}>글로벌 · USDT {usd(pf.globalUsd)}</span>
          <span style={{ color: "var(--sky)" }}>KR · 원화 {usd(pf.krUsd)}</span>
        </div>
        <div style={{ display: "flex", height: 10, borderRadius: 999, overflow: "hidden", background: "var(--bg)", border: "1px solid var(--border)" }}>
          <div style={{ width: `${g}%`, background: "var(--brand)" }} />
          <div style={{ width: `${100 - g}%`, background: "var(--sky)" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-mute)", marginTop: 4 }}>
          <span>{g.toFixed(0)}%</span>
          <span>{(100 - g).toFixed(0)}%</span>
        </div>

        {skewed ? (
          <div style={{ marginTop: 10, padding: "7px 10px", borderRadius: 8, background: "var(--neg-soft)", color: "var(--neg)", fontSize: 11.5, fontWeight: 500 }}>
            편중 —{" "}
            {g > 65
              ? "글로벌에 자본 쏠림. KR 쪽 재고 보충(전송) 필요"
              : "KR에 자본 쏠림. USD 회수(리패트리에이션) 필요"}
          </div>
        ) : (
          <div style={{ marginTop: 10, color: "var(--text-mute)", fontSize: 11 }}>
            균형 양호 — 양쪽 재고로 전송 없이 즉시 체결 가능
          </div>
        )}
      </div>

      {/* ── Aggregated holdings (all venues + wallet) ── */}
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: isMobile ? "12px 14px" : "14px 18px" }}>
        <div style={{ color: "var(--text-dim)", fontSize: 12, fontWeight: 600, marginBottom: 10 }}>자산별 합산</div>
        <AssetTable
          header
          rows={agg.map((a) => ({
            asset: a.asset, amount: a.amount, usdValue: a.usdValue,
            sub: a.where.join(" · "), sharePct: pf.totalUsd > 0 ? (a.usdValue / pf.totalUsd) * 100 : 0,
          }))}
        />
      </div>

      {/* ── Per-venue detail ── */}
      {allVenues.map((v) => (
        <VenueCard key={v.venue} v={v} isMobile={isMobile} totalUsd={pf.totalUsd} />
      ))}
    </div>
  );
}

// One venue's detail card: cash row + every coin row with amount/price/value/share.
function VenueCard({ v, isMobile, totalUsd }: { v: VenueBalance; isMobile?: boolean; totalUsd: number }) {
  const label = VLABEL[v.venue] ?? v.venue;
  if (!v.connected) {
    return (
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: isMobile ? "12px 14px" : "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontWeight: 700, fontSize: 13.5 }}>{label}</span>
        <span style={{ fontSize: 11.5, color: "var(--text-mute)" }}>키 필요 — .env.local에 API 키를 넣으면 실잔고가 표시됩니다</span>
      </div>
    );
  }
  const rows = [
    ...(v.cashUsd > 0 ? [{ asset: v.cashLabel, amount: v.cashRaw, usdValue: v.cashUsd, sub: "현금", sharePct: v.totalUsd > 0 ? (v.cashUsd / v.totalUsd) * 100 : 0 }] : []),
    ...v.coins.map((c) => ({ asset: c.asset, amount: c.amount, usdValue: c.usdValue, sub: undefined as string | undefined, sharePct: v.totalUsd > 0 ? (c.usdValue / v.totalUsd) * 100 : 0 })),
  ];
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: isMobile ? "12px 14px" : "14px 18px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: 13.5, whiteSpace: "nowrap" }}>{label}</span>
        {v.venue === "wallet" && <span style={{ fontSize: 10.5, color: "var(--text-mute)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>자체보관 · 전송 중</span>}
        <span style={{ flex: 1 }} />
        <span className="tnum" style={{ fontSize: 14, fontWeight: 700 }}>{usd(v.totalUsd)}</span>
        <span className="tnum" style={{ fontSize: 10.5, color: "var(--text-mute)" }}>
          {totalUsd > 0 ? `전체의 ${((v.totalUsd / totalUsd) * 100).toFixed(0)}%` : ""}
        </span>
      </div>
      {rows.length ? <AssetTable rows={rows} /> : <div style={{ color: "var(--text-mute)", fontSize: 12 }}>보유 없음</div>}
    </div>
  );
}

// Shared asset table: 자산 | 수량(+단가) | 평가액(+비중 bar)
function AssetTable({ rows, header }: {
  rows: { asset: string; amount: number; usdValue: number; sub?: string; sharePct: number }[];
  header?: boolean;
}) {
  const fmtAmt = (n: number) =>
    n >= 1000 ? Math.round(n).toLocaleString("en-US")
    : n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 4 })
    : n.toLocaleString("en-US", { maximumFractionDigits: 8 });
  const price = (r: { asset: string; amount: number; usdValue: number }) => {
    if (r.asset === "KRW" || r.asset === "USDT" || r.amount <= 0) return null;
    const p = r.usdValue / r.amount;
    return p >= 1 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : `$${p.toPrecision(3)}`;
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {header && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(64px,1fr) 1.4fr 1.2fr", gap: 8, fontSize: 10, color: "var(--text-mute)", padding: "0 0 4px" }}>
          <span>자산</span><span style={{ textAlign: "right" }}>수량 · 단가</span><span style={{ textAlign: "right" }}>평가액 · 비중</span>
        </div>
      )}
      {rows.map((r) => (
        <div key={r.asset + (r.sub ?? "")} style={{ display: "grid", gridTemplateColumns: "minmax(64px,1fr) 1.4fr 1.2fr", gap: 8, alignItems: "center", padding: "5px 0", borderTop: "1px solid var(--border)" }}>
          <span style={{ minWidth: 0 }}>
            <span style={{ fontWeight: 700, fontSize: 12.5 }}>{r.asset}</span>
            {r.sub && <span style={{ display: "block", fontSize: 9.5, color: "var(--text-mute)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.sub}</span>}
          </span>
          <span className="tnum" style={{ textAlign: "right", fontSize: 12, color: "var(--text-dim)" }}>
            {r.asset === "KRW" ? krw(r.amount) : fmtAmt(r.amount)}
            {price(r) && <span style={{ display: "block", fontSize: 9.5, color: "var(--text-mute)" }}>@{price(r)}</span>}
          </span>
          <span style={{ textAlign: "right" }}>
            <span className="tnum" style={{ fontSize: 12.5, fontWeight: 600 }}>{usd(r.usdValue)}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "flex-end", marginTop: 2 }}>
              <span style={{ width: 46, height: 3, borderRadius: 999, background: "var(--bg)", overflow: "hidden" }}>
                <span style={{ display: "block", width: `${Math.min(100, r.sharePct)}%`, height: "100%", background: "var(--brand)" }} />
              </span>
              <span className="tnum" style={{ fontSize: 9.5, color: "var(--text-mute)", minWidth: 26 }}>{r.sharePct.toFixed(0)}%</span>
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}
