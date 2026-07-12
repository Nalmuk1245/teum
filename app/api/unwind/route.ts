import { NextResponse } from "next/server";
import type { Opportunity } from "@/lib/types";
import { unwind } from "@/lib/unwind";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { opportunity?: Opportunity; remainingQty?: number; fraction?: number };
    if (!body.opportunity || body.remainingQty == null || body.fraction == null) {
      return NextResponse.json({ error: "opportunity + remainingQty + fraction 필요" }, { status: 400 });
    }
    // (Live mode is additionally hard-blocked inside unwind() until the real
    // limit-order loop is wired.)
    const result = await unwind(body.opportunity, body.remainingQty, body.fraction);
    return NextResponse.json({ result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "unwind failed" }, { status: 500 });
  }
}
