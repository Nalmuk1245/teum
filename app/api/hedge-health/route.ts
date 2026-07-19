import { NextResponse } from "next/server";
import { binanceFuturesFree } from "@/lib/orders";
import { notify } from "@/lib/telegram";

export const dynamic = "force-dynamic";

// 전송 중 헷지 건전성 점검 — 클라이언트 워치가 60초마다 호출.
// 선물 가용 마진이 헷지 명목의 30% 아래로 내려가면 텔레그램 경보 (청산 예방).
export async function GET(req: Request) {
  const notional = Number(new URL(req.url).searchParams.get("notional") ?? 0);
  if (!(notional > 0)) return NextResponse.json({ ok: false, message: "notional 필요" });
  const free = await binanceFuturesFree();
  if (free === null) return NextResponse.json({ ok: true, free: null, message: "바낸 키 없음 — 점검 불가" });
  const ratio = free / notional;
  if (ratio < 0.3) {
    void notify("hedge:margin", `🚨 헷지 증거금 경보 — 선물 가용 $${free.toFixed(0)} / 헷지 명목 $${notional.toFixed(0)} (${(ratio * 100).toFixed(0)}%). 증거금 추가 또는 부분 청산 검토.`);
  }
  return NextResponse.json({ ok: true, free, ratio });
}
