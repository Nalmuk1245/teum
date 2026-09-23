"use client";

// 백테스트 카드 — 쌓인 갭 에피소드와 상장 히스토리로 "이 설정이면 얼마 벌었나".
// 계산은 서버(/api/backtest, lib/backtest). 여기선 설정 입력과 결과 표시만.

import React from "react";
import { useEffect, useState } from "react";

type Trade = { base: string; kind: string; route: string; entryTs: number; entryNet: number; exitNet: number; sizeUsd: number; profitUsd: number; estimated: boolean };
type Gap = {
  episodes: number; eligible: number; trades: number; wins: number; totalUsd: number; excluded: number;
  avgExitNet: number | null; medianExitNet: number | null; avgEntryNet: number | null; estimated: number; spanDays: number;
  byKind: Record<string, { trades: number; totalUsd: number; wins: number }>; best: Trade[]; worst: Trade[];
};
type Cell = { minNet: number; minHeldSec: number; trades: number; totalUsd: number; winRate: number | null; medianExitNet: number | null; perTradeUsd: number | null };
type Sweep = { cells: Cell[]; best: Cell | null };
type Listing = { marks: { min: number; n: number; avgPct: number | null; medianPct: number | null; winRate: number | null }[]; schema2: number; legacy: number; legacyMedianPeak: number | null };

