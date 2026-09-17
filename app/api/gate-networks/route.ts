import { NextResponse } from "next/server";
import { fetchTransferStatus, gateNetworks, unmappedNetCodes } from "@/lib/transfers";
import { swr } from "@/lib/ttlCache";

export const dynamic = "force-dynamic";

// GET ?coin=XRP → 거래소별 체인 단위 입출금 상태.
// 게이트 스윕("gates" 캐시를 공유 — 추가 스윕 없음)이 지나가며 보존해 둔
// 네트워크별 상세를 그대로 반환한다. 키 없는 거래소는 항목이 없다.
export async function GET(req: Request) {
  const coin = new URL(req.url).searchParams.get("coin")?.trim().toUpperCase();
  if (!coin) return NextResponse.json({ error: "coin 필요" }, { status: 400 });
  await swr("gates", 60_000, fetchTransferStatus); // 스윕 보장 (캐시면 즉시)
  const { nets, fetchedAt } = gateNetworks(coin);
  // 낡은 거래소 표시 — 5분 넘게 갱신 안 된 항목은 UI가 "낡음"을 알 수 있게.
  const staleVenues = Object.entries(fetchedAt).filter(([, t]) => t && Date.now() - t > 5 * 60_000).map(([v]) => v);
  // unmapped: canonChain이 모르는 거래소 코드 — 이게 비어 있어야 체인 단위 게이트가 완전하다.
  return NextResponse.json({ coin, networks: nets, staleVenues, unmapped: unmappedNetCodes(coin) });
}
