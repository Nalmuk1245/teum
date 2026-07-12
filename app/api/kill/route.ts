import { NextResponse } from "next/server";
import { killState, setKilled } from "@/lib/killswitch";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(killState());
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { killed?: boolean };
  return NextResponse.json(setKilled(!!body.killed));
}
