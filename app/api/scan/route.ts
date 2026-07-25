import { NextResponse } from "next/server";
import { getScan } from "@/lib/scanCache";
import { CONFIG } from "@/lib/config";
import { computeCalibrationPct } from "@/lib/calibration";
import { swr } from "@/lib/ttlCache";

export const dynamic = "force-dynamic";

// Served from the warm server-side snapshot (background-refreshed every 8s) —
// only the first request after boot performs a full venue sweep.
export async function GET() {
  try {
    const { opps, ts } = await getScan();
    // The client polls this route every 3s. Recomputing calibration per request
    // re-read and JSON.parsed the whole append-only trades.jsonl each time — on
    // the hottest path, from a file that grows without bound. Same 5min TTL the
    // scanner already uses for this value.
    const cal = await swr("cal", 5 * 60_000, computeCalibrationPct);
    return NextResponse.json({
      opportunities: opps,
      meta: { dryRun: CONFIG.DRY_RUN, mock: CONFIG.USE_MOCK, ts, calPct: cal.pct, calSamples: cal.samples },
    });
  } catch (e) {
    return NextResponse.json(
      { opportunities: [], error: e instanceof Error ? e.message : "scan failed" },
      { status: 500 },
    );
  }
}
