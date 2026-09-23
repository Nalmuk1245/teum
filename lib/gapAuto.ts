// 갭 자동 진입 (서버) — 백테스트로 고른 설정 그대로, 조건을 채운 갭에 런을 띄운다.
//
// 예전엔 브라우저 안에서 돌아 탭을 닫으면 멈췄다(2026-09-21 제거). 이제 스캔이 끝날 때마다
// 서버가 판단한다. 규칙은 백테스트(lib/backtest)의 진입 규칙과 같다:
//   순수익 ≥ minNet 이 minHeldSec 이상 지속 · 순수익 < maxEntryPct(대형 갭 = 입출금 정지·다른 토큰 의심)
// 추가 안전장치: 게이트가 잠김(닫힘·정지 의심)이 아닐 것, 라이브는 확인된 열림일 것, 김프는 헷지 가능(퍼프)할 것,
// 코인당 쿨다운, 동시 실행 상한, 킬 스위치·리스크 한도(엔진이 다시 본다).
//
// 자동화 레벨 기본값은 "출금 전 정지" — 매수·헷지까지 자동, 되돌릴 수 없는 출금은 사람이 누른다.
// "전자동"으로 바꾸면 출금까지 자동. 라이브는 GAP_AUTO_LIVE=true + 켤 때 EXEC_TOKEN.

import type { Opportunity } from "./types";
import { loadSection, flushSection } from "./persist";
import { logEvent } from "./events";
import { notifyNow } from "./telegram";
import { isLocked } from "./gateState";

export type GapAutoCfg = {
  armed: boolean;
  minNet: number; minHeldSec: number; sizeUsd: number;
  kinds: string[]; maxEntryPct: number;
  cooldownMin: number; maxConcurrent: number;
  autoLevel: "beforeWithdraw" | "auto";
};
export const DEFAULT_GAP_AUTO: GapAutoCfg = {
  armed: false, minNet: 0.8, minHeldSec: 60, sizeUsd: 300,
  kinds: ["kimchi", "cross-cex"], maxEntryPct: 10,
  cooldownMin: 30, maxConcurrent: 1, autoLevel: "beforeWithdraw",
};

/** 순수 — 지금 들어갈 기회 하나(순수익 최고) 또는 null + 걸러진 이유 집계. */
export function pickCandidate(args: {
  opps: Opportunity[]; cfg: GapAutoCfg; now: number; dry: boolean;
  lastEntryByBase: Record<string, number>; busyBases: Set<string>;
}): { pick: Opportunity | null; skipped: Record<string, number> } {
  const { opps, cfg, now, dry, lastEntryByBase, busyBases } = args;
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  let pick: Opportunity | null = null;
  for (const o of opps) {
    if (o.mock || !cfg.kinds.includes(o.kind)) continue;
    if (o.netPct < cfg.minNet) continue;
    if (o.netPct >= cfg.maxEntryPct) { skip("대형 갭"); continue; }
    if ((o.persistence?.heldSec ?? 0) < cfg.minHeldSec) { skip("지속 부족"); continue; }
    if (!o.executable) { skip("실행 불가"); continue; }
    if (isLocked(o.gate)) { skip("입출금 잠김"); continue; }
    if (!dry && o.gate !== "open") { skip("입출금 미확인"); continue; }
    if (o.kind === "kimchi" && !o.hasPerp) { skip("헷지 불가"); continue; }
    if (busyBases.has(o.base)) { skip("진행 중"); continue; }
    if (now - (lastEntryByBase[o.base] ?? 0) < cfg.cooldownMin * 60_000) { skip("쿨다운"); continue; }
    if (!pick || o.netPct > pick.netPct) pick = o;
  }
  return { pick, skipped };
}

// ── 상태 ──────────────────────────────────────────────────────────────────────
type State = { cfg: GapAutoCfg; last: Record<string, number>; runIds: string[]; lastSkipped: Record<string, number>; lastTickAt: number };
const g = globalThis as unknown as { __arbGapAuto?: State };
g.__arbGapAuto ??= {
  cfg: { ...DEFAULT_GAP_AUTO, ...(loadSection<Partial<GapAutoCfg>>("gapAuto") ?? {}), armed: false }, // armed는 저장 안 함
  last: loadSection<Record<string, number>>("gapAutoLast") ?? {}, runIds: [], lastSkipped: {}, lastTickAt: 0,
};
const S = g.__arbGapAuto;

