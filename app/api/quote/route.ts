import { NextResponse } from "next/server";
import { quoteOpportunity } from "@/lib/quote";
import type { Opportunity } from "@/lib/types";

export const dynamic = "force-dynamic";

// Depth quote for one opportunity at a size — live order books both legs.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      opportunity?: Opportunity;
      sizeUsd?: number;
    };
    if (!body.opportunity || !body.sizeUsd) {
      return NextResponse.json({ error: "opportunity + sizeUsd required" }, { status: 400 });
    }
    const quote = await quoteOpportunity(body.opportunity, body.sizeUsd);
    return NextResponse.json({ quote });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "quote failed" },
      { status: 500 },
    );
  }
}
