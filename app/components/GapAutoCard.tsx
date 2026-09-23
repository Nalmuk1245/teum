"use client";

import { useEffect, useState } from "react";

// 갭 자동 진입 (서버) — 운영 탭. 켜기/끄기 + 설정 + "백테스트 추천값" 불러오기.
type Cfg = { armed: boolean; minNet: number; minHeldSec: number; sizeUsd: number; kinds: string[]; maxEntryPct: number; cooldownMin: number; maxConcurrent: number; autoLevel: "beforeWithdraw" | "auto" };
type Snap = { cfg: Cfg; runIds: string[]; lastSkipped: Record<string, number>; lastTickAt: number; liveEnabled: boolean; dryRun: boolean };
const KIND_LABEL: Record<string, string> = { kimchi: "김프", "cross-cex": "거래소간", "cex-dex": "CEX-DEX" };

export function GapAutoCard({ killed }: { killed: boolean }) {
  const [snap, setSnap] = useState<Snap | null>(null);
  const [draft, setDraft] = useState<Cfg | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [showCfg, setShowCfg] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => fetch("/api/gap-auto", { cache: "no-store" }).then((r) => r.json()).then((j: Snap) => { setSnap(j); setDraft((d) => d ?? j.cfg); }).catch(() => {});
  useEffect(() => { load(); const id = setInterval(load, 5000); return () => clearInterval(id); }, []);
  useEffect(() => { if (!confirming) return; const id = setTimeout(() => setConfirming(false), 4000); return () => clearTimeout(id); }, [confirming]);
  const save = async (p: Partial<Cfg>) => {
    setMsg(null);
    const token = typeof window !== "undefined" ? (window.localStorage.getItem("ac.execToken") ?? "") : "";
    const r = await fetch("/api/gap-auto", { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-exec-token": token } : {}) }, body: JSON.stringify(p) });
    const j = await r.json();
    if (j.error) { setMsg(j.error); return; }
    setDraft(j.cfg); load();
  };
  const loadBest = async () => {
    setMsg("백테스트 탐색 중…");
    try {
      const kinds = (draft?.kinds ?? ["kimchi", "cross-cex"]).join(",");
      const j = await fetch(`/api/backtest?scope=all&sweep=1&exec=1&kinds=${kinds}&size=${draft?.sizeUsd ?? 300}&maxEntry=${draft?.maxEntryPct ?? 10}`, { cache: "no-store" }).then((r) => r.json());
      const b = j.sweep?.best;
      if (!b) { setMsg("추천할 설정 없음 (20건↑·지속 30초↑·중앙 청산 + 조건)"); return; }
      await save({ minNet: b.minNet, minHeldSec: b.minHeldSec });
      setMsg(`추천 적용 — 최소 ${b.minNet}% · ${b.minHeldSec}초 지속 (과거 ${b.trades}건 $${b.totalUsd})`);
    } catch { setMsg("백테스트 실패"); }
  };
  const armed = snap?.cfg.armed ?? false;
  const blockedLive = snap && !snap.dryRun && !snap.liveEnabled;
  const toggleArm = () => {
    if (!snap) return;
    if (armed) { void save({ armed: false }); setConfirming(false); return; }
    if (!confirming) { setConfirming(true); return; }
    setConfirming(false); void save({ armed: true });
  };
  const num = (v: string) => Number(v.replace(/[^\d.]/g, "")) || 0;
  const field = (label: string, key: "sizeUsd" | "minNet" | "minHeldSec" | "maxEntryPct" | "cooldownMin" | "maxConcurrent", suffix: string) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
      <span style={{ fontSize: 10.5, color: "var(--text-mute)" }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 4, border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", background: "var(--bg)", minWidth: 0 }}>
        <input className="tnum" inputMode="decimal" value={String(draft?.[key] ?? "")} disabled={armed}
          onChange={(e) => setDraft((d) => (d ? { ...d, [key]: num(e.target.value) } : d))}
          onBlur={() => draft && void save({ [key]: draft[key] })}
          style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", color: "var(--text)", fontSize: 13, outline: "none" }} />
        <span style={{ color: "var(--text-mute)", fontSize: 11 }}>{suffix}</span>
      </div>
    </label>
  );
  const chip = (on: boolean, label: string, onClick: () => void) => (
    <button type="button" disabled={armed} onClick={onClick}
      style={{ border: `1px solid ${on ? "var(--brand-2)" : "var(--border)"}`, borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", background: on ? "color-mix(in srgb, var(--brand-2) 14%, transparent)" : "transparent", color: on ? "var(--brand-2)" : "var(--text-dim)" }}>{label}</button>
  );
  const skipped = Object.entries(snap?.lastSkipped ?? {});
  const c = snap?.cfg;
  return (
    <div style={{ background: armed ? "color-mix(in srgb, var(--amber) 12%, transparent)" : "var(--card)", border: `1px solid ${armed ? "var(--amber)" : "var(--border)"}`, borderRadius: "var(--radius)", padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>갭 자동 진입</span>
        <span style={{ width: 6, height: 6, borderRadius: 6, background: armed ? "var(--amber)" : "var(--text-mute)" }} />
        <span style={{ fontSize: 11, fontWeight: armed ? 700 : 400, color: armed ? "var(--amber)" : "var(--text-mute)" }}>{armed ? `켜짐${snap?.dryRun ? " (페이퍼)" : ""}` : "꺼짐"}</span>
        <span style={{ flex: 1 }} />
        {confirming && !armed && <span style={{ fontSize: 11, color: "var(--amber)", fontWeight: 600 }}>조건 맞으면 무인 매수 — 한 번 더</span>}
        <button type="button" disabled={killed || !snap || (!armed && !!blockedLive)} onClick={toggleArm}
          title={blockedLive ? "라이브는 서버에 GAP_AUTO_LIVE=true 필요" : undefined}
          style={{ borderRadius: "var(--radius-sm)", padding: "7px 14px", fontWeight: 800, fontSize: 12, cursor: "pointer",
            border: `1px solid ${armed ? "var(--border-strong)" : "var(--amber)"}`,
            background: armed ? "transparent" : confirming ? "var(--amber)" : "color-mix(in srgb, var(--amber) 16%, transparent)",
            color: armed ? "var(--text)" : confirming ? "var(--brand-ink)" : "var(--amber)" }}>
          {armed ? "끄기" : confirming ? "확인 · 켜기" : "켜기"}
        </button>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-mute)", marginTop: 6, lineHeight: 1.5 }}>
        스캔마다 서버가 판단 — 순수익 {c?.minNet ?? "-"}% 이상이 {c?.minHeldSec ?? "-"}초 지속된 갭 중 최고 하나에 진입.
        {" "}{c?.autoLevel === "auto" ? "출금까지 전자동." : "매수·헷지까지 자동, 출금은 승인 대기."}
        {armed && snap?.lastTickAt ? ` 마지막 판단 ${Math.max(0, Math.round((Date.now() - snap.lastTickAt) / 1000))}초 전.` : ""}
        {blockedLive ? " 라이브 차단 중 (GAP_AUTO_LIVE 미설정)." : ""}
      </div>
      {armed && skipped.length > 0 && (
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>직전 스캔에서 거른 것: {skipped.map(([k, v]) => `${k} ${v}`).join(" · ")}</div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 11.5, color: "var(--text-dim)" }}>
        <span className="tnum">${c?.sizeUsd ?? "-"} · {c?.kinds.map((k) => KIND_LABEL[k] ?? k).join("/") ?? "-"} · 동시 {c?.maxConcurrent ?? "-"} · 쿨다운 {c?.cooldownMin ?? "-"}분</span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => setShowCfg((v) => !v)}
          style={{ border: "none", background: "transparent", color: "var(--brand-2)", fontSize: 11.5, fontWeight: 600, cursor: "pointer", padding: 0 }}>{showCfg ? "설정 접기" : "설정"}</button>
      </div>
      {showCfg && (<>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 8, marginTop: 10 }}>
          {field("규모", "sizeUsd", "$")}
          {field("최소 순수익", "minNet", "%")}
          {field("최소 지속", "minHeldSec", "초")}
          {field("대형 갭 제외", "maxEntryPct", "% 이상")}
          {field("코인당 쿨다운", "cooldownMin", "분")}
          {field("동시 실행", "maxConcurrent", "개")}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 10 }}>
          <span style={{ fontSize: 10.5, color: "var(--text-mute)", marginRight: 2 }}>전략</span>
          {["kimchi", "cross-cex", "cex-dex"].map((k) => chip(!!draft?.kinds.includes(k), KIND_LABEL[k], () => {
            const kinds = draft?.kinds.includes(k) ? draft.kinds.filter((x) => x !== k) : [...(draft?.kinds ?? []), k];
            void save({ kinds });
          }))}
          <span style={{ fontSize: 10.5, color: "var(--text-mute)", margin: "0 2px 0 8px" }}>자동화</span>
          {chip(draft?.autoLevel === "beforeWithdraw", "출금 전 정지", () => void save({ autoLevel: "beforeWithdraw" }))}
          {chip(draft?.autoLevel === "auto", "전자동", () => void save({ autoLevel: "auto" }))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
          <button type="button" disabled={armed} onClick={() => void loadBest()}
            style={{ border: "1px solid var(--border-strong)", borderRadius: 6, padding: "5px 10px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", background: "transparent", color: "var(--text)" }}>백테스트 추천값 불러오기</button>
          <span style={{ fontSize: 10.5, color: "var(--text-mute)" }}>전체 기록 · 실행 가능 · 20건↑·지속 30초↑·중앙 청산 + 중 합계 최고</span>
        </div>
      </>)}
      {msg && <div style={{ fontSize: 11.5, color: msg.startsWith("추천") ? "var(--text-dim)" : "var(--amber)", marginTop: 8 }}>{msg}</div>}
    </div>
  );
}
