import { NextResponse } from "next/server";
import { addWalletEntry, removeWalletEntry, walletBookStats, type WalletType } from "@/lib/exchangeWallets";

export const dynamic = "force-dynamic";

// 거래소 지갑 주소록 — 상장 전 입금 지갑 수동 등록 (영구, data 파일).
export async function GET() {
  return NextResponse.json({ stats: walletBookStats() });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { venue?: string; address?: string; type?: WalletType; tag?: string; remove?: boolean };
    if (!body.venue || !body.address) return NextResponse.json({ ok: false, message: "venue + address 필요" }, { status: 400 });
    const r = body.remove
      ? removeWalletEntry(body.venue, body.address)
      : addWalletEntry(body.venue, body.address, body.type === "cold" ? "cold" : "hot", body.tag);
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "실패" }, { status: 500 });
  }
}
