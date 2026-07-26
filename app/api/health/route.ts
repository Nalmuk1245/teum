import { NextResponse } from "next/server";
import { getScan } from "@/lib/scanCache";
import { isKilled } from "@/lib/killswitch";
import { CONFIG } from "@/lib/config";
import { routeDbStats } from "@/lib/tokenRoutes";

export const dynamic = "force-dynamic";

// 헬스체크 — pm2/uptime 모니터/curl용. 스캔이 60초 이상 멈추면 503.
//
// 이 엔드포인트는 진단만이 아니라 **복구 훅**이다: getScan()이 스냅샷이 낡았거나
// 갱신 래치가 걸린 것을 보면 새 스캔을 띄운다. 프로세스가 죽지 않고 살아서 멈추는
// 고장은 pm2가 잡지 못하므로, 외부에서 이 주소를 주기적으로 찍어주면 그 구멍이
// 메워진다 (예: crontab `* * * * * curl -sf localhost:3100/api/health >/dev/null`).
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
        rssMb: Math.round(process.memoryUsage().rss / 1048576),
        // 경로 DB 규모. 이 섹션은 저장할 때마다 통째로 다시 써지므로 커지면
        // 이벤트 루프가 그만큼 멈춘다 — SQLite로 옮길 시점의 신호다
        // (임계 2MB, docs/TOKEN_ROUTE_DB.md §9).
        routeDb: routeDbStats(),
      },
      { status: healthy ? 200 : 503 },
    );
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "health failed" }, { status: 503 });
  }
}
