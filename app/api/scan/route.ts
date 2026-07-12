import { NextResponse } from "next/server";
import { getScan } from "@/lib/scanCache";
import { CONFIG } from "@/lib/config";

export const dynamic = "force-dynamic";

// Served from the warm server-side snapshot (background-refreshed every 8s) —
// only the first request after boot performs a full venue sweep.
export async function GET() {
  try {
    const { opps, ts } = await getScan();
    return NextResponse.json({
      opportunities: opps,
      meta: { dryRun: CONFIG.DRY_RUN, mock: CONFIG.USE_MOCK, ts },
    });
  } catch (e) {
    return NextResponse.json(
      { opportunities: [], error: e instanceof Error ? e.message : "scan failed" },
      { status: 500 },
    );
  }
}
