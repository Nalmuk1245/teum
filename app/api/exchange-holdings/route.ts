import { NextResponse } from "next/server";
import { fetchHoldings, peekHoldings } from "@/lib/holdings";
import { importFromEthLabels, walletBookStats } from "@/lib/exchangeWallets";

export const dynamic = "force-dynamic";

// GET ?symbol=PYR → per-venue hot/cold on-chain balances (listing-play supply).
//
// 절대 오래 잡고 있지 않는다. 이 조회는 실측 14초인데, 그동안 연결을 잡으면
// 브라우저의 동일 서버 6연결 한도를 하나 차지해 상세 패널의 다른 요청이 줄을
// 선다(수동조회 3.8초의 원인). 캐시가 있으면 즉시, 없으면 { pending }을 즉시
// 반환하고 뒤에서 채운다 — 클라이언트가 잠시 후 다시 물으면 그때 값이 있다.
// ?fresh=1 만 예외로 끝까지 기다린다(수동 새로고침 버튼용).
export async function GET(req: Request) {
  const u = new URL(req.url);
  const symbol = u.searchParams.get("symbol")?.trim();
  if (!symbol) return NextResponse.json({ error: "symbol 필요", stats: walletBookStats() }, { status: 400 });
  if (u.searchParams.get("fresh") === "1") {
    const r = await fetchHoldings(symbol, { fresh: true });
    return "error" in r
      ? NextResponse.json({ error: r.error, stats: walletBookStats() }, { status: 200 })
      : NextResponse.json({ holdings: r, stats: walletBookStats() });
  }
  const { v, pending } = peekHoldings(symbol);
  if (pending || v == null) return NextResponse.json({ pending: true, stats: walletBookStats() });
  return "error" in v
    ? NextResponse.json({ error: v.error, stats: walletBookStats() }, { status: 200 })
    : NextResponse.json({ holdings: v, stats: walletBookStats() });
}

// POST {action:"import"} → one-time Etherscan label dump import (fills the book).
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { action?: string };
    if (body.action !== "import") return NextResponse.json({ error: "unknown action" }, { status: 400 });
    const r = await importFromEthLabels();
    return "error" in r
      ? NextResponse.json({ error: r.error }, { status: 502 })
      : NextResponse.json({ counts: r });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "import failed" }, { status: 500 });
  }
}
