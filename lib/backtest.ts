// 백테스트 — 쌓인 갭 에피소드로 "이 설정이면 얼마 벌었나"를 계산한다.
//
// 에피소드(data/episodes.jsonl*)는 순수익 곡선 [ts, net%, gross%, price]을 갖는다.
// 규칙(실행 엔진과 같은 모양):
//   진입 — 순수익이 minNet 이상인 상태가 minHeldSec 이상 이어진 첫 순간 (조건부 자동 진입과 같다)
//   청산 — 진입 + 전송 ETA 시점의 순수익. 헷지를 걸면 손익 ≈ 도착 시점 프리미엄 − 비용
//          (lib/hedgeCost 주석의 전개: 진입 베이시스는 소거되고 도착 시점 갭이 남는다)
//   규모 — min(설정 규모, 그 에피소드에서 잡을 수 있던 규모: 깊이 사다리 > 최우선호가 한도)
//
// 한계 — 결과 화면에도 적는다:
//   · 도착 시점이 에피소드 끝보다 뒤면 곡선이 없다 → 마지막 기록 순수익으로 추정(estimated).
//     에피소드는 순수익이 0 아래로 꺼져서 끝나므로 이 추정은 대체로 0 근처·음수다(보수적).
//   · 규모 한도는 피크 순간 값이라 진입 순간과 다를 수 있다.
//   · 헷지 없는 코인(퍼프 없음)의 가격 변동은 반영하지 않는다.

import { createReadStream, existsSync, readdirSync, statSync } from "fs";
import { createInterface } from "readline";
import path from "path";

export type BtEpisode = {
  kind: string; base: string; buy: string; sell: string;
  startTs: number; endTs: number;
  curve: [number, number][]; // [ts, net%]
  capUsd: number | null; etaMin: number | null; executable: boolean;
};
export type BtParams = {
  minNet: number; minHeldSec: number; sizeUsd: number;
  kinds: string[]; executableOnly: boolean;
  /** 진입 순수익이 이 % 이상이면 제외 — 입출금 정지나 같은 티커의 다른 토큰일 가능성이 크다.
   *  (전체 기록 기준: 이것 없이 +$2,902 중 +$2,051이 10% 넘는 갭에서 나왔다.) 0 = 제외 안 함. */
  excludeAbovePct?: number;
};
export type BtTrade = {
  base: string; kind: string; route: string; entryTs: number;
  entryNet: number; exitNet: number; sizeUsd: number; profitUsd: number; estimated: boolean;
};
export type BtResult = {
  episodes: number; eligible: number; trades: number; wins: number;
  /** 대형 갭 제외로 빠진 건수 */
  excluded: number;
  totalUsd: number; avgExitNet: number | null; medianExitNet: number | null; avgEntryNet: number | null;
  estimated: number; spanDays: number;
  byKind: Record<string, { trades: number; totalUsd: number; wins: number }>;
  best: BtTrade[]; worst: BtTrade[];
};

const med = (xs: number[]) => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
const r2 = (n: number) => Math.round(n * 100) / 100;

/** 에피소드 하나에 규칙을 적용 — 순수 함수. 진입 조건을 못 채우면 null. */
export function simulateOne(e: BtEpisode, p: BtParams): BtTrade | null {
  const c = e.curve;
  if (!c.length) return null;
  let streakStart: number | null = null;
  let entryIdx = -1;
  for (let i = 0; i < c.length; i++) {
    const [ts, net] = c[i];
    if (net >= p.minNet) {
      if (streakStart == null) streakStart = ts;
      if (ts - streakStart >= p.minHeldSec * 1000) { entryIdx = i; break; }
    } else streakStart = null;
  }
  if (entryIdx < 0) return null;
  const [entryTs, entryNet] = c[entryIdx];
  if (p.excludeAbovePct && entryNet >= p.excludeAbovePct) return null;
  const arrive = entryTs + (e.etaMin ?? 10) * 60_000;
  const after = c.find(([ts]) => ts >= arrive);
  const exitNet = after ? after[1] : c[c.length - 1][1];
  const sizeUsd = Math.max(0, Math.min(p.sizeUsd, e.capUsd ?? p.sizeUsd));
  return {
    base: e.base, kind: e.kind, route: `${e.buy}→${e.sell}`, entryTs,
    entryNet: r2(entryNet), exitNet: r2(exitNet), sizeUsd: r2(sizeUsd),
    profitUsd: r2((sizeUsd * exitNet) / 100), estimated: !after,
  };
}

