import { NextResponse } from "next/server";
import type { Opportunity } from "@/lib/types";
import { CONFIG, TAG_REQUIRED } from "@/lib/config";
import { sendToken, walletAddress } from "@/lib/wallet";
import { BINANCE_NET, chainKeyFromLabel, getChain, isGlobal, isKr } from "@/lib/chains";
import { fetchDepositAddress } from "@/lib/deposits";
import { binanceSpot, binancePerp, binanceFuturesFree, binanceWithdraw, binanceWithdrawTx, upbitOrder, upbitWithdraw, upbitWithdrawTx, bithumbOrder, bithumbWithdraw, bybitOrder, bybitWithdraw, okxOrder, okxWithdraw, checkDeposit } from "@/lib/orders";
import { tokenFor } from "@/lib/tokens";
import { dexConfigured, approveDex, swapDex, CEXDEX_CHAINS } from "@/lib/dex";
import { sendRawEvmTx } from "@/lib/wallet";
import { isKilled } from "@/lib/killswitch";
import { checkEntry, recordPnl } from "@/lib/risk";
import { notifyNow } from "@/lib/telegram";
import { recordTrade } from "@/lib/trades";
import { estimateLegSlippage } from "@/lib/quote";
import { withdrawFeeCoin } from "@/lib/networks";
import { fetchUsdKrw } from "@/lib/exchanges";
import type { StepId } from "@/lib/executionPlan";

export const dynamic = "force-dynamic";

const NET_LABEL = BINANCE_NET; // shared exchange network codes

// Idempotency cache — successful step results by run:step key, 10min TTL.
const gi = globalThis as unknown as { __arbIdem?: Map<string, { r: StepResult; ts: number }> };
gi.__arbIdem ??= new Map();
function idemGet(key: string): StepResult | null {
  const hit = gi.__arbIdem!.get(key);
  if (!hit || Date.now() - hit.ts > 10 * 60_000) return null;
  return hit.r;
}
function idemSet(key: string, r: StepResult) {
  gi.__arbIdem!.set(key, { r, ts: Date.now() });
  if (gi.__arbIdem!.size > 500) { // bound
    const oldest = [...gi.__arbIdem!.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) gi.__arbIdem!.delete(oldest[0]);
  }
}

// Our wallet's receive address on a chain family (for the withdraw destination).
function destAddr(chainKey: string): string | null {
  const fam = getChain(chainKey)?.family;
  if (fam === "xrp") return process.env.WALLET_ADDR_XRP || null;
  if (fam === "tron") return process.env.WALLET_ADDR_TRON || null;
  if (fam === "solana") return process.env.WALLET_ADDR_SOL || null;
  return walletAddress() ?? process.env.WALLET_ADDR_EVM ?? null;
}

// cex-dex: resolve the DEX chain + token/stable contracts from the opp's dex
// leg symbol ("BASE/QUOTE@chain"). Uses the detection universe (CEXDEX_CHAINS).
function dexTarget(opp: Opportunity, dexLeg?: { symbol: string }) {
  const chainKey = dexLeg?.symbol?.split("@")[1];
  const uni = CEXDEX_CHAINS.find((u) => u.chain === chainKey);
  const token = uni?.bases[opp.base];
  const stable = uni?.quote;
  return { chainKey: uni ? chainKey : undefined, token, stable };
}
const chainLabelOf = (chainKey: string) => getChain(chainKey)?.label ?? chainKey;

