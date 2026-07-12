import { NextResponse } from "next/server";
import type { Opportunity } from "@/lib/types";
import { CONFIG, TAG_REQUIRED } from "@/lib/config";
import { sendToken, walletAddress } from "@/lib/wallet";
import { chainKeyFromLabel, getChain } from "@/lib/chains";
import { fetchDepositAddress } from "@/lib/deposits";
import { binanceSpot, binancePerp, binanceWithdraw, upbitOrder, upbitWithdraw, bithumbOrder, bithumbWithdraw, checkDeposit } from "@/lib/orders";
import { tokenFor } from "@/lib/tokens";
import type { StepId } from "@/lib/executionPlan";

export const dynamic = "force-dynamic";

// Exchange net_type/network label per chain key (approx; real strings vary).
const NET_LABEL: Record<string, string> = {
  ethereum: "ETH", polygon: "MATIC", arbitrum: "ARBITRUM", optimism: "OPTIMISM",
  base: "BASE", bsc: "BSC", avalanche: "AVAXC", xrp: "XRP", tron: "TRX", solana: "SOL",
};

// Our wallet's receive address on a chain family (for the withdraw destination).
function destAddr(chainKey: string): string | null {
  const fam = getChain(chainKey)?.family;
  if (fam === "xrp") return process.env.WALLET_ADDR_XRP || null;
  if (fam === "tron") return process.env.WALLET_ADDR_TRON || null;
  if (fam === "solana") return process.env.WALLET_ADDR_SOL || null;
  return walletAddress() ?? process.env.WALLET_ADDR_EVM ?? null;
}

type StepResult = { ok: boolean; dryRun: boolean; message: string; hash?: string | null; filledQty?: number };
const fail = (message: string): StepResult => ({ ok: false, dryRun: CONFIG.DRY_RUN, message });
// A step we haven't wired: fine to no-op in DRY_RUN, but in live mode a silent
// pass would let the machine run real orders around a hole — hard fail.
const unwired = (message: string): StepResult =>
  CONFIG.DRY_RUN
    ? { ok: true, dryRun: true, message: `${message} (모의) · 실주문 미배선` }
    : { ok: false, dryRun: false, message: `실행 불가 — ${message} 미배선` };

