import { NextResponse } from "next/server";
import { CONFIG } from "@/lib/config";
import { loadSecretsIntoEnv } from "@/lib/secrets";
import { getExitCfg, setExitCfg, startListingExit, type ListingExitCfg } from "@/lib/listingExit";

export const dynamic = "force-dynamic";

// 상장따리 자동 청산 설정. 라이브에서 켤 땐 EXEC_TOKEN (돈이 나가는 무인 주문).
export async function GET() {
  startListingExit();
  return NextResponse.json({ cfg: getExitCfg(), liveEnabled: process.env.LISTING_AUTO_LIVE === "true", dryRun: CONFIG.DRY_RUN });
}

export async function POST(req: Request) {
  try {
    loadSecretsIntoEnv();
    const body = (await req.json()) as Partial<ListingExitCfg>;
    if (!CONFIG.DRY_RUN && body.enabled && !getExitCfg().enabled) {
      const token = process.env.EXEC_TOKEN;
      if (!token || req.headers.get("x-exec-token") !== token) {
        return NextResponse.json({ error: "인증 실패 (EXEC_TOKEN)" }, { status: 403 });
      }
    }
    return NextResponse.json({ cfg: setExitCfg(body), liveEnabled: process.env.LISTING_AUTO_LIVE === "true" });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
