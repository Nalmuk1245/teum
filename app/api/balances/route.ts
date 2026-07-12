import { NextResponse } from "next/server";
import { fetchPortfolio } from "@/lib/balances";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const portfolio = await fetchPortfolio();
    return NextResponse.json({ portfolio });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "balances failed" },
      { status: 500 },
    );
  }
}
