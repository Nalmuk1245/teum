"use client";

// 상장 대시보드 — 좌: 탐지·설정·기록이 한 카드 / 우: 선택 티커의 실행 패널.
// 상세 패널은 의사결정 순서대로 흐른다:
//   ① 신호 (가격·시총·볼륨·김프·덤핑압력)  ② 차트  ③ 매수·매도 (CEX+DEX 통합 표)
//   ④ 내 포지션  ⑤ 참고 (온체인 보유량·컨트랙트, 접이식)
// 모든 표는 같은 그리드 문법(처 | 가격 | 내 자금 | 비고 | 액션)을 쓴다.

import React from "react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { vlabel, beep } from "./cockpit-ui";

type Buy = { where: string; usd: number; qty: number | null; price: number | null; ts: number; dry: boolean };
type Listing = {
  base: string; venue: string; announcedAt: number; overseas: boolean; opened: boolean;
  openedAt?: number; opensAt?: number; drill?: boolean; globalVenue?: string; globalPrice?: number; title?: string;
  buys?: Buy[]; sells?: Buy[]; peakPct?: number;
};
type HistoryRow = {
  base: string; venue: string; announcedAt: number; openedAt: number | null; opensAt: number | null;
  peakPct: number | null; peakAfterMin: number | null; buys: number; buyUsd: number; realizedUsd: number | null;
};
type Watch = {
  annOkAgoSec: number | null; annBlocked: boolean; mktOkAgoSec: number | null;
  tgConfigured: boolean; tgChannel: string | null; tgOkAgoSec: number | null; plays: number;
};
type CexRow = { venue: string; listed: boolean; priceUsd: number | null; priceKrw: number | null; myCashUsd: number | null; myCoinQty: number | null };
type DexRow = { chain: string; contract: string; decimals: number; verified: boolean; execPriceUsd: number | null; premiumVsCgPct: number | null; note?: string };
type Detail = {
  base: string; play: Listing | null;
  krDeposits?: { ts: number; up: number; bt: number }[];
  token: { name: string; priceUsd: number | null; volumeUsd: number | null; marketCapUsd: number | null; contractsList: { chain: string; address: string; decimals: number }[] } | null;
  cex: CexRow[]; dex: DexRow[]; dexReady: boolean; walletReady: boolean; kimchiPct: number | null;
};
type WalletBreak = { address: string; tag: string | null; type: "hot" | "cold"; amount: number; usd: number | null };
type Holdings = {
  venues: { venue: string; hot: number; hotUsd: number | null; cold: number; hotDeltaPerMin: number | null; breakdown?: WalletBreak[] }[];
  priceUsd: number | null; globalHotUsd: number | null; dumpRatioPct: number | null; note?: string;
};
type AutoCfg = { armed: boolean; sizeUsd: number };

