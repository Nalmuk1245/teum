// 실행 품질 집계 — 거래소별 Order-to-Ack(p50/p95)·슬리피지 분포. 데이터는
// execStep이 주문마다 남긴 data/exec-metrics.jsonl (DRY 포함 — 페이퍼 데이터).
import { NextResponse } from "next/server";
import { readExecMetrics } from "@/lib/execMetrics";

export const dynamic = "force-dynamic";

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function GET() {
  const rows = await readExecMetrics(2000);
  const pctile = (sorted: number[], p: number) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;

  const byVenueOp = new Map<string, { ack: number[]; ok: number; n: number; dryN: number }>();
  const slipByVenue = new Map<string, number[]>();
  for (const r of rows) {
    const k = `${r.venue}:${r.op}`;
    const e = byVenueOp.get(k) ?? { ack: [], ok: 0, n: 0, dryN: 0 };
    e.n++;
    if (r.ok) e.ok++;
    if (r.dry) e.dryN++;
    e.ack.push(r.ackMs);
    byVenueOp.set(k, e);
    if (r.slipPct != null) {
      const a = slipByVenue.get(r.venue) ?? [];
      a.push(r.slipPct);
      slipByVenue.set(r.venue, a);
    }
  }
  const ack = [...byVenueOp.entries()].map(([k, e]) => {
    const s = [...e.ack].sort((a, b) => a - b);
    const [venue, op] = k.split(":");
    return { venue, op, n: e.n, dryN: e.dryN, okPct: Math.round((e.ok / e.n) * 100), p50Ms: pctile(s, 0.5), p95Ms: pctile(s, 0.95) };
  }).sort((a, b) => b.n - a.n);
  const slip = [...slipByVenue.entries()].map(([venue, arr]) => {
    const s = [...arr].sort((a, b) => a - b);
    return {
      venue, n: arr.length,
      meanPct: r2(arr.reduce((x, y) => x + y, 0) / arr.length),
      p90Pct: r2(pctile(s, 0.9) ?? 0),
      worstPct: r2(s[s.length - 1] ?? 0),
    };
  }).sort((a, b) => b.n - a.n);
  return NextResponse.json({
    total: rows.length,
    dryN: rows.filter((r) => r.dry).length,
    ack, slip,
  });
}
