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
// 기록 가치 하한: 5분 못 버틴 기회는 안 적는다 (운영자 결정 2026-08-21).
// 이 전략의 전송 ETA가 60분인데 5분도 못 버틴 갭은 복기할 가치가 없다 —
// 예전 하한(9초 또는 피크 0.5%+)은 호가 반짝까지 다 적어서 목록이 노이즈가
// 됐다. 판정은 병합(12분 창) **후** 길이 기준이라 조각난 기회는 이어 붙인
// 수명으로 평가된다. 실행된 에피소드는 길이 무관 무조건 남는다(finalize).
const MIN_DURATION_SEC = Number(process.env.EPISODE_MIN_DURATION_SEC ?? 300);
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

/** 닫혔지만 아직 파일에 안 쓴 에피소드 — 병합 대기실.
 *
 *  왜 필요한가(실측): 290개 에피소드가 사실 **8개**의 (코인+경로) 조합이었다.
 *  RED 하나가 82회로 쪼개졌고 재개 간격의 중앙값이 21~69초다. 0% 근처에서
 *  깜빡이는 기회가 매번 새 에피소드를 열어, 30분짜리 기회 하나가 30초짜리
 *  수십 개로 기록됐다. 그러면 복기 카드의 "얼마나 지속됐나"가 통째로 거짓말이
 *  된다 — 지속시간은 조각 길이지 기회의 수명이 아니게 되니까.
 *
 *  그래서 닫자마자 쓰지 않고 여기 잠시 세워둔다. MERGE_GAP 안에 같은 기회가
 *  다시 임계를 넘으면 새로 열지 않고 **이어 붙인다**. 창이 지나면 그때 쓴다. */
type Parked = { a: Active; closedAt: number; reason: Episode["endReason"] };

const g = globalThis as unknown as {
  __arbEpisodes?: Map<string, Active>;
  __arbEpisodesParked?: Map<string, Parked>;
};
g.__arbEpisodes ??= new Map();
g.__arbEpisodesParked ??= new Map();
const ACTIVE = g.__arbEpisodes;
const PARKED = g.__arbEpisodesParked;

/** 이 시간 안에 같은 기회가 돌아오면 같은 에피소드로 본다.
 *
 *  값의 근거(실측 재개 간격 분위수): p25=18s · p50=63s · p75=181s · p90=496s.
 *  처음엔 3분으로 잡았는데 하필 p75에 걸쳐 293구간이 82구간으로밖에 안 줄었다.
 *  12분이면 p90까지 흡수한다.
 *
 *  왜 이렇게 넉넉해도 되는가: 이 전략의 전송 ETA가 60분이다. 8분 끊겼다 돌아온
 *  갭은 운영자 입장에서 **같은 사건**이다 — 한 시간짜리 여정 앞에서 8분의
 *  끊김은 진입 판단을 바꾸지 않는다. 창을 좁게 잡아 조각을 늘리면, 조각 길이가
 *  기회의 수명인 척하게 되는 쪽이 훨씬 큰 거짓말이다. */
const MERGE_GAP_MS = Number(process.env.EPISODE_MERGE_GAP_SEC ?? 720) * 1000;

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

/** 닫되 아직 쓰지 않는다 — 병합 창이 지나야 확정이다. */
function park(id: string, a: Active, reason: Episode["endReason"]): void {
  PARKED.set(id, { a, closedAt: Date.now(), reason });
}

/** 병합 창이 지난 대기 건을 파일로 확정한다. 매 틱 호출. */
function flushParked(now: number): void {
  for (const [id, p] of PARKED) {
    if (now - p.closedAt < MERGE_GAP_MS) continue;
    PARKED.delete(id);
    finalize(p.a, p.reason);
  }
}

