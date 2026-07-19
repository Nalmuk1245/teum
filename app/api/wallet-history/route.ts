import { NextResponse } from "next/server";
import { okxWalletTxs } from "@/lib/okxWallet";
import { walletAddress } from "@/lib/wallet";

export const dynamic = "force-dynamic";

// 개인지갑 최근 온체인 tx (EVM 3체인) — OKX 지갑 API, 주소만으로 조회.
export async function GET() {
  const evm = walletAddress() ?? process.env.WALLET_ADDR_EVM ?? null;
  const sol = process.env.WALLET_ADDR_SOL ?? null;
  const tron = process.env.WALLET_ADDR_TRON ?? null;
  if (!evm && !sol && !tron) return NextResponse.json({ error: "지갑 주소 없음 (⚙ 설정 → 개인지갑)" });
  const txs = await okxWalletTxs({ evm, sol, tron }, 20);
  if (!txs) return NextResponse.json({ error: "OKX_WEB3 키 필요" });
  return NextResponse.json({ address: evm ?? sol ?? tron, txs });
}
