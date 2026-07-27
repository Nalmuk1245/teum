"use client";

import { useEffect, useState } from "react";
import { vlabel } from "../cockpit-ui";
import { CAP, BTN_GHOST, fmtPx, type CexRow, type DexRow } from "./shared";

// ── 차트 — CEX는 TradingView, DEX는 DexScreener 임베드 ────────────────────────
export const TV_SYMBOL: Record<string, (b: string) => string> = {
  binance: (b) => `BINANCE:${b}USDT`,
  bybit: (b) => `BYBIT:${b}USDT`,
  okx: (b) => `OKX:${b}USDT`,
  upbit: (b) => `UPBIT:${b}KRW`,
  bithumb: (b) => `BITHUMB:${b}KRW`,
};

export function ChartSection({ base, cex, dex }: { base: string; cex: CexRow[]; dex: DexRow[] }) {
  type Opt = { key: string; label: string; src?: string; candle?: { chain: string; contract: string } };
  const opts: Opt[] = [
    ...cex.filter((r) => r.listed && TV_SYMBOL[r.venue]).map((r) => ({
      key: `cex:${r.venue}`,
      label: vlabel(r.venue as never) ?? r.venue,
      src: `https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(TV_SYMBOL[r.venue](base))}&interval=5&theme=dark&style=1&locale=kr&hide_side_toolbar=1&allow_symbol_change=0&save_image=0&withdateranges=0`,
    })),
    // DexScreener 임베드는 **페어(풀) 주소**를 요구한다 — 토큰 컨트랙트를 넣으면
    // 그냥 빈 화면이 뜬다. pairAddress가 없으면 볼 풀이 없다는 뜻이라 탭도 안 만든다.
    ...dex.filter((x) => x.pairAddress && !x.untradeable).map((x) => ({
      key: `dex:${x.chain}`,
      label: `DEX·${x.chain}`,
      src: `https://dexscreener.com/${x.chain}/${x.pairAddress}?embed=1&theme=dark&trades=0&info=0`,
    })),
    // 네이티브 캔들 (OKX 시세) — iframe 실패/미상장 대비, 빠르고 가벼움.
    // 거래 불가 체인은 제외 — 토큰이 3개 체인에 배포돼도 풀은 보통 하나뿐인데,
    // 체인마다 탭을 만들면 죽은 체인이 거래 가능한 것처럼 보인다.
    ...dex.filter((x) => x.verified && !x.untradeable).map((x) => ({
      key: `candle:${x.chain}`,
      label: `캔들·${x.chain === "ethereum" ? "eth" : x.chain}`,
      candle: { chain: x.chain, contract: x.contract },
    })),
  ];
  const [sel, setSel] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const active = opts.find((o) => o.key === sel) ?? opts[0];
  if (!opts.length) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
        <span style={{ ...CAP, color: "var(--text-dim)" }}>차트</span>
        {open && opts.map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => setSel(o.key)}
            style={{
              border: "1px solid " + (active?.key === o.key ? "var(--brand)" : "var(--border)"),
              background: active?.key === o.key ? "var(--brand-soft)" : "transparent",
              color: active?.key === o.key ? "var(--brand-2)" : "var(--text-dim)",
              borderRadius: 9, padding: "3px 9px", fontSize: 10.5, fontWeight: 600, cursor: "pointer",
            }}
          >
            {o.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button type="button" style={BTN_GHOST} onClick={() => setOpen(!open)}>{open ? "접기" : "펼치기"}</button>
      </div>
      {open && active && (active.candle ? (
        <CandleMini key={active.key} chain={active.candle.chain} contract={active.candle.contract} />
      ) : (
        <iframe
          key={active.key /* venue 전환 시 강제 재로드 */}
          src={active.src}
          title={`${base} chart — ${active.label}`}
          style={{ width: "100%", height: 440, border: "1px solid var(--border)", borderRadius: 9, background: "#0e0f12" }}
          allow="clipboard-write"
          loading="lazy"
        />
      ))}
    </div>
  );
}

// 네이티브 캔들 — OKX v6 시세 (5분봉 72개), SVG 직접 렌더.
export function CandleMini({ chain, contract }: { chain: string; contract: string }) {
  const [rows, setRows] = useState<{ ts: number; o: number; h: number; l: number; c: number }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () => fetch(`/api/dex-candles?chain=${chain}&address=${contract}&bar=5m`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (!stop) { if (j.candles) { setRows(j.candles); setErr(null); } else setErr(j.error ?? "실패"); } })
      .catch(() => { if (!stop) setErr("요청 실패"); });
    load();
    const id = setInterval(load, 30_000);
    return () => { stop = true; clearInterval(id); };
  }, [chain, contract]);
  if (err) return <div style={{ padding: 14, fontSize: 11, color: "var(--text-mute)", border: "1px solid var(--border)", borderRadius: 9 }}>{err}</div>;
  if (!rows || rows.length < 2) return <div style={{ padding: 14, fontSize: 11, color: "var(--text-mute)", border: "1px solid var(--border)", borderRadius: 9 }}>캔들 로딩…</div>;
  const W = 720, H = 300;
  const lo = Math.min(...rows.map((r) => r.l)), hi = Math.max(...rows.map((r) => r.h));
  const pad = (hi - lo) * 0.06 || hi * 0.01;
  const y = (v: number) => H - ((v - (lo - pad)) / (hi + pad - (lo - pad))) * H;
  const bw = W / rows.length;
  const last = rows[rows.length - 1];
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 9, padding: "8px 10px", background: "var(--card)" }}>
      <div className="tnum" style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-mute)", marginBottom: 4 }}>
        <span>OKX 시세 · 5분봉 · {rows.length}개</span>
        <span>종가 <b style={{ color: last.c >= last.o ? "var(--pos)" : "var(--neg)" }}>{fmtPx(last.c)}</b></span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 300, display: "block" }} preserveAspectRatio="none">
        {rows.map((r, i) => {
          const up = r.c >= r.o;
          const cx = i * bw + bw / 2;
          return (
            <g key={i} stroke={up ? "var(--pos)" : "var(--neg)"} fill={up ? "var(--pos)" : "var(--neg)"}>
              <line x1={cx} x2={cx} y1={y(r.h)} y2={y(r.l)} strokeWidth={1} />
              <rect x={i * bw + bw * 0.2} width={bw * 0.6} y={Math.min(y(r.o), y(r.c))} height={Math.max(1, Math.abs(y(r.o) - y(r.c)))} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
