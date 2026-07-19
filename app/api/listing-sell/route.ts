import { NextResponse } from "next/server";
import { CONFIG } from "@/lib/config";
import { isKilled } from "@/lib/killswitch";
import { binanceSpot, bybitOrder, okxOrder, upbitOrder, bithumbOrder } from "@/lib/orders";
import { getPlay, recordListingSell } from "@/lib/listings";
import { CEXDEX_CHAINS, swapDex, dexConfigured } from "@/lib/dex";
import { sendRawEvmTx, walletAddress } from "@/lib/wallet";
import { resolveToken } from "@/lib/tokenResolve";
import { recordTrade } from "@/lib/trades";
import { notifyNow } from "@/lib/telegram";

export const dynamic = "force-dynamic";

// 상장따리 원클릭 매도 — 산 곳에서 되팔거나(펌핑 실현) 업비트 개장 후 KR 매도.
// qty를 안 주면 이 플레이에서 기록된 매수 수량 합(− 기매도)을 다 판다.
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { base?: string; where?: string; qty?: number };
    const base = body.base?.toUpperCase();
    const where = body.where?.toLowerCase();
    if (!base || !where) return NextResponse.json({ ok: false, message: "base + where 필요" }, { status: 400 });
    if (isKilled()) return NextResponse.json({ ok: false, message: "킬 스위치 활성" }, { status: 423 });
    if (!CONFIG.DRY_RUN) {
      const token = process.env.EXEC_TOKEN;
      if (!token || req.headers.get("x-exec-token") !== token) {
        return NextResponse.json({ ok: false, message: "인증 실패 (EXEC_TOKEN)" }, { status: 403 });
      }
    }

    const play = getPlay(base);
    const bought = (play?.buys ?? []).reduce((s, b) => s + (b.qty ?? 0), 0);
    const sold = (play?.sells ?? []).reduce((s, b) => s + (b.qty ?? 0), 0);
    const qty = Number(body.qty ?? Math.max(0, bought - sold));
    if (!(qty > 0)) return NextResponse.json({ ok: false, message: "매도 수량 0 — 기록된 포지션 없음 (qty 직접 지정 가능)" }, { status: 400 });

    let ok = false, dryRun = CONFIG.DRY_RUN, proceeds: number | null = null, message = "", tx: string | undefined;

    if (where.startsWith("dex:")) {
      const chain = where.slice(4);
      const uni = CEXDEX_CHAINS.find((u) => u.chain === chain);
      if (!uni) return NextResponse.json({ ok: false, message: `미지원 체인: ${chain}` }, { status: 400 });
      const t = await resolveToken(base);
      const c = t?.contracts[chain as "ethereum" | "bsc" | "base"];
      if (!c) return NextResponse.json({ ok: false, message: `${base}: ${chain} 컨트랙트 해석 실패` }, { status: 400 });
      if (CONFIG.DRY_RUN) {
        ok = true; message = `DEX 매도 (모의) — ${qty} ${base} → ${uni.quote.symbol}`;
        proceeds = t?.priceUsd ? qty * t.priceUsd : null;
      } else {
        if (!dexConfigured()) return NextResponse.json({ ok: false, message: "OKX_WEB3 키 없음" });
        const walletAddr = walletAddress();
        if (!walletAddr) return NextResponse.json({ ok: false, message: "개인지갑 키 없음" });
        const swap = await swapDex(chain, { address: c.address, decimals: c.decimals }, uni.quote, qty, CONFIG.MAX_SLIPPAGE_PCT / 100, walletAddr);
        if (!swap) return NextResponse.json({ ok: false, message: "swap 캘리데이터 조회 실패" });
        const res = await sendRawEvmTx({ chain, to: swap.to, data: swap.data, value: swap.value, gas: swap.gas }, [swap.to]);
        ok = res.ok; dryRun = false; message = res.message ?? ""; tx = res.hash ?? undefined;
        proceeds = Number(swap.toAmount) / 10 ** uni.quote.decimals || null;
      }
    } else {
      const r =
        where === "binance" ? await binanceSpot(base, "SELL", { qty })
        : where === "bybit" ? await bybitOrder(base, "SELL", { qty })
        : where === "okx" ? await okxOrder(base, "SELL", { qty })
        : where === "upbit" ? await upbitOrder(base, "ask", { volume: qty })
        : where === "bithumb" ? await bithumbOrder(base, "ask", qty)
        : null;
      if (!r) return NextResponse.json({ ok: false, message: `지원 안 하는 매도처: ${where}` }, { status: 400 });
      ok = r.ok; dryRun = !!r.dryRun; message = r.message ?? "";
      proceeds = r.quoteFilled ?? null; // KR venues: KRW — recorded as-is with note
    }

    if (ok) {
      recordListingSell(base, { where, usd: proceeds ?? 0, qty, price: proceeds ? proceeds / qty : null, ts: Date.now(), dry: dryRun, tx: tx ?? undefined });
      const buyUsd = (play?.buys ?? []).reduce((s, b) => s + b.usd, 0);
      const boughtQty = (play?.buys ?? []).reduce((s, b) => s + (b.qty ?? 0), 0);
      // tx 이력: 이 플레이의 온체인 매수 + 이번 매도.
      const txList = [
        ...(play?.buys ?? []).filter((b) => b.tx).map((b) => ({ step: `매수 ${b.where}`, hash: b.tx!, url: null })),
        ...(tx ? [{ step: `매도 ${where}`, hash: tx, url: null }] : []),
      ];
      void recordTrade({
        ts: Date.now(), base, kind: "listing", route: `${play?.buys?.[0]?.where ?? "?"} → ${where}`,
        sizeUsd: buyUsd || qty * (proceeds && qty ? proceeds / qty : 0),
        detectedNetPct: play?.peakPct ?? 0,
        realizedNetPct: !dryRun && proceeds != null && buyUsd > 0 && !where.startsWith("upbit") && !where.startsWith("bithumb")
          ? ((proceeds - buyUsd) / buyUsd) * 100 : null,
        realizedPnlUsd: !dryRun && proceeds != null && buyUsd > 0 && !["upbit", "bithumb"].includes(where)
          ? proceeds - buyUsd : null,
        hedged: false, dryRun, status: "done", note: "상장따리",
        qty: qty > 0 ? qty : null,
        entryPriceUsd: boughtQty > 0 && buyUsd > 0 ? buyUsd / boughtQty : null,
        exitPriceUsd: proceeds != null && qty > 0 ? proceeds / qty : null,
        buyUsd: buyUsd > 0 ? buyUsd : null,
        sellUsd: proceeds,
        spotPnlUsd: proceeds != null && buyUsd > 0 ? proceeds - buyUsd : null,
        txs: txList.length ? txList : undefined,
      });
      if (!dryRun) void notifyNow(`💰 상장따리 매도 — <b>${base}</b> ${qty} @ ${where}${tx ? `\ntx: ${tx}` : ""}`);
    }
    return NextResponse.json({ ok, dryRun, qty, proceeds, tx, message });
  } catch (e) {
    return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "listing-sell failed" }, { status: 500 });
  }
}
