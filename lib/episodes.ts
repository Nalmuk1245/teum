// 기회 에피소드 — "한 기회가 임계 위에 살아 있던 연속 구간"의 영구 기록 (복기용).
//
// 기존 기록의 빈 곳을 메꾼다: history(30분 창)는 지속성 점수용이라 곧 잊고,
// trades.jsonl은 실행한 것만 남는다. "어제 그 2% 김프가 얼마나 지속됐고 왜 못
// 먹었나"는 어디에도 없었다.
//
// 틱 전체가 아니라 에피소드 단위로 저장하는 이유: 3초 × 50기회 = 하루 ~150만
// 셀 — 저장은 되지만 SQLite 전환 임계(쓰기 빈도)를 바로 넘고, 복기할 땐 결국
// 이 형태로 뭉쳐 보게 된다. 처음부터 복기의 자연 단위로 적는다.
// 하루 수십 건 × ~2KB → JSONL + 로테이션이면 충분하다 (trades.jsonl과 동일 패턴).

import { promises as fs, existsSync, mkdirSync, statSync, renameSync } from "fs";
import path from "path";
import type { Opportunity } from "./types";

const DIR = path.join(process.cwd(), "data");
const FILE = path.join(DIR, "episodes.jsonl");
const ROTATE_BYTES = 4 * 1024 * 1024;

// 시작 임계: 비용 차감 후 흑자였던 기회 전부 (executable 여부 무관 — "왜 못
// 먹었나"가 복기의 핵심이라 막힌 기회도 담는다). env로 조절.
const MIN_NET_PCT = Number(process.env.EPISODE_MIN_NET_PCT ?? 0);
// 종료: 연속 이 횟수만큼 임계 미달이면 닫는다 (틱 3초 × 10 = 30초 유예 —
// 스프레드가 한 틱 출렁인 걸 에피소드 끝으로 오인하지 않게).
const CLOSE_TICKS = 10;
// 기록 가치 하한: 한두 틱 반짝(호가 노이즈)은 버린다. 지속 9초+ 또는 피크 0.5%+.
const MIN_DURATION_SEC = 9;
const MIN_KEEP_PEAK_PCT = 0.5;
// 곡선 다운샘플 상한 — 넘으면 반으로 솎는다(첫/끝 보존). 해상도는 절반이 되지만
// 모양은 남는다 — 복기가 원하는 건 모양이다.
const MAX_POINTS = 120;

/** [ts, netPct, grossPct, priceUsd] */
export type EpisodePoint = [number, number, number, number];

export type Episode = {
  id: string;            // opp id (kimchi:XRP 등)
  base: string;
  kind: string;
  buyVenue: string;
  sellVenue: string;
  startTs: number;
  endTs: number;
  durationSec: number;
  peakNetPct: number;
  peakTs: number;
  avgNetPct: number;
  endReason: "decayed" | "vanished";
  curve: EpisodePoint[];
  /** 피크 순간의 판단 맥락 — "그때 먹을 수 있었나, 아니면 왜 막혔나". */
  atPeak: {
    costPct: number;
    notionalCapUsd: number | null;
    executable: boolean;
    blockReason?: string;
    etaMin?: number;
    hedgeCostPct?: number;
  };
  /** 에피소드 중 실행이 시작됐으면 연결. */
  executed?: { runId: string; dry: boolean; ts: number };
};

type Active = {
  ep: Episode;
  belowCount: number;
  sumNet: number;
  samples: number;
};

const g = globalThis as unknown as { __arbEpisodes?: Map<string, Active> };
g.__arbEpisodes ??= new Map();
const ACTIVE = g.__arbEpisodes;

function blockReasonOf(o: Opportunity): string | undefined {
  if (o.executable) return undefined;
  if (o.transfer?.blocked) return "입출금 중단";
  if (o.transfer && (o.transfer.withdraw.enabled == null || o.transfer.deposit.enabled == null)) return "게이트 미확인 (키 필요)";
  if (o.unverified) return "컨트랙트 미검증";
  if (o.netPct <= 0) return "순수익 ≤ 0";
  return "실행 불가 (기타)";
}

function snapshotPeak(o: Opportunity): Episode["atPeak"] {
  return {
    costPct: Math.round(o.costPct * 1000) / 1000,
    notionalCapUsd: o.notionalCapUsd,
    executable: o.executable,
    blockReason: blockReasonOf(o),
    etaMin: o.transfer?.etaMin,
    hedgeCostPct: o.hedge ? Math.round(o.hedge.totalPct * 1000) / 1000 : undefined,
  };
}

function thin(curve: EpisodePoint[]): EpisodePoint[] {
  // 반으로 솎기 — 짝수 인덱스만 남기되 마지막 점은 보존.
  const out: EpisodePoint[] = [];
  for (let i = 0; i < curve.length; i += 2) out.push(curve[i]);
  if (out[out.length - 1] !== curve[curve.length - 1]) out.push(curve[curve.length - 1]);
  return out;
}

