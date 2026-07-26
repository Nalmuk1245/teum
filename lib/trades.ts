// Trade log — every completed run appended to a JSONL file so P&L survives
// restarts and the "detected vs realized" gap (how much edge leaks between the
// board estimate and the actual fills) can be measured. Server-only (fs).

import { promises as fs, existsSync, mkdirSync } from "fs";
import path from "path";

const DIR = path.join(process.cwd(), "data");
const FILE = path.join(DIR, "trades.jsonl");

export type TimelineEntry = {
  step: string;      // StepId (buy/hedge/withdraw/recv/transfer/deposit/sell/close/settle)
  label: string;     // 사람이 읽는 단계명
  at: number;        // 시작 시각 (ms epoch)
  sec: number;       // 이 시도에 걸린 초
  ok: boolean;
  /** wait = 정상 대기(입금 미확인 등, 실패가 아니다) · retry = 재시도 · rollback = 되돌림 */
  kind?: "wait" | "retry" | "rollback";
  /** 같은 단계의 연속 대기를 한 줄로 합쳤을 때의 횟수 (없으면 1회). */
  tries?: number;
  message?: string;
};

export type TradeRecord = {
  ts: number;
  base: string;
  kind: string;
  route: string; // "Binance → Upbit"
  sizeUsd: number;
  detectedNetPct: number; // edge the board showed at launch
  realizedNetPct: number | null; // from real fills (null if DRY/unknown)
  realizedPnlUsd: number | null;
  hedged: boolean;
  dryRun: boolean;
  status: "done" | "error";
  /** Real per-step seconds (buy/withdraw/deposit/...) — actual transfer time vs
   *  ETA calibration data. */
  durationsSec?: Record<string, number>;
  /**
   * 단계별 진행 기록 — **시각**과 결과까지. durationsSec은 단계당 한 칸이라
   * 재시도·대기·실패가 전부 뭉개졌다. 사후에 "왜 이 거래가 늦었나 / 어디서
   * 틀어졌나"를 보려면 순서와 시각이 필요하다.
   *
   * 한 단계가 여러 항목으로 나올 수 있다(재시도·입금 폴링) — 그게 사실이다.
   */
  timeline?: TimelineEntry[];
  note?: string;
  // ── 상세 (있는 만큼만 기록 — 실체결이면 전부, 추정이면 일부) ──
  qty?: number | null; // 체결 수량 (코인)
  entryPriceUsd?: number | null; // 평균 진입가
  exitPriceUsd?: number | null; // 평균 청산가
  buyUsd?: number | null; // 매수 체결 금액 (USD 환산)
  sellUsd?: number | null; // 매도 체결 금액 (USD 환산)
  spotPnlUsd?: number | null; // 현물 손익
  hedgePnlUsd?: number | null; // 헷지(선물) 손익
  /** 출금·전송·입금·스왑 tx — 사후 추적용. */
  txs?: { step: string; hash: string; url: string | null }[];
};

// Append-only with no rotation meant this file grew forever — and readTrades
// parses EVERY line before slicing, on a path the UI polls. Roll it once it gets
// large; the rolled file stays on disk for analysis.
const ROTATE_BYTES = 4 * 1024 * 1024;
async function rotateIfLarge(): Promise<void> {
  try {
    const { statSync, renameSync } = await import("fs");
    if (!existsSync(FILE)) return;
    if (statSync(FILE).size < ROTATE_BYTES) return;
    renameSync(FILE, `${FILE}.${new Date().toISOString().slice(0, 10)}`);
  } catch {
    /* rotation is best-effort */
  }
}

export async function recordTrade(t: TradeRecord): Promise<void> {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    await rotateIfLarge();
    await fs.appendFile(FILE, JSON.stringify(t) + "\n", "utf8");
  } catch {
    /* logging must never break a trade */
  }
}

export type TradeStats = {
  count: number;
  wins: number; // realized net > 0
  hitRatePct: number;
  realizedPnlUsd: number; // sum of known realized PnL
  avgSlipPct: number; // mean (detected − realized) net, the leak
  dryCount: number;
};

/** Recent trades (newest first) + aggregate stats. */
export async function readTrades(limit = 100): Promise<{ trades: TradeRecord[]; stats: TradeStats }> {
  let lines: string[] = [];
  try {
    if (existsSync(FILE)) {
      const raw = await fs.readFile(FILE, "utf8");
      lines = raw.split("\n").filter(Boolean);
    }
  } catch {
    /* empty */
  }
  const all: TradeRecord[] = [];
  for (const l of lines) {
    try { all.push(JSON.parse(l)); } catch { /* skip bad line */ }
  }
  const withReal = all.filter((t) => t.realizedNetPct != null);
  const wins = withReal.filter((t) => (t.realizedNetPct ?? 0) > 0).length;
  const leaks = withReal.map((t) => t.detectedNetPct - (t.realizedNetPct ?? 0));
  const stats: TradeStats = {
    count: all.length,
    wins,
    hitRatePct: withReal.length ? Math.round((wins / withReal.length) * 100) : 0,
    realizedPnlUsd: all.reduce((s, t) => s + (t.realizedPnlUsd ?? 0), 0),
    avgSlipPct: leaks.length ? leaks.reduce((a, b) => a + b, 0) / leaks.length : 0,
    dryCount: all.filter((t) => t.dryRun).length,
  };
  return { trades: all.reverse().slice(0, limit), stats };
}
