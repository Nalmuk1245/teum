import { NextResponse } from "next/server";
import { getTrack } from "@/lib/history";

export const dynamic = "force-dynamic";

// 30-min gross history for one opportunity id — the detail panel's sparkline.
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id 필요" }, { status: 400 });
  return NextResponse.json({ samples: getTrack(id) });
}
