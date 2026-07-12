import { NextResponse } from "next/server";
import { riskState } from "@/lib/risk";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(riskState());
}
