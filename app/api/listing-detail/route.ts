import { NextResponse } from "next/server";
import { buildListingDetail } from "@/lib/listingDetail";
import { swr } from "@/lib/ttlCache";

export const dynamic = "force-dynamic";

// One-stop payload for the listing detail panel: token identity + CEX matrix
// (+my buying power) + DEX quotes + kimchi read. Holdings are fetched by the
// client separately (/api/exchange-holdings) — they're slower and cacheable.
//
// The panel polls this every 10s and the build does per-chain DEX quotes, so an
// uncached route re-ran every external call on every tick. `swr` serves the last
// value instantly and refreshes behind it: the poll costs ~0ms and the numbers
// stay at most TTL old. A manual lookup of a coin seen recently is instant too;
// only a genuinely cold coin waits.
const TTL_MS = 8000;

export async function GET(req: Request) {
  const base = new URL(req.url).searchParams.get("base")?.trim();
  if (!base) return NextResponse.json({ error: "base 필요" }, { status: 400 });
  const fast = new URL(req.url).searchParams.get("fast") === "1";
  try {
    const key = `listingDetail:${fast ? "fast:" : ""}${base.toUpperCase()}`;
    const detail = await swr(key, TTL_MS, () => buildListingDetail(base, { fast }));
    return NextResponse.json({ detail: fast ? { ...detail, dexPending: true } : detail });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "detail failed" }, { status: 500 });
  }
}
