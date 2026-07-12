import { NextResponse } from "next/server";
import type { Opportunity } from "@/lib/types";
import { CONFIG } from "@/lib/config";
import { sendToken, walletAddress } from "@/lib/wallet";
import { chainKeyFromLabel } from "@/lib/chains";
import { fetchDepositAddress } from "@/lib/deposits";
import { binanceSpot, binancePerp, binanceWithdraw, upbitOrder, upbitWithdraw, bithumbOrder, bithumbWithdraw, checkDeposit } from "@/lib/orders";
import { tokenFor } from "@/lib/tokens";
import { getChain } from "@/lib/chains";
import type { StepId } from "@/lib/executionPlan";

// Our wallet's receive address on a chain family (for the withdraw destination).
function destAddr(chainKey: string): string {
  const fam = getChain(chainKey)?.family;
  if (fam === "xrp") return process.env.WALLET_ADDR_XRP || "(XRP 주소 미설정)";
  if (fam === "tron") return process.env.WALLET_ADDR_TRON || "(TRON 주소 미설정)";
  if (fam === "solana") return process.env.WALLET_ADDR_SOL || "(SOL 주소 미설정)";
  return walletAddress() ?? process.env.WALLET_ADDR_EVM ?? "(EVM 주소 미설정)";
}

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
async function runStep(stepId: StepId, opp: Opportunity, sizeUsd: number, opts?: { rollback?: boolean }): Promise<StepResult> {
  const dry = CONFIG.DRY_RUN;
  const buy = opp.legs.find((l) => l.side === "buy");
  const sell = opp.legs.find((l) => l.side === "sell");
  const bnPrice = opp.legs.find((l) => l.venue === "binance")?.price ?? 0;
  const qty = bnPrice ? sizeUsd / bnPrice : 0;

  if (opts?.rollback) return undoStep(stepId, opp, qty);

  switch (stepId) {
    case "buy": {
      if (buy?.venue === "binance") return await binanceSpot(opp.base, "BUY", { quoteUsd: sizeUsd });
      if (buy?.venue === "upbit") return await upbitOrder(opp.base, "bid", { priceKrw: qty * (buy.price || 0) });
      if (buy?.venue === "bithumb") return await bithumbOrder(opp.base, "bid", qty);
      return { ok: true, dryRun: dry, message: `${buy?.venue} ${opp.base} 매수 (모의) · 실주문 미배선` };
    }
    case "hedge":
      return await binancePerp(opp.base, "SHORT", qty);
    case "withdraw": {
      const chain = chainKeyFromLabel(opp.transfer?.network?.chain);
      const net = NET_LABEL[chain] ?? chain;
      const evm = getChain(chain)?.family === "evm";
      const destVenue = sell?.venue ?? "upbit";
      // EVM → personal wallet (hop). Non-EVM → destination exchange deposit addr (직접).
      let dest: string;
      let note = "";
      if (evm) {
        dest = destAddr(chain);
      } else {
        const fetched = await fetchDepositAddress(destVenue, opp.base, net);
        dest = fetched || process.env.WALLET_DEPOSIT_FALLBACK || "0xDEPOSIT_TODO";
        note = fetched ? ` → ${destVenue} 직접` : ` → ${destVenue} 직접 · 입금주소 미확인(키필요)`;
      }
      const call =
        buy?.venue === "binance" ? binanceWithdraw(opp.base, net, dest, qty)
        : buy?.venue === "upbit" ? upbitWithdraw(opp.base, net, dest, qty)
        : buy?.venue === "bithumb" ? bithumbWithdraw(opp.base, dest, qty)
        : null;
      if (!call) return { ok: true, dryRun: dry, message: `${buy?.venue} 출금 (모의) · 미지원 거래소` };
      const r = await call;
      return { ok: r.ok, dryRun: r.dryRun, message: `${r.message}${note}` };
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
      return await checkDeposit(sell?.venue ?? "upbit", opp.base);
    case "sell": {
      if (sell?.venue === "binance") return await binanceSpot(opp.base, "SELL", { qty });
      if (sell?.venue === "upbit") return await upbitOrder(opp.base, "ask", { volume: qty });
      if (sell?.venue === "bithumb") return await bithumbOrder(opp.base, "ask", qty);
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

// Compensating action to unwind an entry leg on partial-fill (buy/hedge only).
async function undoStep(stepId: StepId, opp: Opportunity, qty: number): Promise<StepResult> {
  const buy = opp.legs.find((l) => l.side === "buy");
  if (stepId === "buy") {
    if (buy?.venue === "binance") return await binanceSpot(opp.base, "SELL", { qty });
    if (buy?.venue === "upbit") return await upbitOrder(opp.base, "ask", { volume: qty });
    if (buy?.venue === "bithumb") return await bithumbOrder(opp.base, "ask", qty);
  }
  if (stepId === "hedge") return await binancePerp(opp.base, "CLOSE", qty);
  return { ok: true, dryRun: CONFIG.DRY_RUN, message: `${stepId} 롤백 불필요` };
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { stepId?: StepId; opportunity?: Opportunity; sizeUsd?: number; rollback?: boolean };
    if (!body.stepId || !body.opportunity) {
      return NextResponse.json({ ok: false, message: "stepId + opportunity 필요" }, { status: 400 });
    }
    const result = await runStep(body.stepId, body.opportunity, body.sizeUsd ?? 0, { rollback: !!body.rollback });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : "step failed" },
      { status: 500 },
    );
  }
}
