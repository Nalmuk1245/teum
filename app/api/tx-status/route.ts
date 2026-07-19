import { NextResponse } from "next/server";
import { okxSwapTxStatus, dexConfigured } from "@/lib/dex";
import { walletAddress } from "@/lib/wallet";

import { loadSecretsIntoEnv } from "@/lib/secrets";

export const dynamic = "force-dynamic";

// 스왑 tx 상태 — OKX post-transaction/orders (온체인 확정/실패 + 실패 사유).
// GET ?chain=&hash=
export async function GET(req: Request) {
  loadSecretsIntoEnv();
  const u = new URL(req.url);
  const chain = u.searchParams.get("chain") ?? "";
  const hash = u.searchParams.get("hash") ?? "";
  if (!chain || !hash) return NextResponse.json({ error: "chain/hash 필요" }, { status: 400 });
  if (hash.startsWith("sim:")) return NextResponse.json({ status: "success", failReason: null, sim: true });
  if (!dexConfigured()) return NextResponse.json({ error: "OKX_WEB3 키 필요" });
  const addr = walletAddress() ?? process.env.WALLET_ADDR_EVM ?? "";
  if (!addr) return NextResponse.json({ error: "지갑 주소 없음" });
  const st = await okxSwapTxStatus(chain, addr, hash);
  if (!st) return NextResponse.json({ error: "조회 실패" });
  return NextResponse.json(st);
}
