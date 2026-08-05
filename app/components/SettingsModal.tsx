"use client";

// 설정 모달 (헤더 톱니바퀴) — 키 · 리스크 · 알림 · 도구 4탭.
// 한 스크롤에 25개 빈 인풋이 늘어서던 것을: 성격별 탭 + 거래소별 아코디언
// (설정 현황 뱃지, 전부 설정/전부 빈 그룹은 접힘)으로 정리.
// 키 원문은 서버가 절대 돌려주지 않는다(설정 여부+끝 4자리만). 저장 즉시
// process.env에 주입되어 재시작 없이 반영. 라이브 모드에선 EXEC_TOKEN 인증
// (상시 노출 대신 저장할 변경이 생겼을 때만 보인다).

import React from "react";
import { useEffect, useMemo, useState } from "react";
import { RiskCard, ManualTokenCard, TelegramCard } from "./ControlPanel";
import { inFlightUsd } from "@/lib/runStore";

type Field = {
  name: string; label: string; group: string; secret: boolean; danger: boolean;
  placeholder?: string; set: boolean; hint: string | null;
};

export type SettingsTab = "keys" | "risk" | "alerts" | "tools";

const INPUT: React.CSSProperties = {
  width: "100%", background: "var(--bg)", border: "1px solid var(--border)",
  borderRadius: 9, color: "var(--text)", padding: "8px 10px", fontSize: 12.5, outline: "none",
};
const BTN_GHOST: React.CSSProperties = {
  border: "1px solid var(--border-strong)", borderRadius: 9, padding: "5px 10px",
  background: "transparent", color: "var(--text-dim)", fontWeight: 600, fontSize: 11, cursor: "pointer",
};

// 거래소 그룹(11필드)을 벤더별 아코디언으로 쪼개기 위한 매핑.
const VENUE_SECTIONS: { key: string; title: string; match: (f: Field) => boolean }[] = [
  { key: "binance", title: "Binance", match: (f) => f.name.startsWith("BINANCE_") },
  { key: "upbit", title: "Upbit", match: (f) => f.name.startsWith("UPBIT_") },
  { key: "bithumb", title: "Bithumb", match: (f) => f.name.startsWith("BITHUMB_") },
  { key: "bybit", title: "Bybit", match: (f) => f.name.startsWith("BYBIT_") },
  { key: "okx", title: "OKX", match: (f) => f.name.startsWith("OKX_") && !f.name.startsWith("OKX_WEB3_") },
];

