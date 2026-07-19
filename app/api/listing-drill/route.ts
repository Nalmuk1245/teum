import { NextResponse } from "next/server";
import { startDrill } from "@/lib/listings";

export const dynamic = "force-dynamic";

// 모의 상장 드릴 — 가짜 공지 주입으로 감지→알림→카드→매수 플로우 리허설.
// 라이브 모드에서도 드릴 플레이는 자동매수가 실행되지 않는다 (listings.ts 가드).
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { base?: string };
    const base = (body.base ?? "PEPE").toUpperCase();
    await startDrill(base);
    return NextResponse.json({ ok: true, base });
  } catch (e) {
    return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "drill failed" }, { status: 500 });
  }
}
