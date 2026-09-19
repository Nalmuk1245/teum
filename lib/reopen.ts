// 입출금 재개 대응 — 감시·공지·사전 포지션·자동 실행을 한 곳에서.
//
// 재개 갭은 "누가 먼저 코인을 입금시키나"의 싸움이다. 봇은 지갑 상태를 초 단위로
// 보고, 공지의 재개 시각에 맞춰 미리 사 두고, 재개 순간 출금만 누른다. 이 모듈은
// 그 네 가지를 서버 루프에서 한다 (브라우저가 닫혀 있어도 돈다):
//
//   1) 고속 감시  — 잠긴(닫힘·정지 의심) 코인만 골라 5초마다 입출금 상태 확인.
//                  열림이 2회 연속 확인되면 즉시 재스캔·알림·(아래 3/4).
//   2) 재개 공지  — 업비트·빗썸 공지에서 "입출금 재개"와 예정 시각을 추출해 저장.
//                  예정 5분 전부터 감시를 2초로 당긴다.
//   3) 사전 포지션 — 예정 시각 N분 전에 해외 매수+헷지까지 하고 출금 직전에서 멈춘 런을
//                  띄운다(기존 "출금 전 정지" 자동화 레벨). 재개 확인 시 출금을 자동 승인.
//                  예정 시각 + 최대 대기가 지나도 안 열리면 되팔고 헷지를 푼다.
//   4) 자동 실행  — 사전 포지션이 없으면 재개 확인 순간 전자동 런을 띄운다.
//
// 3·4는 돈이 나간다. 기본 꺼짐, 킬스위치·일손실·노출 한도 아래, 라이브에선 EXEC_TOKEN
// 없이는 켤 수 없다(/api/reopen). 순수 판단 함수(pickTargets·parseReopenNotice·
// decideOnOpen)는 테스트로 못 박는다.

import type { Opportunity, TransferStatus, Venue, WalletStatus } from "./types";
import { fetchVenueStatus, routeFor } from "./transfers";
import { getCached } from "./ttlCache";
import { isLocked } from "./gateState";
import { logEvent } from "./events";
import { notifyNow } from "./telegram";
import { loadSection, flushSection } from "./persist";
import { isKilled } from "./killswitch";
import { CONFIG } from "./config";
import { parseOpenTimeKst } from "./listings";

// ── 설정 ──────────────────────────────────────────────────────────────────────
export type ReopenAutoCfg = {
  /** 재개 확인 시 자동 실행 (4단계). 켜져 있어야 3단계도 돈다. */
  armed: boolean;
  sizeUsd: number;
  minNet: number;
  /** 비어 있으면 전 코인. 채우면 그 코인만. */
  whitelist: string[];
  /** 3단계 — 예정 시각이 있는 코인은 미리 매수+헷지 */
  preposition: boolean;
  prepositionLeadMin: number;
  prepositionMaxWaitMin: number;
};
const DEFAULT_CFG: ReopenAutoCfg = {
  armed: false, sizeUsd: 300, minNet: 1.0, whitelist: [],
  preposition: false, prepositionLeadMin: 5, prepositionMaxWaitMin: 30,
};

export const GATE_WATCH_MS = Number(process.env.GATE_WATCH_MS ?? 5000);
export const GATE_WATCH_FAST_MS = Number(process.env.GATE_WATCH_FAST_MS ?? 2000);
const NOTICE_POLL_MS = 30_000;
const PREPOS_TICK_MS = 15_000;
const MAX_TARGETS = 20;
const FAST_WINDOW_MS = 5 * 60_000; // 예정 시각 이 안이면 고속
const CONFIRM_STREAK = 2;           // 열림 N회 연속 확인 뒤에만 발사

export type Target = { id: string; base: string; buyVenue: Venue; sellVenue: Venue; netPct: number; reopenAt?: number };
export type ScheduleEntry = { venue: string; at: number; noticeId: string | number; title: string; seenAt: number };
export type PrepositionEntry = { runId: string; base: string; startedAt: number; reopenAt: number; released?: boolean };
type GateSnap = "open" | "closed" | "unknown";

