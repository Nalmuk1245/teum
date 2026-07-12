import { NextResponse } from "next/server";
import { scanAll } from "@/lib/scanner";
import { CONFIG } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const opportunities = await scanAll();
    return NextResponse.json({
      opportunities,
      meta: { dryRun: CONFIG.DRY_RUN, mock: CONFIG.USE_MOCK, ts: Date.now() },
    });
  } catch (e) {
    return NextResponse.json(
      { opportunities: [], error: e instanceof Error ? e.message : "scan failed" },
      { status: 500 },
    );
  }
}
