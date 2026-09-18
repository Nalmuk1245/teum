import { NextResponse } from "next/server";
import { readEvents, type EventType } from "@/lib/events";

export const dynamic = "force-dynamic";

// GET ?limit=200&type=gate.change → data/events.jsonl 최신순.
// 알림·게이트 전환·런 종료 기록. 텔레그램 미설정이어도 여기엔 남는다.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const limit = Math.min(1000, Math.max(1, Number(u.searchParams.get("limit") ?? 200) || 200));
  const type = (u.searchParams.get("type") || undefined) as EventType | undefined;
  const events = await readEvents(limit, type);
  return NextResponse.json({ events, count: events.length });
}
