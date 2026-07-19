import { NextResponse } from "next/server";
import { CONFIG } from "@/lib/config";
import { isKilled } from "@/lib/killswitch";
import { checkEntry } from "@/lib/risk";
import { QUOTE_STABLES, approveDex, swapDex, quoteDex, dexConfigured } from "@/lib/dex";
import { sendRawEvmTx, sendSolRawTx, walletAddress } from "@/lib/wallet";
import { recordListingBuy } from "@/lib/listings";
import { resolveToken } from "@/lib/tokenResolve";
import { notifyNow } from "@/lib/telegram";
import { CHAINS } from "@/lib/chains";

export const dynamic = "force-dynamic";

const MAX_UINT = "115792089237316195423570985008687907853269984665640564039457584007913129639935";

// 상장따리 DEX 원클릭: CEX에 아직 없는(또는 더 싼) 토큰을 OKX Web3 스왑으로
// 즉시 매수. stable→token, 라우터 화이트리스트 + minReceive 보호. 컨트랙트는
// 서버가 CoinGecko에서 직접 재해석 — 클라이언트가 보낸 주소를 신뢰하지 않음.
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { base?: string; chain?: string; sizeUsd?: number };
    const base = body.base?.toUpperCase();
    const chain = body.chain;
    const sizeUsd = Number(body.sizeUsd ?? process.env.LISTING_BUY_USD ?? 500);
    if (!base || !chain) return NextResponse.json({ ok: false, message: "base + chain 필요" }, { status: 400 });
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

    const stable = QUOTE_STABLES[chain];
    if (!stable) return NextResponse.json({ ok: false, message: `미지원 체인: ${chain}` }, { status: 400 });

    // Server-side contract resolution — never trust a client-supplied address.
    const t = await resolveToken(base);
    const c = t?.contracts[chain as "ethereum" | "bsc" | "base" | "solana"];
    if (!c) return NextResponse.json({ ok: false, message: `${base}: ${chain} 컨트랙트 해석 실패` }, { status: 400 });
    const to = { address: c.address, decimals: c.decimals };

    if (CONFIG.DRY_RUN) {
      // Simulate with a real quote when keys allow — honest expected fill.
      const q = dexConfigured() ? await quoteDex(chain, stable, to, sizeUsd) : null;
      // No OKX keys in rehearsal → estimate from CoinGecko spot so the position
      // (and sell path) still threads through.
      const qty = q?.toAmount ?? (t?.priceUsd ? sizeUsd / t.priceUsd : null);
      recordListingBuy(base, {
        where: `dex:${chain}`, usd: sizeUsd, qty, price: qty ? sizeUsd / qty : t?.priceUsd ?? null, ts: Date.now(), dry: true,
      });
      return NextResponse.json({
        ok: true, dryRun: true, qty,
        message: q ? `DEX 매수 (모의) — 예상 ${q.toAmount.toFixed(4)} ${base}` : "DEX 매수 (모의) — OKX 키 없어 견적 생략",
      });
    }

    if (!dexConfigured()) return NextResponse.json({ ok: false, message: "OKX_WEB3 키 없음 — DEX 실행 불가" });

    // 솔라나: approve 불필요, OKX가 완성 tx를 주면 서명·전송만.
    if (chain === "solana") {
      const solAddr = process.env.WALLET_ADDR_SOL;
      if (!process.env.WALLET_SOL_KEY || !solAddr) return NextResponse.json({ ok: false, message: "SOL 지갑 키/주소 없음 (WALLET_SOL_KEY·WALLET_ADDR_SOL)" });
      const swapS = await swapDex(chain, stable, to, sizeUsd, CONFIG.MAX_SLIPPAGE_PCT / 100, solAddr);
      if (!swapS) return NextResponse.json({ ok: false, message: "SOL swap 캘리데이터 조회 실패" });
      const resS = await sendSolRawTx(swapS.data);
      if (!resS.ok) return NextResponse.json({ ok: false, message: `SOL swap 실패 — ${resS.message}` });
      const qtyS = Number(swapS.toAmount) / 10 ** to.decimals || null;
      recordListingBuy(base, { where: `dex:${chain}`, usd: sizeUsd, qty: qtyS, price: qtyS ? sizeUsd / qtyS : null, ts: Date.now(), dry: false, tx: resS.hash ?? undefined });
      void notifyNow(`✅ 상장따리 DEX 매수 — <b>${base}</b> $${sizeUsd} @ Solana\ntx: ${resS.hash}`);
      return NextResponse.json({ ok: true, dryRun: false, qty: qtyS, tx: resS.hash, message: `스왑 완료 — 예상 ${qtyS?.toFixed(4) ?? "?"} ${base}` });
    }

    const walletAddr = walletAddress();
    if (!walletAddr) return NextResponse.json({ ok: false, message: "개인지갑 키 없음 — 스왑 차단" });

    // 1) one-time approve for the stable we spend (idempotent; cheap if already set)
    const ap = await approveDex(chain, stable.address, MAX_UINT);
    if (!ap) return NextResponse.json({ ok: false, message: "approve 캘리데이터 조회 실패" });
    const apRes = await sendRawEvmTx({ chain, to: ap.to, data: ap.data }, [ap.to]);
    if (!apRes.ok) return NextResponse.json({ ok: false, message: `approve 실패 — ${apRes.message}` });

    // 2) swap stable → token
    const swap = await swapDex(chain, stable, to, sizeUsd, CONFIG.MAX_SLIPPAGE_PCT / 100, walletAddr);
    if (!swap) return NextResponse.json({ ok: false, message: "swap 캘리데이터 조회 실패" });
    const res = await sendRawEvmTx({ chain, to: swap.to, data: swap.data, value: swap.value, gas: swap.gas }, [swap.to]);
    if (!res.ok) return NextResponse.json({ ok: false, message: `swap 실패 — ${res.message}` });

    const qty = Number(swap.toAmount) / 10 ** to.decimals || null;
    recordListingBuy(base, { where: `dex:${chain}`, usd: sizeUsd, qty, price: qty ? sizeUsd / qty : null, ts: Date.now(), dry: false, tx: res.hash ?? undefined });
    void notifyNow(`✅ 상장따리 DEX 매수 — <b>${base}</b> $${sizeUsd} @ ${CHAINS[chain]?.label ?? chain}\ntx: ${res.hash}`);
    return NextResponse.json({ ok: true, dryRun: false, qty, tx: res.hash, message: `스왑 완료 — 예상 ${qty?.toFixed(4) ?? "?"} ${base}` });
  } catch (e) {
    return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "dex-buy failed" }, { status: 500 });
  }
}
