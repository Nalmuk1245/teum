"use client";

import React from "react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { vlabel } from "../cockpit-ui";
import { useIsMobile } from "../../mobile";
import {
  CAP, BTN, BTN_SELL, BTN_GHOST, INPUT, EXEC_COLS, EXEC_COLS_M,
  fmtUsd, fmtPx, fmtQty, ago, Countdown,
  type Detail, type DexRow, type Holdings, type PreviewData, type TxStatusData,
} from "./shared";
import { ErrBox } from "./errors";
import { ChartSection } from "./charts";

// 스왑 미리보기 — OKX 견적으로 예상 수령·유효 단가·최소 수령(슬리피지)·
// 가격임팩트·수수료·가스·라우팅 + 토큰 안전성(허니팟·전송세).
function SwapPreview({ base, pv }: { base: string; pv: PreviewData | { error: string } }) {
  if ("error" in pv) return <ErrBox raw={pv.error} />;

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

// ── 지갑 → 거래소 입금 섹션 ───────────────────────────────────────────────────
// DEX 매수분을 개장 전에 매도처(주로 KR)로 옮기는 다리. 주소·컨트랙트 검증은
// 전부 서버(/api/listing-transfer)가 한다 — 이 컴포넌트는 수량·목적지 선택 UI다.
const TRANSFER_CHAINS = ["ethereum", "bsc", "base", "arbitrum", "optimism", "polygon", "avalanche"];
const TRANSFER_VENUES = ["upbit", "bithumb", "binance", "bybit", "okx"] as const;

function TransferSection({ base, play, dex, busy, act }: {
  base: string;
  play: { venue?: string } | null;
  dex: DexRow[];
  busy: string | null;
  act: (key: string, url: string, body: Record<string, unknown>) => Promise<void>;
}) {
  // 체인 후보: 이 토큰이 존재하는 체인 중 전송 배선이 있는 것(EVM)만.
  const chains = useMemo(() => {
    const fromDex = dex.map((x) => x.chain).filter((c: string) => TRANSFER_CHAINS.includes(c));
    return fromDex.length ? fromDex : ["ethereum"];
  }, [dex]);
  const [chain, setChain] = useState(chains[0]);
  const [venue, setVenue] = useState<string>(play?.venue ?? "upbit");
  const [qty, setQty] = useState("");
  const [bal, setBal] = useState<number | null>(null);
  useEffect(() => { if (!chains.includes(chain)) setChain(chains[0]); }, [chains, chain]);

  // 지갑 잔고 — 수량 프리필. 체인이 바뀌면 다시 읽는다.
  useEffect(() => {
    let stop = false;
    setBal(null);
    fetch(`/api/listing-transfer?base=${encodeURIComponent(base)}&chain=${chain}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (!stop) setBal(typeof j.qty === "number" ? j.qty : null); })
      .catch(() => {});
    return () => { stop = true; };
  }, [base, chain]);

  const qn = Number(qty);
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ ...CAP, color: "var(--text-dim)" }}>지갑 → 거래소 입금</span>
        <span style={{ fontSize: 10.5, color: "var(--text-mute)" }}>개장 전에 매도처로 — 입금주소·컨트랙트는 서버가 검증</span>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <select value={chain} onChange={(e) => setChain(e.target.value)}
          style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 9, padding: "7px 8px", color: "var(--text)", fontSize: 12 }}>
          {chains.map((c) => <option key={c} value={c}>{c === "ethereum" ? "eth" : c}</option>)}
        </select>
        <span style={{ color: "var(--text-mute)", fontSize: 12 }}>→</span>
        <select value={venue} onChange={(e) => setVenue(e.target.value)}
          style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 9, padding: "7px 8px", color: "var(--text)", fontSize: 12 }}>
          {TRANSFER_VENUES.map((v) => (
            <option key={v} value={v}>
              {vlabel(v as never) ?? v}{play?.venue === v ? " ★" : ""}
            </option>
          ))}
        </select>
        <input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="수량" inputMode="decimal"
          className="tnum"
          style={{ width: 110, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 9, padding: "7px 10px", color: "var(--text)", fontSize: 12, outline: "none", minWidth: 0 }} />
        <button type="button" style={BTN_GHOST} disabled={bal == null || bal <= 0}
          onClick={() => bal != null && setQty(String(Math.floor(bal * 1e6) / 1e6))}
          title="지갑 잔고 전액">
          전액{bal != null ? ` (${bal >= 1 ? bal.toFixed(3) : bal.toPrecision(3)})` : ""}
        </button>
        <button type="button" style={BTN} disabled={busy != null || !(qn > 0)}
          onClick={() => void act("transfer", "/api/listing-transfer", { base, chain, venue, qty: qn })}>
          {busy === "transfer" ? "…" : "입금 전송"}
        </button>
      </div>
      {bal != null && bal <= 0 && (
        <div style={{ marginTop: 4, fontSize: 10.5, color: "var(--text-mute)" }}>
          이 체인 지갑 잔고 0 — DEX 매수 후 사용하거나 다른 체인을 선택하세요
        </div>
      )}
    </div>
  );
}

// ── 상세·실행 패널 — ①신호 ②차트 ③매수·매도 ③′입금 ④포지션 ⑤참고 ──────────────
export function DetailPanel({ base, narrow }: { base: string; narrow?: boolean }) {
  // 표를 3열로 접어 매수·매도 버튼이 화면 밖으로 안 나가게.
  // `narrow`: 뷰포트는 데스크탑이어도 **이 패널이 들어앉은 컬럼이 좁을 때**(PC
  // 상장 탭의 400px+1fr 분할) 쓰는 플래그. 데스크탑 표는 최소 ~390px를 요구하는데
  // 768px 창이면 우측 컬럼이 ~330px라, 감싸는 카드가 overflow:hidden이라서
  // 마지막 auto 컬럼(매수·매도 버튼)이 그냥 잘려 클릭조차 못 하게 된다.
  const mob = useIsMobile() || !!narrow;
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sizeUsd, setSizeUsd] = useState("500");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
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

  // 열기까지 걸린 시간. "느리다"를 숫자로 바꿔야 어디를 고칠지 정할 수 있고,
  // 기다리는 쪽도 멈춘 건지 오는 중인지 알 수 있다.
  const [openMs, setOpenMs] = useState<{ fast: number | null; full: number | null }>({ fast: null, full: null });
  const [waiting, setWaiting] = useState(0);
  const t0Ref = useRef(0);
  useEffect(() => {
    t0Ref.current = performance.now();
    setD(null); setErr(null); setOpenMs({ fast: null, full: null }); setWaiting(0);
  }, [base]);

  useEffect(() => {
    let stop = false;
    const t0 = t0Ref.current || performance.now();
    const load = (fast?: boolean) =>
      fetch(`/api/listing-detail?base=${encodeURIComponent(base)}${fast ? "&fast=1" : ""}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => {
          if (stop || !j.detail) { if (!stop) setErr(j.error ?? "조회 실패"); return; }
          const ms = Math.round(performance.now() - t0);
          setOpenMs((p) => (fast ? (p.fast == null ? { ...p, fast: ms } : p) : (p.full == null ? { ...p, full: ms } : p)));
          // fast 응답이 늦게 도착해 이미 받은 전체 응답을 덮어쓰면 DEX 표가
          // 사라진다 — pending 응답은 아직 아무것도 없을 때만 반영한다.
          setD((prev) => (j.detail.dexPending && prev && !prev.dexPending ? prev : j.detail));
          setErr(null);
        })
        .catch(() => { if (!stop) setErr("조회 실패"); });
    // 2단계: DEX 없이 먼저(≈0.3s) 그린 뒤 곧바로 전체를 덧씌운다. 상장따리는
    // 늘 처음 보는 코인이라 캐시가 없고, 그 사이 빈 화면이 곧 놓친 시간이다.
    void load(true).then(() => { if (!stop) void load(); });
    const id = setInterval(() => void load(), 10_000);
    return () => { stop = true; clearInterval(id); };
  }, [base]);

  // 경과 초 카운터 — **응답이 오기 전에만** 돈다. `d`를 의존성에 넣어 첫 응답이
  // 도착하면 인터벌이 사라진다. 계속 돌려두면 100ms마다 DetailPanel 전체(차트
  // 440px + 표들)를 리렌더하는데, 이 패널은 이제 PC에서 목록과 나란히 상주하므로
  // 그 낭비가 영구적이 된다.
  useEffect(() => {
    if (d) return;
    const tick = setInterval(() => setWaiting(Math.round((performance.now() - t0Ref.current) / 100) / 10), 100);
    return () => clearInterval(tick);
  }, [d, base]);

  // 온체인 보유량 — 신호 스트립(덤핑압력)과 ⑤ 상세가 같은 데이터를 쓴다.
  const [holdings, setHoldings] = useState<Holdings | null>(null);
  const [holdErr, setHoldErr] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const load = () => fetch(`/api/exchange-holdings?symbol=${encodeURIComponent(base)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (stop) return;
        // pending = 서버가 뒤에서 구축 중 (연결을 잡고 기다리는 대신 즉시 반환).
        // 60초 폴링을 기다리면 첫 화면이 그만큼 비므로 3초 뒤 다시 묻는다.
        if (j.pending) { retry = setTimeout(load, 3000); return; }
        if (j.holdings) { setHoldings(j.holdings); setHoldErr(null); } else setHoldErr(j.error ?? null);
      })
      .catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => { stop = true; clearInterval(id); if (retry) clearTimeout(retry); };
  }, [base]);

  // 매수 실행 — DEX면 응답 tx를 잡아 상태 추적 시작.
  const act = useCallback(async (key: string, url: string, body: Record<string, unknown>) => {
    setBusy(key); setMsg(null); setErrMsg(null);
    try {
      const j = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
      setMsg(j.ok ? `✓ ${j.message ?? "완료"}${j.dryRun ? " (모의)" : ""}` : null);
      setErrMsg(j.ok ? null : (j.message ?? "요청 실패"));
      if (j.ok && j.tx?.hash && typeof body.chain === "string") {
        setLastTx({ chain: body.chain, hash: j.tx.hash, url: j.tx.url ?? null });
        setTxStatus({ status: j.tx.hash.startsWith("sim:") ? "success" : "pending", failReason: null });
      }
    } catch { setMsg(null); setErrMsg("네트워크 오류 — 요청이 서버에 닿지 못했습니다"); }
    finally { setBusy(null); }
  }, []);

  // verified DEX 미리보기 자동 로드 — 클릭 없이 유동성·슬리피지가 바로 뜨게.
  // 상세가 뜨거나 매수 금액이 바뀌면(디바운스) 각 DEX를 병렬 재견적한다.
  const dexKey = d?.dex.filter((x) => x.verified && !x.untradeable).map((x) => x.chain).join(",") ?? "";
  useEffect(() => {
    const usd = Number(sizeUsd) || 0;
    if (!d || usd <= 0) return;
    const targets = d.dex.filter((x) => x.verified && !x.untradeable);
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
  if (!d) return (
    <div style={{ padding: "12px 14px", fontSize: 11.5, color: "var(--text-mute)" }}>
      조회 중… <span className="tnum">{waiting.toFixed(1)}s</span>
    </div>
  );

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
      {/* 느렸을 때만 실측치를 남긴다 — 체감을 숫자로 바꿔야 서버가 느린 건지
          브라우저·회선이 느린 건지 갈린다. 서버 쪽 단계별 소요는 pm2 로그에 있다. */}
      {(openMs.fast ?? 0) > 2000 && (
        <div className="tnum" style={{ fontSize: 10, color: "var(--amber)", paddingTop: 6 }}>
          첫 응답 {(openMs.fast! / 1000).toFixed(1)}s{openMs.full != null ? ` · 전체 ${(openMs.full / 1000).toFixed(1)}s` : ""} — 느림
        </div>
      )}
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
      <div style={{ display: "grid", gridTemplateColumns: mob ? EXEC_COLS_M : EXEC_COLS, gap: "3px 10px", fontSize: 11.5, alignItems: "center" }}>
        {th("매수처")}{th("가격", "right")}{!mob && th("내 자금", "right")}{!mob && th("비고", "right")}<span />
        {[...globals, ...krs].map((r) => (
          <Fragment key={r.venue}>
            <span style={{ fontWeight: 600, color: r.listed ? "var(--text)" : "var(--text-mute)" }}>{vlabel(r.venue as never) ?? r.venue}</span>
            <span className="tnum" style={{ textAlign: "right", color: r.listed ? "var(--text)" : "var(--text-mute)" }}>
              {r.listed ? (r.priceKrw != null ? `₩${r.priceKrw.toLocaleString()}` : `$${fmtPx(r.priceUsd)}`) : "미상장"}
            </span>
            {!mob && <span className="tnum" style={{ textAlign: "right", color: "var(--text-dim)" }}>{r.myCashUsd != null ? fmtUsd(r.myCashUsd) : d.balancesPending ? "…" : "키없음"}</span>}
            {!mob && <span className="tnum" style={{ textAlign: "right",
              color: (r.myCoinQty ?? 0) > 0 ? "var(--amber)"
                : play && !play.opened && r.venue === play.venue ? "var(--amber)" : "var(--text-mute)",
              fontWeight: play && !play.opened && r.venue === play.venue ? 700 : 400 }}>
              {(r.myCoinQty ?? 0) > 0 ? `보유 ${r.myCoinQty!.toFixed(3)}`
                : play && !play.opened && r.venue === play.venue ? "★ 상장 예정 — 개장 후 매도처"
                : ["upbit", "bithumb"].includes(r.venue) ? "개장 후 매도처" : "—"}
            </span>}
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
            {mob && (
              <div className="tnum" style={{ gridColumn: "1 / -1", display: "flex", gap: 10, flexWrap: "wrap", fontSize: 10.5, color: "var(--text-mute)", marginTop: -1 }}>
                <span>{r.myCashUsd != null ? `자금 ${fmtUsd(r.myCashUsd)}` : d.balancesPending ? "자금 …" : "키없음"}</span>
                {(r.myCoinQty ?? 0) > 0 && <span style={{ color: "var(--amber)" }}>보유 {r.myCoinQty!.toFixed(3)}</span>}
                {play && !play.opened && r.venue === play.venue && <span style={{ color: "var(--amber)", fontWeight: 700 }}>★ 상장 예정 — 개장 후 매도처</span>}
              </div>
            )}
          </Fragment>
        ))}
        {d.dexPending && (
          <span style={{ gridColumn: "1 / -1", fontSize: 11, color: "var(--text-mute)", padding: "4px 0" }}>
            DEX 견적 조회 중… (풀 유동성·슬리피지)
          </span>
        )}
        {d.dex.map((x) => (
          <Fragment key={x.chain}>
            <span style={{ fontWeight: 600, color: x.untradeable ? "var(--text-mute)" : x.verified ? "var(--text)" : "var(--text-mute)" }}>
              DEX·{x.chain === "ethereum" ? "eth" : x.chain}
              {x.untradeable && <span style={{ marginLeft: 5, fontSize: 9.5, fontWeight: 700, color: "var(--neg)" }}>거래불가</span>}
            </span>
            <span className="tnum" style={{ textAlign: "right", color: x.untradeable ? "var(--text-mute)" : undefined, textDecoration: x.untradeable ? "line-through" : undefined }}>
              {x.execPriceUsd != null ? `$${fmtPx(x.execPriceUsd)}` : "—"}
            </span>
            {!mob && (
              <span className="tnum" style={{ textAlign: "right", color: "var(--text-dim)" }}>
                {x.liquidityUsd != null ? `풀 $${x.liquidityUsd >= 1e6 ? (x.liquidityUsd / 1e6).toFixed(1) + "M" : Math.round(x.liquidityUsd / 1000) + "K"}` : d.walletReady ? "지갑" : "키없음"}
              </span>
            )}
            {!mob && (
              <span className="tnum" style={{ textAlign: "right", color: x.untradeable ? "var(--neg)" : x.premiumVsCgPct == null ? "var(--text-mute)" : x.premiumVsCgPct > 1 ? "var(--amber)" : "var(--text-dim)" }}>
                {x.untradeable ? (x.note ?? "거래불가") : x.premiumVsCgPct != null ? `슬립 ${x.premiumVsCgPct > 0 ? "+" : ""}${x.premiumVsCgPct.toFixed(2)}%` : x.note ?? "—"}
              </span>
            )}
            <span style={{ display: "flex", gap: 5, justifyContent: "flex-end" }}>
              {x.verified && !x.untradeable && preview[x.chain] === "loading" && (
                <span style={{ ...CAP, alignSelf: "center" }}>견적…</span>
              )}
              <button type="button" style={BTN} disabled={busy != null || size <= 0 || !x.verified || !!x.untradeable}
                onClick={() => void act(`dex:${x.chain}`, "/api/listing-dex-buy", { base, chain: x.chain, sizeUsd: size })}>
                {busy === `dex:${x.chain}` ? "…" : "매수"}
              </button>
              {posQty > 0 && x.verified && !x.untradeable && (
                <button type="button" style={BTN_SELL} disabled={busy != null}
                  onClick={() => void act(`dexsell:${x.chain}`, "/api/listing-sell", { base, where: `dex:${x.chain}` })}>
                  매도
                </button>
              )}
            </span>
            {mob && (
              <div className="tnum" style={{ gridColumn: "1 / -1", display: "flex", gap: 10, flexWrap: "wrap", fontSize: 10.5, color: x.untradeable ? "var(--neg)" : "var(--text-mute)", marginTop: -1 }}>
                <span>{x.liquidityUsd != null ? `풀 $${x.liquidityUsd >= 1e6 ? (x.liquidityUsd / 1e6).toFixed(1) + "M" : Math.round(x.liquidityUsd / 1000) + "K"}` : d.walletReady ? "지갑" : "키없음"}</span>
                <span>{x.untradeable ? (x.note ?? "거래불가") : x.premiumVsCgPct != null ? `슬립 ${x.premiumVsCgPct > 0 ? "+" : ""}${x.premiumVsCgPct.toFixed(2)}%` : x.note ?? ""}</span>
              </div>
            )}
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
      {msg && <div style={{ marginTop: 8, fontSize: 11.5, fontWeight: 600, color: "var(--pos)" }}>{msg}</div>}
      {errMsg && <div style={{ marginTop: 8 }}><ErrBox raw={errMsg} /></div>}

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

      {/* ③′ 지갑 → 거래소 입금 — DEX에서 산 코인을 개장 전에 매도처로 옮겨 두는
          다리. 개장 후 팔려면 개장 전에 도착해 있어야 한다. 입금주소는 서버가
          거래소 API에서 직접 받고(클라이언트 주소 불신), 컨트랙트는 검증 경로를
          거친다 — 검증 실패 코인은 서버가 차단하고 수동 등록을 안내한다. */}
      <TransferSection base={base} play={play} dex={d.dex} busy={busy} act={act} />

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
          <div style={{ display: "grid", gridTemplateColumns: mob ? EXEC_COLS_M : EXEC_COLS, gap: "3px 10px", fontSize: 11.5, alignItems: "center" }}>
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