async function rotateIfLarge(): Promise<void> {
  try {
    if (!existsSync(FILE)) return;
    if (statSync(FILE).size < ROTATE_BYTES) return;
    renameSync(FILE, `${FILE}.${new Date().toISOString().slice(0, 10)}`);
  } catch { /* best-effort */ }
}

async function append(ep: Episode): Promise<void> {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    await rotateIfLarge();
    await fs.appendFile(FILE, JSON.stringify(ep) + "\n", "utf8");
  } catch { /* 기록 실패가 스캔을 깨면 안 된다 */ }
}

function close(a: Active, endReason: Episode["endReason"]): void {
  const ep = a.ep;
  const last = ep.curve[ep.curve.length - 1];
  ep.endTs = last ? last[0] : ep.startTs;
  ep.durationSec = Math.round((ep.endTs - ep.startTs) / 1000);
  ep.avgNetPct = Math.round((a.sumNet / Math.max(1, a.samples)) * 1000) / 1000;
  ep.endReason = endReason;
  // 노이즈 컷: 짧고 얕은 반짝은 기록 가치가 없다 (실행됐으면 무조건 남긴다).
  if (!ep.executed && ep.durationSec < MIN_DURATION_SEC && ep.peakNetPct < MIN_KEEP_PEAK_PCT) return;
  void append(ep);
}

/**
 * 스캔 틱마다 호출 — 활성 에피소드를 갱신하고, 임계를 넘나드는 순간 열고 닫는다.
 * 절대 throw하지 않는다.
 */
export function recordEpisodes(opps: Opportunity[]): void {
  try {
    const now = Date.now();
    const seen = new Set<string>();
    for (const o of opps) {
      // funding-basis 제외: APR 기준이라 상시 양수 — 에피소드가 하루짜리가 되어
      // "구간"이라는 개념 자체가 무의미해진다. mock 제외는 당연.
      if (o.mock || o.kind === "funding-basis") continue;
      seen.add(o.id);
      const active = ACTIVE.get(o.id);
      const above = o.netPct > MIN_NET_PCT;
      const price = o.legs.find((l) => l.quote === "USDT")?.price ?? o.legs[0]?.price ?? 0;
      if (!active) {
        if (!above) continue;
        const buy = o.legs.find((l) => l.side === "buy");
        const sell = o.legs.find((l) => l.side === "sell");
        ACTIVE.set(o.id, {
          belowCount: 0, sumNet: o.netPct, samples: 1,
          ep: {
            id: o.id, base: o.base, kind: o.kind,
            buyVenue: buy?.venue ?? "?", sellVenue: sell?.venue ?? "?",
            startTs: now, endTs: now, durationSec: 0,
            peakNetPct: o.netPct, peakTs: now, avgNetPct: o.netPct,
            endReason: "decayed",
            curve: [[now, r3(o.netPct), r3(o.grossPct), price]],
            atPeak: snapshotPeak(o),
          },
        });
        continue;
      }
      // 갱신
      active.ep.curve.push([now, r3(o.netPct), r3(o.grossPct), price]);
      if (active.ep.curve.length > MAX_POINTS) active.ep.curve = thin(active.ep.curve);
      active.sumNet += o.netPct;
      active.samples++;
      if (o.netPct > active.ep.peakNetPct) {
        active.ep.peakNetPct = r3(o.netPct);
        active.ep.peakTs = now;
        active.ep.atPeak = snapshotPeak(o); // 피크가 갱신될 때의 맥락이 진짜 맥락
      }
      if (above) active.belowCount = 0;
      else if (++active.belowCount >= CLOSE_TICKS) {
        ACTIVE.delete(o.id);
        close(active, "decayed");
      }
    }
    // 보드에서 사라진 기회 — 즉시 닫는다 (스프레드 소멸/상폐 등).
    for (const [id, a] of ACTIVE) {
      if (!seen.has(id)) {
        ACTIVE.delete(id);
        close(a, "vanished");
      }
    }
  } catch { /* 복기 기록이 스캔을 깨면 안 된다 */ }
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** 실행 연결 — startRun이 부른다. 활성 에피소드가 있으면 표식. */
export function markEpisodeExecuted(oppId: string, runId: string, dry: boolean): void {
  const a = ACTIVE.get(oppId);
  if (a && !a.ep.executed) a.ep.executed = { runId, dry, ts: Date.now() };
}

/** 최근 에피소드 (신규순). 필터는 호출부에서 — 파일은 작다. */
export async function readEpisodes(limit = 200): Promise<Episode[]> {
  try {
    if (!existsSync(FILE)) return [];
    const raw = await fs.readFile(FILE, "utf8");
    const out: Episode[] = [];
    for (const l of raw.split("\n")) {
      if (!l) continue;
      try { out.push(JSON.parse(l)); } catch { /* skip */ }
    }
    return out.reverse().slice(0, limit);
  } catch {
    return [];
  }
}

/** 지금 진행 중인 에피소드 (UI의 "현재 열려 있는 기회" 표시용). */
export function activeEpisodes(): Episode[] {
  return [...ACTIVE.values()].map((a) => a.ep);
}
