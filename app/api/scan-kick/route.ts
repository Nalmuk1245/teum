// 감시 카드의 스캔 "재시작" 버튼 — 멈춘 스캔 루프를 강제로 다시 굴린다.
// 읽기 전용 상태 조작(주문·자금과 무관)이라 EXEC_TOKEN 인증은 걸지 않는다.
import { NextResponse } from "next/server";
import { kickScan } from "@/lib/scanCache";

export const dynamic = "force-dynamic";

export async function POST() {
  kickScan();
  return NextResponse.json({ ok: true });
}
