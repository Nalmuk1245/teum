"use client";

import { useEffect, useState } from "react";
import type { Portfolio, VenueBalance } from "@/lib/types";
import { usd } from "@/lib/format";

const VLABEL: Record<string, string> = { binance: "Binance", upbit: "Upbit", bithumb: "Bithumb", bybit: "Bybit", okx: "OKX", wallet: "개인지갑" };
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
  // 정프(KR premium) flow is one-directional: USDT depletes globally, KRW piles
  // up in KR, and repatriating back is the expensive/regulated leg. So the ideal
  // is NOT 50:50 — a 정프-dominant regime should sit deliberately global-heavy
  // and repatriate in batches. Target ~65% global; only warn outside a wide band.
  const TARGET_GLOBAL = 65;
  const skewed = g < 40 || g > 85;
  // 가용률 — 거래소 자본 중 즉시 주문 가능한 현금(USDT/KRW) 비중.
  const exchTotal = pf.venues.reduce((s, v) => s + v.totalUsd, 0);
  const cashTotal = pf.venues.reduce((s, v) => s + v.cashUsd, 0);
  const availPct = exchTotal > 0 ? (cashTotal / exchTotal) * 100 : 0;
  return { g, skewed, availPct, target: TARGET_GLOBAL };
}

/**
 * Compact one-line asset summary for the trading tabs — total, available cash
 * share, skew warning. Tap → the 자산 tab for the full breakdown.
 */
