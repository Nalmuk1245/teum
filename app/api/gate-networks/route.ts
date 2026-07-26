import { NextResponse } from "next/server";
import { fetchTransferStatus, gateNetworks } from "@/lib/transfers";
import { swr } from "@/lib/ttlCache";

export const dynamic = "force-dynamic";

// GET ?coin=XRP → 거래소별 체인 단위 입출금 상태.
// 게이트 스윕("gates" 캐시를 공유 — 추가 스윕 없음)이 지나가며 보존해 둔
// 네트워크별 상세를 그대로 반환한다. 키 없는 거래소는 항목이 없다.
export async function GET(req: Request) {
  const coin = new URL(req.url).searchParams.get("coin")?.trim().toUpperCase();
  if (!coin) return NextResponse.json({ error: "coin 필요" }, { status: 400 });
  await swr("gates", 60_000, fetchTransferStatus); // 스윕 보장 (캐시면 즉시)
  return NextResponse.json({ coin, networks: gateNetworks(coin) });
}
