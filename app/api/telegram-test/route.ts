import { NextResponse } from "next/server";
import { notifyNow, telegramConfigured } from "@/lib/telegram";

export const dynamic = "force-dynamic";

// Ping the configured Telegram chat to confirm token/chat_id are correct.
export async function POST() {
  if (!telegramConfigured()) {
    return NextResponse.json({ ok: false, error: "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 미설정" }, { status: 400 });
  }
  await notifyNow("✅ Arb Cockpit 텔레그램 알림 연결됨");
  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ configured: telegramConfigured() });
}
