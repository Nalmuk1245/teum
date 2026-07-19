import { NextResponse } from "next/server";
import { hourlyHeat } from "@/lib/scanCache";

export const dynamic = "force-dynamic";

// 통계 — 시간대별(KST) 수익 갭 열림 빈도. 곡선/전략별 분해는 /api/trades로.
export async function GET() {
  return NextResponse.json({ heat: hourlyHeat() });
}
