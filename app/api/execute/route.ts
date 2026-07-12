import { NextResponse } from "next/server";
import { executeOpportunity } from "@/lib/execution";
import type { Opportunity } from "@/lib/types";

export const dynamic = "force-dynamic";

// Semi-auto one-click execution. The client posts the chosen opportunity + size
// after the user confirms. DRY_RUN (default) simulates fills.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      opportunity?: Opportunity;
      sizeUsd?: number;
    };
    if (!body.opportunity || !body.sizeUsd) {
      return NextResponse.json({ error: "opportunity + sizeUsd required" }, { status: 400 });
    }
    const report = await executeOpportunity(body.opportunity, body.sizeUsd);
    return NextResponse.json({ report });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "execute failed" },
      { status: 500 },
    );
  }
}
