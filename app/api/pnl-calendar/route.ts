import { NextRequest, NextResponse } from "next/server";
import { readDailyPnl, readDayTrades } from "@/lib/trades";

export const dynamic = "force-dynamic";

// 손익 캘린더 — ?day 없으면 전체 일별 집계(가볍다), 있으면 그 날짜의 거래 상세.
export async function GET(req: NextRequest) {
  const day = req.nextUrl.searchParams.get("day");
  if (day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return NextResponse.json({ error: "day는 YYYY-MM-DD" }, { status: 400 });
    const trades = (await readDayTrades(day)).map((t) => ({
      ts: t.ts, base: t.base, kind: t.kind, route: t.route, sizeUsd: t.sizeUsd,
      detectedNetPct: t.detectedNetPct, realizedNetPct: t.realizedNetPct,
      realizedPnlUsd: t.realizedPnlUsd, dryRun: t.dryRun, status: t.status, note: t.note,
    }));
    return NextResponse.json({ trades });
  }
  return NextResponse.json({ days: await readDailyPnl() });
}
