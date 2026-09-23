import { NextResponse } from "next/server";
import { CONFIG } from "@/lib/config";
import { isKilled } from "@/lib/killswitch";
import { checkEntry } from "@/lib/risk";
import { binanceSpot, bybitOrder, okxOrder } from "@/lib/orders";
import { globalVenueFor, listingInfo, recordListingBuy, listingSlipGate } from "@/lib/listings";
import { notifyNow } from "@/lib/telegram";

export const dynamic = "force-dynamic";

// 상장따리 원클릭: buy `base` on the cheapest global CEX RIGHT NOW — the
// front-run leg after a listing notice. Same gates as any entry (kill switch,
// per-trade risk, EXEC_TOKEN in live). The KR sell comes later via the normal
// kimchi flow once trading opens.
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { base?: string; sizeUsd?: number; venue?: string };
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

    // Explicit venue wins; otherwise cheapest global right now.
    let venue = body.venue?.toLowerCase();
    let price: number | null = null;
    if (venue && !["binance", "bybit", "okx"].includes(venue)) {
      return NextResponse.json({ ok: false, message: `지원 안 하는 거래소: ${venue}` }, { status: 400 });
    }
    // 티커 충돌 방어 — 요청한 거래소가 다른 거래소들과 가격이 크게 다르면 다른 토큰이다.
    const g = await globalVenueFor(base);
    if (venue && g?.outliers?.includes(venue) && !g.ambiguous) {
      return NextResponse.json({ ok: false, message: `${venue}의 ${base}는 다른 거래소와 가격이 크게 달라 다른 토큰으로 보입니다 — 매수 차단 (합의: ${g.venue} @ ${g.price})` }, { status: 409 });
    }
    if (!venue) {
      if (!g) return NextResponse.json({ ok: false, message: `${base} 해외 미상장 — 매수 불가` });
      if (g.ambiguous) return NextResponse.json({ ok: false, message: `${base} 해외 거래소 가격이 서로 달라 어느 게 맞는 토큰인지 불명 — 거래소를 직접 지정하세요` }, { status: 409 });
      venue = g.venue; price = g.price;
    } else {
      // Explicit venue — grab its price so DRY runs still record a usable qty.
      try {
        const url =
          venue === "binance" ? `https://api.binance.com/api/v3/ticker/price?symbol=${base}USDT`
          : venue === "bybit" ? `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${base}USDT`
          : `https://www.okx.com/api/v5/market/ticker?instId=${base}-USDT`;
        const j = await (await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(3000) })).json();
        const p = venue === "binance" ? Number(j.price) : venue === "bybit" ? Number(j.result?.list?.[0]?.lastPrice) : Number(j.data?.[0]?.last);
        if (p > 0) price = p;
      } catch { /* record without price */ }
    }

    // 엔진 경로와 같은 슬리피지 상한 — 원클릭도 얇은 호가에 시장가를 던지지 않는다.
    const slip = await listingSlipGate(venue, base, sizeUsd);
    if (slip) return NextResponse.json({ ok: false, message: `슬리피지 게이트 — ${slip}` }, { status: 409 });

    const r =
      venue === "binance" ? await binanceSpot(base, "BUY", { quoteUsd: sizeUsd })
      : venue === "bybit" ? await bybitOrder(base, "BUY", { quoteUsd: sizeUsd })
      : await okxOrder(base, "BUY", { quoteUsd: sizeUsd });

    const info = listingInfo(base);
    if (r.ok) {
      // DRY sims report no fill — estimate from the live ticker so position
      // tracking (and the sell path) still works end-to-end in rehearsal.
      const qty = r.filledQty ?? (r.dryRun && price ? sizeUsd / price : null);
      recordListingBuy(base, {
        where: venue, usd: sizeUsd, qty,
        price: r.filledQty ? sizeUsd / r.filledQty : price, ts: Date.now(), dry: !!r.dryRun,
      });
      if (!CONFIG.DRY_RUN) {
        void notifyNow(`✅ 상장따리 매수 — <b>${base}</b> $${sizeUsd} @ ${venue} (공지 ${info?.ageSec ?? "?"}s 전)`);
      }
    }
    return NextResponse.json({ ok: r.ok, dryRun: r.dryRun, venue, price, qty: r.filledQty ?? (r.dryRun && price ? sizeUsd / price : null), message: r.message });
  } catch (e) {
    return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "listing-buy failed" }, { status: 500 });
  }
}
