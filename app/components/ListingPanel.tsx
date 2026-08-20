"use client";

// 상장 대시보드 — 좌: 탐지·설정·기록이 한 카드 / 우: 선택 티커의 실행 패널.
// 상세 패널은 의사결정 순서대로 흐른다:
//   ① 신호 (가격·시총·볼륨·김프·덤핑압력)  ② 차트  ③ 매수·매도 (CEX+DEX 통합 표)
//   ④ 내 포지션  ⑤ 참고 (온체인 보유량·컨트랙트, 접이식)
// 모든 표는 같은 그리드 문법(처 | 가격 | 내 자금 | 비고 | 액션)을 쓴다.

import { Fragment, useEffect, useRef, useState } from "react";
import { beep, VenueLink } from "./cockpit-ui";
import { authHeaders } from "@/lib/runStore";
import {
  CAP, CARD, BTN, BTN_GHOST, INPUT, DETAIL_ANCHOR,
  fmtPx, ago, Countdown,
  type Listing, type Watch, type HistoryRow, type AutoCfg,
} from "./listing/shared";
import { DetailPanel } from "./listing/DetailPanel";

// 하위 호환 재수출 — GapInspect 등이 "./ListingPanel"에서 가져간다.
export { TV_SYMBOL } from "./listing/charts";