type State = {
  targets: Map<string, Target>;
  lastGate: Map<string, GateSnap>;
  openStreak: Map<string, number>;
  schedule: Record<string, ScheduleEntry>;
  prepos: Record<string, PrepositionEntry>;
  cfg: ReopenAutoCfg;
  watch: ReturnType<typeof setTimeout> | null;
  notice: ReturnType<typeof setInterval> | null;
  prep: ReturnType<typeof setInterval> | null;
  lastTickAt: number;
  lastIntervalMs: number;
  noticeSeen: Set<string>;
  opps: Opportunity[];
};
const g = globalThis as unknown as { __arbReopen?: State };
g.__arbReopen ??= {
  targets: new Map(), lastGate: new Map(), openStreak: new Map(),
  schedule: loadSection<Record<string, ScheduleEntry>>("reopenSchedule") ?? {},
  prepos: loadSection<Record<string, PrepositionEntry>>("prepos") ?? {},
  cfg: { ...DEFAULT_CFG, ...(loadSection<Partial<ReopenAutoCfg>>("reopenAuto") ?? {}), armed: false }, // armed는 세션마다 직접
  watch: null, notice: null, prep: null, lastTickAt: 0, lastIntervalMs: 0, noticeSeen: new Set(), opps: [],
};
const S = g.__arbReopen;
// 핫리로드 — 이전 타이머 정리
if (S.watch) { clearTimeout(S.watch); S.watch = null; }
if (S.notice) { clearInterval(S.notice); S.notice = null; }
if (S.prep) { clearInterval(S.prep); S.prep = null; }

// ── 순수 함수 ─────────────────────────────────────────────────────────────────

/** 감시 대상 — 잠금(닫힘·정지 의심) + 갭 살아 있음, 순수익 순 상위 MAX_TARGETS. */
export function pickTargets(opps: Opportunity[], schedule: Record<string, ScheduleEntry>, max = MAX_TARGETS): Target[] {
  return opps
    .filter((o) => !o.mock && o.kind === "kimchi" && isLocked(o.gate) && o.netPct > 0)
    .sort((a, b) => b.netPct - a.netPct)
    .slice(0, max)
    .map((o) => {
      const buy = o.legs.find((l) => l.side === "buy")!;
      const sell = o.legs.find((l) => l.side === "sell")!;
      return { id: o.id, base: o.base, buyVenue: buy.venue, sellVenue: sell.venue, netPct: o.netPct, reopenAt: schedule[o.base]?.at };
    });
}

/** 재개 공지 제목/본문 → 코인들 + 예정 시각. 재개가 아니면 null. */
export const REOPEN_RE = /(입출금|입금|출금|네트워크|지갑)[^\n]{0,24}(재개|정상화|정상\s*운영|점검\s*완료|서비스\s*재개)/;
const NOT_REOPEN_RE = /(일시\s*중단|중단\s*안내|지연\s*안내|중단\s*예정)/;
const TICKER_RE = /\(([A-Z0-9]{2,10})\)/g;
export function parseReopenNotice(title: string, body?: string): { bases: string[]; at: number | null } | null {
  if (!REOPEN_RE.test(title)) return null;
  if (NOT_REOPEN_RE.test(title) && !/(재개|정상화)/.test(title)) return null;
  const bases = new Set<string>();
  let m: RegExpExecArray | null;
  TICKER_RE.lastIndex = 0;
  while ((m = TICKER_RE.exec(title))) bases.add(m[1]);
  if (!bases.size) return null;
  const at = parseOpenTimeKst(title) ?? (body ? parseOpenTimeKst(body) : null);
  return { bases: [...bases], at };
}

/** 감시 간격 — 예정 시각이 5분 안인 대상이 있으면 고속. */
export function watchIntervalMs(targets: Iterable<Target>, now = Date.now(), normal = GATE_WATCH_MS, fast = GATE_WATCH_FAST_MS): number {
  for (const t of targets) {
    if (t.reopenAt && t.reopenAt - now <= FAST_WINDOW_MS && now - t.reopenAt <= FAST_WINDOW_MS * 6) return fast;
  }
  return normal;
}

export type OpenDecision =
  | { action: "release"; runId: string }
  | { action: "start"; sizeUsd: number }
  | { action: "none"; reason: string };