export function runBacktest(eps: BtEpisode[], p: BtParams): BtResult {
  const pool = eps.filter((e) => p.kinds.includes(e.kind) && (!p.executableOnly || e.executable));
  const trades = pool.map((e) => simulateOne(e, p)).filter((t): t is BtTrade => !!t);
  const excluded = p.excludeAbovePct ? pool.map((e) => simulateOne(e, { ...p, excludeAbovePct: 0 })).filter((t) => t && t.entryNet >= p.excludeAbovePct!).length : 0;
  const byKind: BtResult["byKind"] = {};
  for (const t of trades) {
    const k = (byKind[t.kind] ??= { trades: 0, totalUsd: 0, wins: 0 });
    k.trades++; k.totalUsd = r2(k.totalUsd + t.profitUsd); if (t.profitUsd > 0) k.wins++;
  }
  const exits = trades.map((t) => t.exitNet);
  const sorted = [...trades].sort((a, b) => b.profitUsd - a.profitUsd);
  const ts = eps.map((e) => e.startTs);
  return {
    episodes: eps.length, eligible: pool.length, trades: trades.length, excluded,
    wins: trades.filter((t) => t.profitUsd > 0).length,
    totalUsd: r2(trades.reduce((s, t) => s + t.profitUsd, 0)),
    avgExitNet: exits.length ? r2(exits.reduce((s, x) => s + x, 0) / exits.length) : null,
    medianExitNet: med(exits),
    avgEntryNet: trades.length ? r2(trades.reduce((s, t) => s + t.entryNet, 0) / trades.length) : null,
    estimated: trades.filter((t) => t.estimated).length,
    spanDays: ts.length ? r2((Math.max(...ts) - Math.min(...ts)) / 86_400_000) : 0,
    byKind, best: sorted.slice(0, 8), worst: sorted.slice(-5).reverse(),
  };
}

// ── 로더 — 한 줄씩 읽어 필요한 필드만 남긴다 (파일이 수 MB라 통째 파싱은 1CPU 박스에 무겁다) ──
const DIR = () => path.join(process.cwd(), "data");
type Raw = { kind: string; base: string; buyVenue: string; sellVenue: string; startTs: number; endTs: number; curve: [number, number, ...unknown[]][]; atPeak?: { notionalCapUsd: number | null; etaMin?: number; executable: boolean; depth?: { maxSizeUsd: number } } };
async function readFile(file: string): Promise<BtEpisode[]> {
  const out: BtEpisode[] = [];
  const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as Raw;
      out.push({
        kind: r.kind, base: r.base, buy: r.buyVenue, sell: r.sellVenue, startTs: r.startTs, endTs: r.endTs,
        curve: (r.curve ?? []).map((p) => [p[0], p[1]] as [number, number]),
        capUsd: r.atPeak?.depth?.maxSizeUsd ?? r.atPeak?.notionalCapUsd ?? null,
        etaMin: r.atPeak?.etaMin ?? null, executable: !!r.atPeak?.executable,
      });
    } catch { /* 손상 줄 */ }
  }
  return out;
}
const gc = globalThis as unknown as { __btCache?: Map<string, { mtime: number; eps: BtEpisode[] }> };
gc.__btCache ??= new Map();
/** scope "recent" = 현재 파일만, "all" = 회전된 옛 파일까지. 파일별 mtime 캐시. */
export async function loadEpisodes(scope: "recent" | "all"): Promise<BtEpisode[]> {
  const dir = DIR();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f === "episodes.jsonl" || (scope === "all" && f.startsWith("episodes.jsonl.") && !f.includes(".bak")));
  const out: BtEpisode[] = [];
  for (const f of files) {
    const full = path.join(dir, f);
    const mtime = statSync(full).mtimeMs;
    const hit = gc.__btCache!.get(full);
    if (hit && hit.mtime === mtime) { out.push(...hit.eps); continue; }
    const eps = await readFile(full);
    gc.__btCache!.set(full, { mtime, eps });
    out.push(...eps);
  }
  return out;
}

