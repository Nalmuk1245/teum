"use client";

// 설정 모달 (헤더 톱니바퀴) — API 키·알림·상장 설정·리스크 한도를 한 곳에.
// 키 원문은 서버가 절대 돌려주지 않는다(설정 여부+끝 4자리만). 저장 즉시
// process.env에 주입되어 재시작 없이 반영. 라이브 모드에선 EXEC_TOKEN 인증.

import React from "react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { RiskCard } from "./ControlPanel";
import { inFlightUsd } from "@/lib/runStore";

type Field = {
  name: string; label: string; group: string; secret: boolean; danger: boolean;
  placeholder?: string; set: boolean; hint: string | null;
};

const INPUT: React.CSSProperties = {
  width: "100%", background: "var(--bg)", border: "1px solid var(--border)",
  borderRadius: 9, color: "var(--text)", padding: "8px 10px", fontSize: 12.5, outline: "none",
};
const BTN_GHOST: React.CSSProperties = {
  border: "1px solid var(--border-strong)", borderRadius: 9, padding: "5px 10px",
  background: "transparent", color: "var(--text-dim)", fontWeight: 600, fontSize: 11, cursor: "pointer",
};

export function SettingsModal({ onClose }: { onClose: () => void }) {
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

  const load = () =>
    fetch("/api/settings", { cache: "no-store" }).then((r) => r.json())
      .then((j) => { setFields(j.fields ?? []); setDryRun(!!j.dryRun); }).catch(() => {});
  useEffect(() => { void load(); }, []);

  const groups = useMemo(() => {
    const m = new Map<string, Field[]>();
    for (const f of fields) { (m.get(f.group) ?? m.set(f.group, []).get(f.group)!).push(f); }
    return [...m.entries()];
  }, [fields]);

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
        {/* 헤더 */}
        <div style={{ position: "sticky", top: 0, zIndex: 1, display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: "1px solid var(--border)", background: "var(--card)", backdropFilter: "blur(18px) saturate(1.4)", WebkitBackdropFilter: "blur(18px) saturate(1.4)" }}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>⚙ 설정</span>
          <span style={{ fontSize: 11, color: dryRun ? "var(--amber)" : "var(--neg)", fontWeight: 600 }}>
            {dryRun ? "모의 모드 (DRY_RUN)" : "라이브 모드"}
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={() => void save()}
            style={{ border: "none", borderRadius: 9, padding: "7px 16px", background: "var(--brand)", color: "var(--brand-ink)", fontWeight: 700, fontSize: 12.5, cursor: "pointer" }}
          >
            {saving ? "저장 중…" : dirty ? `저장 (${Object.keys(draft).length})` : "저장"}
          </button>
          <button type="button" onClick={onClose} style={BTN_GHOST}>✕</button>
        </div>

        <div style={{ padding: "14px 18px 18px" }}>
          {msg && <div style={{ marginBottom: 10, fontSize: 12, fontWeight: 600, color: msg.startsWith("✓") ? "var(--pos)" : "var(--neg)" }}>{msg}</div>}

          {!dryRun && (
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

          {/* 키 그룹들 */}
          {groups.map(([group, fs]) => (
            <div key={group} style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 8px" }}>
                <span style={{ fontSize: 12.5, fontWeight: 700 }}>{group}</span>
                {group === "알림" && (
                  <>
                    <button type="button" style={BTN_GHOST} onClick={() => void tgTest()}>테스트 발송</button>
                    {tgMsg && <span style={{ fontSize: 10.5, color: tgMsg.startsWith("✓") ? "var(--pos)" : "var(--text-mute)" }}>{tgMsg}</span>}
                  </>
                )}
                <span style={{ flex: 1, borderBottom: "1px solid var(--border)" }} />
              </div>
              {group === "개인지갑" && (
                <div style={{ marginBottom: 8, fontSize: 10.5, color: "var(--neg)", lineHeight: 1.5 }}>
                  이 키는 자금을 옮길 수 있습니다. 주력 지갑 말고 <b>이 앱 전용 새 지갑</b>의 키만 넣으세요.
                  로컬 파일(data/secrets.json, 0600)에만 저장되고 절대 커밋되지 않습니다.
                </div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: fs.length > 2 ? "1fr 1fr" : "1fr", gap: "0 14px" }}>
                {fs.map(fieldRow)}
              </div>
            </div>
          ))}

          {/* 리스크 한도 */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 8px" }}>
              <span style={{ fontSize: 12.5, fontWeight: 700 }}>리스크 한도</span>
              <span style={{ flex: 1, borderBottom: "1px solid var(--border)" }} />
            </div>
            <RiskCard inFlight={inFlightUsd()} />
          </div>

          <div style={{ fontSize: 10.5, color: "var(--text-mute)", lineHeight: 1.6 }}>
            · 키는 저장 즉시 반영됩니다 (재시작 불필요). 여기 저장된 값이 .env.local보다 우선.<br />
            · 모의 ↔ 라이브 전환(DRY_RUN)은 안전상 .env.local 수정 + 재시작으로만 가능합니다.
          </div>
        </div>
      </div>
    </div>
  );
}

export default SettingsModal;
