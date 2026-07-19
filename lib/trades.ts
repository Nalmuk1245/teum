// Trade log — every completed run appended to a JSONL file so P&L survives
// restarts and the "detected vs realized" gap (how much edge leaks between the
// board estimate and the actual fills) can be measured. Server-only (fs).

import { promises as fs, existsSync, mkdirSync } from "fs";
import path from "path";

const DIR = path.join(process.cwd(), "data");
const FILE = path.join(DIR, "trades.jsonl");

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

export async function recordTrade(t: TradeRecord): Promise<void> {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
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
