"use client";

// 상장 대시보드 — 자동 탐지된 티커 카드 → 클릭하면 원스톱 실행 패널:
// 토큰 정보(컨트랙트·교차검증) / CEX 매트릭스(+내 구매력) / DEX 견적·매수 /
// 포지션·P&L / 거래소 핫·콜드 보유량. 수동 티커 조회도 같은 패널.

import React from "react";
import { Fragment, useCallback, useEffect, useState } from "react";
import { vlabel } from "./cockpit-ui";
import { HoldingsCard } from "./ControlPanel";

type Buy = { where: string; usd: number; qty: number | null; price: number | null; ts: number; dry: boolean };
type Listing = {
  base: string; venue: string; announcedAt: number; overseas: boolean; opened: boolean;
  openedAt?: number; globalVenue?: string; globalPrice?: number; title?: string;
  buys?: Buy[]; sells?: Buy[]; peakPct?: number;
};
type Watch = {
  annOkAgoSec: number | null; annBlocked: boolean; mktOkAgoSec: number | null;
  tgConfigured: boolean; tgChannel: string | null; tgOkAgoSec: number | null; plays: number;
};
type CexRow = { venue: string; listed: boolean; priceUsd: number | null; priceKrw: number | null; myCashUsd: number | null; myCoinQty: number | null };
type DexRow = { chain: string; contract: string; decimals: number; verified: boolean; execPriceUsd: number | null; premiumVsCgPct: number | null; note?: string };
type Detail = {
  base: string; play: Listing | null;
  token: { name: string; priceUsd: number | null; volumeUsd: number | null; marketCapUsd: number | null; contractsList: { chain: string; address: string; decimals: number }[] } | null;
  cex: CexRow[]; dex: DexRow[]; dexReady: boolean; walletReady: boolean; kimchiPct: number | null;
};
type AutoCfg = { armed: boolean; sizeUsd: number };