const KIND_KO: Record<string, string> = { kimchi: "김프·역프", "cross-cex": "크로스", "cex-dex": "CEX-DEX" };
const CARD: React.CSSProperties = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 14px" };
const INP: React.CSSProperties = { background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 8px", color: "var(--text)", fontSize: 12.5, outline: "none", width: "100%", minWidth: 0 };
const CAP: React.CSSProperties = { fontSize: 10.5, color: "var(--text-mute)" };
const pct = (x: number | null) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`);
const usd = (x: number) => `${x >= 0 ? "+" : "−"}$${Math.abs(x).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export function BacktestCard() {
  const [minNet, setMinNet] = useState("0.8");
  const [minHeld, setMinHeld] = useState("60");
  const [size, setSize] = useState("300");
  const [kinds, setKinds] = useState<string[]>(["kimchi", "cross-cex"]);
  const [exec, setExec] = useState(false);
  const [dropBig, setDropBig] = useState(true);
  const [scope, setScope] = useState<"recent" | "all">("recent");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ gap: Gap; listing: Listing } | null>(null);
  const [sw, setSw] = useState<Sweep | null>(null);
  const [swBusy, setSwBusy] = useState(false);
  const runSweep = async () => {
    setSwBusy(true);
    try {
      const q = new URLSearchParams({ size, kinds: kinds.join(","), exec: exec ? "1" : "0", scope, maxEntry: dropBig ? "10" : "0", sweep: "1" });
      const j = await (await fetch(`/api/backtest?${q}`, { cache: "no-store" })).json();
      setSw(j.sweep ?? null);
    } catch { /* */ } finally { setSwBusy(false); }
  };
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const q = new URLSearchParams({ minNet, minHeld, size, kinds: kinds.join(","), exec: exec ? "1" : "0", scope, maxEntry: dropBig ? "10" : "0" });
      const j = await (await fetch(`/api/backtest?${q}`, { cache: "no-store" })).json();
      if (!j.gap) throw new Error(j.error ?? "실패");
      setRes(j);
    } catch (e) { setErr(e instanceof Error ? e.message : "실패"); }
    finally { setBusy(false); }
  };
  useEffect(() => { void run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const g = res?.gap;
  return (
    <div style={CARD}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>백테스트</span>
        <span style={CAP}>쌓인 갭 기록으로 "이 설정이면 얼마 벌었나"</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 8 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 3 }}><span style={CAP}>최소 순수익 %</span><input style={INP} value={minNet} onChange={(e) => setMinNet(e.target.value)} /></label>
        <label style={{ display: "flex", flexDirection: "column", gap: 3 }}><span style={CAP}>최소 지속 초</span><input style={INP} value={minHeld} onChange={(e) => setMinHeld(e.target.value)} /></label>
        <label style={{ display: "flex", flexDirection: "column", gap: 3 }}><span style={CAP}>규모 $</span><input style={INP} value={size} onChange={(e) => setSize(e.target.value)} /></label>
        <label style={{ display: "flex", flexDirection: "column", gap: 3 }}><span style={CAP}>기간</span>
          <select style={INP} value={scope} onChange={(e) => setScope(e.target.value as "recent" | "all")}><option value="recent">최근 파일</option><option value="all">전체 기록</option></select>
        </label>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 8, fontSize: 12 }}>
        {Object.entries(KIND_KO).map(([k, label]) => (
          <label key={k} style={{ display: "inline-flex", gap: 4, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={kinds.includes(k)} onChange={(e) => setKinds((p) => (e.target.checked ? [...p, k] : p.filter((x) => x !== k)))} />{label}
          </label>
        ))}
        <label style={{ display: "inline-flex", gap: 4, alignItems: "center", cursor: "pointer" }} title="그때 입출금이 막히지 않아 실행 가능했던 에피소드만">
          <input type="checkbox" checked={exec} onChange={(e) => setExec(e.target.checked)} />실행 가능했던 것만
        </label>
        <label style={{ display: "inline-flex", gap: 4, alignItems: "center", cursor: "pointer" }} title="진입 순수익 10% 이상은 대개 입출금 정지나 같은 티커의 다른 토큰이다 — 끄면 그 '유령 수익'이 결과를 지배한다">
          <input type="checkbox" checked={dropBig} onChange={(e) => setDropBig(e.target.checked)} />10% 넘는 갭 제외
        </label>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => void run()} disabled={busy}
          style={{ border: "none", borderRadius: 8, padding: "6px 14px", background: "var(--brand)", color: "var(--brand-ink)", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>{busy ? "계산 중…" : "돌려보기"}</button>
        <button type="button" onClick={() => void runSweep()} disabled={swBusy} title="최소 순수익 × 최소 지속 조합 35개를 전부 돌려 비교"
          style={{ border: "1px solid var(--border-strong)", borderRadius: 8, padding: "6px 12px", background: "transparent", color: "var(--text-dim)", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>{swBusy ? "탐색 중…" : "설정 탐색"}</button>
      </div>
      {err && <div style={{ fontSize: 11.5, color: "var(--neg)", marginTop: 8 }}>{err}</div>}

      {g && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 8, marginTop: 12 }}>
            {[
              ["총 손익", usd(g.totalUsd), g.totalUsd >= 0 ? "var(--pos)" : "var(--neg)"],
              ["거래", `${g.trades}건`, undefined],
              ["승률", g.trades ? `${Math.round((g.wins / g.trades) * 100)}%` : "—", undefined],
              ["진입 → 청산 순수익", `${pct(g.avgEntryNet)} → ${pct(g.avgExitNet)}`, (g.avgExitNet ?? 0) >= 0 ? "var(--pos)" : "var(--neg)"],
            ].map(([l, v, c]) => (
              <div key={l} style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px" }}>
                <div style={CAP}>{l}</div>
                <div className="tnum" style={{ fontSize: 15, fontWeight: 800, color: c ?? "var(--text)" }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-mute)", marginTop: 6, lineHeight: 1.5 }}>
            에피소드 {g.episodes.toLocaleString()}개({g.spanDays}일) 중 조건 맞는 {g.eligible.toLocaleString()}개 → 진입 {g.trades}건{g.excluded > 0 && <> (10% 넘는 갭 {g.excluded}건 제외 — 입출금 정지·다른 토큰 의심)</>}.
            청산은 진입 + 전송 ETA 시점의 순수익(헷지 가정). {g.estimated > 0 && <>그중 {g.estimated}건은 도착 전에 갭이 끝나 마지막 값으로 추정. </>}
            규모는 그때 잡을 수 있던 호가 한도로 자름.
          </div>
          {Object.keys(g.byKind).length > 1 && (
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 11.5, marginTop: 6 }}>
              {Object.entries(g.byKind).map(([k, v]) => (
                <span key={k}>{KIND_KO[k] ?? k} {v.trades}건 <b className="tnum" style={{ color: v.totalUsd >= 0 ? "var(--pos)" : "var(--neg)" }}>{usd(v.totalUsd)}</b></span>
              ))}
            </div>
          )}
          {g.trades > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto auto auto", gap: "3px 10px", fontSize: 11.5, marginTop: 10, alignItems: "baseline" }}>
              <span style={CAP}>코인</span><span style={CAP}>경로</span><span style={{ ...CAP, textAlign: "right" }}>진입→청산</span><span style={{ ...CAP, textAlign: "right" }}>규모</span><span style={{ ...CAP, textAlign: "right" }}>손익</span>
              {[...g.best.slice(0, 5), ...g.worst.filter((w) => !g.best.slice(0, 5).includes(w)).slice(0, 3)].map((t, i) => (
                <React.Fragment key={t.base + t.entryTs + i}>
                  <b>{t.base}</b>
                  <span style={{ color: "var(--text-mute)" }}>{t.route}{t.estimated ? " · 추정" : ""}</span>
                  <span className="tnum" style={{ textAlign: "right" }}>{pct(t.entryNet)} → {pct(t.exitNet)}</span>
                  <span className="tnum" style={{ textAlign: "right", color: "var(--text-dim)" }}>${t.sizeUsd.toFixed(0)}</span>
                  <span className="tnum" style={{ textAlign: "right", fontWeight: 700, color: t.profitUsd >= 0 ? "var(--pos)" : "var(--neg)" }}>{usd(t.profitUsd)}</span>
                </React.Fragment>
              ))}
            </div>
          )}
        </>
      )}

      {sw && (() => {
        const nets = [...new Set(sw.cells.map((c) => c.minNet))];
        const helds = [...new Set(sw.cells.map((c) => c.minHeldSec))];
        const max = Math.max(1, ...sw.cells.map((c) => Math.abs(c.totalUsd)));
        const at = (n: number, h: number) => sw.cells.find((c) => c.minNet === n && c.minHeldSec === h)!;
        return (
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>설정 탐색 — 총 손익 (칸을 누르면 그 설정으로)</div>
            <div style={{ fontSize: 10.5, color: "var(--text-mute)", marginBottom: 6 }}>
              {sw.best ? <>추천(20건↑·지속 30초↑·중앙 청산 +): 순수익 ≥{sw.best.minNet}% · {sw.best.minHeldSec}초 지속 → {sw.best.trades}건 {usd(sw.best.totalUsd)} (건당 {usd(sw.best.perTradeUsd ?? 0)}). </> : "추천 조건(20건↑·지속 30초↑·중앙 청산 +)을 채운 설정이 없음. "}
              과거에 맞춘 최고값이라 실전은 이보다 못하다 — 이웃 칸도 괜찮은 설정을 고를 것.
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", fontSize: 11, minWidth: 420 }}>
                <thead><tr><th style={{ ...CAP, textAlign: "left", padding: "3px 6px" }}>순수익 \ 지속</th>{helds.map((h) => <th key={h} style={{ ...CAP, padding: "3px 6px" }}>{h}초</th>)}</tr></thead>
                <tbody>{nets.map((n) => (
                  <tr key={n}><td style={{ ...CAP, padding: "3px 6px" }}>≥{n}%</td>{helds.map((h) => {
                    const c = at(n, h);
                    const a = Math.min(0.55, Math.abs(c.totalUsd) / max * 0.55);
                    const isBest = sw.best && c.minNet === sw.best.minNet && c.minHeldSec === sw.best.minHeldSec;
                    return (
                      <td key={h} onClick={() => { setMinNet(String(n)); setMinHeld(String(h)); }}
                        title={`${c.trades}건 · 승률 ${c.winRate ?? "—"}% · 청산 중앙값 ${pct(c.medianExitNet)}`}
                        className="tnum"
                        style={{ padding: "4px 6px", textAlign: "right", cursor: "pointer", border: isBest ? "1.5px solid var(--brand)" : "1px solid var(--border)", opacity: c.trades < 20 ? 0.5 : 1,
                          background: c.totalUsd >= 0 ? `color-mix(in srgb, var(--pos) ${Math.round(a * 100)}%, transparent)` : `color-mix(in srgb, var(--neg) ${Math.round(a * 100)}%, transparent)` }}>
                        {usd(c.totalUsd)}<div style={{ fontSize: 9, color: "var(--text-mute)" }}>{c.trades}건</div>
                      </td>
                    );
                  })}</tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {res?.listing && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>상장따리 — 공지 때 사서 N분 뒤 팔았으면</div>
          {res.listing.schema2 === 0 ? (
            <div style={{ fontSize: 11.5, color: "var(--text-mute)" }}>
              새 형식 기록 0건 — 공지 후 5·15·30·60분 수익률은 이제부터 쌓입니다.
              {res.listing.legacy > 0 && <> 참고로 옛 기록 {res.listing.legacy}건의 피크 중앙값은 {pct(res.listing.legacyMedianPeak)} (기준가가 늦게 잡혀 과소평가됐을 수 있음).</>}
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 6 }}>
              {res.listing.marks.map((m) => (
                <div key={m.min} style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", textAlign: "center" }}>
                  <div style={CAP}>{m.min}분 후 · {m.n}건</div>
                  <div className="tnum" style={{ fontWeight: 800, color: (m.medianPct ?? 0) >= 0 ? "var(--pos)" : "var(--neg)" }}>{pct(m.medianPct)}</div>
                  <div style={CAP}>승률 {m.winRate ?? "—"}%</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