export function ListingPanel({ wide }: { wide?: boolean }) {
  const [rows, setRows] = useState<Listing[]>([]);
  const [watch, setWatch] = useState<Watch | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  // 기본 펼침 — 접혀 있으면 존재 자체를 모른다 (실사용 피드백). 긴 목록은
  // 아래 스크롤 컨테이너가 감당한다.
  const [histOpen, setHistOpen] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  // PC 2단 배치에서 우측 컬럼이 데스크탑 표(최소 ~390px)를 담을 수 있는가.
  // 좌측 목록이 400px 고정이므로 창이 이만큼은 돼야 한다. 그 아래(태블릿 세로,
  // 반쪽 창)에서는 상세를 모바일 배치로 접는다 — 안 접으면 매수 버튼이 잘린다.
  // 서버에선 알 수 없는 값이라 false로 시작해 마운트 후 정정한다(mobile.tsx와 동일).
  const [tight, setTight] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const sync = () => setTight(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // 히스토리에서 여는 경로. 히스토리는 목록 카드 맨 아래라 상세(모바일: 목록 위
  // 인라인 / PC: 우측 컬럼 상단)가 화면 밖에서 열려 무반응처럼 보인다 — 열린
  // 상세 블록(DETAIL_ANCHOR)으로 스크롤을 같이 옮긴다.
  const openDetail = (base: string) => {
    setSelected(base);
    requestAnimationFrame(() => {
      document.getElementById(DETAIL_ANCHOR)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };
  const [manual, setManual] = useState("");
  const [auto, setAuto] = useState<AutoCfg | null>(null);
  const [autoLive, setAutoLive] = useState(false);
  const [autoSize, setAutoSize] = useState("500");
  const [autoErr, setAutoErr] = useState<string | null>(null);
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
      // authHeaders: 토큰이 있으면 실어 보낸다. 이 라우트 자체는 토큰을 요구하지
      // 않고, 브라우저발 CSRF는 미들웨어(lib/originGuard)가 막는다.
      const res = await fetch("/api/listing-auto", { method: "POST", headers: authHeaders(), body: JSON.stringify(p) });
      const j = await res.json();
      if (!res.ok) { setAutoErr(j.message ?? "자동매수 설정 실패"); return; }
      setAutoErr(null);
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
      {autoErr && (
        <div style={{ padding: "6px 14px", borderBottom: "1px solid var(--border)", fontSize: 11, color: "var(--neg)" }}>
          {autoErr}
        </div>
      )}

      {/* 플레이 리스트 */}
      {rows.length === 0 ? (
        <div style={{ padding: "16px 14px", fontSize: 11.5, color: "var(--text-mute)" }}>
          감시 중 — 공지가 뜨면 여기 카드가 생기고 텔레그램(+보유량)이 갑니다.
        </div>
      ) : rows.map((l) => {
        const pos = (l.buys ?? []).reduce((s, b) => s + (b.qty ?? 0), 0) - (l.sells ?? []).reduce((s, b) => s + (b.qty ?? 0), 0);
        const open = selected === l.base;
        return (
          <div key={l.base + l.venue} id={open ? DETAIL_ANCHOR : undefined} style={{ borderBottom: "1px solid var(--border)" }}>
            {/* button이 아니라 role="button" div — 안에 거래소 딥링크 <a>가 들어가는데,
                <button> 안의 <a>는 비허용 중첩이라 브라우저마다 클릭이 오동작한다. */}
            <div
              role="button" tabIndex={0}
              onClick={() => setSelected(open ? null : l.base)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(open ? null : l.base); } }}
              style={{ display: "block", width: "100%", textAlign: "left", background: open ? "var(--card-2)" : "transparent", border: "none", padding: "10px 14px", cursor: "pointer", color: "var(--text)", boxShadow: open ? "inset 2px 0 0 var(--brand)" : undefined }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{l.base}</span>
                {l.drill && <span style={{ fontSize: 9, fontWeight: 700, color: "var(--sky)", border: "1px solid var(--sky)", borderRadius: 9, padding: "0 4px", whiteSpace: "nowrap" }}>드릴</span>}
                <span style={{ fontSize: 9.5, fontWeight: 700, color: "var(--brand-ink)", background: l.opened ? "var(--pos)" : "var(--amber)", borderRadius: 9, padding: "1px 5px", whiteSpace: "nowrap" }}>
                  {l.opened ? "거래개시" : "공지"}
                </span>
                <span style={{ color: "var(--text-mute)", fontSize: 11 }}>
                  {/* 개장 순간 거래소 화면을 바로 열어야 한다 — 행 클릭(상세)과 분리된 링크 */}
                  <VenueLink venue={l.venue} base={l.base} label={l.venue === "upbit" ? "업비트" : "빗썸"} style={{ color: "var(--text-mute)" }} /> · {ago(l.announcedAt)} 전
                </span>
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
            </div>
            {/* 모바일: 인라인 상세 / PC: 우측 패널 */}
            {!wide && open && <DetailPanel base={l.base} />}
          </div>
        );
      })}
      {/* 수동 티커 (모바일 인라인) */}
      {!wide && selected && !rows.some((r) => r.base === selected) && (
        <div id={DETAIL_ANCHOR} style={{ borderBottom: "1px solid var(--border)" }}>
          <div style={{ padding: "9px 14px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 700 }}>{selected}</span>
            <span style={CAP}>수동 조회</span>
            <span style={{ flex: 1 }} />
            <button type="button" style={BTN_GHOST} onClick={() => setSelected(null)}>닫기</button>
          </div>
          <DetailPanel base={selected} />
        </div>
      )}

      {/* 성과 히스토리 — 같은 카드의 접이식 섹션 (기본 펼침) */}
      <div>
        <button
          type="button"
          onClick={() => setHistOpen(!histOpen)}
          style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", background: "transparent", border: "none", padding: "9px 14px", cursor: "pointer", color: "var(--text-dim)" }}
        >
          <span style={{ fontSize: 12, fontWeight: 600 }}>성과 히스토리</span>
          <span style={CAP}>{history.length > 0 ? `${history.length}건 · 공지가→피크` : "공지가→피크"}</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 10, color: "var(--text-mute)" }}>{histOpen ? "▲" : "▼"}</span>
        </button>
        {histOpen && history.length === 0 && (
          // 0건이어도 섹션은 보인다 — 안 보이면 "기록 기능이 없다"로 읽힌다.
          <div style={{ padding: "0 14px 12px", fontSize: 11.5, color: "var(--text-mute)" }}>
            아직 기록 없음 — 감시 중 상장이 지나가면 자동으로 쌓입니다
          </div>
        )}
        {histOpen && history.length > 0 && (
          // 전 건 표시 — 잘라 보여주면 "이게 전부"로 오독한다. 길이는 스크롤이 감당.
          <div style={{ maxHeight: 300, overflowY: "auto" }}>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto auto auto", gap: "4px 12px", padding: "0 14px 12px", fontSize: 11, alignItems: "baseline" }}>
              <span style={CAP}>티커</span><span style={CAP}>공지</span>
              <span style={{ ...CAP, textAlign: "right" }}>피크</span>
              <span style={{ ...CAP, textAlign: "right" }}>도달</span>
              <span style={{ ...CAP, textAlign: "right" }}>실현</span>
              {history.map((h) => (
                <Fragment key={h.base + h.announcedAt}>
                  {/* 지난 상장도 다시 열어본다 — 그때 왜 그 값이 나왔는지 보려면
                      결국 같은 상세 패널이 필요하다. 티커 자체가 그 입구다. */}
                  <button type="button" onClick={() => openDetail(h.base)} title={`${h.base} 상세 열기`}
                    style={{ fontSize: 11, fontWeight: 700, background: "transparent", border: "none", padding: 0, textAlign: "left", cursor: "pointer", color: selected === h.base ? "var(--brand)" : "var(--text)", textDecoration: "underline", textDecorationColor: "var(--border)", textUnderlineOffset: 3 }}>
                    {h.base}
                  </button>
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
          </div>
        )}
      </div>
    </div>
  );

  if (!wide) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingBottom: 40 }}>
        {mainCard}
      </div>
    );
  }

  // ── PC: 목록은 항상 좌측에 산다 — 선택은 우측 상세만 바꾼다 ──
  // 예전엔 선택하면 상세가 전체 화면을 덮고 목록이 접혔다. 이 화면이 제일
  // 중요한 순간은 상장 이벤트 중인데, 그때 한 코인을 실행하느라 새 감지가
  // 안 보이면 다음 기회를 그대로 놓친다. 갭 탭 검사창과 같은 구조로 맞춘다.
  return (
    <div style={{ display: "grid", gridTemplateColumns: "400px minmax(0,1fr)", gap: 14, alignItems: "start", paddingBottom: 40 }}>
      <div style={{ minWidth: 0 }}>{mainCard}</div>
      {selected ? (
        // sticky 금지 — 상세가 화면보다 길어서(차트 440px+표) 걸면 하단이 안 닿는다
        <div key={selected} id={DETAIL_ANCHOR} className="panel-in" style={{ ...CARD, padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--border)" }}>
            <span style={{ fontWeight: 700, fontSize: 15 }}>{selected}</span>
            <span style={CAP}>상세 · 실행</span>
            <span style={{ flex: 1 }} />
            <button type="button" style={BTN_GHOST} onClick={() => setSelected(null)}>닫기</button>
          </div>
          <DetailPanel base={selected} narrow={tight} />
        </div>
      ) : (
        <div style={{ ...CARD, padding: "60px 20px", textAlign: "center", color: "var(--text-mute)", fontSize: 12.5, border: "1px dashed var(--border)" }}>
          좌측에서 티커를 선택하거나 수동 조회로 열면<br />여기에 신호·차트·매수처·포지션이 표시됩니다.
        </div>
      )}
    </div>
  );
}

export default ListingPanel;
