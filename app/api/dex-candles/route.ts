import { NextResponse } from "next/server";
import { okxGet, OKX_CHAIN_ID, dexConfigured } from "@/lib/dex";

export const dynamic = "force-dynamic";

// DEX 토큰 캔들 (OKX v6) — CEX 미상장 코인의 네이티브 차트용.
// row: [ts, o, h, l, c, vol, volUsd, confirm] (문자열)
export async function GET(req: Request) {
  const u = new URL(req.url);
  const chain = u.searchParams.get("chain") ?? "";
  const address = u.searchParams.get("address") ?? "";
  const bar = u.searchParams.get("bar") ?? "5m";
  const chainIndex = OKX_CHAIN_ID[chain];
  if (!chainIndex || !address) return NextResponse.json({ error: "chain + address 필요" }, { status: 400 });
  if (!dexConfigured()) return NextResponse.json({ error: "OKX_WEB3 키 필요" }, { status: 200 });
  try {
    const data = await okxGet("/api/v6/dex/market/candles", {
      chainIndex, tokenContractAddress: address, bar, limit: "72",
    });
    const candles = (data as string[][]).map((r) => ({
      ts: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), volUsd: Number(r[6] ?? 0),
    })).reverse(); // 오래된 것부터
    return NextResponse.json({ candles });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "candles failed" }, { status: 500 });
  }
}
