"use client";

import { useState } from "react";
import { vlabel } from "../cockpit-ui";
import { CAP, BTN_GHOST, type CexRow, type DexRow } from "./shared";

// ── 차트 — CEX는 TradingView, DEX는 DexScreener 임베드 ────────────────────────
export const TV_SYMBOL: Record<string, (b: string) => string> = {
  binance: (b) => `BINANCE:${b}USDT`,
  bybit: (b) => `BYBIT:${b}USDT`,
  okx: (b) => `OKX:${b}USDT`,
  upbit: (b) => `UPBIT:${b}KRW`,
  bithumb: (b) => `BITHUMB:${b}KRW`,
};

export function ChartSection({ base, cex, dex }: { base: string; cex: CexRow[]; dex: DexRow[] }) {
  type Opt = { key: string; label: string; src: string };
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
    // 네이티브 캔들 탭은 뺐다(운영자 결정 2026-08-03): TradingView·DexScreener와
    // 정보가 겹치는데 탭만 늘려 혼란을 줬다("이건 왜 있는지 모르겠음"). OKX 캔들
    // API(/api/dex-candles)는 남겨둔다 — 임베드가 다 막히는 환경이 생기면 재배선.
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
      {open && active && (
        <iframe
          key={active.key /* venue 전환 시 강제 재로드 */}
          src={active.src}
          title={`${base} chart — ${active.label}`}
          style={{ width: "100%", height: 440, border: "1px solid var(--border)", borderRadius: 9, background: "#0e0f12" }}
          allow="clipboard-write"
          loading="lazy"
        />
      )}
    </div>
  );
}