const fmtUsd = (n: number | null | undefined, digits = 0): string =>
  n == null ? "—" : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(digits)}`;
const fmtPx = (n: number | null | undefined): string =>
  n == null ? "—" : n >= 100 ? n.toLocaleString(undefined, { maximumFractionDigits: 1 }) : n >= 0.01 ? n.toFixed(4) : n.toPrecision(3);
const ago = (ts: number) => { const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; };

const CAP: React.CSSProperties = { fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-mute)" };
const CARD: React.CSSProperties = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 14px" };
const BTN: React.CSSProperties = { border: "none", borderRadius: 2, padding: "6px 12px", background: "var(--brand)", color: "#10141a", fontWeight: 700, fontSize: 11.5, cursor: "pointer" };
const BTN_GHOST: React.CSSProperties = { border: "1px solid var(--border-strong)", borderRadius: 2, padding: "5px 10px", background: "transparent", color: "var(--text-dim)", fontWeight: 600, fontSize: 11, cursor: "pointer" };

function Chip({ ok, label, text }: { ok: boolean; label: string; text: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, color: "var(--text-mute)", border: "1px solid var(--border)", borderRadius: 2, padding: "2px 7px" }}>
      <span style={{ width: 5, height: 5, borderRadius: 2, background: ok ? "var(--pos)" : "var(--amber)" }} />
      <span style={{ fontWeight: 600, color: "var(--text-dim)" }}>{label}</span>
      <span className="tnum">{text}</span>
    </span>
  );
}

export function ListingPanel({ wide }: { wide?: boolean }) {
  const [rows, setRows] = useState<Listing[]>([]);
  const [watch, setWatch] = useState<Watch | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [auto, setAuto] = useState<AutoCfg | null>(null);
  const [autoLive, setAutoLive] = useState(false);
  const [autoSize, setAutoSize] = useState("500");

  useEffect(() => {
    const load = () => fetch("/api/listings", { cache: "no-store" }).then((r) => r.json())
      .then((j) => { setRows(j.listings ?? []); setWatch(j.watch ?? null); }).catch(() => {});
    load();
    const id = setInterval(load, 4000);
    fetch("/api/listing-auto", { cache: "no-store" }).then((r) => r.json())
      .then((j) => { if (j.cfg) { setAuto(j.cfg); setAutoSize(String(j.cfg.sizeUsd)); setAutoLive(!!j.liveEnabled); } }).catch(() => {});
    return () => clearInterval(id);
  }, []);

  const saveAuto = async (p: Partial<AutoCfg>) => {
    try {
      const j = await (await fetch("/api/listing-auto", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) })).json();
      if (j.cfg) setAuto(j.cfg);
    } catch { /* ignore */ }
  };

  // ── 공용 블록들 (모바일: 세로 스택 / PC: 좌 리스트 + 우 상세) ──
  const watchCard = (
      <div style={CARD}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>상장 감시</span>
          {watch && (
            <>
              <Chip label="공지 API" ok={!watch.annBlocked && watch.annOkAgoSec != null} text={watch.annBlocked ? "차단(비KR)" : watch.annOkAgoSec != null ? `${watch.annOkAgoSec}s` : "대기"} />
              <Chip label="TG" ok={watch.tgConfigured && watch.tgOkAgoSec != null} text={!watch.tgConfigured ? "미설정" : watch.tgOkAgoSec != null ? `${watch.tgOkAgoSec}s` : "대기"} />
              <Chip label="마켓 diff" ok={watch.mktOkAgoSec != null} text={watch.mktOkAgoSec != null ? `${watch.mktOkAgoSec}s` : "대기"} />
            </>
          )}
          <span style={{ flex: 1 }} />
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === "Enter" && manual.trim()) setSelected(manual.trim()); }}
            placeholder="티커 수동 조회"
            style={{ width: 120, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 2, color: "var(--text)", padding: "5px 9px", fontSize: 12, outline: "none" }}
          />
          <button type="button" style={BTN} disabled={!manual.trim()} onClick={() => setSelected(manual.trim())}>열기</button>
        </div>
      </div>
  );

  const autoCard = (
      <div style={{ ...CARD, borderColor: auto?.armed ? "var(--amber)" : "var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>공지 즉시 자동매수</span>
          <span style={{ fontSize: 10.5, color: auto?.armed ? "var(--amber)" : "var(--text-mute)", fontWeight: 600 }}>{auto?.armed ? "무장됨" : "꺼짐"}</span>
          <span style={{ flex: 1 }} />
          <span style={CAP}>규모 $</span>
          <input
            value={autoSize}
            onChange={(e) => setAutoSize(e.target.value.replace(/[^0-9]/g, ""))}
            onBlur={() => { const n = Number(autoSize); if (n > 0) void saveAuto({ sizeUsd: n }); }}
            style={{ width: 70, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 2, color: "var(--text)", padding: "5px 8px", fontSize: 12, outline: "none", textAlign: "right" }}
          />
          <button
            type="button"
            onClick={() => void saveAuto({ armed: !auto?.armed })}
            style={{ ...BTN, background: auto?.armed ? "var(--neg)" : "var(--brand)", color: auto?.armed ? "#fff" : "#10141a" }}
          >
            {auto?.armed ? "해제" : "무장"}
          </button>
        </div>
        <div style={{ marginTop: 6, fontSize: 10.5, color: "var(--text-mute)", lineHeight: 1.5 }}>
          공지 감지 → 해외 최저가 CEX에서 즉시 시장가 매수. 킬스위치·리스크 한도 하위.
          {" "}라이브 집행은 <code>LISTING_AUTO_LIVE=true</code> 필요{autoLive ? " (활성)" : " (현재 미설정 — 모의만)"}.
        </div>
      </div>
  );

  const listCard = (
      <div style={{ ...CARD, padding: 0 }}>
        <div style={{ padding: "11px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>탐지된 상장</span>
          <span style={{ ...CAP }}>{rows.length}건 · 카드 클릭 → 상세·실행</span>
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: "18px 14px", fontSize: 11.5, color: "var(--text-mute)" }}>
            감시 중 — 공지 API 2.5s · TG 3s · 마켓 diff 3s. 공지가 뜨면 여기 카드가 생기고 텔레그램(+보유량)이 갑니다.
          </div>
        ) : rows.map((l) => {
          const pos = (l.buys ?? []).reduce((s, b) => s + (b.qty ?? 0), 0) - (l.sells ?? []).reduce((s, b) => s + (b.qty ?? 0), 0);
          const open = selected === l.base;
          return (
            <div key={l.base + l.venue} style={{ borderBottom: "1px solid var(--border)" }}>
              <button
                type="button"
                onClick={() => setSelected(open ? null : l.base)}
                style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left", background: open ? "var(--card-2)" : "transparent", border: "none", padding: "11px 14px", cursor: "pointer", color: "var(--text)" }}
              >
                <span style={{ fontWeight: 700, fontSize: 14 }}>{l.base}</span>
                <span style={{ fontSize: 9.5, fontWeight: 700, color: "#181a20", background: l.opened ? "var(--pos)" : "var(--amber)", borderRadius: 2, padding: "1px 5px" }}>
                  {l.opened ? "거래개시" : "공지"}
                </span>
                <span style={{ color: "var(--text-mute)", fontSize: 11 }}>{l.venue === "upbit" ? "업비트" : "빗썸"} · {ago(l.announcedAt)} 전</span>
                {l.overseas
                  ? <span style={{ fontSize: 11, color: "var(--pos)" }}>{l.globalVenue ? `해외 ${l.globalVenue} @ ${fmtPx(l.globalPrice)}` : "해외 상장"}</span>
                  : <span style={{ fontSize: 11, color: "var(--text-mute)" }}>해외 미상장</span>}
                {l.peakPct != null && <span className="tnum" style={{ fontSize: 11, color: l.peakPct > 0 ? "var(--pos)" : "var(--text-mute)" }}>피크 +{l.peakPct.toFixed(1)}%</span>}
                {pos > 0 && <span className="tnum" style={{ fontSize: 10, fontWeight: 700, color: "var(--amber)" }}>보유 {pos.toFixed(3)}</span>}
                <span style={{ flex: 1 }} />
                <span style={{ color: "var(--text-mute)", fontSize: 11 }}>{open ? "▲" : "▼"}</span>
              </button>
              {/* 모바일: 아코디언 인라인 상세 / PC: 우측 패널에서 표시 */}
              {!wide && open && <DetailPanel base={l.base} />}
            </div>
          );
        })}
        {/* 수동 티커가 플레이 목록에 없을 때 (모바일 인라인) */}
        {!wide && selected && !rows.some((r) => r.base === selected) && (
          <div style={{ borderTop: "1px solid var(--border)" }}>
            <div style={{ padding: "9px 14px", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 700 }}>{selected}</span>
              <span style={CAP}>수동 조회</span>
              <span style={{ flex: 1 }} />
              <button type="button" style={BTN_GHOST} onClick={() => setSelected(null)}>닫기</button>
            </div>
            <DetailPanel base={selected} />
          </div>
        )}
      </div>
  );

  if (!wide) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingBottom: 40 }}>
        {watchCard}
        {autoCard}
        {listCard}
        <HoldingsCard />
      </div>
    );
  }

  // ── PC: 좌(감시·자동매수·리스트·보유량) / 우(선택 티커 상세·차트) ──
  return (
    <div style={{ display: "grid", gridTemplateColumns: "400px minmax(0,1fr)", gap: 14, alignItems: "start", paddingBottom: 40 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        {watchCard}
        {autoCard}
        {listCard}
        <HoldingsCard />
      </div>
      <div style={{ position: "sticky", top: 60, minWidth: 0 }}>
        {selected ? (
          <div style={{ ...CARD, padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--border)" }}>
              <span style={{ fontWeight: 700, fontSize: 15 }}>{selected}</span>
              <span style={CAP}>상세 · 실행</span>
              <span style={{ flex: 1 }} />
              <button type="button" style={BTN_GHOST} onClick={() => setSelected(null)}>닫기</button>
            </div>
            <DetailPanel base={selected} />
          </div>
        ) : (
          <div style={{ ...CARD, padding: "60px 20px", textAlign: "center", color: "var(--text-mute)", fontSize: 12.5, border: "1px dashed var(--border)" }}>
            좌측에서 티커를 선택하거나 수동 조회로 열면<br />여기에 차트·매수처·포지션·보유량이 표시됩니다.
          </div>
        )}
      </div>
    </div>
  );
}

// ── 차트 (PC용) — CEX는 TradingView 임베드, DEX는 DexScreener 임베드 ──────────
export const TV_SYMBOL: Record<string, (b: string) => string> = {
  binance: (b) => `BINANCE:${b}USDT`,
  bybit: (b) => `BYBIT:${b}USDT`,
  okx: (b) => `OKX:${b}USDT`,
  upbit: (b) => `UPBIT:${b}KRW`,
  bithumb: (b) => `BITHUMB:${b}KRW`,
};

function ChartSection({ base, cex, dex }: { base: string; cex: CexRow[]; dex: DexRow[] }) {
  type Opt = { key: string; label: string; src: string };
  const opts: Opt[] = [
    ...cex.filter((r) => r.listed && TV_SYMBOL[r.venue]).map((r) => ({
      key: `cex:${r.venue}`,
      label: vlabel(r.venue as never) ?? r.venue,
      src: `https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(TV_SYMBOL[r.venue](base))}&interval=5&theme=dark&style=1&locale=kr&hide_side_toolbar=1&allow_symbol_change=0&save_image=0&withdateranges=0`,
    })),
    ...dex.map((x) => ({
      key: `dex:${x.chain}`,
      label: `DEX·${x.chain}`,
      src: `https://dexscreener.com/${x.chain}/${x.contract}?embed=1&theme=dark&trades=0&info=0`,
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
              borderRadius: 2, padding: "3px 9px", fontSize: 10.5, fontWeight: 600, cursor: "pointer",
            }}
          >
            {o.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button type="button" style={BTN_GHOST} onClick={() => setOpen(!open)}>{open ? "차트 접기" : "차트 펼치기"}</button>
      </div>
      {open && active && (
        <iframe
          key={active.key /* venue 전환 시 강제 재로드 */}
          src={active.src}
          title={`${base} chart — ${active.label}`}
          style={{ width: "100%", height: 440, border: "1px solid var(--border)", borderRadius: 2, background: "#0e0f12" }}
          allow="clipboard-write"
          loading="lazy"
        />
      )}
    </div>
  );
}

