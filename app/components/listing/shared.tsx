"use client";

import React from "react";
import { useEffect, useState } from "react";
import type { ListingDetail, DexRow, CexRow } from "@/lib/listingDetail";

export type { DexRow, CexRow };
export type Detail = ListingDetail;

export type Buy = { where: string; usd: number; qty: number | null; price: number | null; ts: number; dry: boolean };
export type Listing = {
  base: string; venue: string; announcedAt: number; overseas: boolean; opened: boolean;
  openedAt?: number; opensAt?: number; drill?: boolean; globalVenue?: string; globalPrice?: number; title?: string;
  buys?: Buy[]; sells?: Buy[]; peakPct?: number;
};
export type HistoryRow = {
  base: string; venue: string; announcedAt: number; openedAt: number | null; opensAt: number | null;
  peakPct: number | null; peakAfterMin: number | null; buys: number; buyUsd: number; realizedUsd: number | null;
};
export type Watch = {
  annOkAgoSec: number | null; annBlocked: boolean; mktOkAgoSec: number | null;
  tgConfigured: boolean; tgChannel: string | null; tgOkAgoSec: number | null; plays: number;
};
export type WalletBreak = { address: string; tag: string | null; type: "hot" | "cold"; amount: number; usd: number | null };
export type Holdings = {
  venues: { venue: string; hot: number; hotUsd: number | null; cold: number; hotDeltaPerMin: number | null; hotInPerMin: number | null; hotOutPerMin: number | null; breakdown?: WalletBreak[] }[];
  priceUsd: number | null; globalHotUsd: number | null; dumpRatioPct: number | null; note?: string;
};
export type AutoCfg = { armed: boolean; sizeUsd: number };

export const fmtUsd = (n: number | null | undefined, digits = 0): string =>
  n == null ? "—" : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(digits)}`;
export const fmtPx = (n: number | null | undefined): string =>
  n == null ? "—" : n >= 100 ? n.toLocaleString(undefined, { maximumFractionDigits: 1 }) : n >= 0.01 ? n.toFixed(4) : n.toPrecision(3);
export const fmtQty = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(1));
export const ago = (ts: number) => { const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; };

export const CAP: React.CSSProperties = { fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-mute)" };
/** 열려 있는 상세 블록에 붙는 id — 히스토리에서 열었을 때 거기로 스크롤하기 위한 표식. */
export const DETAIL_ANCHOR = "listing-detail-open";
export const CARD: React.CSSProperties = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 14px"  }
export const BTN: React.CSSProperties = { border: "none", borderRadius: 9, padding: "6px 12px", background: "var(--brand)", color: "var(--brand-ink)", fontWeight: 700, fontSize: 11.5, cursor: "pointer" };
export const BTN_SELL: React.CSSProperties = { ...BTN, background: "var(--neg)", color: "#fff" };
export const BTN_GHOST: React.CSSProperties = { border: "1px solid var(--border-strong)", borderRadius: 9, padding: "5px 10px", background: "transparent", color: "var(--text-dim)", fontWeight: 600, fontSize: 11, cursor: "pointer" };
export type PreviewData = {
  expectedOut: number; pricePerToken: number; minReceive: number; slippagePct: number;
  priceImpactPct: number | null; tradeFeeUsd: number | null; gasUsd: number | null;
  route: string[]; honeypot: boolean; taxRatePct: number | null;
  liquidity: "deep" | "ok" | "thin"; probeUsd: number; probeImpactPct: number | null;
};
export type TxStatusData = { status: "pending" | "success" | "fail" | "unknown"; failReason: string | null };
export const INPUT: React.CSSProperties = { background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 9, color: "var(--text)", padding: "4px 8px", fontSize: 12, outline: "none" };

// 실행 표 공통 그리드: 처 | 가격 | 내 자금 | 비고 | 액션
export const EXEC_COLS = "84px minmax(70px,1fr) minmax(60px,1fr) minmax(80px,1.2fr) auto";
// 모바일: 고정 최소폭 5열(84+70+60+80+버튼 ≈ 430px)은 360px 폰을 넘겨 매수·매도
// 버튼이 화면 밖으로 밀린다. 이름·가격·버튼만 남기고 나머지는 전폭 한 줄로 내린다.
export const EXEC_COLS_M = "minmax(0,1fr) minmax(0,auto) auto";

/** 개장 카운트다운 — 1초 틱, 임박(5분)부터 앰버. */
export function Countdown({ opensAt }: { opensAt: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const left = opensAt - Date.now();
  if (left <= 0) return <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--pos)" }}>개장 시각 경과</span>;
  const h = Math.floor(left / 3600_000), m = Math.floor((left % 3600_000) / 60_000), s = Math.floor((left % 60_000) / 1000);
  const soon = left <= 5 * 60_000;
  return (
    <span className="tnum" style={{ fontSize: 11, fontWeight: 700, color: soon ? "var(--amber)" : "var(--brand-2)" }}>
      개장 T−{h > 0 ? `${h}h ` : ""}{m}m {h === 0 ? `${s}s` : ""}
    </span>
  );
}