type StepResult = {
  ok: boolean; dryRun: boolean; message: string; filledQty?: number;
  /** Real fill of this leg: base qty + quote amount in `ccy` (settle uses it). */
  fill?: { qty?: number; quote?: number; ccy?: string };
  /** On-chain tx of this step + explorer link (null link when simulated). */
  tx?: { hash: string; url: string | null };
};
// Explorer link for a tx on the opp's transfer chain.
function txInfo(chainLabel: string | undefined, hash: string | null | undefined, dry: boolean) {
  if (!hash) return undefined;
  const chain = getChain(chainKeyFromLabel(chainLabel));
  const url = !dry && chain?.explorer ? `${chain.explorer}${hash}` : null;
  return { hash, url };
}
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
  opts: {
    rollback?: boolean; qty?: number; sinceTs?: number;
    fills?: { buyQuote?: number; buyCcy?: string; buyQty?: number; sellQuote?: number; sellCcy?: string; sellQty?: number; hedgeOpenQuote?: number; hedgeCloseQuote?: number };
    txs?: { step: string; hash: string; url: string | null }[];
    durations?: Record<string, number>;
  },
): Promise<StepResult> {
  const dry = CONFIG.DRY_RUN;
  const buy = opp.legs.find((l) => l.side === "buy");
  const sell = opp.legs.find((l) => l.side === "sell");
  // USD price of the coin from any USDT-quoted leg — works for kimchi (global
  // leg), cross-cex (both USDT, no binance leg), and cex-dex alike. NOT tied to
  // Binance, so a bybit↔okx cross derives size correctly.
  const usdPrice = opp.legs.find((l) => l.quote === "USDT")?.price ?? 0;
  // Prefer the fill-adjusted qty threaded from prior steps; fall back to nominal.
  const qty = opts.qty ?? (usdPrice ? sizeUsd / usdPrice : 0);
  if (qty <= 0) return fail("수량 0 — 이전 단계 체결량 없음");

  if (opts.rollback) return undoStep(stepId, opp, qty);

  switch (stepId) {
    case "buy": {
      if (!buy) return fail("매수 다리 없음");
      if (!(sizeUsd > 0)) return fail("주문 규모가 0 이하");
      if (isKilled()) return fail("킬 스위치 활성 — 신규 실행 차단");
      const risk = checkEntry(sizeUsd);
      if (risk) return fail(`리스크 한도 — ${risk}`);
      // Live slippage cap — a thin book can eat the whole edge in one market order.
      if (!dry) {
        const est = await estimateLegSlippage(buy.venue, buy.symbol, "buy", {
          quoteAmount: buy.quote === "KRW" ? qty * (buy.price || 0) : sizeUsd,
        });
        if (est && (est.slipPct > CONFIG.MAX_SLIPPAGE_PCT || !est.filled)) {
          return fail(`매수 슬리피지 ${est.slipPct.toFixed(2)}% > 상한 ${CONFIG.MAX_SLIPPAGE_PCT}% — 중단`);
        }
      }
      const r =
        buy.venue === "binance" ? await binanceSpot(opp.base, "BUY", { quoteUsd: sizeUsd })
        : buy.venue === "bybit" ? await bybitOrder(opp.base, "BUY", { quoteUsd: sizeUsd })
        : buy.venue === "okx" ? await okxOrder(opp.base, "BUY", { quoteUsd: sizeUsd })
        : buy.venue === "upbit" ? await upbitOrder(opp.base, "bid", { priceKrw: qty * (buy.price || 0) })
        : buy.venue === "bithumb" ? await bithumbOrder(opp.base, "bid", qty)
        : null;
      if (!r) return unwired(`${buy.venue} ${opp.base} 매수`);
      return { ...r, message: r.message, fill: { qty: r.filledQty, quote: r.quoteFilled, ccy: buy.quote } };
    }
    case "approve": {
      // cex-dex: one-time ERC20 approve for the OKX aggregator spender. In DRY
      // this is a no-op; live checks OKX keys + wallet.
      if (dry) return { ok: true, dryRun: true, message: "DEX 승인 (모의)" };
      if (!dexConfigured()) return fail("OKX_WEB3 키 없음 — DEX 실행 불가");
      const dexLeg = opp.legs.find((l) => l.venue === "dex");
      const { chainKey, token } = dexTarget(opp, dexLeg);
      if (!chainKey || !token) return fail("DEX 토큰/체인 미확인 — 승인 차단");
      const ap = await approveDex(chainKey, token.address, "115792089237316195423570985008687907853269984665640564039457584007913129639935");
      if (!ap) return fail("approve 캘리데이터 조회 실패");
      const res = await sendRawEvmTx({ chain: chainKey, to: ap.to, data: ap.data }, [ap.to]);
      return { ok: res.ok, dryRun: res.dryRun, message: `DEX 승인 · ${res.message}`, tx: res.hash ? txInfo(chainLabelOf(chainKey), res.hash, res.dryRun) : undefined };
    }
    case "swap": {
      // cex-dex DEX leg: OKX swap calldata → wallet signs (router whitelisted,
      // minReceive enforced by OKX per our slippage cap).
      if (dry) return { ok: true, dryRun: true, message: "DEX 스왑 (모의)", tx: { hash: "sim:dex:swap", url: null } };
      if (!dexConfigured()) return fail("OKX_WEB3 키 없음 — DEX 실행 불가");
      const dexLeg = opp.legs.find((l) => l.venue === "dex");
      const walletAddr = walletAddress();
      if (!walletAddr) return fail("개인지갑 주소 없음 — 스왑 차단");
      const { chainKey, token, stable } = dexTarget(opp, dexLeg);
      if (!chainKey || !token || !stable) return fail("DEX 경로 미확인 — 스왑 차단");
      // buy on DEX = stable→token; sell on DEX = token→stable.
      const dexBuys = dexLeg?.side === "buy";
      const from = dexBuys ? stable : token;
      const to = dexBuys ? token : stable;
      const amountHuman = dexBuys ? sizeUsd : qty;
      const swap = await swapDex(chainKey, from, to, amountHuman, CONFIG.MAX_SLIPPAGE_PCT / 100, walletAddr);
      if (!swap) return fail("swap 캘리데이터 조회 실패");
      const res = await sendRawEvmTx({ chain: chainKey, to: swap.to, data: swap.data, value: swap.value, gas: swap.gas }, [swap.to]);
      return { ok: res.ok, dryRun: res.dryRun, message: `DEX 스왑 · ${res.message}`, tx: res.hash ? txInfo(chainLabelOf(chainKey), res.hash, res.dryRun) : undefined };
    }
    case "hedge": {
      // Hedge the ARRIVAL quantity, not the bought quantity — taker fee (base-
      // denominated) and the flat withdrawal fee never reach the sell venue, so
      // shorting the full buy leaves a residual net-short every trade.
      const wFee = withdrawFeeCoin(opp.base) ?? 0;
      const hedgeQty = Math.max(0, qty - wFee);
      if (hedgeQty <= 0) return fail("헷지 수량 0 (출금비 차감 후)");
      // Live margin gate: the coin is in-flight and can't collateralize the
      // short — require free USDT ≥ 60% of notional (≈1.6x max) so a pump
      // during transfer doesn't liquidate the hedge exactly when it matters.
      if (!dry) {
        const free = await binanceFuturesFree();
        const price = opp.legs.find((l) => l.quote === "USDT")?.price ?? 0;
        const notional = hedgeQty * price;
        if (free !== null && free < notional * 0.6) {
          return fail(`선물 가용 마진 부족 ($${free.toFixed(0)} < 필요 $${(notional * 0.6).toFixed(0)}) — 청산 위험, 헷지 차단`);
        }
      }
      const r = await binancePerp(opp.base, "SHORT", hedgeQty);
      return { ...r, message: r.message, fill: { qty: r.filledQty, quote: r.quoteFilled, ccy: "USDT" } };
    }
    case "withdraw": {
      const chain = chainKeyFromLabel(opp.transfer?.network?.chain);
      // DRY: show a simulated withdraw tx chip (parity with transfer/deposit).
      const simTx = dry ? { hash: `sim:${chain || "chain"}:withdraw:${opp.base}`, url: null } : undefined;
      // Live: an unresolvable chain must never fall through to a guessed
      // network/address — wrong-chain sends are permanent loss.
      if (!chain) {
        return dry
          ? { ok: true, dryRun: true, message: `${buy?.venue} 출금 (모의) · 체인 미상 — 라이브면 차단됨`, tx: simTx }
          : fail(`체인 미상(${opp.transfer?.network?.chain ?? "?"}) — 출금 차단`);
      }
      const net = NET_LABEL[chain] ?? chain;
      const evm = getChain(chain)?.family === "evm";
      const destVenue = sell?.venue ?? "upbit";
      // Personal-wallet hop ONLY for overseas → KR (travel-rule bypass on the
      // deposit side). KR → overseas and global ↔ global withdraw DIRECT to the
      // destination exchange; non-EVM chains are direct in every direction.
      const hop = evm && isGlobal(buy?.venue) && isKr(destVenue);
      let dest: string | null;
      let tag: string | null = null;
      let note = "";
      if (hop) {
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
          ? { ok: true, dryRun: true, message: `${buy?.venue} 출금${note} (모의) · 주소 미확인(키 필요) — 라이브면 차단됨`, tx: simTx }
          : fail(`출금 주소 미확인 — 차단`);
      }
      // Tag/memo-required coins: sending WITHOUT the tag lands uncredited in the
      // exchange omnibus wallet. Hard requirement — never send tagless.
      if (TAG_REQUIRED.has(opp.base) && !hop && !tag) {
        return dry
          ? { ok: true, dryRun: true, message: `${buy?.venue} 출금${note} (모의) · ${opp.base}는 태그 필수 — 태그 미확인, 라이브면 차단됨`, tx: simTx }
          : fail(`${opp.base}는 데스티네이션 태그 필수 — 태그 미확인, 출금 차단`);
      }
      const call =
        buy?.venue === "binance" ? binanceWithdraw(opp.base, net, dest, qty, tag ?? undefined)
        : buy?.venue === "bybit" ? bybitWithdraw(opp.base, net, dest, qty, tag ?? undefined)
        : buy?.venue === "okx" ? okxWithdraw(opp.base, net, dest, qty, tag ?? undefined)
        : buy?.venue === "upbit" ? upbitWithdraw(opp.base, net, dest, qty, tag ?? undefined)
        : buy?.venue === "bithumb" ? bithumbWithdraw(opp.base, dest, qty, tag ?? undefined)
        : null;
      if (!call) return unwired(`${buy?.venue} 출금`);
      const r = await call;
      // Attach the withdrawal's on-chain tx: DRY → a simulated hash chip so the
      // step shows a tx like transfer/deposit; LIVE → the exchange withdrawal
      // broadcasts on-chain after acceptance, so briefly poll history for the
      // real txId (may still be pending — deposit step catches the arrival tx).
      let wtx: { hash: string; url: string | null } | undefined;
      if (r.dryRun) {
        wtx = { hash: `sim:${chain}:withdraw:${opp.base}`, url: null };
      } else if (r.ok && r.id) {
        let txId: string | null = null;
        for (let i = 0; i < 3 && !txId; i++) {
          await new Promise((res) => setTimeout(res, 2000));
          txId = buy?.venue === "binance" ? await binanceWithdrawTx(opp.base, r.id)
            : buy?.venue === "upbit" ? await upbitWithdrawTx(r.id)
            : null;
        }
        wtx = txId ? txInfo(opp.transfer?.network?.chain, txId, false) : undefined;
        if (!wtx) note += " · 온체인 tx 대기";
      }
      return { ok: r.ok, dryRun: r.dryRun, message: `${r.message}${note}`, tx: wtx };
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
      return {
        ok: res.ok, dryRun: res.dryRun,
        message: `개인지갑 → ${destVenue} 송금 · ${res.message}${noteAddr}`,
        tx: txInfo(opp.transfer?.network?.chain, res.hash, res.dryRun),
      };
    }
    case "deposit": {
      const r = await checkDeposit(sell?.venue ?? "upbit", opp.base, opts.sinceTs ?? Date.now() - 60 * 60 * 1000);
      // DRY → sim chip; LIVE → real credited txid from the deposit record.
      const dtx = r.dryRun
        ? { hash: `sim:${chainKeyFromLabel(opp.transfer?.network?.chain) || "chain"}:deposit:${opp.base}`, url: null }
        : txInfo(opp.transfer?.network?.chain, r.txHash, r.dryRun);
      return { ok: r.ok, dryRun: r.dryRun, message: r.message, tx: dtx };
    }
    case "sell": {
      if (!sell) return fail("매도 다리 없음");
      if (!dry) {
        const est = await estimateLegSlippage(sell.venue, sell.symbol, "sell", { baseQty: qty });
        if (est && (est.slipPct > CONFIG.MAX_SLIPPAGE_PCT || !est.filled)) {
          return fail(`매도 슬리피지 ${est.slipPct.toFixed(2)}% > 상한 ${CONFIG.MAX_SLIPPAGE_PCT}% — 중단`);
        }
      }
      const r =
        sell.venue === "binance" ? await binanceSpot(opp.base, "SELL", { qty })
        : sell.venue === "bybit" ? await bybitOrder(opp.base, "SELL", { qty })
        : sell.venue === "okx" ? await okxOrder(opp.base, "SELL", { qty })
        : sell.venue === "upbit" ? await upbitOrder(opp.base, "ask", { volume: qty })
        : sell.venue === "bithumb" ? await bithumbOrder(opp.base, "ask", qty)
        : null;
      if (!r) return unwired(`${sell.venue} ${opp.base} 매도`);
      return { ...r, message: r.message, fill: { qty: r.filledQty, quote: r.quoteFilled, ccy: sell.quote } };
    }
    case "close": {
      const r = await binancePerp(opp.base, "CLOSE", qty);
      return { ...r, message: r.message, fill: { qty: r.filledQty, quote: r.quoteFilled, ccy: "USDT" } };
    }
    case "settle": {
      const logTrade = (
        realizedNetPct: number | null,
        realizedPnlUsd: number | null,
        detail?: Partial<Parameters<typeof recordTrade>[0]>,
      ) =>
        void recordTrade({
          ts: Date.now(), base: opp.base, kind: opp.kind,
          route: `${buy?.venue ?? "?"} → ${sell?.venue ?? "?"}`,
          sizeUsd, detectedNetPct: opp.netPct, realizedNetPct, realizedPnlUsd,
          hedged: !!opp.hasPerp, dryRun: dry, status: "done",
          durationsSec: opts.durations,
          txs: opts.txs?.length ? opts.txs : undefined,
          ...detail,
        });
      // Prefer REAL fills threaded from the buy/sell steps; KRW legs convert at
      // the venue's live USDT/KRW. Falls back to the scan-time estimate.
      const f = opts.fills;
      if (f?.buyQuote && f?.sellQuote) {
        const toUsd = async (amt: number, ccy?: string) => {
          if (ccy !== "KRW") return amt;
          const kv = (sell?.quote === "KRW" ? sell.venue : buy?.venue) ?? "upbit";
          const fx = await fetchUsdKrw(kv);
          return fx ? amt / fx : 0;
        };
        const buyUsd = await toUsd(f.buyQuote, f.buyCcy);
        const sellUsd = await toUsd(f.sellQuote, f.sellCcy);
        if (buyUsd > 0 && sellUsd > 0) {
          // Perp P&L is a first-class leg: SHORT opened at hedgeOpenQuote (USDT
          // received), closed at hedgeCloseQuote (USDT paid) → open − close.
          const perpPnl = (f.hedgeOpenQuote && f.hedgeCloseQuote)
            ? f.hedgeOpenQuote - f.hedgeCloseQuote
            : 0;
          const pnl = sellUsd - buyUsd + perpPnl;
          const pct = (pnl / buyUsd) * 100;
          if (!dry) recordPnl(pnl); // feeds the daily-loss limit — spot+perp together
          // 상세 기록: 수량·평균 진입/청산가·현물/헷지 분해까지 전부.
          const bq = f.buyQty ?? qty;
          const sq = f.sellQty ?? bq;
          logTrade(pct, pnl, {
            qty: bq > 0 ? bq : null,
            entryPriceUsd: bq > 0 ? buyUsd / bq : null,
            exitPriceUsd: sq > 0 ? sellUsd / sq : null,
            buyUsd, sellUsd,
            spotPnlUsd: sellUsd - buyUsd,
            hedgePnlUsd: perpPnl !== 0 ? perpPnl : null,
          });
          const perpNote = perpPnl !== 0 ? ` · 헷지 ${perpPnl >= 0 ? "+" : "−"}$${Math.abs(perpPnl).toFixed(2)}` : "";
          return { ok: true, dryRun: dry, message: `정산 · 실현 ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% (${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(2)})${perpNote} · 실체결 기반` };
        }
      }
      const pnl = (opp.netPct / 100) * sizeUsd;
      // 실체결 없음(모의/수동) → 추정 기록. 스캔가 기준 진입/청산가라도 남긴다.
      logTrade(null, null, {
        qty: qty > 0 ? qty : null,
        entryPriceUsd: buy?.quote === "USDT" ? buy.price : null,
        exitPriceUsd: sell?.quote === "USDT" ? sell.price : null,
        note: "추정치 (실체결 없음)",
      });
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
      fills?: { buyQuote?: number; buyCcy?: string; buyQty?: number; sellQuote?: number; sellCcy?: string; sellQty?: number; hedgeOpenQuote?: number; hedgeCloseQuote?: number };
    txs?: { step: string; hash: string; url: string | null }[];
      idempotencyKey?: string;
      durations?: Record<string, number>;
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
    // Idempotency: replay a cached SUCCESS for the same run+step (protects the
    // "network died but the server executed" case). Failures are never cached,
    // so a genuine retry re-executes.
    const idem = body.idempotencyKey;
    if (idem) {
      const hit = idemGet(idem);
      if (hit) return NextResponse.json({ ...hit, message: `${hit.message} · (재전송 방지 — 이전 결과)` });
    }
    const result = await runStep(body.stepId, body.opportunity, body.sizeUsd ?? 0, {
      rollback: !!body.rollback, qty: body.qty, sinceTs: body.sinceTs, fills: body.fills, durations: body.durations, txs: body.txs,
    });
    if (idem && result.ok) idemSet(idem, result);
    // Live failure on a money step → phone alert (LIVE only; DRY sims fail loudly
    // in the UI already and would be noise).
    if (!result.ok && !CONFIG.DRY_RUN && !body.rollback) {
      void notifyNow(`⚠️ <b>${body.opportunity.base}</b> ${body.stepId} 실패\n${result.message ?? ""}`);
    }
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : "step failed" },
      { status: 500 },
    );
  }
}