/** 열림이 확인됐을 때 무엇을 할지 — 순수 판단. */
export function decideOnOpen(args: {
  base: string; netPct: number; cfg: ReopenAutoCfg; prepos?: PrepositionEntry; killed: boolean; hasOpenPosition: boolean;
}): OpenDecision {
  const { base, netPct, cfg, prepos, killed, hasOpenPosition } = args;
  if (killed) return { action: "none", reason: "킬 스위치 활성" };
  if (prepos && !prepos.released) return { action: "release", runId: prepos.runId };
  if (!cfg.armed) return { action: "none", reason: "자동 실행 꺼짐" };
  if (cfg.whitelist.length && !cfg.whitelist.includes(base)) return { action: "none", reason: "화이트리스트 밖" };
  if (netPct < cfg.minNet) return { action: "none", reason: `순수익 ${netPct.toFixed(2)}% < 최소 ${cfg.minNet}%` };
  if (hasOpenPosition) return { action: "none", reason: "같은 코인 포지션 진행 중" };
  return { action: "start", sizeUsd: cfg.sizeUsd };
}

/** 사전 포지션을 지금 띄울지 — 예정 시각 lead분 전 ~ 예정 시각 사이, 조건 충족. */
export function shouldPreposition(args: {
  base: string; netPct: number; buyGlobal: boolean; cfg: ReopenAutoCfg; reopenAt?: number; now: number; already: boolean; killed: boolean;
}): { ok: true } | { ok: false; reason: string } {
  const { base, netPct, buyGlobal, cfg, reopenAt, now, already, killed } = args;
  if (killed) return { ok: false, reason: "킬 스위치" };
  if (!cfg.armed || !cfg.preposition) return { ok: false, reason: "사전 포지션 꺼짐" };
  if (!reopenAt) return { ok: false, reason: "예정 시각 없음" };
  if (already) return { ok: false, reason: "이미 포지션" };
  if (!buyGlobal) return { ok: false, reason: "역프 방향(국내 매수)은 사전 포지션 대상 아님" };
  if (cfg.whitelist.length && !cfg.whitelist.includes(base)) return { ok: false, reason: "화이트리스트 밖" };
  if (netPct < cfg.minNet) return { ok: false, reason: "순수익 미달" };
  const lead = cfg.prepositionLeadMin * 60_000;
  if (reopenAt - now > lead) return { ok: false, reason: "아직 이름" };
  if (now - reopenAt > cfg.prepositionMaxWaitMin * 60_000) return { ok: false, reason: "예정 시각 한참 지남" };
  return { ok: true };
}

// ── 상태 접근 ─────────────────────────────────────────────────────────────────
export function reopenCfg(): ReopenAutoCfg { return S.cfg; }
export function setReopenCfg(p: Partial<ReopenAutoCfg>): ReopenAutoCfg {
  S.cfg = { ...S.cfg, ...p };
  flushSection("reopenAuto", { ...S.cfg, armed: false }); // armed는 저장하지 않는다
  logEvent("reopen.cfg", { armed: S.cfg.armed, sizeUsd: S.cfg.sizeUsd, minNet: S.cfg.minNet, preposition: S.cfg.preposition });
  return S.cfg;
}
export function reopenSnapshot() {
  return {
    targets: [...S.targets.values()].map((t) => ({ ...t, gate: S.lastGate.get(t.id) ?? null, streak: S.openStreak.get(t.id) ?? 0 })),
    schedule: S.schedule, prepos: S.prepos, cfg: S.cfg,
    watch: { intervalMs: S.lastIntervalMs || GATE_WATCH_MS, lastTickAt: S.lastTickAt },
  };
}
/** 스캔이 끝날 때마다 — 대상 갱신 + 기회에 재개 예정 시각 부착. */
export function updateReopenTargets(opps: Opportunity[]): void {
  S.opps = opps;
  for (const o of opps) {
    const sch = S.schedule[o.base];
    if (sch && !o.mock) o.reopenAt = sch.at;
  }
  const next = new Map<string, Target>();
  for (const t of pickTargets(opps, S.schedule)) next.set(t.id, t);
  for (const id of S.targets.keys()) if (!next.has(id)) { S.lastGate.delete(id); S.openStreak.delete(id); }
  S.targets = next;
}