// ── 상세·실행 패널 ─────────────────────────────────────────────────────────────
function DetailPanel({ base }: { base: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sizeUsd, setSizeUsd] = useState("500");
  const [busy, setBusy] = useState<string | null>(null); // action key
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const load = () => fetch(`/api/listing-detail?base=${encodeURIComponent(base)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (!stop) { if (j.detail) { setD(j.detail); setErr(null); } else setErr(j.error ?? "조회 실패"); } })
      .catch(() => { if (!stop) setErr("조회 실패"); });
    load();
    const id = setInterval(load, 10_000);
    return () => { stop = true; clearInterval(id); };
  }, [base]);

  const act = useCallback(async (key: string, url: string, body: Record<string, unknown>) => {
    setBusy(key); setMsg(null);
    try {
      const j = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
      setMsg(`${j.ok ? "✓" : "✗"} ${j.message ?? ""}${j.dryRun ? " (모의)" : ""}`);
    } catch { setMsg("✗ 요청 실패"); }
    finally { setBusy(null); }
  }, []);

  if (err) return <div style={{ padding: "12px 14px", fontSize: 11.5, color: "var(--amber)" }}>{err}</div>;
  if (!d) return <div style={{ padding: "12px 14px", fontSize: 11.5, color: "var(--text-mute)" }}>조회 중…</div>;

  const size = Number(sizeUsd) || 0;
  const globals = d.cex.filter((r) => ["binance", "bybit", "okx"].includes(r.venue));
  const krs = d.cex.filter((r) => ["upbit", "bithumb"].includes(r.venue));
  const play = d.play;
  const buys = play?.buys ?? [];
  const sells = play?.sells ?? [];
  const posQty = buys.reduce((s, b) => s + (b.qty ?? 0), 0) - sells.reduce((s, b) => s + (b.qty ?? 0), 0);
  const costUsd = buys.reduce((s, b) => s + b.usd, 0) - sells.reduce((s, b) => s + b.usd, 0);
  const curUsd = Math.min(...globals.filter((r) => r.priceUsd != null).map((r) => r.priceUsd!), Infinity);
  const unrealized = posQty > 0 && Number.isFinite(curUsd) ? posQty * curUsd - Math.max(0, costUsd) : null;

  const sec = (title: string, right?: React.ReactNode) => (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "12px 0 6px" }}>
      <span style={{ ...CAP, color: "var(--text-dim)" }}>{title}</span>
      {right}
      <span style={{ flex: 1, borderBottom: "1px solid var(--border)", transform: "translateY(-3px)" }} />
    </div>
  );

  return (
    <div style={{ padding: "2px 14px 14px", background: "var(--card-2)", borderTop: "1px solid var(--border)" }}>
      {/* 토큰 요약 */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", paddingTop: 10, fontSize: 11.5 }}>
        <span><b>{d.token?.name ?? base}</b></span>
        <span className="tnum">가격 {d.token?.priceUsd != null ? `$${fmtPx(d.token.priceUsd)}` : "—"}</span>
        <span className="tnum">시총 {fmtUsd(d.token?.marketCapUsd)}</span>
        <span className="tnum">24h 볼륨 {fmtUsd(d.token?.volumeUsd)}</span>
        {d.kimchiPct != null && (
          <span className="tnum" style={{ fontWeight: 700, color: d.kimchiPct > 0 ? "var(--pos)" : "var(--neg)" }}>
            김프 {d.kimchiPct > 0 ? "+" : ""}{d.kimchiPct.toFixed(2)}%
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={CAP}>금액 $</span>
        <input
          value={sizeUsd}
          onChange={(e) => setSizeUsd(e.target.value.replace(/[^0-9]/g, ""))}
          style={{ width: 64, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 2, color: "var(--text)", padding: "4px 7px", fontSize: 12, outline: "none", textAlign: "right" }}
        />
      </div>

      {/* 차트 — CEX(TradingView) / DEX(DexScreener) 전환 */}
      <ChartSection base={base} cex={d.cex} dex={d.dex.filter((x) => !x.note || x.verified || x.note.includes("키"))} />

      {/* 컨트랙트 */}
      {d.token && d.token.contractsList.length > 0 && (
        <>
          {sec("컨트랙트")}
          {d.token.contractsList.map((c) => {
            const dexRow = d.dex.find((x) => x.chain === c.chain);
            return (
              <div key={c.chain} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, padding: "2px 0" }}>
                <span style={{ width: 64, color: "var(--text-dim)", fontWeight: 600 }}>{c.chain}</span>
                <button
                  type="button"
                  title="클릭 = 주소 복사"
                  onClick={() => { void navigator.clipboard?.writeText(c.address); setCopied(c.chain); setTimeout(() => setCopied(null), 1200); }}
                  className="tnum"
                  style={{ background: "none", border: "none", cursor: "pointer", color: copied === c.chain ? "var(--pos)" : "var(--text)", fontSize: 10.5, padding: 0 }}
                >
                  {copied === c.chain ? "복사됨 ✓" : `${c.address.slice(0, 10)}…${c.address.slice(-8)}`}
                </button>
                {dexRow?.verified && <span style={{ fontSize: 9, fontWeight: 700, color: "var(--pos)", border: "1px solid var(--pos)", borderRadius: 2, padding: "0 4px" }}>OKX 검증</span>}
                {dexRow?.note && <span style={{ fontSize: 9.5, color: "var(--text-mute)" }}>{dexRow.note}</span>}
              </div>
            );
          })}
        </>
      )}
      {d.token && d.token.contractsList.length === 0 && (
        <div style={{ marginTop: 8, fontSize: 10.5, color: "var(--text-mute)" }}>EVM 컨트랙트 없음 (비EVM 체인 토큰) — DEX 매수 불가</div>
      )}

      {/* CEX 매트릭스 */}
      {sec("CEX")}
      <div style={{ display: "grid", gridTemplateColumns: "72px 1fr 1fr 1fr auto", gap: "3px 10px", fontSize: 11.5, alignItems: "center" }}>
        <span style={CAP}>거래소</span><span style={{ ...CAP, textAlign: "right" }}>가격</span>
        <span style={{ ...CAP, textAlign: "right" }}>내 현금</span><span style={{ ...CAP, textAlign: "right" }}>내 코인</span><span />
        {[...globals, ...krs].map((r) => (
          <Fragment key={r.venue}>
            <span style={{ fontWeight: 600, color: r.listed ? "var(--text)" : "var(--text-mute)" }}>{vlabel(r.venue as never) ?? r.venue}</span>
            <span className="tnum" style={{ textAlign: "right", color: r.listed ? "var(--text)" : "var(--text-mute)" }}>
              {r.listed ? (r.priceKrw != null ? `₩${r.priceKrw.toLocaleString()}` : `$${fmtPx(r.priceUsd)}`) : "미상장"}
            </span>
            <span className="tnum" style={{ textAlign: "right", color: "var(--text-dim)" }}>{r.myCashUsd != null ? fmtUsd(r.myCashUsd) : "키없음"}</span>
            <span className="tnum" style={{ textAlign: "right", color: (r.myCoinQty ?? 0) > 0 ? "var(--amber)" : "var(--text-mute)" }}>
              {r.myCoinQty != null ? r.myCoinQty.toFixed(3) : "—"}
            </span>
            <span style={{ display: "flex", gap: 5, justifyContent: "flex-end" }}>
              {r.listed && ["binance", "bybit", "okx"].includes(r.venue) && (
                <button type="button" style={BTN} disabled={busy != null || size <= 0}
                  onClick={() => void act(`buy:${r.venue}`, "/api/listing-buy", { base, venue: r.venue, sizeUsd: size })}>
                  {busy === `buy:${r.venue}` ? "…" : "매수"}
                </button>
              )}
              {r.listed && (posQty > 0 || (r.myCoinQty ?? 0) > 0) && (
                <button type="button" style={{ ...BTN, background: "var(--neg)", color: "#fff" }} disabled={busy != null}
                  onClick={() => void act(`sell:${r.venue}`, "/api/listing-sell", { base, where: r.venue })}>
                  {busy === `sell:${r.venue}` ? "…" : "매도"}
                </button>
              )}
            </span>
          </Fragment>
        ))}
      </div>

      {/* DEX */}
      {d.dex.length > 0 && (
        <>
          {sec("DEX (OKX Web3)", !d.dexReady ? <span style={{ fontSize: 9.5, color: "var(--amber)" }}>OKX_WEB3 키 필요 — 견적/실행 불가</span> : !d.walletReady ? <span style={{ fontSize: 9.5, color: "var(--amber)" }}>지갑 키 없음 — 라이브 매수 불가</span> : undefined)}
          <div style={{ display: "grid", gridTemplateColumns: "72px 1fr 1fr auto", gap: "3px 10px", fontSize: 11.5, alignItems: "center" }}>
            <span style={CAP}>체인</span><span style={{ ...CAP, textAlign: "right" }}>실행가($500)</span><span style={{ ...CAP, textAlign: "right" }}>vs 시세</span><span />
            {d.dex.map((x) => (
              <Fragment key={x.chain}>
                <span style={{ fontWeight: 600 }}>{x.chain}</span>
                <span className="tnum" style={{ textAlign: "right" }}>{x.execPriceUsd != null ? `$${fmtPx(x.execPriceUsd)}` : "—"}</span>
                <span className="tnum" style={{ textAlign: "right", color: x.premiumVsCgPct == null ? "var(--text-mute)" : x.premiumVsCgPct > 1 ? "var(--amber)" : "var(--text-dim)" }}>
                  {x.premiumVsCgPct != null ? `${x.premiumVsCgPct > 0 ? "+" : ""}${x.premiumVsCgPct.toFixed(2)}%` : "—"}
                </span>
                <span style={{ display: "flex", gap: 5, justifyContent: "flex-end" }}>
                  <button type="button" style={BTN} disabled={busy != null || size <= 0 || !x.verified}
                    onClick={() => void act(`dex:${x.chain}`, "/api/listing-dex-buy", { base, chain: x.chain, sizeUsd: size })}>
                    {busy === `dex:${x.chain}` ? "…" : "DEX 매수"}
                  </button>
                  {posQty > 0 && x.verified && (
                    <button type="button" style={{ ...BTN, background: "var(--neg)", color: "#fff" }} disabled={busy != null}
                      onClick={() => void act(`dexsell:${x.chain}`, "/api/listing-sell", { base, where: `dex:${x.chain}` })}>
                      매도
                    </button>
                  )}
                </span>
              </Fragment>
            ))}
          </div>
        </>
      )}

      {/* 포지션 */}
      {(buys.length > 0 || sells.length > 0) && (
        <>
          {sec("내 포지션")}
          <div style={{ fontSize: 11.5, display: "flex", flexDirection: "column", gap: 3 }}>
            {buys.map((b, i) => (
              <div key={`b${i}`} className="tnum" style={{ display: "flex", gap: 10, color: "var(--text-dim)" }}>
                <span style={{ color: "var(--pos)", fontWeight: 600 }}>매수</span>
                <span>{b.where}</span><span>${b.usd}</span>
                <span>{b.qty != null ? `${b.qty.toFixed(4)} @ $${fmtPx(b.price)}` : ""}</span>
                <span style={{ color: "var(--text-mute)" }}>{ago(b.ts)} 전{b.dry ? " · 모의" : ""}</span>
              </div>
            ))}
            {sells.map((s, i) => (
              <div key={`s${i}`} className="tnum" style={{ display: "flex", gap: 10, color: "var(--text-dim)" }}>
                <span style={{ color: "var(--neg)", fontWeight: 600 }}>매도</span>
                <span>{s.where}</span><span>{s.qty?.toFixed(4)}</span>
                <span style={{ color: "var(--text-mute)" }}>{ago(s.ts)} 전{s.dry ? " · 모의" : ""}</span>
              </div>
            ))}
            <div className="tnum" style={{ marginTop: 4, paddingTop: 6, borderTop: "1px solid var(--border)", display: "flex", gap: 14 }}>
              <span>잔여 <b>{posQty.toFixed(4)}</b> {base}</span>
              {unrealized != null && (
                <span style={{ fontWeight: 700, color: unrealized >= 0 ? "var(--pos)" : "var(--neg)" }}>
                  미실현 {unrealized >= 0 ? "+" : "−"}${Math.abs(unrealized).toFixed(2)}
                </span>
              )}
            </div>
          </div>
        </>
      )}

      {msg && <div style={{ marginTop: 10, fontSize: 11.5, fontWeight: 600, color: msg.startsWith("✓") ? "var(--pos)" : "var(--neg)" }}>{msg}</div>}

      {/* 보유량 (핫/콜드) */}
      <DetailHoldings base={base} />
    </div>
  );
}

function DetailHoldings({ base }: { base: string }) {
  const [h, setH] = useState<{ venues: { venue: string; hot: number; hotUsd: number | null; cold: number; hotDeltaPerMin: number | null }[]; priceUsd: number | null; globalHotUsd: number | null; dumpRatioPct: number | null; note?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () => fetch(`/api/exchange-holdings?symbol=${encodeURIComponent(base)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (!stop) { if (j.holdings) { setH(j.holdings); setErr(null); } else setErr(j.error ?? null); } })
      .catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => { stop = true; clearInterval(id); };
  }, [base]);
  const fq = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(1));
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <span style={{ ...CAP, color: "var(--text-dim)" }}>거래소 보유량 (온체인)</span>
        {h?.dumpRatioPct != null && (
          <span style={{ fontSize: 10, fontWeight: 700, color: h.dumpRatioPct > 50 ? "var(--amber)" : "var(--pos)" }}>
            즉시유입/24h볼륨 {h.dumpRatioPct.toFixed(0)}%{h.dumpRatioPct > 50 ? " ⚠ 펌핑 짧을 확률" : ""}
          </span>
        )}
        <span style={{ flex: 1, borderBottom: "1px solid var(--border)", transform: "translateY(-3px)" }} />
      </div>
      {err && <div style={{ fontSize: 10.5, color: "var(--text-mute)" }}>{err}</div>}
      {!h && !err && <div style={{ fontSize: 10.5, color: "var(--text-mute)" }}>조회 중… (~10s)</div>}
      {h && (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11 }}>
          {h.venues.filter((v) => v.hot + v.cold > 0).map((v) => (
            <span key={v.venue} className="tnum" style={{ color: "var(--text-dim)" }}>
              <b style={{ color: "var(--text)" }}>{v.venue}</b> 핫 {fq(v.hot)}{v.hotUsd ? ` (${fmtUsd(v.hotUsd)})` : ""} · 콜드 {fq(v.cold)}
              {v.hotDeltaPerMin != null && v.hotDeltaPerMin !== 0 && h.priceUsd != null && (
                <span style={{ color: v.hotDeltaPerMin > 0 ? "var(--pos)" : "var(--neg)" }}>
                  {" "}Δ{v.hotDeltaPerMin > 0 ? "+" : "−"}${fq(Math.abs(v.hotDeltaPerMin * h.priceUsd))}/분
                </span>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default ListingPanel;
