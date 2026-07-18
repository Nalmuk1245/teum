import { NextResponse } from "next/server";
import { CONFIG } from "@/lib/config";
import { isKilled } from "@/lib/killswitch";
import { checkEntry } from "@/lib/risk";
import { binanceSpot, bybitOrder, okxOrder } from "@/lib/orders";
import { globalVenueFor, listingInfo } from "@/lib/listings";
import { notifyNow } from "@/lib/telegram";

export const dynamic = "force-dynamic";

// 상장따리 원클릭: buy `base` on the cheapest global CEX RIGHT NOW — the
// front-run leg after a listing notice. Same gates as any entry (kill switch,
// per-trade risk, EXEC_TOKEN in live). The KR sell comes later via the normal
// kimchi flow once trading opens.
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { base?: string; sizeUsd?: number };
    const base = body.base?.toUpperCase();
    const sizeUsd = Number(body.sizeUsd ?? process.env.LISTING_BUY_USD ?? 500);
    if (!base) return NextResponse.json({ ok: false, message: "base 필요" }, { status: 400 });
    if (!(sizeUsd > 0)) return NextResponse.json({ ok: false, message: "규모가 0 이하" }, { status: 400 });
    if (isKilled()) return NextResponse.json({ ok: false, message: "킬 스위치 활성" }, { status: 423 });
    const risk = checkEntry(sizeUsd);
    if (risk) return NextResponse.json({ ok: false, message: `리스크 한도 — ${risk}` }, { status: 400 });
    if (!CONFIG.DRY_RUN) {
      const token = process.env.EXEC_TOKEN;
      if (!token || req.headers.get("x-exec-token") !== token) {
        return NextResponse.json({ ok: false, message: "인증 실패 (EXEC_TOKEN)" }, { status: 403 });
      }
    }

    const g = await globalVenueFor(base);
    if (!g) return NextResponse.json({ ok: false, message: `${base} 해외 미상장 — 매수 불가` });

    const r =
      g.venue === "binance" ? await binanceSpot(base, "BUY", { quoteUsd: sizeUsd })
      : g.venue === "bybit" ? await bybitOrder(base, "BUY", { quoteUsd: sizeUsd })
      : await okxOrder(base, "BUY", { quoteUsd: sizeUsd });

    const info = listingInfo(base);
    if (r.ok && !CONFIG.DRY_RUN) {
      void notifyNow(`✅ 상장따리 매수 — <b>${base}</b> $${sizeUsd} @ ${g.venue} (공지 ${info?.ageSec ?? "?"}s 전)`);
    }
    return NextResponse.json({ ok: r.ok, dryRun: r.dryRun, venue: g.venue, price: g.price, message: r.message });
  } catch (e) {
    return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "listing-buy failed" }, { status: 500 });
  }
}
