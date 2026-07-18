import { NextResponse } from "next/server";
import { buildListingDetail } from "@/lib/listingDetail";

export const dynamic = "force-dynamic";

// One-stop payload for the listing detail panel: token identity + CEX matrix
// (+my buying power) + DEX quotes + kimchi read. Holdings are fetched by the
// client separately (/api/exchange-holdings) — they're slower and cacheable.
export async function GET(req: Request) {
  const base = new URL(req.url).searchParams.get("base")?.trim();
  if (!base) return NextResponse.json({ error: "base 필요" }, { status: 400 });
  try {
    const detail = await buildListingDetail(base);
    return NextResponse.json({ detail });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "detail failed" }, { status: 500 });
  }
}
