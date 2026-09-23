import { NextResponse } from "next/server";
import { CONFIG } from "@/lib/config";
import { loadSecretsIntoEnv } from "@/lib/secrets";
import { gapAutoState, setGapAuto, type GapAutoCfg } from "@/lib/gapAuto";

export const dynamic = "force-dynamic";

// 갭 자동 진입 설정. 라이브에서 켤 땐 EXEC_TOKEN (돈이 나가는 무인 주문).
export async function GET() {
  return NextResponse.json({ ...gapAutoState(), liveEnabled: process.env.GAP_AUTO_LIVE === "true", dryRun: CONFIG.DRY_RUN });
}

export async function POST(req: Request) {
  try {
    loadSecretsIntoEnv();
    const body = (await req.json()) as Partial<GapAutoCfg>;
    if (!CONFIG.DRY_RUN && body.armed && !gapAutoState().cfg.armed) {
      const token = process.env.EXEC_TOKEN;
      if (!token || req.headers.get("x-exec-token") !== token) {
        return NextResponse.json({ error: "인증 실패 (EXEC_TOKEN)" }, { status: 403 });
      }
    }
    return NextResponse.json({ cfg: setGapAuto(body), liveEnabled: process.env.GAP_AUTO_LIVE === "true" });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
