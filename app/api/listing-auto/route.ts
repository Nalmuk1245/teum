import { NextResponse } from "next/server";
import { getListingAuto, setListingAuto } from "@/lib/listings";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ cfg: getListingAuto(), liveEnabled: process.env.LISTING_AUTO_LIVE === "true" });
}

// 켜짐/규모 변경 — 실제 자금 집행은 DRY이거나 LISTING_AUTO_LIVE=true일 때만.
//
// 무장은 곧 예약된 주문이지만(listings.ts의 autoBuy가 거래소 어댑터를 직접
// 호출하므로 이 라우트가 유일한 관문이다), 여기 EXEC_TOKEN을 걸지는 않는다 —
// 로컬 단일 사용자 앱에서 막아야 할 호출자는 브라우저에서 열어둔 다른 사이트고,
// 그건 middleware.ts의 출처 확인이 DRY·LIVE 모두에서 막는다. 무인 집행의
// 이중 옵트인(armed + LISTING_AUTO_LIVE=true)은 그대로다.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { armed?: boolean; sizeUsd?: number; route?: "global" | "kr" };
    const cfg = setListingAuto(body);
    return NextResponse.json({ cfg, liveEnabled: process.env.LISTING_AUTO_LIVE === "true" });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