// Execute ONE step server-side. Orders (Binance spot/perp, Upbit, Bithumb),
// withdrawal, deposit polling and the personal-wallet transfer are wired to real
// signed APIs — dormant & DRY-RUN-simulated until keys are set.
// `qty` = the actual quantity carried from the previous step (fill-adjusted).
async function runStep(
  stepId: StepId, opp: Opportunity, sizeUsd: number,
  opts: { rollback?: boolean; qty?: number; sinceTs?: number },
): Promise<StepResult> {
  const dry = CONFIG.DRY_RUN;
  const buy = opp.legs.find((l) => l.side === "buy");
  const sell = opp.legs.find((l) => l.side === "sell");
  const bnPrice = opp.legs.find((l) => l.venue === "binance")?.price ?? 0;
  // Prefer the fill-adjusted qty threaded from prior steps; fall back to nominal.
  const qty = opts.qty ?? (bnPrice ? sizeUsd / bnPrice : 0);
  if (qty <= 0) return fail("수량 0 — 이전 단계 체결량 없음");

  if (opts.rollback) return undoStep(stepId, opp, qty);

  switch (stepId) {
    case "buy": {
      if (buy?.venue === "binance") return await binanceSpot(opp.base, "BUY", { quoteUsd: sizeUsd });
      if (buy?.venue === "upbit") return await upbitOrder(opp.base, "bid", { priceKrw: qty * (buy.price || 0) });
      if (buy?.venue === "bithumb") return await bithumbOrder(opp.base, "bid", qty);
      return unwired(`${buy?.venue} ${opp.base} 매수`);
    }
    case "hedge":
      return await binancePerp(opp.base, "SHORT", qty);
    case "withdraw": {
      const chain = chainKeyFromLabel(opp.transfer?.network?.chain);
      // Live: an unresolvable chain must never fall through to a guessed
      // network/address — wrong-chain sends are permanent loss.
      if (!chain) {
        return dry
          ? { ok: true, dryRun: true, message: `${buy?.venue} 출금 (모의) · 체인 미상 — 라이브면 차단됨` }
          : fail(`체인 미상(${opp.transfer?.network?.chain ?? "?"}) — 출금 차단`);
      }
      const net = NET_LABEL[chain] ?? chain;
      const evm = getChain(chain)?.family === "evm";
      const destVenue = sell?.venue ?? "upbit";
      let dest: string | null;
      let tag: string | null = null;
      let note = "";
      if (evm) {
        dest = destAddr(chain); // personal-wallet hop
      } else {
        // Direct exchange→exchange: use the destination's real deposit address+tag.
        const fetched = await fetchDepositAddress(destVenue, opp.base, net);
        dest = fetched?.address ?? null;
        tag = fetched?.tag ?? null;
        note = ` → ${destVenue} 직접`;
      }
      if (!dest) {
        return dry
          ? { ok: true, dryRun: true, message: `${buy?.venue} 출금${note} (모의) · 주소 미확인(키 필요) — 라이브면 차단됨` }
          : fail(`출금 주소 미확인 — 차단`);
      }
      // Tag/memo-required coins: sending WITHOUT the tag lands uncredited in the
      // exchange omnibus wallet. Hard requirement — never send tagless.
      if (TAG_REQUIRED.has(opp.base) && !evm && !tag) {
        return dry
          ? { ok: true, dryRun: true, message: `${buy?.venue} 출금${note} (모의) · ⚠ ${opp.base}는 태그 필수 — 태그 미확인, 라이브면 차단됨` }
          : fail(`${opp.base}는 데스티네이션 태그 필수 — 태그 미확인, 출금 차단`);
      }
      const call =
        buy?.venue === "binance" ? binanceWithdraw(opp.base, net, dest, qty, tag ?? undefined)
        : buy?.venue === "upbit" ? upbitWithdraw(opp.base, net, dest, qty, tag ?? undefined)
        : buy?.venue === "bithumb" ? bithumbWithdraw(opp.base, dest, qty, tag ?? undefined)
        : null;
      if (!call) return unwired(`${buy?.venue} 출금`);
      const r = await call;
      return { ok: r.ok, dryRun: r.dryRun, message: `${r.message}${note}` };
    }
    case "transfer": {
      // Personal wallet → destination exchange deposit address (EVM hop only).
      const chain = chainKeyFromLabel(opp.transfer?.network?.chain);
      if (!chain) return fail(`${opp.transfer?.network?.chain ?? "체인 미상"} — 미지원 체인`);
      const destVenue = sell?.venue ?? "upbit";
      const fetched = await fetchDepositAddress(destVenue, opp.base, NET_LABEL[chain] ?? chain);
      // Live: never substitute a fallback destination for a real send.
      if (!fetched?.address && !dry) return fail("입금주소 미확인 — 송금 차단");
      if (TAG_REQUIRED.has(opp.base) && !fetched?.tag && !dry) return fail(`${opp.base} 태그 필수 — 태그 미확인, 송금 차단`);
      const to = fetched?.address || "0xDRYRUN_DEST";
      const asset = tokenFor(opp.base, chain); // native vs ERC20/TRC20/SPL
      if (asset.kind === "unknown" && !dry) return fail(`${opp.base} 토큰 컨트랙트 미확인 — 송금 차단`);
      const res = await sendToken({
        chain, to, amountHuman: String(+qty.toFixed(6)),
        tag: fetched?.tag ?? undefined,
        ...(asset.kind === "token" ? { tokenAddress: asset.address, decimals: asset.decimals } : {}),
        confirms: opp.transfer?.network?.confirms ?? 1,
      });
      const noteAddr = fetched?.address ? "" : " · 입금주소 미확인(키필요)";
      return { ok: res.ok, dryRun: res.dryRun, message: `개인지갑 → ${destVenue} 송금 · ${res.message}${noteAddr}`, hash: res.hash };
    }
    case "deposit":
      return await checkDeposit(sell?.venue ?? "upbit", opp.base, opts.sinceTs ?? Date.now() - 60 * 60 * 1000);
    case "sell": {
      if (sell?.venue === "binance") return await binanceSpot(opp.base, "SELL", { qty });
      if (sell?.venue === "upbit") return await upbitOrder(opp.base, "ask", { volume: qty });
      if (sell?.venue === "bithumb") return await bithumbOrder(opp.base, "ask", qty);
      return unwired(`${sell?.venue} ${opp.base} 매도`);
    }
    case "close":
      return await binancePerp(opp.base, "CLOSE", qty);
    case "settle": {
      const pnl = (opp.netPct / 100) * sizeUsd;
      return { ok: true, dryRun: dry, message: `정산 · 순수익 ${opp.netPct >= 0 ? "+" : ""}${opp.netPct.toFixed(2)}% (${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(2)}) · 추정치` };
    }
    default:
      return fail(`알 수 없는 단계: ${stepId}`);
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
    const body = (await req.json()) as {
      stepId?: StepId; opportunity?: Opportunity; sizeUsd?: number;
      rollback?: boolean; qty?: number; sinceTs?: number;
    };
    if (!body.stepId || !body.opportunity) {
      return NextResponse.json({ ok: false, message: "stepId + opportunity 필요" }, { status: 400 });
    }
    // Live mode: mock opportunities carry made-up prices — never execute them
    // against real APIs. (DRY_RUN lets them through for demo flow.)
    if (body.opportunity.mock && !CONFIG.DRY_RUN) {
      return NextResponse.json({ ok: false, message: "목업 기회는 실행 불가" }, { status: 400 });
    }
    // Live mode: money-moving endpoint requires the shared token (EXEC_TOKEN).
    if (!CONFIG.DRY_RUN) {
      const token = process.env.EXEC_TOKEN;
      if (!token) return NextResponse.json({ ok: false, message: "라이브 모드에는 EXEC_TOKEN 설정 필수" }, { status: 403 });
      if (req.headers.get("x-exec-token") !== token) {
        return NextResponse.json({ ok: false, message: "인증 실패" }, { status: 403 });
      }
    }
    const result = await runStep(body.stepId, body.opportunity, body.sizeUsd ?? 0, {
      rollback: !!body.rollback, qty: body.qty, sinceTs: body.sinceTs,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : "step failed" },
      { status: 500 },
    );
  }
}
