import { NextResponse } from "next/server";
import { getListingAuto, setListingAuto } from "@/lib/listings";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ cfg: getListingAuto(), liveEnabled: process.env.LISTING_AUTO_LIVE === "true" });
}

// 무장/규모 변경 — 실제 자금 집행은 DRY이거나 LISTING_AUTO_LIVE=true일 때만.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { armed?: boolean; sizeUsd?: number };
    const cfg = setListingAuto(body);
    return NextResponse.json({ cfg, liveEnabled: process.env.LISTING_AUTO_LIVE === "true" });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
