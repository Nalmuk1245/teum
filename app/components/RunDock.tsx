"use client";

// 우하단 실행 독 — 진행 중인 런을 어느 탭에서든 눈 한구석에 걸어둔다.
//
// 실행 상태는 runStore(모달 밖)에 살아서 모달을 닫아도 런은 계속 돈다 —
// 문제는 닫는 순간 진행 상황이 시야에서 사라진다는 것이었다(운영 탭에
// 들어가야만 보임). 실행 중에 가장 하고 싶은 일이 "보드 보면서 다음 기회
// 찾기"인데, 그러려면 돌아가는 런이 시야 구석에 항상 있어야 한다.
// 칩 클릭 = 그 런의 실행 모달 재오픈 (initialRunId 경로).

import React from "react";
import type { RunView } from "@/lib/runStore";
import { usd } from "@/lib/format";

const PHASE: Record<string, { label: string; color: string }> = {
  running: { label: "실행 중", color: "var(--amber)" },
  paused: { label: "확인 대기", color: "var(--brand-2)" },
  error: { label: "오류", color: "var(--neg)" },
};

export function RunDock({ runs, hidden, isMobile, onOpen, onMore }: {
  runs: RunView[];
  /** 실행 모달이 열려 있는 동안엔 숨긴다 — 같은 정보가 두 겹으로 뜬다. */
  hidden?: boolean;
  isMobile?: boolean;
  onOpen: (r: RunView) => void;
  /** 넘친 런 요약 클릭 → 운영 탭. */
  onMore: () => void;
}) {
  const active = runs.filter((r) => r.phase === "running" || r.phase === "paused" || r.phase === "error");
  if (hidden || active.length === 0) return null;
  // 사람 손을 기다리는 상태가 맨 위 — 확인 대기(출금 승인) > 오류 > 실행 중.
  const order: Record<string, number> = { paused: 0, error: 1, running: 2 };
  const sorted = [...active].sort((a, b) => (order[a.phase] ?? 9) - (order[b.phase] ?? 9) || b.startedAt - a.startedAt);
  const shown = sorted.slice(0, 3);
  const extra = sorted.length - shown.length;
  return (
    // 하단 요약바(~46px) 위에 뜬다. z는 모달(50) 아래.
    <div style={{ position: "fixed", right: 14, bottom: isMobile ? 64 : 58, zIndex: 40, display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
      {shown.map((r) => {
        const ph = PHASE[r.phase] ?? PHASE.running;
        const total = r.plan.length;
        const done = r.plan.filter((s) => r.statuses[s.id] === "done").length;
        const cur = r.plan[r.pauseAt] ?? r.plan.find((s) => r.statuses[s.id] === "running") ?? r.plan[done];
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onOpen(r)}
            className={r.phase === "paused" ? "dock-pulse" : undefined}
            title={`${r.base} · ${r.route} — 클릭하면 실행 창이 다시 열립니다`}
            style={{
              width: 232, textAlign: "left", cursor: "pointer",
              background: "var(--card)",
              border: `1px solid ${r.phase === "error" ? "var(--neg)" : r.phase === "paused" ? "var(--brand)" : "var(--border-strong)"}`,
              borderRadius: 12, padding: "9px 12px", boxShadow: "var(--shadow-lg)", color: "var(--text)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ width: 6, height: 6, borderRadius: 6, background: ph.color, boxShadow: `0 0 6px ${ph.color}`, flex: "0 0 auto" }} />
              <span style={{ fontWeight: 700, fontSize: 12.5 }}>{r.base}</span>
              <span className="tnum" style={{ fontSize: 10, color: "var(--text-mute)" }}>{usd(r.sizeUsd)}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 10.5, fontWeight: 700, color: ph.color }}>{ph.label}</span>
            </div>
            <div style={{ display: "flex", height: 4, borderRadius: 6, overflow: "hidden", background: "var(--bg)", marginTop: 7 }}>
              <div style={{ width: `${total ? (done / total) * 100 : 0}%`, background: r.phase === "error" ? "var(--neg)" : "var(--brand)", transition: "width 200ms" }} />
            </div>
            <div className="tnum" style={{ marginTop: 5, fontSize: 10, color: "var(--text-mute)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {done}/{total} · {cur ? cur.label : "—"}
              {r.pnlUsd !== 0 && <span style={{ color: r.pnlUsd >= 0 ? "var(--pos)" : "var(--neg)", marginLeft: 6 }}>실현 {r.pnlUsd >= 0 ? "+" : "−"}${Math.abs(r.pnlUsd).toFixed(2)}</span>}
            </div>
          </button>
        );
      })}
      {extra > 0 && (
        <button type="button" onClick={onMore}
          style={{ border: "1px solid var(--border-strong)", background: "var(--card)", color: "var(--text-dim)", borderRadius: 999, padding: "5px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", boxShadow: "var(--shadow-sm)" }}>
          외 {extra}건 — 운영 탭
        </button>
      )}
    </div>
  );
}

export default RunDock;
