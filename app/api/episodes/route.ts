import { NextResponse } from "next/server";
import { readEpisodes, activeEpisodes } from "@/lib/episodes";

export const dynamic = "force-dynamic";

// 기회 복기 — 지난 에피소드(신규순) + 지금 진행 중인 것.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const base = u.searchParams.get("base")?.trim().toUpperCase();
  const kind = u.searchParams.get("kind")?.trim();
  let eps = await readEpisodes(500);
  if (base) eps = eps.filter((e) => e.base.includes(base));
  if (kind) eps = eps.filter((e) => e.kind === kind);
  return NextResponse.json({ episodes: eps.slice(0, 100), active: activeEpisodes() });
}
