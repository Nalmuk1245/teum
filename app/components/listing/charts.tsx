"use client";

import { useState } from "react";
import { vlabel } from "../cockpit-ui";
import { PremiumChart, type Spec } from "../PremiumChart";
import { CAP, BTN_GHOST, type CexRow, type DexRow } from "./shared";

// ── 차트 — CEX는 TradingView, DEX는 DexScreener 임베드 ────────────────────────
export const TV_SYMBOL: Record<string, (b: string) => string> = {
  binance: (b) => `BINANCE:${b}USDT`,
  bybit: (b) => `BYBIT:${b}USDT`,
  okx: (b) => `OKX:${b}USDT`,
  upbit: (b) => `UPBIT:${b}KRW`,
  bithumb: (b) => `BITHUMB:${b}KRW`,
};

// 갭 차트 캔들 소스(lib/premiumSeries)가 있는 해외 거래소만 — OKX는 아직 없다.
const GLOBAL_PREF = ["binance", "bybit"];
const KR_V = ["upbit", "bithumb"];

export function ChartSection({ base, cex, dex, krVenue }: { base: string; cex: CexRow[]; dex: DexRow[]; krVenue?: string }) {
  // 갭 탭 — 두 거래소 가격과 그 차이(%)를 1분봉으로. 상장따리는 "국내 개장 후 김프가
  // 얼마나 붙었다 꺼지나"와 "공지 직후 해외 거래소끼리 가격이 벌어지나"가 판단의 절반이다.
  // 캔들은 각 거래소 공개 API에서 요청 시점에 만든다(lib/premiumSeries) — KR 개장 전엔
  // KR 캔들이 없으니 김프 탭은 개장 뒤에만 생긴다.
  type Opt = { key: string; label: string; src?: string; gap?: { a: Spec; b: Spec } };
  // 다른 토큰 의심(suspect) 거래소는 갭 계산에서 뺀다 — 넣으면 +587% 같은 유령 갭이 그려진다.
  const listed = new Set<string>(cex.filter((r) => r.listed && !r.suspect).map((r) => r.venue));
  const globals = GLOBAL_PREF.filter((v) => listed.has(v));
  const krs = KR_V.filter((v) => listed.has(v)).sort((a, b) => (a === krVenue ? -1 : b === krVenue ? 1 : 0));
  const gapOpts: Opt[] = [
    ...(krs[0] && globals[0] ? [{ key: `gap:${krs[0]}:${globals[0]}`, label: `김프 ${vlabel(krs[0] as never)}·${vlabel(globals[0] as never)}`, gap: { a: { venue: krs[0], market: "spot" as const }, b: { venue: globals[0], market: "spot" as const } } }] : []),
    ...(globals.length >= 2 ? [{ key: `gap:${globals[0]}:${globals[1]}`, label: `해외갭 ${vlabel(globals[0] as never)}·${vlabel(globals[1] as never)}`, gap: { a: { venue: globals[0], market: "spot" as const }, b: { venue: globals[1], market: "spot" as const } } }] : []),
  ];
  const opts: Opt[] = [
    ...gapOpts,
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
      {open && active?.gap && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 9, padding: "8px 10px", background: "var(--card)" }}>
          <PremiumChart key={active.key} coin={base} a={active.gap.a} b={active.gap.b} unit={1} compact costPct={null} />
        </div>
      )}
      {open && active?.src && (
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

