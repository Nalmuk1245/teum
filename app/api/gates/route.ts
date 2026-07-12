import { NextResponse } from "next/server";
import { fetchTransferStatus } from "@/lib/transfers";
import { swr } from "@/lib/ttlCache";
import type { Venue, WalletStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

// Per-coin deposit/withdraw availability across venues. Bithumb is public
// (always populated); Upbit/Binance need keys (null = "키 필요"). Optional
// ?coin= filters to one base.
export async function GET(req: Request) {
  const coin = new URL(req.url).searchParams.get("coin")?.toUpperCase();
  const ts = await swr("gates", 60_000, fetchTransferStatus);
  const venues = Object.keys(ts.byVenue) as Venue[];

  // Union of coins across venues (or just the requested one).
  const bases = new Set<string>();
  for (const v of venues) {
    const m = ts.byVenue[v];
    if (!m) continue;
    for (const base of m.keys()) {
      if (!coin || base === coin) bases.add(base);
    }
  }

  const rows = [...bases].sort().map((base) => {
    const perVenue: Record<string, WalletStatus | null> = {};
    for (const v of venues) perVenue[v] = ts.byVenue[v]?.get(base) ?? null;
    return { base, venues: perVenue };
  });

  return NextResponse.json({ venues, rows });
}
