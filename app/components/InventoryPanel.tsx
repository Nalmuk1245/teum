"use client";

import { useEffect, useState } from "react";
import type { Portfolio, VenueBalance } from "@/lib/types";
import { usd } from "@/lib/format";

const VLABEL: Record<string, string> = { binance: "Binance", upbit: "Upbit", bithumb: "Bithumb", wallet: "개인지갑" };
const krw = (v: number) => `₩${Math.round(v).toLocaleString("en-US")}`;

export default function InventoryPanel({ isMobile }: { isMobile?: boolean }) {
  const [pf, setPf] = useState<Portfolio | null>(null);
  const [open, setOpen] = useState(false);

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

  if (!pf) return null;
  const g = Math.max(0, Math.min(100, pf.skewPct)); // global share %
  const skewed = g < 35 || g > 65;
  // 가용률 — 거래소 자본 중 즉시 주문 가능한 현금(USDT/KRW) 비중.
  const exchTotal = pf.venues.reduce((s, v) => s + v.totalUsd, 0);
  const cashTotal = pf.venues.reduce((s, v) => s + v.cashUsd, 0);
  const availPct = exchTotal > 0 ? (cashTotal / exchTotal) * 100 : 0;

  return (
    <div
      style={{
        background: "var(--card)", border: "1px solid var(--border)",
        borderRadius: "var(--radius)", padding: isMobile ? "9px 11px" : "12px 14px",
        marginBottom: isMobile ? 10 : 14, boxShadow: "var(--shadow-sm)",
      }}
    >
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ color: "var(--text-dim)", fontSize: 12, fontWeight: 600 }}>잔고 · 재고</span>
        {pf.mock && (
          <span style={{ fontSize: 9, fontWeight: 700, color: "var(--sky)", border: "1px solid var(--sky)", borderRadius: 999, padding: "1px 7px" }}>
            데모
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span className="tnum" title="즉시 주문 가능한 현금 비중" style={{ fontSize: 11, color: "var(--brand-2)", fontWeight: 600 }}>
          가용 {availPct.toFixed(0)}%
        </span>
        <span className="tnum" style={{ fontSize: 15, fontWeight: 700 }}>{usd(pf.totalUsd)}</span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          style={{ background: "transparent", border: "1px solid var(--border-strong)", color: "var(--text-dim)", borderRadius: 8, padding: "3px 9px", fontSize: 11, cursor: "pointer" }}
        >
          {open ? "접기" : "상세"}
        </button>
      </div>

      {/* skew bar: global (USDT) vs KR (KRW) */}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, margin: "12px 0 5px" }}>
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

      {skewed && (
        <div style={{ marginTop: 8, padding: "7px 10px", borderRadius: 8, background: "var(--neg-soft)", color: "var(--neg)", fontSize: 11.5, fontWeight: 500 }}>
          ⚠ 편중 —{" "}
          {g > 65
            ? "글로벌에 자본 쏠림. KR 쪽 재고 보충(전송) 필요"
            : "KR에 자본 쏠림. USD 회수(리패트리에이션) 필요"}
        </div>
      )}
      {!skewed && (
        <div style={{ marginTop: 8, color: "var(--text-mute)", fontSize: 11 }}>
          균형 양호 — 양쪽 재고로 전송 없이 즉시 체결 가능
        </div>
      )}

      {/* personal wallet (in-transit / self-custody) summary */}
      {pf.wallet && pf.wallet.totalUsd > 0 && (
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11.5 }}>
          <span style={{ color: "var(--text-dim)" }}>
            🔗 개인지갑 <span style={{ color: "var(--text-mute)" }}>· 자체보관/전송 중</span>
          </span>
          <span className="tnum" style={{ color: "var(--text)" }}>{usd(pf.wallet.totalUsd)}</span>
        </div>
      )}

      {/* per-venue detail */}
      {open && (
        <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
          {pf.venues.map((v) => (
            <VenueRow key={v.venue} v={v} />
          ))}
          {pf.wallet && <VenueRow key="wallet" v={pf.wallet} />}
        </div>
      )}
    </div>
  );
}

function VenueRow({ v }: { v: VenueBalance }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{VLABEL[v.venue] ?? v.venue}</span>
        {v.connected ? (
          <span className="tnum" style={{ fontSize: 13, color: "var(--text-dim)" }}>{usd(v.totalUsd)}</span>
        ) : (
          <span style={{ fontSize: 11, color: "var(--text-mute)" }}>키 필요</span>
        )}
      </div>
      {v.connected && (
        <div style={{ marginTop: 3, fontSize: 11.5, color: "var(--text-mute)" }}>
          {v.cashRaw > 0 && (
            <span className="tnum">
              {v.cashLabel === "KRW" ? krw(v.cashRaw) : `${v.cashRaw.toLocaleString("en-US", { maximumFractionDigits: 0 })} USDT`}
            </span>
          )}
          {v.coins.slice(0, 4).map((c, i) => (
            <span key={c.asset}>
              {v.cashRaw > 0 || i > 0 ? " · " : ""}
              <span style={{ color: "var(--text-dim)" }}>{c.asset}</span> {usd(c.usdValue)}
            </span>
          ))}
          {v.coins.length === 0 && v.cashRaw === 0 && <span>—</span>}
        </div>
      )}
    </div>
  );
}
