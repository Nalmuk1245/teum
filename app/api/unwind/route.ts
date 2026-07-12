import { NextResponse } from "next/server";
import type { Opportunity } from "@/lib/types";
import { unwind } from "@/lib/unwind";
import { CONFIG } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { opportunity?: Opportunity; remainingQty?: number; fraction?: number };
    if (!body.opportunity || body.remainingQty == null || body.fraction == null) {
      return NextResponse.json({ error: "opportunity + remainingQty + fraction 필요" }, { status: 400 });
    }
    // Live unwind places REAL orders — same guards as exec-step.
    if (!CONFIG.DRY_RUN) {
      if (body.opportunity.mock) {
        return NextResponse.json({ error: "목업 기회는 실행 불가" }, { status: 400 });
      }
      const token = process.env.EXEC_TOKEN;
      if (!token) return NextResponse.json({ error: "라이브 모드에는 EXEC_TOKEN 설정 필수" }, { status: 403 });
      if (req.headers.get("x-exec-token") !== token) {
        return NextResponse.json({ error: "인증 실패" }, { status: 403 });
      }
    }
    const result = await unwind(body.opportunity, body.remainingQty, body.fraction);
    return NextResponse.json({ result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "unwind failed" }, { status: 500 });
  }
}