export function SettingsModal({ onClose, initialTab }: { onClose: () => void; initialTab?: SettingsTab }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? "keys");
  const [fields, setFields] = useState<Field[]>([]);
  const [dryRun, setDryRun] = useState(true);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [authToken, setAuthToken] = useState("");
  // 라이브 실행 인증 토큰은 실행 미러(runStore)도 써야 해서 localStorage에 동기화.
  useEffect(() => {
    try { const t = localStorage.getItem("ac.execToken"); if (t && !authToken) setAuthToken(t); } catch { /* private */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    try { if (authToken) localStorage.setItem("ac.execToken", authToken); } catch { /* private */ }
  }, [authToken]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [tgMsg, setTgMsg] = useState<string | null>(null);
  // 아코디언 수동 토글 (열림 기본값은 아래 defaultOpen이 정한다)
  const [openSec, setOpenSec] = useState<Record<string, boolean>>({});

  const [loading, setLoading] = useState(true);
  const load = () => {
    setLoading(true);
    return fetch("/api/settings", { cache: "no-store" }).then((r) => r.json())
      .then((j) => { setFields(j.fields ?? []); setDryRun(!!j.dryRun); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };
  useEffect(() => { void load(); }, []);

  const dirty = Object.keys(draft).length > 0;
  const save = async () => {
    if (!dirty) return;
    setSaving(true); setMsg(null);
    try {
      const j = await (await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json", ...(authToken ? { "x-exec-token": authToken } : {}) },
        body: JSON.stringify({ secrets: draft }),
      })).json();
      if (j.ok) {
        setMsg(`✓ 저장됨 (${(j.saved ?? []).length}건${j.cleared?.length ? ` · 삭제 ${j.cleared.length}건` : ""}) — 즉시 반영`);
        setDraft({});
        setFields(j.fields ?? []);
      } else setMsg(`✗ ${j.message ?? "저장 실패"}`);
    } catch { setMsg("✗ 요청 실패"); }
    finally { setSaving(false); }
  };

  const tgTest = async () => {
    setTgMsg("발송 중…");
    try {
      const j = await (await fetch("/api/telegram-test", { method: "POST" })).json();
      setTgMsg(j.ok ? "✓ 발송됨 — 폰 확인" : `✗ ${j.message ?? "실패 (토큰/챗ID 확인)"}`);
    } catch { setTgMsg("✗ 요청 실패"); }
  };

  const fieldRow = (f: Field) => (
    <div key={f.name} style={{ marginBottom: 9 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 7, marginBottom: 3 }}>
        <span style={{ fontSize: 11.5, color: f.danger ? "var(--neg)" : "var(--text-dim)", fontWeight: 600 }}>
          {f.danger ? "⚠ " : ""}{f.label}
        </span>
        {f.set && (
          <>
            <span className="tnum" style={{ fontSize: 10, color: "var(--pos)" }}>설정됨 {f.hint}</span>
            <button
              type="button"
              onClick={() => setDraft((d) => ({ ...d, [f.name]: "" }))}
              title="저장된 값 삭제"
              style={{ background: "none", border: "none", color: "var(--text-mute)", fontSize: 10, cursor: "pointer", padding: 0 }}
            >
              삭제
            </button>
          </>
        )}
        {draft[f.name] === "" && <span style={{ fontSize: 10, color: "var(--neg)" }}>저장 시 삭제됨</span>}
      </div>
      <input
        type={f.secret ? "password" : "text"}
        autoComplete="off"
        value={draft[f.name] ?? ""}
        onChange={(e) => setDraft((d) => ({ ...d, [f.name]: e.target.value }))}
        placeholder={f.set ? "새 값 입력 시 교체" : f.placeholder ?? ""}
        style={INPUT}
      />
    </div>
  );

  // ── 아코디언 섹션 — 뱃지(설정 n/m) + 접힘 기본값 ─────────────────────────────
  // 기본 열림 = 일부만 설정된 그룹(마저 채우라는 뜻) 또는 지금 편집 중인 그룹.
  // 전부 설정(끝난 그룹)·전부 빈 그룹(당장 안 쓰는 그룹)은 접어서 소음을 없앤다.
  const section = (key: string, title: string, fs: Field[], warn?: React.ReactNode) => {
    if (!fs.length) return null;
    const setN = fs.filter((f) => f.set).length;
    const editing = fs.some((f) => draft[f.name] !== undefined);
    const defaultOpen = (setN > 0 && setN < fs.length) || editing;
    const open = openSec[key] ?? defaultOpen;
    const done = setN === fs.length;
    return (
      <div key={key} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", marginBottom: 8, overflow: "hidden" }}>
        <button
          type="button"
          onClick={() => setOpenSec((s) => ({ ...s, [key]: !open }))}
          style={{
            width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "9px 12px",
            border: "none", background: open ? "var(--card-2)" : "transparent", cursor: "pointer", color: "var(--text)",
          }}
        >
          <span style={{ fontSize: 12.5, fontWeight: 700 }}>{title}</span>
          <span className="tnum" style={{
            fontSize: 10, fontWeight: 700, borderRadius: 999, padding: "1px 7px",
            background: done ? "var(--pos-soft)" : "var(--card-3)",
            color: done ? "var(--pos)" : setN > 0 ? "var(--amber)" : "var(--text-mute)",
          }}>
            {setN}/{fs.length}{done ? " ✓" : ""}
          </span>
          {editing && <span style={{ fontSize: 9.5, color: "var(--amber)", fontWeight: 700 }}>편집 중</span>}
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 10, color: "var(--text-mute)" }}>{open ? "▲" : "▼"}</span>
        </button>
        {open && (
          <div style={{ padding: "10px 12px 4px", borderTop: "1px solid var(--border)" }}>
            {warn}
            <div style={{ display: "grid", gridTemplateColumns: fs.length > 2 ? "1fr 1fr" : "1fr", gap: "0 14px" }}>
              {fs.map(fieldRow)}
            </div>
          </div>
        )}
      </div>
    );
  };

  const byGroup = useMemo(() => {
    const m = new Map<string, Field[]>();
    for (const f of fields) { (m.get(f.group) ?? m.set(f.group, []).get(f.group)!).push(f); }
    return m;
  }, [fields]);
  const exchange = byGroup.get("거래소") ?? [];

  const secHd = (title: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 8px" }}>
      <span style={{ fontSize: 12.5, fontWeight: 700 }}>{title}</span>
      <span style={{ flex: 1, borderBottom: "1px solid var(--border)" }} />
    </div>
  );

  const TABS: { key: SettingsTab; label: string }[] = [
    { key: "keys", label: "키" },
    { key: "risk", label: "리스크" },
    { key: "alerts", label: "알림" },
    { key: "tools", label: "도구" },
  ];

  return (
    <div
      onClick={onClose}
      className="overlay-in"
      style={{
        position: "fixed", inset: 0, zIndex: 60,
        background: "rgba(6,8,13,0.6)", backdropFilter: "blur(4px)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="panel-in"
        style={{
          width: 620, maxWidth: "100%", maxHeight: "90dvh", overflowY: "auto",
          background: "var(--card)", backdropFilter: "blur(18px) saturate(1.4)", WebkitBackdropFilter: "blur(18px) saturate(1.4)", border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius)", boxShadow: "var(--shadow-lg)",
        }}
      >
        {/* 헤더 + 탭 */}
        <div style={{ position: "sticky", top: 0, zIndex: 1, background: "var(--card)", backdropFilter: "blur(18px) saturate(1.4)", WebkitBackdropFilter: "blur(18px) saturate(1.4)", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px 8px" }}>
            <span style={{ fontWeight: 700, fontSize: 15 }}>⚙ 설정</span>
            <span style={{ fontSize: 11, color: dryRun ? "var(--amber)" : "var(--neg)", fontWeight: 600 }}>
              {dryRun ? "모의 모드 (DRY_RUN)" : "라이브 모드"}
            </span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              disabled={!dirty || saving}
              onClick={() => void save()}
              style={{ border: "none", borderRadius: 9, padding: "7px 16px", background: dirty ? "var(--brand)" : "var(--card-3)", color: dirty ? "var(--brand-ink)" : "var(--text-mute)", fontWeight: 700, fontSize: 12.5, cursor: dirty ? "pointer" : "default" }}
            >
              {saving ? "저장 중…" : dirty ? `저장 (${Object.keys(draft).length})` : "저장"}
            </button>
            <button type="button" onClick={onClose} style={BTN_GHOST}>✕</button>
          </div>
          <div style={{ display: "flex", gap: 4, padding: "0 14px 10px" }}>
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                style={{
                  border: "none", borderRadius: 999, padding: "5px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer",
                  background: tab === t.key ? "var(--brand-soft)" : "transparent",
                  color: tab === t.key ? "var(--brand-2)" : "var(--text-mute)",
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ padding: "14px 18px 18px" }}>
          {msg && <div style={{ marginBottom: 10, fontSize: 12, fontWeight: 600, color: msg.startsWith("✓") ? "var(--pos)" : "var(--neg)" }}>{msg}</div>}

          {/* 라이브 모드 인증 — 저장할 변경이 생겼을 때만 (상시 노출은 소음) */}
          {!dryRun && dirty && (
            <div style={{ marginBottom: 12, padding: "9px 12px", borderRadius: 9, background: "var(--neg-soft)", fontSize: 11.5, color: "var(--text-dim)" }}>
              라이브 모드 — 저장하려면 EXEC_TOKEN 입력:
              <input
                type="password"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                style={{ ...INPUT, marginTop: 6 }}
                placeholder="EXEC_TOKEN"
              />
            </div>
          )}

          {/* 로딩 스켈레톤 — fields fetch 전 빈 화면 대신 (dev 첫 컴파일 체감 개선) */}
          {loading && fields.length === 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[0, 1, 2].map((g) => (
                <div key={g} style={{ height: 38, borderRadius: 8, background: "var(--card-2)", opacity: 0.5 }} />
              ))}
              <div style={{ fontSize: 11, color: "var(--text-mute)", textAlign: "center", marginTop: 4 }}>설정 불러오는 중…</div>
            </div>
          )}

          {/* ── 키 탭: 거래소별 아코디언 + DEX + 개인지갑 ── */}
          {tab === "keys" && !loading && (
            <>
              {VENUE_SECTIONS.map((v) => section(v.key, v.title, exchange.filter(v.match)))}
              {section("dex", "DEX (OKX Web3)", byGroup.get("DEX (OKX Web3)") ?? [])}
              {section("wallet", "개인지갑", byGroup.get("개인지갑") ?? [], (
                <div style={{ marginBottom: 8, fontSize: 10.5, color: "var(--neg)", lineHeight: 1.5 }}>
                  이 키는 자금을 옮길 수 있습니다. 주력 지갑 말고 <b>이 앱 전용 새 지갑</b>의 키만 넣으세요.
                  로컬 파일(data/secrets.json, 0600)에만 저장되고 절대 커밋되지 않습니다.
                </div>
              ))}
              <div style={{ marginTop: 10, fontSize: 10.5, color: "var(--text-mute)", lineHeight: 1.6 }}>
                · 키는 저장 즉시 반영됩니다 (재시작 불필요). 여기 저장된 값이 .env.local보다 우선.<br />
                · 모의 ↔ 라이브 전환(DRY_RUN)은 안전상 .env.local 수정 + 재시작으로만 가능합니다.
              </div>
            </>
          )}

          {/* ── 리스크 탭 ── */}
          {tab === "risk" && (
            <>
              {secHd("리스크 한도")}
              <RiskCard inFlight={inFlightUsd()} />
            </>
          )}

          {/* ── 알림 탭: TG 키 + 테스트 + 채널 상태를 한 곳에 ── */}
          {tab === "alerts" && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 8px" }}>
                <span style={{ fontSize: 12.5, fontWeight: 700 }}>텔레그램 연결</span>
                <button type="button" style={BTN_GHOST} onClick={() => void tgTest()}>테스트 발송</button>
                {tgMsg && <span style={{ fontSize: 10.5, color: tgMsg.startsWith("✓") ? "var(--pos)" : "var(--text-mute)" }}>{tgMsg}</span>}
                <span style={{ flex: 1, borderBottom: "1px solid var(--border)" }} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 14px", marginBottom: 12 }}>
                {(byGroup.get("알림") ?? []).map(fieldRow)}
              </div>
              {secHd("감지 채널")}
              <TelegramCard />
            </>
          )}

          {/* ── 도구 탭: 상장따리 설정 + 수동 컨트랙트 ── */}
          {tab === "tools" && (
            <>
              {secHd("상장따리")}
              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "0 14px", marginBottom: 12 }}>
                {(byGroup.get("상장따리") ?? []).map(fieldRow)}
              </div>
              {secHd("수동 컨트랙트 등록")}
              <ManualTokenCard />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default SettingsModal;