function finalize(a: Active, endReason: Episode["endReason"]): void {
  const ep = a.ep;
  const last = ep.curve[ep.curve.length - 1];
  ep.endTs = last ? last[0] : ep.startTs;
  ep.durationSec = Math.round((ep.endTs - ep.startTs) / 1000);
  ep.avgNetPct = Math.round((a.sumNet / Math.max(1, a.samples)) * 1000) / 1000;
  ep.endReason = endReason;
  // 노이즈 컷: 하한 못 넘긴 기회는 버린다 (실행됐으면 무조건 남긴다).
  // 피크 우회 없음 — 아무리 높은 피크도 5분을 못 버티면 전송형 전략에선
  // 어차피 못 먹는 기회다.
  if (!ep.executed && ep.durationSec < MIN_DURATION_SEC) return;
  void append(ep);
}

/** 프로세스가 내려갈 때 기록을 잃지 않게 — 종료 훅이 부른다.
 *
 *  **진행 중(ACTIVE)인 것까지** 확정한다. 대기실만 비우면, 재시작 시점에 살아
 *  있던 에피소드는 통째로 사라진다 — 그리고 그건 대개 지금 가장 오래 지속되고
 *  있는, 즉 가장 복기할 가치가 큰 기회다. */
export function flushAllEpisodes(): void {
  for (const [id, p] of PARKED) {
    PARKED.delete(id);
    finalize(p.a, p.reason);
  }
  for (const [id, a] of ACTIVE) {
    ACTIVE.delete(id);
    finalize(a, "decayed");
  }
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
        // 방금 닫힌 같은 기회가 대기실에 있으면 새로 열지 않고 이어 붙인다.
        const parked = PARKED.get(o.id);
        if (parked) {
          PARKED.delete(o.id);
          ACTIVE.set(o.id, parked.a);
          parked.a.belowCount = 0;
          // 아래 갱신 블록으로 흘러가게 한다 (이 틱의 점이 곡선에 실린다).
          const resumed = parked.a;
          resumed.ep.curve.push([now, r3(o.netPct), r3(o.grossPct), price]);
          if (resumed.ep.curve.length > MAX_POINTS) resumed.ep.curve = thin(resumed.ep.curve);
          resumed.sumNet += o.netPct;
          resumed.samples++;
          if (o.netPct > resumed.ep.peakNetPct) {
            resumed.ep.peakNetPct = r3(o.netPct);
            resumed.ep.peakTs = now;
            resumed.ep.atPeak = snapshotPeak(o);
          }
          continue;
        }
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
        park(o.id, active, "decayed");
      }
    }
    // 보드에서 사라진 기회 — 임계 미달과 **같은 유예**를 준다.
    //
    // 예전엔 즉시 닫았다. 그런데 기회가 보드에서 빠지는 흔한 이유는 소멸이
    // 아니라 호가가 한 틱 벌어져 스프레드 게이트(MAX_SPREAD_PCT)에 걸리는
    // 것이다. 그 한 틱마다 에피소드를 끊으니, decayed에 30초 유예를 준 의미가
    // vanished 경로로 통째로 새고 있었다. 진짜로 사라진 기회는 어차피 유예가
    // 지나면 닫힌다 — 늦게 닫혀서 잃는 건 없고, 일찍 끊어서 잃는 건 많다.
    for (const [id, a] of ACTIVE) {
      if (seen.has(id)) continue;
      if (++a.belowCount >= CLOSE_TICKS) {
        ACTIVE.delete(id);
        park(id, a, "vanished");
      }
    }
    flushParked(now);
  } catch { /* 복기 기록이 스캔을 깨면 안 된다 */ }
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** 실행 연결 — startRun이 부른다. 활성 에피소드가 있으면 표식. */
export function markEpisodeExecuted(oppId: string, runId: string, dry: boolean): void {
  // 병합 대기실도 본다 — 기회가 잠깐 임계 아래로 내려간 사이에 실행을 시작하는
  // 건 드물지 않고(모달을 열어둔 채 몇 초 지나면 그렇게 된다), 그때 표식을
  // 놓치면 "실행 가능했지만 안 함(놓친 기회)"으로 잘못 복기된다.
  const a = ACTIVE.get(oppId) ?? PARKED.get(oppId)?.a;
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