// ── 상장따리 — "공지 때 사서 N분 뒤 팔았으면" ─────────────────────────────────
export type ListingBt = {
  marks: { min: number; n: number; avgPct: number | null; medianPct: number | null; winRate: number | null }[];
  schema2: number; legacy: number; legacyMedianPeak: number | null;
};
export function listingBacktest(rows: { schema?: number; pctAt?: Record<string, number>; peakPct: number | null }[]): ListingBt {
  const v2 = rows.filter((r) => r.schema === 2);
  const marks = [5, 15, 30, 60].map((m) => {
    const xs = v2.map((r) => r.pctAt?.[String(m)]).filter((x): x is number => x != null);
    return {
      min: m, n: xs.length,
      avgPct: xs.length ? r2(xs.reduce((s, x) => s + x, 0) / xs.length) : null,
      medianPct: med(xs), winRate: xs.length ? Math.round((xs.filter((x) => x > 0).length / xs.length) * 100) : null,
    };
  });
  const legacy = rows.filter((r) => r.schema !== 2);
  return { marks, schema2: v2.length, legacy: legacy.length, legacyMedianPeak: med(legacy.map((r) => r.peakPct).filter((x): x is number => x != null)) };
}

// ── 설정 탐색 — 최소 순수익 × 최소 지속 격자를 전부 돌려 비교 ─────────────────
// "어느 설정이 제일 나았나"를 눈으로 고르게. 과최적화 주의: 격자 최고값은 과거에 맞춘 값이라
// 실전에선 그보다 못하다. 그래서 추천에서 빼는 칸:
//   · 거래 20건 미만 — 우연일 수 있다
//   · 지속 0초 — 한 번 스친 갭에 진입. 기록상으론 돈이 되지만(2026-09 전체 기록 최고 칸) 승률 49%·
//     중앙 청산 +0.01%로, 스캔 지연·호가 소진을 생각하면 실전에서 못 잡는 몫이다
//   · 중앙 청산 순수익 ≤ 0 — 소수 대박이 합계를 끌어올린 설정
export const SWEEP_NETS = [0.3, 0.5, 0.8, 1.0, 1.5, 2.0, 3.0];
export const SWEEP_HELDS = [0, 30, 60, 120, 300];
export type SweepCell = { minNet: number; minHeldSec: number; trades: number; totalUsd: number; winRate: number | null; medianExitNet: number | null; perTradeUsd: number | null };
export function sweep(eps: BtEpisode[], base: Omit<BtParams, "minNet" | "minHeldSec">): { cells: SweepCell[]; best: SweepCell | null } {
  const cells: SweepCell[] = [];
  for (const minNet of SWEEP_NETS) for (const minHeldSec of SWEEP_HELDS) {
    const r = runBacktest(eps, { ...base, minNet, minHeldSec });
    cells.push({
      minNet, minHeldSec, trades: r.trades, totalUsd: r.totalUsd,
      winRate: r.trades ? Math.round((r.wins / r.trades) * 100) : null,
      medianExitNet: r.medianExitNet, perTradeUsd: r.trades ? r2(r.totalUsd / r.trades) : null,
    });
  }
  const eligible = cells.filter((c) => c.trades >= 20 && c.minHeldSec > 0 && (c.medianExitNet ?? 0) > 0);
  const best = eligible.length ? eligible.reduce((a, b) => (b.totalUsd > a.totalUsd ? b : a)) : null;
  return { cells, best };
}