export function AssetSummary({ isMobile, onOpen }: { isMobile?: boolean; onOpen?: () => void }) {
  const pf = usePortfolio();
  if (!pf) return null;
  const { g, skewed, availPct, target } = derive(pf);
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
        <span style={{ fontSize: 9, fontWeight: 700, color: "var(--sky)", border: "1px solid var(--sky)", borderRadius: 9, padding: "1px 7px" }}>
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
  const { g, skewed, availPct, target } = derive(pf);
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
            <span style={{ fontSize: 9, fontWeight: 700, color: "var(--sky)", border: "1px solid var(--sky)", borderRadius: 9, padding: "1px 7px" }}>
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
        <div style={{ display: "flex", height: 10, borderRadius: 9, overflow: "hidden", background: "var(--bg)", border: "1px solid var(--border)" }}>
          <div style={{ width: `${g}%`, background: "var(--brand)" }} />
          <div style={{ width: `${100 - g}%`, background: "var(--sky)" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-mute)", marginTop: 4 }}>
          <span>{g.toFixed(0)}%</span>
          <span>{(100 - g).toFixed(0)}%</span>
        </div>

        {skewed ? (
          <div style={{ marginTop: 10, padding: "7px 10px", borderRadius: 9, background: "var(--neg-soft)", color: "var(--neg)", fontSize: 11.5, fontWeight: 500 }}>
            {g > 85
              ? "글로벌 과다 — USDT 놀고 있음. KR 재고 보충하거나 규모 확대"
              : `KR 과다 — 원화가 묶임. USD 회수(원화 회수)를 원/USDT 유리할 때 배치로 (목표 글로벌 ${target}%)`}
          </div>
        ) : (
          <div style={{ marginTop: 10, color: "var(--text-mute)", fontSize: 11 }}>
            정프 장세 적정 — 글로벌 {target}% 목표 근처 (50:50 아님: 회수가 비싼 다리)
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

      {/* ── 거래소별 — 한 줄 요약 표, 클릭 시 코인 목록 펼침 ──
          (예전: 거래소마다 풀 카드 6개 세로 스택 — 자산별 합산과 같은 코인을
           두 번 보여주며 스크롤만 늘렸다. 상세는 원할 때만 편다.) */}
      <VenueSummary venues={allVenues} totalUsd={pf.totalUsd} isMobile={isMobile} />

      {/* ── 지갑 도구 — 잔고와 성격이 다르므로 접이식으로 분리 ── */}
      <ToolsSection isMobile={isMobile} />
    </div>
  );
}

// ── 거래소별 요약 — venue당 한 줄 (현금·코인·합계·비중), 클릭 펼침 ────────────
function VenueSummary({ venues, totalUsd, isMobile }: { venues: VenueBalance[]; totalUsd: number; isMobile?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const connected = venues.filter((v) => v.connected);
  const missing = venues.filter((v) => !v.connected).map((v) => VLABEL[v.venue] ?? v.venue);
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: isMobile ? "12px 14px" : "14px 18px" }}>
      <div style={{ color: "var(--text-dim)", fontSize: 12, fontWeight: 600, marginBottom: 8 }}>거래소별</div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(64px,1fr) minmax(0,1.1fr) minmax(0,1.1fr) minmax(0,1.3fr) 14px", gap: 8, fontSize: 10, color: "var(--text-mute)", padding: "0 0 4px" }}>
        <span>거래소</span><span style={{ textAlign: "right" }}>현금</span><span style={{ textAlign: "right" }}>코인</span><span style={{ textAlign: "right" }}>합계 · 비중</span><span />
      </div>
      {connected.map((v) => {
        const label = VLABEL[v.venue] ?? v.venue;
        const coinsUsd = v.coins.reduce((s, c) => s + c.usdValue, 0);
        const opened = open === v.venue;
        const rows = [
          ...(v.cashUsd > 0 ? [{ asset: v.cashLabel, amount: v.cashRaw, usdValue: v.cashUsd, sub: "현금", sharePct: v.totalUsd > 0 ? (v.cashUsd / v.totalUsd) * 100 : 0 }] : []),
          ...v.coins.map((c) => ({ asset: c.asset, amount: c.amount, usdValue: c.usdValue, sub: undefined as string | undefined, sharePct: v.totalUsd > 0 ? (c.usdValue / v.totalUsd) * 100 : 0 })),
        ];
        return (
          <div key={v.venue} style={{ borderTop: "1px solid var(--border)" }}>
            <div onClick={() => setOpen(opened ? null : v.venue)}
              style={{ display: "grid", gridTemplateColumns: "minmax(64px,1fr) minmax(0,1.1fr) minmax(0,1.1fr) minmax(0,1.3fr) 14px", gap: 8, alignItems: "center", padding: "7px 0", cursor: "pointer" }}>
              <span style={{ fontWeight: 700, fontSize: 12.5, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {label}{v.venue === "wallet" && <span style={{ fontSize: 9.5, color: "var(--text-mute)", marginLeft: 4 }}>전송 중</span>}
              </span>
              <span className="tnum" style={{ textAlign: "right", fontSize: 12, color: "var(--text-dim)" }}>{v.cashUsd > 0 ? usd(v.cashUsd) : "—"}</span>
              <span className="tnum" style={{ textAlign: "right", fontSize: 12, color: "var(--text-dim)" }}>{coinsUsd > 0 ? usd(coinsUsd) : "—"}</span>
              <span style={{ textAlign: "right" }}>
                <span className="tnum" style={{ fontSize: 12.5, fontWeight: 700 }}>{usd(v.totalUsd)}</span>
                <span className="tnum" style={{ fontSize: 9.5, color: "var(--text-mute)", marginLeft: 5 }}>{totalUsd > 0 ? `${((v.totalUsd / totalUsd) * 100).toFixed(0)}%` : ""}</span>
              </span>
              <span style={{ fontSize: 9, color: "var(--text-mute)", textAlign: "right" }}>{opened ? "▲" : "▼"}</span>
            </div>
            {opened && (
              <div style={{ padding: "2px 0 8px" }}>
                {rows.length ? <AssetTable rows={rows} /> : <div style={{ color: "var(--text-mute)", fontSize: 12 }}>보유 없음</div>}
              </div>
            )}
          </div>
        );
      })}
      {missing.length > 0 && (
        <div style={{ borderTop: "1px solid var(--border)", padding: "7px 0 2px", fontSize: 11, color: "var(--text-mute)" }}>
          미연결: {missing.join(" · ")} — 헤더 ⚙ 설정에 키를 넣으면 실잔고 표시
        </div>
      )}
    </div>
  );
}

// ── 지갑 도구 — 브릿지·온체인 히스토리. 매일 보는 화면이 아니라 접어 둔다 ─────
function ToolsSection({ isMobile }: { isMobile?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: isMobile ? "10px 14px" : "12px 18px" }}>
      <div onClick={() => setOpen(!open)} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
        <span style={{ color: "var(--text-dim)", fontSize: 12, fontWeight: 600 }}>지갑 도구</span>
        <span style={{ fontSize: 10.5, color: "var(--text-mute)" }}>크로스체인 브릿지 · 온체인 히스토리</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: "var(--text-mute)" }}>{open ? "▲ 접기" : "▼ 펼치기"}</span>
      </div>
      {open && (
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "minmax(0,1fr)" : "minmax(0,1fr) minmax(0,1fr)", gap: 12, marginTop: 12 }}>
          <BridgeCard />
          <WalletHistoryCard />
        </div>
      )}
    </div>
  );
}

