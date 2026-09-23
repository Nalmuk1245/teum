import { NextResponse } from "next/server";
import { loadEpisodes, runBacktest, listingBacktest } from "@/lib/backtest";
import { listingHistory } from "@/lib/listings";

export const dynamic = "force-dynamic";

// GET ?minNet=0.8&minHeld=60&size=300&kinds=kimchi,cross-cex&exec=1&scope=recent|all
export async function GET(req: Request) {
  const u = new URL(req.url);
  const num = (k: string, d: number) => { const v = Number(u.searchParams.get(k)); return Number.isFinite(v) && u.searchParams.has(k) ? v : d; };
  const kinds = (u.searchParams.get("kinds") || "kimchi,cross-cex,cex-dex").split(",").filter(Boolean);
  const scope = u.searchParams.get("scope") === "all" ? "all" : "recent";
  const eps = await loadEpisodes(scope);
  const gap = runBacktest(eps, {
    minNet: num("minNet", 0.8), minHeldSec: num("minHeld", 60), sizeUsd: num("size", 300),
    kinds, executableOnly: u.searchParams.get("exec") === "1",
    excludeAbovePct: num("maxEntry", 10),
  });
  return NextResponse.json({ gap, listing: listingBacktest(listingHistory()) });
}