// ── 1단계: 고속 감시 ──────────────────────────────────────────────────────────
async function watchTick(): Promise<void> {
  S.lastTickAt = Date.now();
  const targets = [...S.targets.values()];
  if (!targets.length) return;
  const venues = new Set<Venue>();
  for (const t of targets) { venues.add(t.buyVenue); venues.add(t.sellVenue); }
  // 필요한 거래소만 조회. 결과는 공유 캐시에도 밀어 넣어 다음 스캔이 같은 사실을 본다.
  const fresh: Partial<Record<Venue, Map<string, WalletStatus>>> = {};
  await Promise.all([...venues].map(async (v) => {
    try { const m = await fetchVenueStatus(v); if (m) fresh[v] = m; } catch { /* 거래소 장애 — 이번 틱은 미확인 */ }
  }));
  const shared = getCached<TransferStatus>("transfers");
  if (shared) for (const [v, m] of Object.entries(fresh) as [Venue, Map<string, WalletStatus>][]) shared.byVenue[v] = m;
  const ts: TransferStatus = { byVenue: { ...(shared?.byVenue ?? {}), ...fresh } };

  for (const t of targets) {
    const r = routeFor(t.base, t.buyVenue, t.sellVenue, ts);
    const gate: GateSnap = r.withdraw === false || r.deposit === false ? "closed"
      : r.withdraw === true && r.deposit === true ? "open" : "unknown";
    const was = S.lastGate.get(t.id);
    S.lastGate.set(t.id, gate);
    const streak = gate === "open" ? (S.openStreak.get(t.id) ?? 0) + 1 : 0;
    S.openStreak.set(t.id, streak);
    if (was !== undefined && was !== gate) {
      logEvent("gate.watch", { base: t.base, id: t.id, from: was, to: gate, netPct: t.netPct, chain: r.label, streak });
    }
    if (gate === "open" && streak === CONFIRM_STREAK) await onConfirmedOpen(t, r.label);
  }
}
function scheduleWatch(): void {
  const ms = watchIntervalMs(S.targets.values());
  S.lastIntervalMs = ms;
  S.watch = setTimeout(() => {
    void watchTick().catch(() => {}).finally(scheduleWatch);
  }, ms);
  S.watch.unref?.();
}

// ── 4단계(+3단계 출금 승인): 열림 확인 시 ───────────────────────────────────
async function onConfirmedOpen(t: Target, chainLabel: string): Promise<void> {
  const { kickScan } = await import("./scanCache");
  kickScan(); // 보드가 바로 🔓로 바뀌고 열림 알림이 나간다
  logEvent("alert.reopen", { base: t.base, id: t.id, netPct: t.netPct, chain: chainLabel, source: "watch" });
  const eng = await import("./runEngine");
  const prepos = S.prepos[t.base];
  const decision = decideOnOpen({
    base: t.base, netPct: t.netPct, cfg: S.cfg, prepos, killed: isKilled(),
    hasOpenPosition: !!Object.values(eng.snapshot().runs).find((r) => r.base === t.base && (r.phase === "running" || r.phase === "paused")),
  });
  logEvent("reopen.decision", { base: t.base, ...decision });
  if (decision.action === "release") {
    eng.confirmRun(decision.runId);
    S.prepos[t.base] = { ...prepos!, released: true };
    flushSection("prepos", S.prepos);
    void notifyNow(`🔓 <b>${t.base}</b> 입출금 열림 확인 — 사전 포지션 출금 승인 (${chainLabel})`);
    return;
  }
  if (decision.action === "start") {
    const opp = S.opps.find((o) => o.id === t.id) ?? S.opps.find((o) => o.base === t.base && o.kind === "kimchi");
    if (!opp) return;
    // 방금 확인한 사실로 게이트를 덮어쓴 사본 — 스캔 스냅샷은 아직 🔒일 수 있다.
    const fresh: Opportunity = {
      ...opp, executable: opp.netPct > 0,
      transfer: opp.transfer ? { ...opp.transfer, blocked: false, withdraw: { ...opp.transfer.withdraw, enabled: true }, deposit: { ...opp.transfer.deposit, enabled: true } } : opp.transfer,
    };
    const res = eng.startRun({ opp: fresh, sizeUsd: decision.sizeUsd, hedge: true, autoLevel: "auto" });
    logEvent("reopen.auto_start", { base: t.base, sizeUsd: decision.sizeUsd, ...("id" in res ? { runId: res.id } : { error: res.error }) });
    void notifyNow("id" in res
      ? `🚀 <b>${t.base}</b> 재개 자동 실행 시작 — $${decision.sizeUsd} · net +${t.netPct.toFixed(2)}%${CONFIG.DRY_RUN ? " (페이퍼)" : ""}`
      : `⚠️ <b>${t.base}</b> 재개 자동 실행 거부 — ${res.error}`);
  }
}

