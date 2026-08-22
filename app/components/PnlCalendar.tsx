"use client";

// 손익 캘린더 — 트레이딩 저널식 월 그리드. 날짜마다 그날 실현 손익이 색으로
// 뜨고(흑자 초록·적자 빨강, 진하기 = 크기), 클릭하면 그날 거래 목록이 펼쳐진다.
// 주 단위 소계 열 + 월 합계 헤더. 데이터는 /api/pnl-calendar (일 경계 = KST,
// 리스크 카드의 "오늘 실현"과 같은 시간대).

import React from "react";
import { useEffect, useMemo, useState } from "react";
import type { DayPnl } from "@/lib/trades";

type DayTrade = {
  ts: number; base: string; kind: string; route: string; sizeUsd: number;
  detectedNetPct: number; realizedNetPct: number | null; realizedPnlUsd: number | null;
  dryRun: boolean; status?: string; note?: string;
};

const money = (n: number, digits?: number) => {
  const abs = Math.abs(n);
  const d = digits ?? (abs >= 100 ? 0 : 2);
  return `${n >= 0 ? "+" : "−"}$${abs.toFixed(d)}`;
};
const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

export function PnlCalendar() {
  const [days, setDays] = useState<DayPnl[] | null>(null);
  const [month, setMonth] = useState(() => ym(new Date()));
  const [sel, setSel] = useState<string | null>(null);
  const [selTrades, setSelTrades] = useState<DayTrade[] | null>(null);

  useEffect(() => {
    const load = () => fetch("/api/pnl-calendar", { cache: "no-store" }).then((r) => r.json()).then((j) => setDays(j.days ?? [])).catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  // 날짜 클릭 → 그날 거래. 다시 클릭하면 접는다.
  useEffect(() => {
    if (!sel) { setSelTrades(null); return; }
    let dead = false;
    setSelTrades(null);
    fetch(`/api/pnl-calendar?day=${sel}`, { cache: "no-store" })
      .then((r) => r.json()).then((j) => { if (!dead) setSelTrades(j.trades ?? []); })
      .catch(() => { if (!dead) setSelTrades([]); });
    return () => { dead = true; };
  }, [sel]);

  const byDate = useMemo(() => new Map((days ?? []).map((d) => [d.date, d])), [days]);
  const nowYm = ym(new Date());
  const [y, m] = month.split("-").map(Number);

  // 주 단위(일요일 시작)로 셀을 깐다. 날짜 계산은 UTC 고정 — 브라우저 시간대에
  // 따라 월초 요일이 흔들리면 안 된다.
  const weeks = useMemo(() => {
    const first = new Date(Date.UTC(y, m - 1, 1));
    const nDays = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const cells: (string | null)[] = Array(first.getUTCDay()).fill(null);
    for (let d = 1; d <= nDays; d++) cells.push(`${month}-${String(d).padStart(2, "0")}`);
    while (cells.length % 7) cells.push(null);
    const out: (string | null)[][] = [];
    for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
    return out;
  }, [y, m, month]);

  // 색 진하기 스케일 — 이 달의 최대 |손익| 기준.
  const maxAbs = useMemo(() => {
    let mx = 0;
    for (const w of weeks) for (const d of w) {
      const v = d ? byDate.get(d) : null;
      if (v && v.realCount > 0) mx = Math.max(mx, Math.abs(v.pnlUsd));
    }
    return mx;
  }, [weeks, byDate]);

  // 월 합계
  const sum = useMemo(() => {
    const s = { pnl: 0, real: 0, wins: 0, dry: 0, dryPnl: 0, posDays: 0, negDays: 0 };
    for (const w of weeks) for (const d of w) {
      const v = d ? byDate.get(d) : null;
      if (!v) continue;
      s.pnl += v.pnlUsd; s.real += v.realCount; s.wins += v.wins; s.dry += v.dryCount; s.dryPnl += v.dryPnlUsd;
      if (v.realCount > 0) { if (v.pnlUsd >= 0) s.posDays++; else s.negDays++; }
    }
    return s;
  }, [weeks, byDate]);

  const move = (dir: -1 | 1) => {
    const d = new Date(Date.UTC(y, m - 1 + dir, 1));
    const next = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (dir > 0 && next > nowYm) return; // 미래 달은 없다
    setMonth(next); setSel(null);
  };
  const today = (() => {
    const d = new Date();
    return `${ym(d)}-${String(d.getDate()).padStart(2, "0")}`;
  })();

  const navBtn = (label: string, onClick: () => void, disabled?: boolean) => (
    <button
      type="button" onClick={onClick} disabled={disabled}
      style={{ border: "1px solid var(--border-strong)", background: "transparent", color: disabled ? "var(--text-mute)" : "var(--text-dim)", borderRadius: 8, width: 24, height: 24, fontSize: 12, fontWeight: 700, cursor: disabled ? "default" : "pointer", lineHeight: 1 }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ margin: "12px 0 10px" }}>
      {/* 헤더: 월 이동 + 월 합계 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        {navBtn("‹", () => move(-1))}
        <span className="tnum" style={{ fontSize: 12.5, fontWeight: 700, minWidth: 74, textAlign: "center" }}>{y}년 {m}월</span>
        {navBtn("›", () => move(1), month >= nowYm)}
        <span style={{ flex: 1 }} />
        {sum.real > 0 ? (
          <span className="tnum" style={{ fontSize: 11, color: "var(--text-dim)" }}>
            <b style={{ color: sum.pnl >= 0 ? "var(--pos)" : "var(--neg)", fontSize: 12.5 }}>{money(sum.pnl)}</b>
            <span style={{ marginLeft: 8 }}>실거래 {sum.real}건 · 승 {sum.wins}</span>
            <span style={{ marginLeft: 8, color: "var(--text-mute)" }}>흑자 {sum.posDays}일 / 적자 {sum.negDays}일</span>
          </span>
        ) : sum.dry > 0 ? (
          <span className="tnum" style={{ fontSize: 11, color: "var(--text-mute)" }}>페이퍼 {sum.dry}건 · 리허설 {money(sum.dryPnl)}</span>
        ) : (
          <span style={{ fontSize: 11, color: "var(--text-mute)" }}>{days == null ? "불러오는 중…" : "이 달 거래 없음"}</span>
        )}
      </div>

      {/* 그리드: 요일 헤더 + 날짜 셀 + 주 소계 열 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0,1fr)) minmax(46px,0.9fr)", gap: 3 }}>
        {["일", "월", "화", "수", "목", "금", "토"].map((d, i) => (
          <div key={d} style={{ fontSize: 9, textAlign: "center", color: i === 0 ? "var(--neg)" : "var(--text-mute)", padding: "2px 0" }}>{d}</div>
        ))}
        <div style={{ fontSize: 9, textAlign: "center", color: "var(--text-mute)", padding: "2px 0" }}>주</div>

        {weeks.map((week, wi) => {
          const wk = week.reduce((s, d) => {
            const v = d ? byDate.get(d) : null;
            return v && v.realCount > 0 ? s + v.pnlUsd : s;
          }, 0);
          const wkHas = week.some((d) => { const v = d ? byDate.get(d) : null; return !!v && v.realCount > 0; });
          return (
            <React.Fragment key={wi}>
              {week.map((date, di) => {
                if (!date) return <div key={di} />;
                const v = byDate.get(date);
                const hasReal = !!v && v.realCount > 0;
                const dryOnly = !!v && !hasReal && v.dryCount > 0;
                const ratio = hasReal && maxAbs > 0 ? Math.abs(v!.pnlUsd) / maxAbs : 0;
                const bg = hasReal
                  ? `color-mix(in srgb, ${v!.pnlUsd >= 0 ? "var(--pos)" : "var(--neg)"} ${Math.round(10 + ratio * 35)}%, transparent)`
                  : dryOnly ? "var(--card-3)" : "transparent";
                const isSel = sel === date;
                return (
                  <div
                    key={date}
                    onClick={() => v && setSel(isSel ? null : date)}
                    title={v ? `${date} · ${v.count}건${hasReal ? ` · ${money(v.pnlUsd)}` : ""}${v.dryCount ? ` · 페이퍼 ${v.dryCount}` : ""}` : date}
                    style={{
                      minHeight: 44, borderRadius: 7, padding: "3px 4px 2px", background: bg,
                      border: isSel ? "1.5px solid var(--brand)" : date === today ? "1px solid var(--border-strong)" : "1px solid transparent",
                      cursor: v ? "pointer" : "default", minWidth: 0, overflow: "hidden",
                    }}
                  >
                    <div className="tnum" style={{ fontSize: 8.5, color: "var(--text-mute)" }}>{Number(date.slice(-2))}</div>
                    {hasReal && (
                      <div className="tnum" style={{ fontSize: 10, fontWeight: 700, letterSpacing: "-0.02em", color: v!.pnlUsd >= 0 ? "var(--pos)" : "var(--neg)" }}>
                        {money(v!.pnlUsd)}
                      </div>
                    )}
                    {hasReal && <div className="tnum" style={{ fontSize: 8, color: "var(--text-mute)" }}>{v!.realCount}건{v!.dryCount ? ` +페이퍼` : ""}</div>}
                    {dryOnly && <div className="tnum" style={{ fontSize: 8.5, color: "var(--sky)" }}>페이퍼 {v!.dryCount}</div>}
                  </div>
                );
              })}
              <div style={{ minHeight: 44, borderRadius: 7, padding: "3px 4px 2px", background: "var(--bg)", border: "1px solid var(--border)", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", minWidth: 0 }}>
                {wkHas ? (
                  <span className="tnum" style={{ fontSize: 9.5, fontWeight: 700, color: wk >= 0 ? "var(--pos)" : "var(--neg)", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>{money(wk)}</span>
                ) : (
                  <span style={{ fontSize: 9, color: "var(--text-mute)" }}>—</span>
                )}
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {/* 선택한 날짜 상세 */}
      {sel && (
        <div style={{ marginTop: 8, padding: "8px 12px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
            <span className="tnum" style={{ fontSize: 11.5, fontWeight: 700 }}>{sel}</span>
            {(() => { const v = byDate.get(sel); return v && v.realCount > 0 ? (
              <span className="tnum" style={{ fontSize: 11, fontWeight: 700, color: v.pnlUsd >= 0 ? "var(--pos)" : "var(--neg)" }}>{money(v.pnlUsd)}</span>
            ) : null; })()}
            <span style={{ flex: 1 }} />
            <button type="button" onClick={() => setSel(null)} style={{ border: "none", background: "transparent", color: "var(--text-mute)", fontSize: 11, cursor: "pointer" }}>닫기 ✕</button>
          </div>
          {selTrades == null ? (
            <div style={{ fontSize: 11, color: "var(--text-mute)", padding: "4px 0" }}>불러오는 중…</div>
          ) : selTrades.length === 0 ? (
            <div style={{ fontSize: 11, color: "var(--text-mute)", padding: "4px 0" }}>거래 없음</div>
          ) : (
            selTrades.map((t, i) => (
              <div key={`${t.ts}:${i}`} style={{ display: "grid", gridTemplateColumns: "auto minmax(0,1fr) auto auto", gap: 8, alignItems: "baseline", padding: "3.5px 0", borderTop: i > 0 ? "1px solid var(--border)" : "none", fontSize: 11 }}>
                <span className="tnum" style={{ color: "var(--text-mute)" }}>
                  {new Date(t.ts).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false })}
                </span>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <b>{t.base}</b>
                  <span style={{ marginLeft: 5, fontSize: 9.5, fontWeight: 700, color: "var(--brand-2)" }}>
                    {t.kind === "kimchi" ? "김프" : t.kind === "cross-cex" ? "크로스" : t.kind === "cex-dex" ? "CEX-DEX" : t.kind}
                  </span>
                  {t.dryRun && <span style={{ marginLeft: 5, fontSize: 9, fontWeight: 700, color: "var(--sky)", border: "1px solid var(--sky)", borderRadius: 8, padding: "0 4px" }}>페이퍼</span>}
                  <span style={{ marginLeft: 6, fontSize: 10, color: "var(--text-mute)" }}>{t.route}</span>
                </span>
                <span className="tnum" style={{ fontSize: 10, color: "var(--text-mute)" }}>
                  {t.realizedNetPct != null ? `${t.realizedNetPct >= 0 ? "+" : ""}${t.realizedNetPct.toFixed(2)}%` : `~${t.detectedNetPct.toFixed(2)}%`}
                </span>
                <span className="tnum" style={{ fontWeight: 700, textAlign: "right", color: t.realizedPnlUsd == null ? "var(--text-mute)" : t.realizedPnlUsd >= 0 ? "var(--pos)" : "var(--neg)" }}>
                  {t.realizedPnlUsd != null ? money(t.realizedPnlUsd, 2) : "—"}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default PnlCalendar;
