import { NextResponse } from "next/server";
import { readTrades } from "@/lib/trades";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await readTrades(50));
}