// ── 2단계: 재개 공지 ──────────────────────────────────────────────────────────
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
async function pollUpbit(): Promise<void> {
  // wallet 카테고리가 재개 공지의 자리. 없거나 막히면(비KR IP) 조용히 넘어간다.
  const r = await fetch("https://api-manager.upbit.com/api/v1/announcements?os=web&page=1&per_page=20&category=wallet", {
    headers: { "User-Agent": UA, Accept: "application/json", Referer: "https://upbit.com/service_center/notice" },
    cache: "no-store", signal: AbortSignal.timeout(4000),
  });
  if (!(r.headers.get("content-type") ?? "").includes("json")) return;
  const j = await r.json() as { data?: { notices?: unknown[]; list?: unknown[] } | unknown[] };
  const d = j?.data as { notices?: unknown[]; list?: unknown[] } | unknown[] | undefined;
  const list = (Array.isArray(d) ? d : d?.notices ?? d?.list ?? []) as Array<Record<string, unknown>>;
  for (const x of list) {
    const id = String(x.id ?? ""); const title = String(x.title ?? "");
    if (!id || !title || S.noticeSeen.has(`upbit:${id}`)) continue;
    S.noticeSeen.add(`upbit:${id}`);
    const parsed = parseReopenNotice(title);
    if (!parsed) continue;
    let at = parsed.at;
    if (at == null) {
      try {
        const b = await fetch(`https://api-manager.upbit.com/api/v1/announcements/${id}?os=web`, { headers: { "User-Agent": UA, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(4000) });
        const bj = await b.json() as { data?: { content?: string } };
        at = parseReopenNotice(title, (bj.data?.content ?? "").replace(/<[^>]+>/g, " "))?.at ?? null;
      } catch { /* 본문 없이 */ }
    }
    for (const base of parsed.bases) recordSchedule(base, "upbit", at ?? Date.now(), id, title);
  }
}
async function pollBithumb(): Promise<void> {
  // 빗썸 공지 API는 문서가 얇다 — 실패해도 조용히. 응답 모양은 관대하게 읽는다.
  const url = process.env.BITHUMB_NOTICE_URL || "https://api.bithumb.com/v1/notices?count=20";
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(4000) });
  if (!r.ok) return;
  const j = await r.json() as unknown;
  const list = (Array.isArray(j) ? j : (j as { data?: unknown[] })?.data ?? []) as Array<Record<string, unknown>>;
  for (const x of list) {
    const id = String(x.id ?? x.notice_id ?? x.seq ?? ""); const title = String(x.title ?? "");
    if (!id || !title || S.noticeSeen.has(`bithumb:${id}`)) continue;
    S.noticeSeen.add(`bithumb:${id}`);
    const parsed = parseReopenNotice(title, typeof x.content === "string" ? x.content : undefined);
    if (!parsed) continue;
    for (const base of parsed.bases) recordSchedule(base, "bithumb", parsed.at ?? Date.now(), id, title);
  }
}
function recordSchedule(base: string, venue: string, at: number, noticeId: string, title: string): void {
  const prev = S.schedule[base];
  if (prev && prev.noticeId === noticeId) return;
  S.schedule[base] = { venue, at, noticeId, title, seenAt: Date.now() };
  flushSection("reopenSchedule", S.schedule);
  logEvent("reopen.notice", { base, venue, at, noticeId, title: title.slice(0, 80) });
  void notifyNow(`📢 <b>${base}</b> ${venue} 입출금 재개 공지 — ${new Date(at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}\n${title.slice(0, 80)}`);
}
async function noticeTick(): Promise<void> {
  await Promise.all([pollUpbit().catch(() => {}), pollBithumb().catch(() => {})]);
  // 지난 지 6시간 넘은 예정은 정리
  let changed = false;
  for (const [base, e] of Object.entries(S.schedule)) if (Date.now() - e.at > 6 * 3600_000) { delete S.schedule[base]; changed = true; }
  if (changed) flushSection("reopenSchedule", S.schedule);
}