const fmtUsd = (n: number | null | undefined, digits = 0): string =>
  n == null ? "—" : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(digits)}`;
const fmtPx = (n: number | null | undefined): string =>
  n == null ? "—" : n >= 100 ? n.toLocaleString(undefined, { maximumFractionDigits: 1 }) : n >= 0.01 ? n.toFixed(4) : n.toPrecision(3);
const fmtQty = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(1));
const ago = (ts: number) => { const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; };

const CAP: React.CSSProperties = { fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-mute)" };
const CARD: React.CSSProperties = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 14px"  }
const BTN: React.CSSProperties = { border: "none", borderRadius: 9, padding: "6px 12px", background: "var(--brand)", color: "var(--brand-ink)", fontWeight: 700, fontSize: 11.5, cursor: "pointer" };
const BTN_SELL: React.CSSProperties = { ...BTN, background: "var(--neg)", color: "#fff" };
const BTN_GHOST: React.CSSProperties = { border: "1px solid var(--border-strong)", borderRadius: 9, padding: "5px 10px", background: "transparent", color: "var(--text-dim)", fontWeight: 600, fontSize: 11, cursor: "pointer" };
type PreviewData = {
  expectedOut: number; pricePerToken: number; minReceive: number; slippagePct: number;
  priceImpactPct: number | null; tradeFeeUsd: number | null; gasUsd: number | null;
  route: string[]; honeypot: boolean; taxRatePct: number | null;
  liquidity: "deep" | "ok" | "thin"; probeUsd: number; probeImpactPct: number | null;
};
type TxStatusData = { status: "pending" | "success" | "fail" | "unknown"; failReason: string | null };
const INPUT: React.CSSProperties = { background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 9, color: "var(--text)", padding: "4px 8px", fontSize: 12, outline: "none" };

// 실행 표 공통 그리드: 처 | 가격 | 내 자금 | 비고 | 액션
const EXEC_COLS = "84px minmax(70px,1fr) minmax(60px,1fr) minmax(80px,1.2fr) auto";

/** 개장 카운트다운 — 1초 틱, 임박(5분)부터 앰버. */
function Countdown({ opensAt }: { opensAt: number }) {
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

export function ListingPanel({ wide }: { wide?: boolean }) {
  const [rows, setRows] = useState<Listing[]>([]);
  const [watch, setWatch] = useState<Watch | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [histOpen, setHistOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [auto, setAuto] = useState<AutoCfg | null>(null);
  const [autoLive, setAutoLive] = useState(false);
  const [autoSize, setAutoSize] = useState("500");
  const [drilling, setDrilling] = useState(false);
  // 감지 알림 (비프 + 데스크톱) — persisted, 기본 on.
  const [detectAlert, setDetectAlert] = useState(true);
  useEffect(() => {
    try { const v = localStorage.getItem("ac.listingAlert"); if (v != null) setDetectAlert(v === "1"); } catch { /* */ }
  }, []);
  const toggleDetectAlert = () => {
    const v = !detectAlert;
    setDetectAlert(v);
    try { localStorage.setItem("ac.listingAlert", v ? "1" : "0"); } catch { /* */ }
    if (v && "Notification" in window && Notification.permission === "default") void Notification.requestPermission();
  };
  // 새 플레이 감지 → 비프 + 데스크톱 알림 + 상세 자동 오픈.
  const knownRef = useRef<Set<string> | null>(null);
  const detectAlertRef = useRef(detectAlert);
  detectAlertRef.current = detectAlert;
  useEffect(() => {
    if (knownRef.current == null) { knownRef.current = new Set(rows.map((r) => r.base)); return; }
    const fresh = rows.filter((r) => !knownRef.current!.has(r.base));
    if (!fresh.length) return;
    for (const r of rows) knownRef.current.add(r.base);
    const top = fresh[0];
    setSelected(top.base);
    if (detectAlertRef.current) {
      beep();
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification(`${top.drill ? "[드릴] " : ""}상장 감지 — ${top.base}`, {
          body: `${top.venue === "upbit" ? "업비트" : "빗썸"} · ${top.overseas ? `해외 ${top.globalVenue} 매수 가능` : "해외 미상장"}`,
          tag: "arb-listing",
        });
      }
    }
  }, [rows]);

  useEffect(() => {
    const load = () => fetch("/api/listings", { cache: "no-store" }).then((r) => r.json())
      .then((j) => { setRows(j.listings ?? []); setWatch(j.watch ?? null); setHistory(j.history ?? []); }).catch(() => {});
    load();
    const id = setInterval(load, 4000);
    fetch("/api/listing-auto", { cache: "no-store" }).then((r) => r.json())
      .then((j) => { if (j.cfg) { setAuto(j.cfg); setAutoSize(String(j.cfg.sizeUsd)); setAutoLive(!!j.liveEnabled); } }).catch(() => {});
    return () => clearInterval(id);
  }, []);

  const runDrill = async () => {
    setDrilling(true);
    try {
      await fetch("/api/listing-drill", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ base: manual.trim() || "PEPE" }) });
    } catch { /* ignore */ }
    finally { setDrilling(false); }
  };

  const saveAuto = async (p: Partial<AutoCfg>) => {
    try {
      const j = await (await fetch("/api/listing-auto", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) })).json();
      if (j.cfg) setAuto(j.cfg);
    } catch { /* ignore */ }
  };

  const watchOk = watch != null && ((!watch.annBlocked && watch.annOkAgoSec != null) || (watch.tgConfigured && watch.tgOkAgoSec != null));
  const watchTitle = watch == null ? "감시 상태 로딩 중"
    : [
        `공지 API: ${watch.annBlocked ? "차단(비KR IP)" : watch.annOkAgoSec != null ? `정상 (${watch.annOkAgoSec}s 전)` : "대기"}`,
        `TG 채널: ${!watch.tgConfigured ? "미설정" : watch.tgOkAgoSec != null ? `정상 (${watch.tgOkAgoSec}s 전)` : "대기"}`,
        `마켓 diff: ${watch.mktOkAgoSec != null ? `정상 (${watch.mktOkAgoSec}s 전)` : "대기"}`,
        "— 공지 2.5s · TG 3s · 마켓 3s 폴링 중",
      ].join("\n");

  // ── 좌측: 탐지·설정·기록이 한 카드 ──────────────────────────────────────────
  const mainCard = (
    <div style={{ ...CARD, padding: 0 }}>
      {/* 헤더: 상태점 + 수동조회 + 알림 + 드릴 */}
      <div style={{ padding: "9px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
        <span title={watchTitle} style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "help" }}>
          <span style={{ width: 6, height: 6, borderRadius: 9, background: watch == null ? "var(--text-mute)" : watchOk ? "var(--pos)" : "var(--amber)" }} />
          <span style={{ fontSize: 13, fontWeight: 700 }}>탐지된 상장</span>
        </span>
        <span style={CAP}>{rows.length}건</span>
        <span style={{ flex: 1 }} />
        <input
          value={manual}
          onChange={(e) => setManual(e.target.value.toUpperCase())}
          onKeyDown={(e) => { if (e.key === "Enter" && manual.trim()) setSelected(manual.trim()); }}
          placeholder="티커 조회"
          style={{ ...INPUT, width: 84 }}
        />
        <button type="button" style={BTN} disabled={!manual.trim()} onClick={() => setSelected(manual.trim())}>열기</button>
        <button
          type="button" onClick={toggleDetectAlert}
          title="새 상장 감지 시 비프 + 데스크톱 알림 + 상세 자동 오픈"
          style={{ ...BTN_GHOST, borderColor: detectAlert ? "var(--brand)" : "var(--border-strong)", color: detectAlert ? "var(--brand-2)" : "var(--text-dim)", whiteSpace: "nowrap" }}
        >
          알림 {detectAlert ? "ON" : "OFF"}
        </button>
        <button
          type="button" disabled={drilling} onClick={() => void runDrill()}
          title="가짜 상장 공지를 주입해 감지→알림→매수 플로우 리허설 (티커 입력값 또는 PEPE)"
          style={{ ...BTN_GHOST, whiteSpace: "nowrap" }}
        >
          {drilling ? "…" : "🥁 드릴"}
        </button>
      </div>

      {/* 자동매수 — 설정도 이 카드의 한 행 */}
      <div
        title={`공지 감지 → 해외 최저가 CEX 즉시 시장가 매수.\n킬스위치·리스크 한도 하위 + 시총/기펌핑 가드.\n라이브 집행은 LISTING_AUTO_LIVE=true 필요${autoLive ? " (활성)" : " (미설정 — 모의만)"}.`}
        style={{ padding: "8px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8, background: auto?.armed ? "color-mix(in srgb, var(--amber) 6%, transparent)" : "transparent" }}
      >
        <span style={{ width: 6, height: 6, borderRadius: 9, background: auto?.armed ? "var(--amber)" : "var(--text-mute)" }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: auto?.armed ? "var(--amber)" : "var(--text-dim)" }}>공지 즉시 자동매수</span>
        <span style={{ fontSize: 10, color: "var(--text-mute)" }}>{auto?.armed ? (autoLive ? "켜짐 · 라이브" : "켜짐 · 모의") : "꺼짐"}</span>
        <span style={{ flex: 1 }} />
        <span style={CAP}>$</span>
        <input
          value={autoSize}
          onChange={(e) => setAutoSize(e.target.value.replace(/[^0-9]/g, ""))}
          onBlur={() => { const n = Number(autoSize); if (n > 0) void saveAuto({ sizeUsd: n }); }}
          style={{ ...INPUT, width: 58, textAlign: "right" }}
        />
        <button
          type="button"
          onClick={() => void saveAuto({ armed: !auto?.armed })}
          style={{ ...BTN, background: auto?.armed ? "var(--neg)" : "var(--brand)", color: auto?.armed ? "#fff" : "var(--brand-ink)" }}
        >
          {auto?.armed ? "끄기" : "켜기"}
        </button>
      </div>

      {/* 플레이 리스트 */}
      {rows.length === 0 ? (
        <div style={{ padding: "16px 14px", fontSize: 11.5, color: "var(--text-mute)" }}>
          감시 중 — 공지가 뜨면 여기 카드가 생기고 텔레그램(+보유량)이 갑니다.
        </div>
      ) : rows.map((l) => {
        const pos = (l.buys ?? []).reduce((s, b) => s + (b.qty ?? 0), 0) - (l.sells ?? []).reduce((s, b) => s + (b.qty ?? 0), 0);
        const open = selected === l.base;
        return (
          <div key={l.base + l.venue} style={{ borderBottom: "1px solid var(--border)" }}>
            <button
              type="button"
              onClick={() => setSelected(open ? null : l.base)}
              style={{ display: "block", width: "100%", textAlign: "left", background: open ? "var(--card-2)" : "transparent", border: "none", padding: "10px 14px", cursor: "pointer", color: "var(--text)", boxShadow: open ? "inset 2px 0 0 var(--brand)" : undefined }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{l.base}</span>
                {l.drill && <span style={{ fontSize: 9, fontWeight: 700, color: "var(--sky)", border: "1px solid var(--sky)", borderRadius: 9, padding: "0 4px", whiteSpace: "nowrap" }}>드릴</span>}
                <span style={{ fontSize: 9.5, fontWeight: 700, color: "var(--brand-ink)", background: l.opened ? "var(--pos)" : "var(--amber)", borderRadius: 9, padding: "1px 5px", whiteSpace: "nowrap" }}>
                  {l.opened ? "거래개시" : "공지"}
                </span>
                <span style={{ color: "var(--text-mute)", fontSize: 11 }}>{l.venue === "upbit" ? "업비트" : "빗썸"} · {ago(l.announcedAt)} 전</span>
                <span style={{ flex: 1 }} />
                {!l.opened && l.opensAt != null && <Countdown opensAt={l.opensAt} />}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 3, fontSize: 11 }}>
                {l.overseas
                  ? <span style={{ color: "var(--pos)" }}>{l.globalVenue ? `해외 ${l.globalVenue} @ ${fmtPx(l.globalPrice)}` : "해외 상장"}</span>
                  : <span style={{ color: "var(--text-mute)" }}>해외 미상장 · 펌핑만</span>}
                {l.peakPct != null && <span className="tnum" style={{ color: l.peakPct > 0 ? "var(--pos)" : "var(--text-mute)" }}>피크 +{l.peakPct.toFixed(1)}%</span>}
                {pos > 0 && <span className="tnum" style={{ fontWeight: 700, color: "var(--amber)" }}>보유 {pos.toFixed(3)}</span>}
              </div>
            </button>
            {/* 모바일: 인라인 상세 / PC: 우측 패널 */}
            {!wide && open && <DetailPanel base={l.base} />}
          </div>
        );
      })}
      {/* 수동 티커 (모바일 인라인) */}
      {!wide && selected && !rows.some((r) => r.base === selected) && (
        <div style={{ borderBottom: "1px solid var(--border)" }}>
          <div style={{ padding: "9px 14px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 700 }}>{selected}</span>
            <span style={CAP}>수동 조회</span>
            <span style={{ flex: 1 }} />
            <button type="button" style={BTN_GHOST} onClick={() => setSelected(null)}>닫기</button>
          </div>
          <DetailPanel base={selected} />
        </div>
      )}

      {/* 성과 히스토리 — 같은 카드의 접이식 섹션 */}
      {history.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setHistOpen(!histOpen)}
            style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", background: "transparent", border: "none", padding: "9px 14px", cursor: "pointer", color: "var(--text-dim)" }}
          >
            <span style={{ fontSize: 12, fontWeight: 600 }}>성과 히스토리</span>
            <span style={CAP}>{history.length}건 · 공지가→피크</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 10, color: "var(--text-mute)" }}>{histOpen ? "▲" : "▼"}</span>
          </button>
          {histOpen && (
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto auto auto", gap: "4px 12px", padding: "0 14px 12px", fontSize: 11, alignItems: "baseline" }}>
              <span style={CAP}>티커</span><span style={CAP}>공지</span>
              <span style={{ ...CAP, textAlign: "right" }}>피크</span>
              <span style={{ ...CAP, textAlign: "right" }}>도달</span>
              <span style={{ ...CAP, textAlign: "right" }}>실현</span>
              {history.slice(0, 12).map((h) => (
                <Fragment key={h.base + h.announcedAt}>
                  <span style={{ fontWeight: 700 }}>{h.base}</span>
                  <span className="tnum" style={{ color: "var(--text-mute)" }}>
                    {new Date(h.announcedAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span className="tnum" style={{ textAlign: "right", fontWeight: 700, color: (h.peakPct ?? 0) > 0 ? "var(--pos)" : "var(--text-mute)" }}>
                    {h.peakPct != null ? `+${h.peakPct.toFixed(1)}%` : "—"}
                  </span>
                  <span className="tnum" style={{ textAlign: "right", color: "var(--text-dim)" }}>
                    {h.peakAfterMin != null ? `${h.peakAfterMin}분` : "—"}
                  </span>
                  <span className="tnum" style={{ textAlign: "right", color: h.realizedUsd == null ? "var(--text-mute)" : h.realizedUsd >= 0 ? "var(--pos)" : "var(--neg)" }}>
                    {h.realizedUsd != null ? `${h.realizedUsd >= 0 ? "+" : "−"}$${Math.abs(h.realizedUsd).toFixed(0)}` : "—"}
                  </span>
                </Fragment>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  if (!wide) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingBottom: 40 }}>
        {mainCard}
      </div>
    );
  }

  // ── PC: 종목 미선택 = 좌 목록 + 우 안내 / 선택 = 상세 풀스크린(목록 접힘) ──
  if (selected) {
    return (
      <div key={selected} className="panel-in" style={{ ...CARD, padding: 0, overflow: "hidden", marginBottom: 40 }}>
        <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--border)" }}>
          <button type="button" style={BTN_GHOST} onClick={() => setSelected(null)} title="목록으로">← 목록</button>
          <span style={{ fontWeight: 700, fontSize: 15 }}>{selected}</span>
          <span style={CAP}>상세 · 실행</span>
          <span style={{ flex: 1 }} />
          <button type="button" style={BTN_GHOST} onClick={() => setSelected(null)}>닫기</button>
        </div>
        <DetailPanel base={selected} />
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "400px minmax(0,1fr)", gap: 14, alignItems: "start", paddingBottom: 40 }}>
      <div style={{ minWidth: 0 }}>{mainCard}</div>
      <div style={{ ...CARD, padding: "60px 20px", textAlign: "center", color: "var(--text-mute)", fontSize: 12.5, border: "1px dashed var(--border)" }}>
        좌측에서 티커를 선택하거나 수동 조회로 열면<br />여기에 신호·차트·매수처·포지션이 전체 화면으로 표시됩니다.
      </div>
    </div>
  );
}

// ── 차트 — CEX는 TradingView, DEX는 DexScreener 임베드 ────────────────────────
export const TV_SYMBOL: Record<string, (b: string) => string> = {
  binance: (b) => `BINANCE:${b}USDT`,
  bybit: (b) => `BYBIT:${b}USDT`,
  okx: (b) => `OKX:${b}USDT`,
  upbit: (b) => `UPBIT:${b}KRW`,
  bithumb: (b) => `BITHUMB:${b}KRW`,
};

// 스왑 미리보기 — OKX 견적으로 예상 수령·유효 단가·최소 수령(슬리피지)·
// 가격임팩트·수수료·가스·라우팅 + 토큰 안전성(허니팟·전송세).
function SwapPreview({ base, pv }: { base: string; pv: PreviewData | { error: string } }) {
  if ("error" in pv) {
    return <div style={{ fontSize: 11, color: "var(--amber)", padding: "6px 10px", background: "var(--card)", borderRadius: 9, border: "1px solid var(--border)" }}>미리보기 실패 · {pv.error}</div>;
  }
  const cell = (label: string, val: React.ReactNode, tone?: string) => (
    <div style={{ minWidth: 0 }}>
      <div style={{ ...CAP, whiteSpace: "nowrap" }}>{label}</div>
      <div className="tnum" style={{ fontSize: 12, fontWeight: 700, color: tone ?? "var(--text)", whiteSpace: "nowrap" }}>{val}</div>
    </div>
  );
  const impact = pv.priceImpactPct;
  const liq = pv.liquidity;
  const liqColor = liq === "deep" ? "var(--pos)" : liq === "ok" ? "var(--amber)" : "var(--neg)";
  const liqLabel = liq === "deep" ? "깊음" : liq === "ok" ? "보통" : "얕음";
  const liqDesc = pv.probeImpactPct != null
    ? `$${(pv.probeUsd / 1000).toFixed(0)}k 매수 시 임팩트 ${pv.probeImpactPct > 0 ? "+" : ""}${pv.probeImpactPct.toFixed(2)}%`
    : `$${(pv.probeUsd / 1000).toFixed(0)}k 규모는 못 삼킴 — 소액만 가능`;
  return (
    <div style={{ padding: "8px 11px", background: "var(--card)", border: `1px solid ${liq === "thin" ? "var(--neg)" : "var(--border)"}`, borderRadius: 9 }}>
      {/* 유동성 강조 헤더 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, paddingBottom: 8, borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontSize: 11.5, fontWeight: 800, color: liqColor, padding: "2px 9px", borderRadius: 7, border: `1.5px solid ${liqColor}`, whiteSpace: "nowrap" }}>
          유동성 {liqLabel}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{liqDesc}</span>
        {liq === "thin" && <span style={{ fontSize: 11, fontWeight: 700, color: "var(--neg)", marginLeft: "auto" }}>⚠ 큰 물량 진입 주의</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(88px, 1fr))", gap: "8px 14px" }}>
        {cell("예상 수령", `${pv.expectedOut.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${base}`)}
        {cell("유효 단가", `$${fmtPx(pv.pricePerToken)}`)}
        {cell(`최소 수령 (−${pv.slippagePct}%)`, `${pv.minReceive.toLocaleString(undefined, { maximumFractionDigits: 4 })}`)}
        {cell("가격 임팩트", impact != null ? `${impact > 0 ? "+" : ""}${impact.toFixed(2)}%` : "—",
          impact == null ? undefined : Math.abs(impact) > 1 ? "var(--amber)" : "var(--pos)")}
        {cell("수수료", pv.tradeFeeUsd != null ? `$${pv.tradeFeeUsd.toFixed(2)}` : "—")}
        {cell("가스", pv.gasUsd != null ? `$${pv.gasUsd.toFixed(2)}` : "—")}
      </div>
      {pv.route.length > 0 && (
        <div style={{ marginTop: 7, fontSize: 10.5, color: "var(--text-mute)", whiteSpace: "nowrap", overflowX: "auto" }}>
          경로 · {pv.route.join("  →  ")}
        </div>
      )}
      {(pv.honeypot || pv.taxRatePct != null) && (
        <div style={{ marginTop: 6, fontSize: 11, fontWeight: 700, color: "var(--neg)" }}>
          {pv.honeypot ? "⚠ 허니팟 의심 — 매수 금지" : ""}
          {pv.taxRatePct != null ? `${pv.honeypot ? " · " : "⚠ "}전송세 ${pv.taxRatePct.toFixed(1)}%` : ""}
        </div>
      )}
    </div>
  );
}

function ChartSection({ base, cex, dex }: { base: string; cex: CexRow[]; dex: DexRow[] }) {
  type Opt = { key: string; label: string; src?: string; candle?: { chain: string; contract: string } };
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
    // 네이티브 캔들 (OKX 시세) — iframe 실패/미상장 대비, 빠르고 가벼움
    ...dex.filter((x) => x.verified).map((x) => ({
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
function CandleMini({ chain, contract }: { chain: string; contract: string }) {
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

// ── 상세·실행 패널 — ①신호 ②차트 ③매수·매도 ④포지션 ⑤참고 ────────────────────
function DetailPanel({ base }: { base: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sizeUsd, setSizeUsd] = useState("500");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // DEX 매수 미리보기(체인별) + 최근 스왑 tx 상태
  const [preview, setPreview] = useState<Record<string, PreviewData | "loading" | { error: string }>>({});
  const [lastTx, setLastTx] = useState<{ chain: string; hash: string; url: string | null } | null>(null);
  const [txStatus, setTxStatus] = useState<TxStatusData | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [refOpen, setRefOpen] = useState(false); // ⑤ 참고(보유량·컨트랙트) 접기
  const [hotOpen, setHotOpen] = useState<string | null>(null); // 핫월렛 드릴다운 (거래소별 주소 잔고)
  const [addOpen, setAddOpen] = useState(false); // 입금 지갑 수동 등록 폼
  const [addForm, setAddForm] = useState({ venue: "upbit", type: "hot", address: "", tag: "" });
  const [addMsg, setAddMsg] = useState<string | null>(null);

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

  // 온체인 보유량 — 신호 스트립(덤핑압력)과 ⑤ 상세가 같은 데이터를 쓴다.
  const [holdings, setHoldings] = useState<Holdings | null>(null);
  const [holdErr, setHoldErr] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () => fetch(`/api/exchange-holdings?symbol=${encodeURIComponent(base)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (!stop) { if (j.holdings) { setHoldings(j.holdings); setHoldErr(null); } else setHoldErr(j.error ?? null); } })
      .catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => { stop = true; clearInterval(id); };
  }, [base]);

  // 매수 실행 — DEX면 응답 tx를 잡아 상태 추적 시작.
  const act = useCallback(async (key: string, url: string, body: Record<string, unknown>) => {
    setBusy(key); setMsg(null);
    try {
      const j = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
      setMsg(`${j.ok ? "✓" : "✗"} ${j.message ?? ""}${j.dryRun ? " (모의)" : ""}`);
      if (j.ok && j.tx?.hash && typeof body.chain === "string") {
        setLastTx({ chain: body.chain, hash: j.tx.hash, url: j.tx.url ?? null });
        setTxStatus({ status: j.tx.hash.startsWith("sim:") ? "success" : "pending", failReason: null });
      }
    } catch { setMsg("✗ 요청 실패"); }
    finally { setBusy(null); }
  }, []);

  // verified DEX 미리보기 자동 로드 — 클릭 없이 유동성·슬리피지가 바로 뜨게.
  // 상세가 뜨거나 매수 금액이 바뀌면(디바운스) 각 DEX를 병렬 재견적한다.
  const dexKey = d?.dex.filter((x) => x.verified).map((x) => x.chain).join(",") ?? "";
  useEffect(() => {
    const usd = Number(sizeUsd) || 0;
    if (!d || usd <= 0) return;
    const targets = d.dex.filter((x) => x.verified);
    if (!targets.length) return;
    let stop = false;
    const t = setTimeout(() => {
      setPreview((p) => { const n = { ...p }; for (const x of targets) n[x.chain] = "loading"; return n; });
      for (const x of targets) {
        void (async () => {
          try {
            const j = await (await fetch(`/api/swap-preview?chain=${x.chain}&token=${x.contract}&usd=${usd}&decimals=${x.decimals}`)).json();
            if (!stop) setPreview((p) => ({ ...p, [x.chain]: j.error ? { error: j.error } : j }));
          } catch { if (!stop) setPreview((p) => ({ ...p, [x.chain]: { error: "요청 실패" } })); }
        })();
      }
    }, 500);
    return () => { stop = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dexKey, sizeUsd]);

  // 스왑 tx 폴링 — 확정/실패까지 6초 간격, 모의는 즉시 성공.
  useEffect(() => {
    if (!lastTx || txStatus?.status === "success" || txStatus?.status === "fail") return;
    if (lastTx.hash.startsWith("sim:")) return;
    let alive = true;
    const tick = async () => {
      try {
        const j = await (await fetch(`/api/tx-status?chain=${lastTx.chain}&hash=${lastTx.hash}`)).json();
        if (alive && !j.error) setTxStatus(j);
      } catch { /* 다음 틱 */ }
    };
    void tick();
    const iv = setInterval(tick, 6000);
    return () => { alive = false; clearInterval(iv); };
  }, [lastTx, txStatus?.status]);

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
    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "14px 0 6px" }}>
      <span style={{ ...CAP, color: "var(--text-dim)" }}>{title}</span>
      <span style={{ flex: 1, borderBottom: "1px solid var(--border)" }} />
      {right}
    </div>
  );
  const th = (label: string, align: "left" | "right" = "left") => (
    <span style={{ ...CAP, textAlign: align }}>{label}</span>
  );

  // ── ① 신호 스트립 — 판단에 필요한 숫자를 균일 셀로 ──
  const signal = (label: string, value: React.ReactNode, tone?: string) => (
    <div style={{ padding: "7px 10px", borderRight: "1px solid var(--border)", minWidth: 0 }}>
      <div className="tnum" style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.1, color: tone ?? "var(--text)", whiteSpace: "nowrap" }}>{value}</div>
      <div style={{ marginTop: 3, ...CAP, whiteSpace: "nowrap" }}>{label}</div>
    </div>
  );

  return (
    <div style={{ padding: "0 14px 14px", background: "var(--card-2)", borderTop: "1px solid var(--border)" }}>
      {/* ⓪ 상장 정보 배지 — 어느 거래소에 상장하는지 + 개장 상태 */}
      {(() => {
        const upListed = d.cex.find((r) => r.venue === "upbit")?.listed;
        const btListed = d.cex.find((r) => r.venue === "bithumb")?.listed;
        const badge = (label: string, tone: string, strong?: boolean) => (
          <span style={{ fontSize: 11.5, fontWeight: strong ? 800 : 600, color: tone, padding: "3px 10px", borderRadius: 8, border: `1.5px solid ${tone}`, whiteSpace: "nowrap" }}>{label}</span>
        );
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            {play ? (
              <>
                {badge(`${play.venue === "upbit" ? "업비트" : "빗썸"} 상장${play.opened ? "됨" : " 예정"}`, play.opened ? "var(--pos)" : "var(--amber)", true)}
                {!play.opened && play.opensAt != null && (
                  <span style={{ fontSize: 12, fontWeight: 700, color: "var(--amber)" }}>개장 <Countdown opensAt={play.opensAt} /></span>
                )}
                {!play.opened && play.opensAt == null && <span style={{ fontSize: 11, color: "var(--text-mute)" }}>개장 시각 미정 (공지 확인)</span>}
                {play.overseas && play.globalVenue && badge(`해외 기상장 · ${play.globalVenue}`, "var(--text-dim)")}
              </>
            ) : (
              <>
                {badge(`업비트 ${upListed ? "상장됨" : "미상장"}`, upListed ? "var(--pos)" : "var(--text-mute)")}
                {badge(`빗썸 ${btListed ? "상장됨" : "미상장"}`, btListed ? "var(--pos)" : "var(--text-mute)")}
              </>
            )}
          </div>
        );
      })()}

      {/* ① 신호 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(92px, 1fr))", border: "1px solid var(--border)", borderRadius: 9, overflow: "hidden", marginTop: 12, background: "var(--card)" }}>
        {signal("가격", d.token?.priceUsd != null ? `$${fmtPx(d.token.priceUsd)}` : "—")}
        {signal("시총", fmtUsd(d.token?.marketCapUsd))}
        {signal("24h 볼륨", fmtUsd(d.token?.volumeUsd), d.token?.volumeUsd == null ? undefined : d.token.volumeUsd < 1_000_000 ? "var(--amber)" : undefined)}
        {signal("김프", d.kimchiPct != null ? `${d.kimchiPct > 0 ? "+" : ""}${d.kimchiPct.toFixed(2)}%` : "—", d.kimchiPct == null ? undefined : d.kimchiPct > 0 ? "var(--pos)" : "var(--neg)")}
        {signal("즉시유입/24h", holdings?.dumpRatioPct != null ? `${holdings.dumpRatioPct.toFixed(0)}%` : holdErr ? "—" : "…",
          holdings?.dumpRatioPct == null ? undefined : holdings.dumpRatioPct > 50 ? "var(--amber)" : "var(--pos)")}
        {signal("24h 피크", play?.peakPct != null ? `+${play.peakPct.toFixed(1)}%` : "—", (play?.peakPct ?? 0) > 0 ? "var(--pos)" : undefined)}
      </div>

      {/* ② 차트 */}
      <ChartSection base={base} cex={d.cex} dex={d.dex.filter((x) => !x.note || x.verified || x.note.includes("키"))} />

      {/* ③ 매수·매도 — CEX+DEX 통합 표, 금액 입력은 표 머리에 */}
      {sec("매수 · 매도", (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={CAP}>금액 $</span>
          <input
            value={sizeUsd}
            onChange={(e) => setSizeUsd(e.target.value.replace(/[^0-9]/g, ""))}
            style={{ ...INPUT, width: 62, textAlign: "right" }}
          />
        </span>
      ))}
      <div style={{ display: "grid", gridTemplateColumns: EXEC_COLS, gap: "3px 10px", fontSize: 11.5, alignItems: "center" }}>
        {th("매수처")}{th("가격", "right")}{th("내 자금", "right")}{th("비고", "right")}<span />
        {[...globals, ...krs].map((r) => (
          <Fragment key={r.venue}>
            <span style={{ fontWeight: 600, color: r.listed ? "var(--text)" : "var(--text-mute)" }}>{vlabel(r.venue as never) ?? r.venue}</span>
            <span className="tnum" style={{ textAlign: "right", color: r.listed ? "var(--text)" : "var(--text-mute)" }}>
              {r.listed ? (r.priceKrw != null ? `₩${r.priceKrw.toLocaleString()}` : `$${fmtPx(r.priceUsd)}`) : "미상장"}
            </span>
            <span className="tnum" style={{ textAlign: "right", color: "var(--text-dim)" }}>{r.myCashUsd != null ? fmtUsd(r.myCashUsd) : "키없음"}</span>
            <span className="tnum" style={{ textAlign: "right",
              color: (r.myCoinQty ?? 0) > 0 ? "var(--amber)"
                : play && !play.opened && r.venue === play.venue ? "var(--amber)" : "var(--text-mute)",
              fontWeight: play && !play.opened && r.venue === play.venue ? 700 : 400 }}>
              {(r.myCoinQty ?? 0) > 0 ? `보유 ${r.myCoinQty!.toFixed(3)}`
                : play && !play.opened && r.venue === play.venue ? "★ 상장 예정 — 개장 후 매도처"
                : ["upbit", "bithumb"].includes(r.venue) ? "개장 후 매도처" : "—"}
            </span>
            <span style={{ display: "flex", gap: 5, justifyContent: "flex-end" }}>
              {r.listed && ["binance", "bybit", "okx"].includes(r.venue) && (
                <button type="button" style={BTN} disabled={busy != null || size <= 0}
                  onClick={() => void act(`buy:${r.venue}`, "/api/listing-buy", { base, venue: r.venue, sizeUsd: size })}>
                  {busy === `buy:${r.venue}` ? "…" : "매수"}
                </button>
              )}
              {r.listed && (posQty > 0 || (r.myCoinQty ?? 0) > 0) && (
                <button type="button" style={BTN_SELL} disabled={busy != null}
                  onClick={() => void act(`sell:${r.venue}`, "/api/listing-sell", { base, where: r.venue })}>
                  {busy === `sell:${r.venue}` ? "…" : "매도"}
                </button>
              )}
            </span>
          </Fragment>
        ))}
        {d.dex.map((x) => (
          <Fragment key={x.chain}>
            <span style={{ fontWeight: 600, color: x.verified ? "var(--text)" : "var(--text-mute)" }}>DEX·{x.chain === "ethereum" ? "eth" : x.chain}</span>
            <span className="tnum" style={{ textAlign: "right" }}>{x.execPriceUsd != null ? `$${fmtPx(x.execPriceUsd)}` : "—"}</span>
            <span className="tnum" style={{ textAlign: "right", color: "var(--text-dim)" }}>{d.walletReady ? "지갑" : "키없음"}</span>
            <span className="tnum" style={{ textAlign: "right", color: x.premiumVsCgPct == null ? "var(--text-mute)" : x.premiumVsCgPct > 1 ? "var(--amber)" : "var(--text-dim)" }}>
              {x.premiumVsCgPct != null ? `슬립 ${x.premiumVsCgPct > 0 ? "+" : ""}${x.premiumVsCgPct.toFixed(2)}%` : x.note ?? "—"}
            </span>
            <span style={{ display: "flex", gap: 5, justifyContent: "flex-end" }}>
              {x.verified && preview[x.chain] === "loading" && (
                <span style={{ ...CAP, alignSelf: "center" }}>견적…</span>
              )}
              <button type="button" style={BTN} disabled={busy != null || size <= 0 || !x.verified}
                onClick={() => void act(`dex:${x.chain}`, "/api/listing-dex-buy", { base, chain: x.chain, sizeUsd: size })}>
                {busy === `dex:${x.chain}` ? "…" : "매수"}
              </button>
              {posQty > 0 && x.verified && (
                <button type="button" style={BTN_SELL} disabled={busy != null}
                  onClick={() => void act(`dexsell:${x.chain}`, "/api/listing-sell", { base, where: `dex:${x.chain}` })}>
                  매도
                </button>
              )}
            </span>
            {preview[x.chain] && preview[x.chain] !== "loading" && (
              <div style={{ gridColumn: "1 / -1", margin: "2px 0 6px" }}>
                <SwapPreview base={base} pv={preview[x.chain] as PreviewData | { error: string }} />
              </div>
            )}
          </Fragment>
        ))}
      </div>
      {lastTx && txStatus && (
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8, fontSize: 11.5,
          padding: "7px 10px", borderRadius: 9, border: "1px solid var(--border)", background: "var(--card)" }}>
          <span style={{ fontWeight: 700,
            color: txStatus.status === "success" ? "var(--pos)" : txStatus.status === "fail" ? "var(--neg)" : "var(--amber)" }}>
            스왑 {txStatus.status === "success" ? "✓ 확정" : txStatus.status === "fail" ? "✗ 실패" : txStatus.status === "pending" ? "⏳ 대기" : "· 조회중"}
          </span>
          <span className="tnum" style={{ color: "var(--text-dim)" }}>{lastTx.hash.slice(0, 12)}…</span>
          {lastTx.url && <a href={lastTx.url} target="_blank" rel="noreferrer" style={{ color: "var(--brand-2)", textDecoration: "none" }}>익스플로러 ↗</a>}
          {txStatus.failReason && <span style={{ color: "var(--neg)" }}>· {txStatus.failReason.slice(0, 60)}</span>}
        </div>
      )}
      {!d.dexReady && d.dex.length > 0 && (
        <div style={{ marginTop: 4, fontSize: 10, color: "var(--text-mute)" }}>DEX 실행가·매수는 OKX_WEB3 키 필요{!d.walletReady ? " · 라이브 매수는 지갑 키 필요" : ""}</div>
      )}
      {msg && <div style={{ marginTop: 8, fontSize: 11.5, fontWeight: 600, color: msg.startsWith("✓") ? "var(--pos)" : "var(--neg)" }}>{msg}</div>}

      {/* ③.5 거래소 핫월렛 잔고 — 상장 시 덤프 압력 (온체인 라벨 기반) */}
      {sec("거래소 핫월렛 잔고", (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {holdings?.globalHotUsd != null && (
            <span className="tnum" style={{ fontSize: 11.5, color: "var(--text-dim)" }}>글로벌 핫 합계 <b style={{ color: "var(--text)" }}>{fmtUsd(holdings.globalHotUsd)}</b></span>
          )}
          <button type="button" style={BTN_GHOST} onClick={() => setAddOpen(!addOpen)}>{addOpen ? "닫기" : "＋ 주소"}</button>
        </span>
      ))}
      {addOpen && (
        <div style={{ margin: "2px 0 10px", padding: "9px 11px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 9 }}>
          <div style={{ ...CAP, marginBottom: 6 }}>입금 지갑 수동 등록 — 상장 전 KR 거래소 입금 물량 워치 (영구 주소록에 저장)</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <select value={addForm.venue} onChange={(e) => setAddForm({ ...addForm, venue: e.target.value })} style={{ ...INPUT, width: 86 }}>
              {["upbit", "bithumb", "binance", "okx", "bybit"].map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
            <select value={addForm.type} onChange={(e) => setAddForm({ ...addForm, type: e.target.value })} style={{ ...INPUT, width: 64 }}>
              <option value="hot">핫</option><option value="cold">콜드</option>
            </select>
            <input placeholder="0x… 주소" value={addForm.address} onChange={(e) => setAddForm({ ...addForm, address: e.target.value.trim() })} style={{ ...INPUT, flex: 1, minWidth: 260 }} />
            <input placeholder="메모 (예: 업비트 PEPE 입금)" value={addForm.tag} onChange={(e) => setAddForm({ ...addForm, tag: e.target.value })} style={{ ...INPUT, width: 150 }} />
            <button type="button" style={BTN} disabled={!/^0x[0-9a-fA-F]{40}$/.test(addForm.address)}
              onClick={async () => {
                setAddMsg(null);
                try {
                  const j = await (await fetch("/api/wallet-book", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(addForm) })).json();
                  setAddMsg(`${j.ok ? "✓" : "✗"} ${j.message}`);
                  if (j.ok) {
                    setAddForm({ ...addForm, address: "", tag: "" });
                    // 즉시 재조회 (캐시 우회) — 새 주소 잔고가 바로 표에 반영
                    const h = await (await fetch(`/api/exchange-holdings?symbol=${encodeURIComponent(base)}&fresh=1`, { cache: "no-store" })).json();
                    if (h.holdings) setHoldings(h.holdings);
                  }
                } catch { setAddMsg("✗ 요청 실패"); }
              }}>등록</button>
          </div>
          {addMsg && <div style={{ marginTop: 5, fontSize: 11, fontWeight: 600, color: addMsg.startsWith("✓") ? "var(--pos)" : "var(--neg)" }}>{addMsg}</div>}
          {d.token && d.token.contractsList.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 10.5, color: "var(--text-mute)", display: "flex", gap: 10, flexWrap: "wrap" }}>
              주소 찾기:
              {d.token.contractsList.filter((c) => ["ethereum", "bsc", "base"].includes(c.chain)).map((c) => {
                const ex = c.chain === "ethereum" ? "etherscan.io" : c.chain === "bsc" ? "bscscan.com" : "basescan.org";
                return (
                  <span key={c.chain} style={{ display: "inline-flex", gap: 6 }}>
                    <a href={`https://${ex}/token/${c.address}#balances`} target="_blank" rel="noreferrer" style={{ color: "var(--brand-2)", textDecoration: "none" }}>{c.chain} 홀더 상위 ↗</a>
                    <a href={`https://${ex}/token/${c.address}`} target="_blank" rel="noreferrer" style={{ color: "var(--brand-2)", textDecoration: "none" }}>최근 전송 ↗</a>
                  </span>
                );
              })}
              <span>— 상장 발표 후 갑자기 등장한 대형 수신 주소가 거래소 입금 지갑 후보</span>
            </div>
          )}
        </div>
      )}
      {holdErr ? (
        <div style={{ fontSize: 11, color: "var(--text-mute)" }}>{holdErr}</div>
      ) : !holdings ? (
        <div style={{ fontSize: 11, color: "var(--text-mute)" }}>온체인 라벨로 조회 중… (~10s)</div>
      ) : (() => {
        const rows = holdings.venues.filter((v) => v.hot + v.cold > 0);
        if (!rows.length) return <div style={{ fontSize: 11, color: "var(--text-mute)" }}>라벨된 거래소 지갑 잔고 없음 (신규·비주류 토큰)</div>;
        const maxHotUsd = Math.max(...rows.map((v) => v.hotUsd ?? 0), 1);
        return (
          <div style={{ display: "grid", gridTemplateColumns: "96px minmax(90px,1.4fr) 1fr 1fr", gap: "5px 12px", fontSize: 11.5, alignItems: "center" }}>
            {th("거래소")}{th("핫월렛", "right")}{th("콜드", "right")}{th("핫 유입 Δ/분", "right")}
            {rows.map((v) => {
              const barPct = v.hotUsd != null ? Math.max(3, (v.hotUsd / maxHotUsd) * 100) : 0;
              const dumping = (v.hotDeltaPerMin ?? 0) > 0;
              const canDrill = (v.breakdown?.length ?? 0) > 0;
              const opened = hotOpen === v.venue;
              return (
                <Fragment key={v.venue}>
                  <button type="button" disabled={!canDrill}
                    onClick={() => setHotOpen(opened ? null : v.venue)}
                    style={{ background: "none", border: "none", padding: 0, textAlign: "left", cursor: canDrill ? "pointer" : "default",
                      fontWeight: 700, color: "var(--text)", display: "flex", alignItems: "center", gap: 4 }}>
                    {canDrill && <span style={{ fontSize: 8, color: "var(--text-mute)" }}>{opened ? "▼" : "▶"}</span>}
                    {v.venue}
                  </button>
                  <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                    <span className="tnum" style={{ fontWeight: 700 }}>{v.hotUsd != null ? fmtUsd(v.hotUsd) : fmtQty(v.hot)}</span>
                    <span style={{ width: "100%", height: 3, background: "var(--card-3)", borderRadius: 2, overflow: "hidden" }}>
                      <span style={{ display: "block", height: "100%", width: `${barPct}%`, background: dumping ? "var(--amber)" : "var(--brand)", borderRadius: 2 }} />
                    </span>
                  </span>
                  <span className="tnum" style={{ textAlign: "right", color: "var(--text-dim)" }}>{fmtQty(v.cold)}</span>
                  <span className="tnum" style={{ textAlign: "right", fontWeight: dumping ? 700 : 400,
                    color: v.hotDeltaPerMin == null || v.hotDeltaPerMin === 0 ? "var(--text-mute)" : v.hotDeltaPerMin > 0 ? "var(--amber)" : "var(--pos)" }}>
                    {v.hotDeltaPerMin == null ? "—" : v.hotDeltaPerMin === 0 ? "0"
                      : `${v.hotDeltaPerMin > 0 ? "▲ +" : "▼ −"}${holdings.priceUsd != null ? "$" + fmtQty(Math.abs(v.hotDeltaPerMin * holdings.priceUsd)) : fmtQty(Math.abs(v.hotDeltaPerMin))}`}
                    {dumping ? "/분" : ""}
                  </span>
                  {opened && v.breakdown && (
                    <div style={{ gridColumn: "1 / -1", margin: "1px 0 6px", padding: "6px 10px 6px 20px", background: "var(--card)", borderRadius: 8, border: "1px solid var(--border)" }}>
                      <div style={{ ...CAP, marginBottom: 4 }}>{v.venue} 지갑별 잔고 — 상위 {v.breakdown.length} (라벨된 주소만)</div>
                      {v.breakdown.map((w) => (
                        <div key={w.address} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto auto", gap: "2px 10px", alignItems: "center", padding: "1px 0", fontSize: 11 }}>
                          <span style={{ fontSize: 8.5, fontWeight: 700, padding: "0 4px", borderRadius: 6, color: w.type === "hot" ? "var(--amber)" : "var(--text-mute)", border: `1px solid ${w.type === "hot" ? "var(--amber)" : "var(--border-strong)"}` }}>{w.type === "hot" ? "핫" : "콜드"}</span>
                          <span style={{ color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.tag ?? "라벨 없음"}</span>
                          <a href={`https://etherscan.io/address/${w.address}`} target="_blank" rel="noreferrer" className="tnum" style={{ color: "var(--text-mute)", fontSize: 10, textDecoration: "none" }}>{w.address.slice(0, 8)}…{w.address.slice(-4)} ↗</a>
                          <span className="tnum" style={{ textAlign: "right", fontWeight: 600 }}>{w.usd != null ? fmtUsd(w.usd) : fmtQty(w.amount)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>
        );
      })()}
      {holdings && holdings.venues.some((v) => (v.hotDeltaPerMin ?? 0) > 0) && (
        <div style={{ marginTop: 6, fontSize: 10.5, color: "var(--amber)" }}>▲ 핫월렛 유입 = 거래소가 매도 물량을 준비 중일 수 있음 (덤프 경계)</div>
      )}

      {/* ③.6 개장 전 입금 물량 — 발표→개장 사이 KR 거래소 누적 (예상 초기 매도 재고) */}
      {play && (d.krDeposits?.length ?? 0) >= 2 && (() => {
        const pts = d.krDeposits!;
        const first = pts[0], last = pts[pts.length - 1];
        const cur = last.up + last.bt;
        const delta = cur - (first.up + first.bt);
        const W = 260, H = 36;
        const maxV = Math.max(...pts.map((q) => q.up + q.bt), 1);
        const line = pts.map((q, i) => `${(i / (pts.length - 1)) * W},${H - ((q.up + q.bt) / maxV) * (H - 4) - 2}`).join(" ");
        return (
          <>
            {sec("개장 전 입금 물량", (
              <span className="tnum" style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
                현재 <b style={{ color: "var(--text)" }}>{fmtUsd(cur)}</b>
                {delta > 100 && <span style={{ color: "var(--amber)", fontWeight: 700 }}> · 추적 후 +{fmtUsd(delta)}</span>}
              </span>
            ))}
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <svg width={W} height={H} style={{ display: "block" }}>
                <polyline points={line} fill="none" stroke="var(--amber)" strokeWidth={1.5} />
              </svg>
              <div style={{ fontSize: 11 }} className="tnum">
                <div>업비트 <b>{fmtUsd(last.up)}</b>{play.venue === "upbit" && <span style={{ color: "var(--amber)" }}> ★</span>}</div>
                <div>빗썸 <b>{fmtUsd(last.bt)}</b>{play.venue === "bithumb" && <span style={{ color: "var(--amber)" }}> ★</span>}</div>
              </div>
              <div style={{ fontSize: 10.5, color: "var(--text-mute)", maxWidth: 340 }}>
                등록된 KR 지갑의 이 코인 잔고 누적(60초 간격) — 개장 직후 나올 수 있는 매도 재고의 하한선. ＋ 주소로 입금 지갑을 등록할수록 정확해집니다.
              </div>
            </div>
          </>
        );
      })()}

      {/* ④ 내 포지션 */}
      {(buys.length > 0 || sells.length > 0) && (
        <>
          {sec("내 포지션", (
            <span className="tnum" style={{ fontSize: 11.5 }}>
              잔여 <b>{posQty.toFixed(4)}</b>
              {unrealized != null && (
                <span style={{ marginLeft: 8, fontWeight: 700, color: unrealized >= 0 ? "var(--pos)" : "var(--neg)" }}>
                  미실현 {unrealized >= 0 ? "+" : "−"}${Math.abs(unrealized).toFixed(2)}
                </span>
              )}
            </span>
          ))}
          <div style={{ display: "grid", gridTemplateColumns: EXEC_COLS, gap: "3px 10px", fontSize: 11.5, alignItems: "center" }}>
            {th("구분")}{th("수량", "right")}{th("금액", "right")}{th("단가", "right")}<span style={{ ...CAP, textAlign: "right" }}>시각</span>
            {[...buys.map((b) => ({ ...b, kind: "매수" as const })), ...sells.map((s) => ({ ...s, kind: "매도" as const }))]
              .sort((a, b) => a.ts - b.ts)
              .map((r, i) => (
                <Fragment key={i}>
                  <span style={{ fontWeight: 600, color: r.kind === "매수" ? "var(--pos)" : "var(--neg)" }}>{r.kind} · {r.where}</span>
                  <span className="tnum" style={{ textAlign: "right" }}>{r.qty != null ? r.qty.toFixed(4) : "—"}</span>
                  <span className="tnum" style={{ textAlign: "right" }}>${r.usd.toFixed(0)}</span>
                  <span className="tnum" style={{ textAlign: "right", color: "var(--text-dim)" }}>{r.price != null ? `$${fmtPx(r.price)}` : "—"}</span>
                  <span className="tnum" style={{ textAlign: "right", color: "var(--text-mute)" }}>{ago(r.ts)} 전{r.dry ? " · 모의" : ""}</span>
                </Fragment>
              ))}
          </div>
        </>
      )}

      {/* ⑤ 참고 — 온체인 보유량 상세 + 컨트랙트 (접이식) */}
      <div style={{ marginTop: 14 }}>
        <button
          type="button"
          onClick={() => setRefOpen(!refOpen)}
          style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "var(--text-dim)" }}
        >
          <span style={CAP}>참고 — 컨트랙트 주소</span>
          {holdings?.globalHotUsd != null && (
            <span className="tnum" style={{ fontSize: 10.5, color: "var(--text-mute)" }}>
              글로벌 핫 {fmtUsd(holdings.globalHotUsd)}
            </span>
          )}
          <span style={{ flex: 1, borderBottom: "1px solid var(--border)" }} />
          <span style={{ fontSize: 10, color: "var(--text-mute)" }}>{refOpen ? "▲" : "▼"}</span>
        </button>
        {refOpen && (
          <div style={{ marginTop: 8, fontSize: 11 }}>
            {d.token && d.token.contractsList.length > 0 ? d.token.contractsList.map((c) => {
              const dexRow = d.dex.find((x) => x.chain === c.chain);
              return (
                <div key={c.chain} style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0" }}>
                  <span style={{ width: 76, color: "var(--text-dim)", fontWeight: 600 }}>{c.chain}</span>
                  <button
                    type="button"
                    title="클릭 = 주소 복사"
                    onClick={() => { void navigator.clipboard?.writeText(c.address); setCopied(c.chain); setTimeout(() => setCopied(null), 1200); }}
                    className="tnum"
                    style={{ background: "none", border: "none", cursor: "pointer", color: copied === c.chain ? "var(--pos)" : "var(--text)", fontSize: 10.5, padding: 0 }}
                  >
                    {copied === c.chain ? "복사됨 ✓" : `${c.address.slice(0, 10)}…${c.address.slice(-8)}`}
                  </button>
                  {dexRow?.verified && <span style={{ fontSize: 9, fontWeight: 700, color: "var(--pos)", border: "1px solid var(--pos)", borderRadius: 9, padding: "0 4px" }}>OKX 검증</span>}
                </div>
              );
            }) : (
              <div style={{ color: "var(--text-mute)" }}>EVM 컨트랙트 없음 (비EVM 체인 토큰) — DEX 매수 불가</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default ListingPanel;
