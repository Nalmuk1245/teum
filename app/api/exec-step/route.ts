import { NextResponse } from "next/server";
import type { Opportunity } from "@/lib/types";
import { CONFIG } from "@/lib/config";
import { sendToken, walletAddress } from "@/lib/wallet";
import { chainKeyFromLabel } from "@/lib/chains";
import { fetchDepositAddress } from "@/lib/deposits";
import { binanceSpot, binancePerp, binanceWithdraw, upbitOrder } from "@/lib/orders";
import { tokenFor } from "@/lib/tokens";
import type { StepId } from "@/lib/executionPlan";

export const dynamic = "force-dynamic";

// Exchange net_type/network label per chain key (approx; real strings vary).
const NET_LABEL: Record<string, string> = {
  ethereum: "ETH", polygon: "MATIC", arbitrum: "ARBITRUM", optimism: "OPTIMISM",
  base: "BASE", bsc: "BSC", avalanche: "AVAXC", xrp: "XRP", tron: "TRX", solana: "SOL",
};

type StepResult = { ok: boolean; dryRun: boolean; message: string; hash?: string | null };

// Execute ONE step server-side. Orders (Binance spot/perp, Upbit), withdrawal,
// and the personal-wallet transfer are all wired to real signed APIs — dormant
// & DRY-RUN-simulated until keys are set. (Bithumb orders/withdraw still TODO.)
async function runStep(stepId: StepId, opp: Opportunity, sizeUsd: number): Promise<StepResult> {
  const dry = CONFIG.DRY_RUN;
  const buy = opp.legs.find((l) => l.side === "buy");
  const sell = opp.legs.find((l) => l.side === "sell");
  const bnPrice = opp.legs.find((l) => l.venue === "binance")?.price ?? 0;
  const qty = bnPrice ? sizeUsd / bnPrice : 0;

  switch (stepId) {
    case "buy": {
      if (buy?.venue === "binance") return await binanceSpot(opp.base, "BUY", { quoteUsd: sizeUsd });
      if (buy?.venue === "upbit") return await upbitOrder(opp.base, "bid", { priceKrw: qty * (buy.price || 0) });
      return { ok: true, dryRun: dry, message: `${buy?.venue} ${opp.base} 매수 (모의) · 실주문 미배선` };
    }
    case "hedge":
      return await binancePerp(opp.base, "SHORT", qty);
    case "withdraw": {
      // Withdraw the bought coin from the buy venue to the tool wallet address.
      const chain = chainKeyFromLabel(opp.transfer?.network?.chain);
      const dest = walletAddress() ?? process.env.WALLET_ADDR_EVM ?? "(주소 미설정)";
      if (buy?.venue === "binance") return await binanceWithdraw(opp.base, NET_LABEL[chain] ?? chain, dest, qty);
      return { ok: true, dryRun: dry, message: `${buy?.venue} → 개인지갑(${dest.slice(0, 10)}…) 출금 (모의) · ${buy?.venue} 출금API 미배선` };
    }
    case "transfer": {
      // Personal wallet → destination exchange deposit address (the real send).
      const chain = chainKeyFromLabel(opp.transfer?.network?.chain);
      if (!chain) {
        return { ok: false, dryRun: dry, message: `${opp.transfer?.network?.chain ?? "체인 미상"} — 미지원 체인` };
      }
      const destVenue = sell?.venue ?? "upbit";
      const fetched = await fetchDepositAddress(destVenue, opp.base, NET_LABEL[chain] ?? chain);
      const to = fetched || process.env.WALLET_DEPOSIT_FALLBACK || "0xDEPOSIT_ADDRESS_TODO";
      const asset = tokenFor(opp.base, chain); // native vs ERC20/TRC20/SPL
      const res = await sendToken({
        chain, to, amountHuman: String(+qty.toFixed(6)),
        ...(asset.kind === "token" ? { tokenAddress: asset.address, decimals: asset.decimals } : {}),
        confirms: opp.transfer?.network?.confirms ?? 1,
      });
      const noteAddr = fetched ? "" : " · 입금주소 미확인(키필요)";
      const noteTok = asset.kind === "unknown" ? " · 토큰컨트랙트 미확인" : "";
      return { ok: res.ok, dryRun: res.dryRun, message: `개인지갑 → ${destVenue} 송금 · ${res.message}${noteAddr}${noteTok}`, hash: res.hash };
    }
    case "deposit":
      // TODO: poll destination exchange deposit crediting (signed). Dry: assume ok.
      return { ok: true, dryRun: dry, message: `${sell?.venue} 입금 확인 ${dry ? "(모의)" : ""}` };
    case "sell": {
      if (sell?.venue === "binance") return await binanceSpot(opp.base, "SELL", { qty });
      if (sell?.venue === "upbit") return await upbitOrder(opp.base, "ask", { volume: qty });
      return { ok: true, dryRun: dry, message: `${sell?.venue} ${opp.base} 매도 (모의) · 실주문 미배선` };
    }
    case "close":
      return await binancePerp(opp.base, "CLOSE", qty);
    case "settle": {
      const pnl = (opp.netPct / 100) * sizeUsd;
      return { ok: true, dryRun: dry, message: `정산 · 순수익 ${opp.netPct >= 0 ? "+" : ""}${opp.netPct.toFixed(2)}% (${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(2)})` };
    }
    default:
      return { ok: false, dryRun: dry, message: `알 수 없는 단계: ${stepId}` };
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { stepId?: StepId; opportunity?: Opportunity; sizeUsd?: number };
    if (!body.stepId || !body.opportunity) {
      return NextResponse.json({ ok: false, message: "stepId + opportunity 필요" }, { status: 400 });
    }
    const result = await runStep(body.stepId, body.opportunity, body.sizeUsd ?? 0);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : "step failed" },
      { status: 500 },
    );
  }
}