// ── 크로스체인 브릿지 (OKX v6 cross-chain) — 지갑 스테이블 리밸런싱 ───────────
function BridgeCard() {
  const CHAINS_OPT = ["ethereum", "base", "bsc"];
  const [from, setFrom] = useState("ethereum");
  const [to, setTo] = useState("base");
  const [amt, setAmt] = useState("500");
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState<{ bridge?: string; outUsd?: number; feeUsd?: number; etaMin?: number; error?: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const sel: React.CSSProperties = { background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 9, color: "var(--text)", padding: "6px 8px", fontSize: 12, outline: "none" };
  const getQuote = async () => {
    setBusy(true); setQ(null); setMsg(null);
    try { setQ(await (await fetch(`/api/bridge?from=${from}&to=${to}&amountUsd=${Number(amt) || 0}`, { cache: "no-store" })).json()); }
    catch { setQ({ error: "요청 실패" }); }
    finally { setBusy(false); }
  };
  const exec = async () => {
    setBusy(true); setMsg(null);
    try {
      const j = await (await fetch("/api/bridge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from, to, amountUsd: Number(amt) || 0 }) })).json();
      setMsg(`${j.ok ? "✓" : "✗"} ${j.message ?? ""}${j.tx ? ` · tx ${String(j.tx).slice(0, 14)}…` : ""}`);
    } catch { setMsg("✗ 요청 실패"); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 14px" }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 3 }}>크로스체인 브릿지</div>
      <div style={{ fontSize: 10.5, color: "var(--text-mute)", marginBottom: 9 }}>지갑 스테이블(USDC/USDT)을 체인 간 이동 — OKX 라우팅</div>
      <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
        <select value={from} onChange={(e) => setFrom(e.target.value)} style={sel}>{CHAINS_OPT.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        <span style={{ color: "var(--text-mute)", fontSize: 12 }}>→</span>
        <select value={to} onChange={(e) => setTo(e.target.value)} style={sel}>{CHAINS_OPT.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        <span style={{ color: "var(--text-mute)", fontSize: 11 }}>$</span>
        <input value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9]/g, ""))} style={{ ...sel, width: 70, textAlign: "right" }} />
        <button type="button" disabled={busy || from === to} onClick={() => void getQuote()}
          style={{ border: "none", borderRadius: 9, padding: "6px 13px", background: "var(--brand)", color: "var(--brand-ink)", fontWeight: 700, fontSize: 11.5, cursor: "pointer" }}>
          {busy ? "…" : "견적"}
        </button>
      </div>
      {q && (
        q.error ? <div style={{ marginTop: 8, fontSize: 11, color: "var(--amber)" }}>{q.error}</div> : (
          <div className="tnum" style={{ marginTop: 9, fontSize: 12, display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
            <span>{q.bridge}</span>
            <span>수취 <b>${q.outUsd?.toFixed(2)}</b></span>
            <span style={{ color: "var(--text-dim)" }}>수수료 ${q.feeUsd?.toFixed(2)}</span>
            <span style={{ color: "var(--text-dim)" }}>ETA {q.etaMin}분</span>
            <button type="button" disabled={busy} onClick={() => void exec()}
              style={{ marginLeft: "auto", border: "1px solid var(--border-strong)", borderRadius: 9, padding: "5px 12px", background: "transparent", color: "var(--text-dim)", fontWeight: 600, fontSize: 11, cursor: "pointer" }}>
              실행
            </button>
          </div>
        )
      )}
      {msg && <div style={{ marginTop: 6, fontSize: 11, fontWeight: 600, color: msg.startsWith("✓") ? "var(--pos)" : "var(--neg)" }}>{msg}</div>}
    </div>
  );
}

// ── 개인지갑 온체인 히스토리 (OKX 지갑 API) ──────────────────────────────────
function WalletHistoryCard() {
  const [data, setData] = useState<{ txs?: { chain: string; hash: string; timeMs: number; symbol: string; amount: string; direction: string }[]; error?: string } | null>(null);
  useEffect(() => {
    fetch("/api/wallet-history", { cache: "no-store" }).then((r) => r.json()).then(setData).catch(() => setData({ error: "요청 실패" }));
  }, []);
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 14px" }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 3 }}>지갑 온체인 히스토리</div>
      <div style={{ fontSize: 10.5, color: "var(--text-mute)", marginBottom: 9 }}>개인지갑 최근 전송 (ETH·BSC·Base)</div>
      {!data ? <div style={{ fontSize: 11, color: "var(--text-mute)" }}>조회 중…</div>
        : data.error ? <div style={{ fontSize: 11, color: "var(--text-mute)" }}>{data.error}</div>
        : !data.txs?.length ? <div style={{ fontSize: 11, color: "var(--text-mute)" }}>기록 없음</div>
        : (
          <div style={{ maxHeight: 200, overflowY: "auto" }}>
            {data.txs.slice(0, 12).map((t) => (
              <div key={t.hash} className="tnum" style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderTop: "1px solid var(--border)", fontSize: 11 }}>
                <span style={{ fontWeight: 700, color: t.direction === "in" ? "var(--pos)" : t.direction === "out" ? "var(--neg)" : "var(--text-dim)" }}>
                  {t.direction === "in" ? "수신" : t.direction === "out" ? "송신" : "—"}
                </span>
                <span>{t.amount ? `${Number(t.amount).toLocaleString(undefined, { maximumFractionDigits: 4 })} ` : ""}{t.symbol}</span>
                <span style={{ color: "var(--text-mute)" }}>{t.chain}</span>
                <span style={{ flex: 1 }} />
                <span style={{ color: "var(--text-mute)" }}>{new Date(t.timeMs).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                <span title="클릭 = 해시 복사" onClick={() => void navigator.clipboard?.writeText(t.hash)} style={{ color: "var(--text-dim)", cursor: "pointer" }}>
                  {t.hash.slice(0, 8)}…
                </span>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

// One venue's detail card: cash row + every coin row with amount/price/value/share.
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
              <span style={{ width: 46, height: 3, borderRadius: 9, background: "var(--bg)", overflow: "hidden" }}>
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