export function gapAutoState() { return { cfg: S.cfg, runIds: S.runIds.slice(-10), lastSkipped: S.lastSkipped, lastTickAt: S.lastTickAt }; }
export function setGapAuto(p: Partial<GapAutoCfg>): GapAutoCfg {
  const n = (v: unknown, d: number, min = 0) => (typeof v === "number" && Number.isFinite(v) && v >= min ? v : d);
  S.cfg = {
    armed: typeof p.armed === "boolean" ? p.armed : S.cfg.armed,
    minNet: n(p.minNet, S.cfg.minNet), minHeldSec: n(p.minHeldSec, S.cfg.minHeldSec),
    sizeUsd: n(p.sizeUsd, S.cfg.sizeUsd, 1), maxEntryPct: n(p.maxEntryPct, S.cfg.maxEntryPct, 0.1),
    cooldownMin: n(p.cooldownMin, S.cfg.cooldownMin), maxConcurrent: Math.max(1, Math.round(n(p.maxConcurrent, S.cfg.maxConcurrent, 1))),
    kinds: Array.isArray(p.kinds) ? p.kinds.filter((k) => ["kimchi", "cross-cex", "cex-dex"].includes(k)) : S.cfg.kinds,
    autoLevel: p.autoLevel === "auto" || p.autoLevel === "beforeWithdraw" ? p.autoLevel : S.cfg.autoLevel,
  };
  flushSection("gapAuto", { ...S.cfg, armed: false });
  logEvent("gap_auto.cfg", { ...S.cfg });
  return S.cfg;
}

/** 스캔마다 호출 (scanCache). */
export async function onScan(opps: Opportunity[]): Promise<void> {
  S.lastTickAt = Date.now();
  if (!S.cfg.armed) return;
  const { CONFIG } = await import("./config");
  const { isKilled } = await import("./killswitch");
  if (isKilled()) return;
  if (!CONFIG.DRY_RUN && process.env.GAP_AUTO_LIVE !== "true") return; // 라이브 이중 옵트인
  const eng = await import("./runEngine");
  const runs = eng.snapshot().runs;
  const active = S.runIds.filter((id) => runs[id] && (runs[id].phase === "running" || runs[id].phase === "paused"));
  S.runIds = S.runIds.filter((id) => runs[id]); // 삭제된 런 정리
  if (active.length >= S.cfg.maxConcurrent) return;
  const busy = new Set(Object.values(runs).filter((r) => r.phase === "running" || r.phase === "paused" || r.remaining > 0).map((r) => r.base));
  const { pick, skipped } = pickCandidate({ opps, cfg: S.cfg, now: Date.now(), dry: CONFIG.DRY_RUN, lastEntryByBase: S.last, busyBases: busy });
  S.lastSkipped = skipped;
  if (!pick) return;
  // 규모 — 설정값과 지금 잡을 수 있는 규모(깊이 사다리 > 최우선호가) 중 작은 쪽
  const cap = pick.depth?.maxSizeUsd ?? pick.notionalCapUsd ?? S.cfg.sizeUsd;
  const size = Math.floor(Math.min(S.cfg.sizeUsd, cap));
  if (size < 20) { S.lastSkipped = { ...skipped, "규모 부족": 1 }; return; }
  S.last[pick.base] = Date.now(); // 거부돼도 쿨다운 — 같은 이유로 3초마다 두드리지 않게
  flushSection("gapAutoLast", S.last);
  const res = eng.startRun({ opp: pick, sizeUsd: size, hedge: !!pick.hasPerp, autoLevel: S.cfg.autoLevel });
  logEvent("gap_auto.entry", { base: pick.base, kind: pick.kind, netPct: pick.netPct, heldSec: pick.persistence?.heldSec, size, route: pick.legs.map((l) => l.venue).join("→"), ...("id" in res ? { runId: res.id } : { error: res.error }) });
  if ("id" in res) {
    S.runIds.push(res.id);
    void notifyNow(`🤖 갭 자동 진입 — <b>${pick.base}</b> ${pick.legs.map((l) => l.venue).join("→")} +${pick.netPct.toFixed(2)}% · $${size}${S.cfg.autoLevel === "beforeWithdraw" ? " · 출금 전 정지(승인 필요)" : " · 전자동"}${CONFIG.DRY_RUN ? " (페이퍼)" : ""}`);
  } else {
    void notifyNow(`⚠️ 갭 자동 진입 거부 — <b>${pick.base}</b>: ${res.error}`);
  }
}
