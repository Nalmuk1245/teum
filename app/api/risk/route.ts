import { NextResponse } from "next/server";
import { riskState, setLimits } from "@/lib/risk";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(riskState());
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    maxPerTradeUsd?: number; maxInFlightUsd?: number; maxDailyLossUsd?: number;
  };
  setLimits(body);
  return NextResponse.json(riskState());
}
