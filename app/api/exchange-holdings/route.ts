import { NextResponse } from "next/server";
import { fetchHoldings } from "@/lib/holdings";
import { importFromEthLabels, walletBookStats } from "@/lib/exchangeWallets";

export const dynamic = "force-dynamic";

// GET ?symbol=PYR → per-venue hot/cold on-chain balances (listing-play supply).
export async function GET(req: Request) {
  const symbol = new URL(req.url).searchParams.get("symbol")?.trim();
  if (!symbol) return NextResponse.json({ error: "symbol 필요", stats: walletBookStats() }, { status: 400 });
  const r = await fetchHoldings(symbol);
  return "error" in r
    ? NextResponse.json({ error: r.error, stats: walletBookStats() }, { status: 200 })
    : NextResponse.json({ holdings: r, stats: walletBookStats() });
}

// POST {action:"import"} → one-time Etherscan label dump import (fills the book).
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { action?: string };
    if (body.action !== "import") return NextResponse.json({ error: "unknown action" }, { status: 400 });
    const r = await importFromEthLabels();
    return "error" in r
      ? NextResponse.json({ error: r.error }, { status: 502 })
      : NextResponse.json({ counts: r });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "import failed" }, { status: 500 });
  }
}