// ── 3단계: 사전 포지션 ────────────────────────────────────────────────────────
async function prepositionTick(): Promise<void> {
  const eng = await import("./runEngine");
  const now = Date.now();
  // (a) 예정 시각 임박 → 매수+헷지까지 (출금 전 정지)
  for (const [base, sch] of Object.entries(S.schedule)) {
    const opp = S.opps.find((o) => o.base === base && o.kind === "kimchi" && !o.mock && (o.id.endsWith(":locked") || isLocked(o.gate)))
      ?? S.opps.find((o) => o.base === base && o.kind === "kimchi" && !o.mock);
    if (!opp) continue;
    const buyGlobal = opp.legs.find((l) => l.side === "buy")?.quote === "USDT";
    const already = !!S.prepos[base] || !!Object.values(eng.snapshot().runs).find((r) => r.base === base && (r.phase === "running" || r.phase === "paused"));
    const d = shouldPreposition({ base, netPct: opp.netPct, buyGlobal, cfg: S.cfg, reopenAt: sch.at, now, already, killed: isKilled() });
    if (!d.ok) continue;
    const res = eng.startRun({ opp: { ...opp, executable: true }, sizeUsd: S.cfg.sizeUsd, hedge: true, autoLevel: "beforeWithdraw" });
    logEvent("prepos.start", { base, reopenAt: sch.at, sizeUsd: S.cfg.sizeUsd, ...("id" in res ? { runId: res.id } : { error: res.error }) });
    if ("id" in res) {
      S.prepos[base] = { runId: res.id, base, startedAt: now, reopenAt: sch.at };
      flushSection("prepos", S.prepos);
      void notifyNow(`🧷 <b>${base}</b> 사전 포지션 — 재개 예정 ${new Date(sch.at).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul" })} · $${S.cfg.sizeUsd} 매수+헷지, 출금 대기${CONFIG.DRY_RUN ? " (페이퍼)" : ""}`);
    } else {
      void notifyNow(`⚠️ <b>${base}</b> 사전 포지션 거부 — ${res.error}`);
    }
  }
  // (b) 최대 대기 초과 → 되팔고 헷지 해제
  for (const [base, p] of Object.entries(S.prepos)) {
    if (p.released) { if (now - p.reopenAt > 6 * 3600_000) { delete S.prepos[base]; flushSection("prepos", S.prepos); } continue; }
    if (now - p.reopenAt <= S.cfg.prepositionMaxWaitMin * 60_000) continue;
    const run = eng.snapshot().runs[p.runId];
    if (!run) { delete S.prepos[base]; flushSection("prepos", S.prepos); continue; }
    const r = await eng.unwindRun(p.runId, 1);
    logEvent("prepos.abort", { base, runId: p.runId, waitedMin: Math.round((now - p.reopenAt) / 60_000), ...("error" in r ? { error: r.error } : {}) });
    void notifyNow(`↩️ <b>${base}</b> 사전 포지션 철회 — 예정 시각 +${S.cfg.prepositionMaxWaitMin}분 지나도 미개방${"error" in r ? ` · 청산 실패: ${r.error}` : ""}`);
    delete S.prepos[base];
    flushSection("prepos", S.prepos);
  }
}

// ── 부팅 ──────────────────────────────────────────────────────────────────────
export function startReopenLoops(): void {
  if (S.watch) return;
  scheduleWatch();
  S.notice = setInterval(() => { void noticeTick().catch(() => {}); }, NOTICE_POLL_MS);
  S.notice.unref?.();
  S.prep = setInterval(() => { void prepositionTick().catch(() => {}); }, PREPOS_TICK_MS);
  S.prep.unref?.();
  void noticeTick().catch(() => {});
}

// 테스트용 — 상태 초기화
export function _resetReopenForTest(): void {
  S.targets.clear(); S.lastGate.clear(); S.openStreak.clear(); S.schedule = {}; S.prepos = {}; S.cfg = { ...DEFAULT_CFG }; S.opps = [];
}
