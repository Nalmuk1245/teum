import { NextResponse } from "next/server";
import type { Opportunity } from "@/lib/types";
import { CONFIG } from "@/lib/config";
import { sendToken, walletAddress } from "@/lib/wallet";
import { chainKeyFromLabel } from "@/lib/chains";
import { fetchDepositAddress } from "@/lib/deposits";
import type { StepId } from "@/lib/executionPlan";

export const dynamic = "force-dynamic";

// Exchange net_type/network label per chain key (approx; real strings vary).
const NET_LABEL: Record<string, string> = {
  ethereum: "ETH", polygon: "MATIC", arbitrum: "ARBITRUM", optimism: "OPTIMISM",
  base: "BASE", bsc: "BSC", avalanche: "AVAXC", xrp: "XRP", tron: "TRX", solana: "SOL",
};

type StepResult = { ok: boolean; dryRun: boolean; message: string; hash?: string | null };

// Execute ONE step server-side. Orders/withdraw are TODO stubs (dry-simulated);
// the `transfer` step runs the real personal-wallet send path (dormant w/o keys).
async function runStep(stepId: StepId, opp: Opportunity, sizeUsd: number): Promise<StepResult> {
  const dry = CONFIG.DRY_RUN;
  const buy = opp.legs.find((l) => l.side === "buy");
  const sell = opp.legs.find((l) => l.side === "sell");
  const bnPrice = opp.legs.find((l) => l.venue === "binance")?.price ?? 0;
  const qty = bnPrice ? sizeUsd / bnPrice : 0;

  switch (stepId) {
    case "buy":
      // TODO: real spot buy (Binance/Upbit signed). Dry-simulated.
      return { ok: true, dryRun: dry, message: `${buy?.venue} ${opp.base} 매수 ${dry ? "(모의)" : ""}` };
    case "hedge":
      // TODO: Binance USDT-M short (signed).
      return { ok: true, dryRun: dry, message: `Binance ${opp.base} 숏 진입 ${dry ? "(모의)" : ""}` };
    case "withdraw": {
      // TODO: real exchange withdrawal (Binance /sapi/v1/capital/withdraw) to the
      // tool wallet address. Whitelist THIS address on the exchange first.
      const addr = walletAddress() ?? "(지갑 키 없음)";
      return { ok: true, dryRun: dry, message: `${buy?.venue} → 개인지갑(${addr.slice(0, 10)}…) 출금 ${dry ? "(모의)" : ""}` };
    }
    case "transfer": {
      // Personal wallet → destination exchange deposit address (the real send).
      const chain = chainKeyFromLabel(opp.transfer?.network?.chain);
      if (!chain) {
        return { ok: false, dryRun: dry, message: `${opp.transfer?.network?.chain ?? "체인 미상"} — 미지원 체인` };
      }
      // Resolve the SELL venue's deposit address for this coin/network (signed).
      const destVenue = sell?.venue ?? "upbit";
      const net = NET_LABEL[chain] ?? chain;
      const fetched = await fetchDepositAddress(destVenue, opp.base, net);
      const to = fetched || process.env.WALLET_DEPOSIT_FALLBACK || "0xDEPOSIT_ADDRESS_TODO";
      const res = await sendToken({
        chain,
        to,
        amountHuman: String(+qty.toFixed(6)),
        // TODO: per-coin ERC20/TRC20/SPL contract + decimals; omit → native (fine in dry)
        confirms: opp.transfer?.network?.confirms ?? 1,
      });
      const note = fetched ? "" : " · 입금주소 미확인(키 필요)";
      return { ok: res.ok, dryRun: res.dryRun, message: `개인지갑 → ${destVenue} 송금 · ${res.message}${note}`, hash: res.hash };
    }
    case "deposit":
      // TODO: poll destination exchange deposit crediting (signed).
      return { ok: true, dryRun: dry, message: `${sell?.venue} 입금 확인 ${dry ? "(모의)" : ""}` };
    case "sell":
      return { ok: true, dryRun: dry, message: `${sell?.venue} ${opp.base} 매도 ${dry ? "(모의)" : ""}` };
    case "close":
      return { ok: true, dryRun: dry, message: `Binance 숏 청산 ${dry ? "(모의)" : ""}` };
    case "settle":
      return { ok: true, dryRun: dry, message: "정산 완료" };
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
