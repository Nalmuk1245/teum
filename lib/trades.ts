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
  note?: string;
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
