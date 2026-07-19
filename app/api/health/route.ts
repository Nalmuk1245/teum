import { NextResponse } from "next/server";
import { getScan } from "@/lib/scanCache";
import { isKilled } from "@/lib/killswitch";
import { CONFIG } from "@/lib/config";

export const dynamic = "force-dynamic";

// 헬스체크 — pm2/uptime 모니터/curl용. 스캔이 60초 이상 멈추면 503.
export async function GET() {
  try {
    const { opps, ts } = await getScan();
    const ageSec = ts ? Math.round((Date.now() - ts) / 1000) : null;
    const healthy = ageSec != null && ageSec < 60;
    return NextResponse.json(
      {
        ok: healthy,
        scanAgeSec: ageSec,
        liveOpps: opps.filter((o) => !o.mock).length,
        killed: isKilled(),
        dryRun: CONFIG.DRY_RUN,
        uptimeSec: Math.round(process.uptime()),
      },
      { status: healthy ? 200 : 503 },
    );
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "health failed" }, { status: 503 });
  }
}
