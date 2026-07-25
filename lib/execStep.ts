// Step executor — 한 단계를 서버에서 실행한다 (주문·출금·전송·정산 전부).
// /api/exec-step 라우트와 서버 실행엔진(runEngine)이 공유. 라우트를 거치지
// 않는 엔진 경로에서도 동일한 가드(킬스위치·리스크·슬리피지)가 적용된다.

import type { Opportunity } from "./types";
import { CONFIG, TAG_REQUIRED } from "./config";
import { sendToken, walletAddress } from "./wallet";
import { BINANCE_NET, chainKeyFromLabel, getChain, isGlobal, isKr } from "./chains";
import { fetchDepositAddress } from "./deposits";
import { binanceSpot, binancePerp, binanceFuturesFree, binanceWithdraw, binanceWithdrawTx, upbitOrder, upbitWithdraw, upbitWithdrawTx, bithumbOrder, bithumbWithdraw, bybitOrder, bybitWithdraw, bybitWithdrawTx, okxOrder, okxWithdraw, okxWithdrawTx, checkDeposit } from "./orders";
import { resolveWalletAsset } from "./tokens";
import { dexConfigured, approveDex, swapDex, CEXDEX_CHAINS, allTokens, QUOTE_STABLES } from "./dex";
import { sendRawEvmTx } from "./wallet";
import { isKilled } from "./killswitch";
import { checkEntry, recordPnl } from "./risk";
import { notifyNow } from "./telegram";
import { recordTrade } from "./trades";
import { estimateLegSlippage } from "./quote";
import { withdrawFeeCoin, withdrawMinCoin } from "./networks";
import { fetchUsdKrw } from "./exchanges";
import type { StepId } from "./execPlan";
import { notify } from "./telegram";


const NET_LABEL = BINANCE_NET; // shared exchange network codes

// Idempotency cache — successful step results by run:step key, 10min TTL.
const gi = globalThis as unknown as { __arbIdem?: Map<string, { r: StepResult; ts: number }> };
gi.__arbIdem ??= new Map();
export function idemGet(key: string): StepResult | null {
  const hit = gi.__arbIdem!.get(key);
  if (!hit || Date.now() - hit.ts > 10 * 60_000) return null;
  return hit.r;
}
export function idemSet(key: string, r: StepResult) {
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
async function dexTarget(opp: Opportunity, dexLeg?: { symbol: string }) {
  const chainKey = dexLeg?.symbol?.split("@")[1];
  const uni = CEXDEX_CHAINS.find((u) => u.chain === chainKey);
  let token = uni?.bases[opp.base];
  const stable = uni?.quote ?? (chainKey ? QUOTE_STABLES[chainKey] : undefined);
  // 동적 유니버스(코어 밖) 토큰: 검출과 같은 소스(OKX 토큰리스트, 심볼 유일)로
  // 재해석 — 검출은 됐는데 실행만 안 되는 비대칭 방지.
  if (!token && chainKey) {
    try { token = (await allTokens(chainKey)).get(opp.base) ?? undefined; } catch { /* 아래서 차단 */ }
  }
  return { chainKey: token && stable ? chainKey : undefined, token, stable };
}
const chainLabelOf = (chainKey: string) => getChain(chainKey)?.label ?? chainKey;

export type StepResult = {
  ok: boolean; dryRun: boolean; message: string; filledQty?: number;
  /** Real fill of this leg: base qty + quote amount in `ccy` (settle uses it). */
  fill?: { qty?: number; quote?: number; ccy?: string };
  /** On-chain tx of this step + explorer link (null link when simulated). */
  tx?: { hash: string; url: string | null };
  /** Outcome unknown — the request may have been accepted. No auto-retry, no
   *  rollback: a human must check the venue first. */
  ambiguous?: boolean;
  /** Not a failure, just not done yet (deposit still confirming). */
  pending?: boolean;
  /** Wallet balance snapshot taken before an outbound withdrawal — the engine
   *  carries it to the `recv` step so arrival is judged on the delta. */
  walletBefore?: number;
};
// Explorer link for a tx on the opp's transfer chain.
function txInfo(chainLabel: string | undefined, hash: string | null | undefined, dry: boolean) {
  if (!hash) return undefined;
  const chain = getChain(chainKeyFromLabel(chainLabel));
  const url = !dry && chain?.explorer ? `${chain.explorer}${hash}` : null;
  return { hash, url };
}
const fail = (message: string): StepResult => ({ ok: false, dryRun: CONFIG.DRY_RUN, message });

/** On-chain balance of `base` at our wallet on `chainKey`. null = can't tell. */
async function walletBalanceOf(base: string, chainKey: string): Promise<number | null> {
  const addr = destAddr(chainKey);
  if (!addr) return null;
  try {
    const { JsonRpcProvider, Contract, formatUnits, formatEther } = await import("ethers");
    const provider = new JsonRpcProvider(getChain(chainKey)!.rpc);
    const asset = await resolveWalletAsset(base, chainKey);
    if (asset.kind === "token") {
      const c = new Contract(asset.address, ["function balanceOf(address) view returns (uint256)"], provider);
      return Number(formatUnits(await c.balanceOf(addr), asset.decimals));
    }
    if (asset.kind === "native") return Number(formatEther(await provider.getBalance(addr)));
    return null; // contract unknown
  } catch {
    return null;
  }
}

/** Has the coin actually LANDED in our wallet?
 *
 *  Judged on the INCREASE since the pre-withdrawal snapshot, not on the absolute
 *  balance: any leftover holding of the same coin would otherwise satisfy an
 *  absolute check instantly and the next step would spend coin that never
 *  arrived. `before` is captured by the withdraw step; when it's unavailable we
 *  fall back to an absolute check and say so.
 *
 *  Returns `pending` (not a failure) while waiting — the engine polls it. */
async function walletArrival(
  opp: Opportunity, qty: number, dry: boolean, before?: number,
): Promise<StepResult> {
  const chain = chainKeyFromLabel(opp.transfer?.network?.chain);
  if (dry) {
    return { ok: true, dryRun: true, message: "지갑 수신 확인 (모의)", tx: { hash: `sim:${chain || "chain"}:recv:${opp.base}`, url: null } };
  }
  if (!chain) return fail("체인 미상 — 수신 확인 불가");
  if (!destAddr(chain)) return fail("지갑 주소 없음 — 수신 확인 불가");
  const bal = await walletBalanceOf(opp.base, chain);
  if (bal == null) return { ok: false, pending: true, dryRun: false, message: `${opp.base} 지갑 잔고 조회 실패 — 재확인 대기` };
  // Expect the withdrawal net of the venue's flat fee; 2% slack for fee-table drift.
  const wFee = withdrawFeeCoin(opp.base) ?? 0;
  const expect = Math.max(0, qty - wFee) * 0.98;
  const arrived = before != null ? bal - before : bal;
  const ok = arrived >= expect && expect > 0;
  const basis = before != null ? "증가분" : "잔고(기준치 없음)";
  if (ok) {
    // Thread the ACTUAL arrival forward so the send uses what really landed.
    return {
      ok: true, dryRun: false,
      filledQty: before != null ? arrived : bal,
      message: `지갑 수신 확인 · ${basis} ${arrived.toFixed(6)} ${opp.base}`,
    };
  }
  return {
    ok: false, pending: true, dryRun: false,
    message: `수신 대기 중 · ${basis} ${arrived.toFixed(6)} / 기대 ${expect.toFixed(6)} ${opp.base}`,
  };
}
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
export async function runStep(
  stepId: StepId, opp: Opportunity, sizeUsd: number,
  opts: {
    rollback?: boolean; qty?: number; sinceTs?: number;
    /** Exact quantity the hedge opened — `close` must reduce that, not the
     *  currently-threaded qty (which by then is the deposit-credited amount). */
    hedgeQty?: number;
    /** Wallet balance of the coin captured just BEFORE the withdrawal, so `recv`
     *  can judge arrival by the increase instead of the absolute balance. */
    walletBefore?: number;
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

  // ── Step-agnostic pre-flight ────────────────────────────────────────────────
  // These used to live inside `case "buy"`, so the cex-dex buyDex plan — which
  // has no `buy` step, it enters via `swap` — bypassed the kill switch, the
  // per-trade/daily risk limits AND the snapshot-staleness gate entirely.
  const dexLeg = opp.legs.find((l) => l.venue === "dex");
  const isEntry = stepId === "buy" || (stepId === "swap" && dexLeg?.side === "buy");
  // Kill switch blocks anything that moves money. `deposit`/`recv` (read-only
  // arrival polling) and `settle` (bookkeeping) still run so an in-flight run can
  // be closed out.
  const readOnlyStep = stepId === "deposit" || stepId === "recv" || stepId === "settle";
  if (!readOnlyStep && isKilled()) {
    return fail("킬 스위치 활성 — 실행 차단");
  }
  if (isEntry) {
    if (!(sizeUsd > 0)) return fail("주문 규모가 0 이하");
    // 스냅샷 신선도 — 라이브 진입은 2분 넘은 기회로 시작하지 않는다
    // (재검증이 있어도 진입 자체가 낡은 판단이면 원천 차단이 맞다).
    if (!dry && opp.ts && Date.now() - opp.ts > 120_000) {
      return fail("기회 스냅샷 2분 초과 — 보드 갱신 후 다시 실행");
    }
    const risk = checkEntry(sizeUsd);
    if (risk) return fail(`리스크 한도 — ${risk}`);
  }

  switch (stepId) {
    case "buy": {
      if (!buy) return fail("매수 다리 없음");
      // (킬 스위치·스냅샷 신선도·리스크 한도는 위 프리플라이트에서 처리)
      // 최소 출금 수량 사전 게이트 — 부분체결로 수량이 min 미달이면 출금
      // 단계에서 터지고 롤백 덤프로 이어진다. 진입 전에 막는다.
      const willWithdraw =
        opp.kind === "kimchi" || opp.kind === "cross-cex" ||
        (opp.kind === "cex-dex" && opp.legs.find((l) => l.venue === "dex")?.side === "sell");
      if (willWithdraw && buy.venue === "binance") {
        const wMin = withdrawMinCoin(opp.base);
        if (wMin != null && qty < wMin) {
          return fail(`예상 수량 ${qty.toFixed(6)} < 바낸 최소 출금 ${wMin} — 규모를 키우거나 중단`);
        }
      }
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
      // A live entry with no fill quantity would make every downstream step use
      // the nominal scan-price estimate: hedge mis-sized, withdrawal possibly
      // exceeding the balance, and settle unable to compute realized P&L (so
      // recordPnl never runs and the daily-loss limit goes blind). Stop instead.
      if (r.ok && !dry && !(r.filledQty && r.filledQty > 0)) {
        return {
          ok: false, dryRun: false,
          message: `${buy.venue} 매수는 성공했지만 체결량을 확인할 수 없습니다 — 명목 수량으로 진행하지 않습니다. 거래소에서 잔고 확인 후 수동 처리`,
          ambiguous: true, // 주문은 실제로 났다 → 롤백·자동재시도 금지
        };
      }
      return { ...r, message: r.message, fill: { qty: r.filledQty, quote: r.quoteFilled, ccy: buy.quote } };
    }
    case "approve": {
      // cex-dex: one-time ERC20 approve for the OKX aggregator spender. In DRY
      // this is a no-op; live checks OKX keys + wallet.
      if (dry) return { ok: true, dryRun: true, message: "DEX 승인 (모의)" };
      if (!dexConfigured()) return fail("OKX_WEB3 키 없음 — DEX 실행 불가");
      const dexLeg = opp.legs.find((l) => l.venue === "dex");
      const { chainKey, token } = await dexTarget(opp, dexLeg);
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
      const { chainKey, token, stable } = await dexTarget(opp, dexLeg);
      if (!chainKey || !token || !stable) return fail("DEX 경로 미확인 — 스왑 차단");
      // buy on DEX = stable→token; sell on DEX = token→stable.
      const dexBuys = dexLeg?.side === "buy";
      const from = dexBuys ? stable : token;
      const to = dexBuys ? token : stable;
      const amountHuman = dexBuys ? sizeUsd : qty;
      const swap = await swapDex(chainKey, from, to, amountHuman, CONFIG.MAX_SLIPPAGE_PCT / 100, walletAddr);
      if (!swap) return fail("swap 캘리데이터 조회 실패");
      const res = await sendRawEvmTx({ chain: chainKey, to: swap.to, data: swap.data, value: swap.value, gas: swap.gas }, [swap.to]);
      // On the buyDex plan the swap IS the entry, so its output quantity must be
      // threaded forward — otherwise the CEX sell leg sized itself off the
      // nominal estimate. `swap.toAmount` is the router's quoted output (base
      // units); the on-chain receive is ≥ minReceive, so treat it as an estimate
      // and let the deposit/receive check correct it.
      const outRaw = Number(swap.toAmount ?? 0);
      const outQty = dexBuys && outRaw > 0 ? outRaw / 10 ** to.decimals : undefined;
      // Failed WITH a hash = it was broadcast; the outcome is unknown and a
      // retry would swap twice. Failed without a hash = never left, safe.
      const ambiguous = !res.ok && !!res.hash;
      return {
        ok: res.ok, dryRun: res.dryRun, ambiguous,
        message: `DEX 스왑 · ${res.message}`,
        filledQty: outQty && outQty > 0 ? outQty : undefined,
        tx: res.hash ? txInfo(chainLabelOf(chainKey), res.hash, res.dryRun) : undefined,
      };
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
      // 부분체결 등으로 실수량이 최소 출금 미달이면 API 에러 대신 명시 중단
      // (여기서 실패해야 롤백 경로가 슬리피지 가드를 태운다).
      if (buy?.venue === "binance") {
        const wMin = withdrawMinCoin(opp.base);
        if (wMin != null && qty < wMin) {
          return fail(`체결 수량 ${qty.toFixed(6)} < 최소 출금 ${wMin} — 출금 불가, 수동 처리 또는 롤백`);
        }
      }
      const evm = getChain(chain)?.family === "evm";
      const destVenue = sell?.venue ?? "upbit";
      // Personal-wallet hop ONLY for overseas → KR (travel-rule bypass on the
      // deposit side). KR → overseas and global ↔ global withdraw DIRECT to the
      // destination exchange; non-EVM chains are direct in every direction.
      const hop = evm && isGlobal(buy?.venue) && isKr(destVenue);
      // cex-dex sellDex: 매도 다리가 DEX = 코인을 "내 지갑"으로 빼서 온체인 매도.
      const toWallet = destVenue === "dex";
      let dest: string | null;
      let tag: string | null = null;
      let note = "";
      if (hop || toWallet) {
        dest = destAddr(chain); // personal wallet
        if (toWallet) note = " → 개인지갑(DEX 매도용)";
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
      // Snapshot the wallet BEFORE sending, so the `recv` step can judge arrival
      // on the increase rather than the absolute balance (a leftover holding of
      // the same coin would otherwise read as "already arrived").
      const walletBefore = (hop || toWallet) && !dry
        ? (await walletBalanceOf(opp.base, chain)) ?? undefined
        : undefined;
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
            : buy?.venue === "bybit" ? await bybitWithdrawTx(r.id)
            : buy?.venue === "okx" ? await okxWithdrawTx(r.id)
            : null;
        }
        wtx = txId ? txInfo(opp.transfer?.network?.chain, txId, false) : undefined;
        if (!wtx) note += " · 온체인 tx 대기";
      }
      return { ok: r.ok, ambiguous: r.ambiguous, dryRun: r.dryRun, message: `${r.message}${note}`, tx: wtx, walletBefore };
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
      // 큐레이션 → 내 지갑 보유 컨트랙트(OKX) → 토큰리스트 순 자동 해석.
      const asset = await resolveWalletAsset(opp.base, chain);
      if (asset.kind === "unknown" && !dry) return fail(`${opp.base} 토큰 컨트랙트 미확인 — 송금 차단`);
      // FLOOR, never round: toFixed rounds half-up, so a balance of 1.0000004
      // became a 1.000001 request and the transfer reverted on insufficient
      // funds (gas burned, and past the irreversible boundary so no rollback).
      const sendQty = Math.floor(qty * 1e6) / 1e6;
      if (!(sendQty > 0)) return fail("전송 수량 0 (6자리 내림 후)");
      const res = await sendToken({
        chain, to, amountHuman: String(sendQty),
        tag: fetched?.tag ?? undefined,
        ...(asset.kind === "token" ? { tokenAddress: asset.address, decimals: asset.decimals } : {}),
        confirms: opp.transfer?.network?.confirms ?? 1,
      });
      const noteAddr = fetched?.address ? "" : " · 입금주소 미확인(키필요)";
      return {
        ok: res.ok, dryRun: res.dryRun,
        // Broadcast but unconfirmed → ambiguous: never re-send, a human checks
        // the explorer. Never broadcast → safe to treat as a clean failure.
        ambiguous: !res.ok && !!res.hash,
        message: `개인지갑 → ${destVenue} 송금 · ${res.message}${noteAddr}`,
        tx: txInfo(opp.transfer?.network?.chain, res.hash, res.dryRun),
      };
    }
    // Personal-wallet arrival check. Used by the kimchi hop (between the
    // exchange withdrawal and the wallet→exchange send) and by cex-dex sellDex.
    case "recv":
      return walletArrival(opp, qty, dry, opts.walletBefore);
    case "deposit": {
      // cex-dex sellDex: "입금 확인" = 개인지갑 온체인 수신 확인.
      if (sell?.venue === "dex") return walletArrival(opp, qty, dry, opts.walletBefore);
      const r = await checkDeposit(sell?.venue ?? "upbit", opp.base, opts.sinceTs ?? Date.now() - 60 * 60 * 1000);
      // DRY → sim chip; LIVE → real credited txid from the deposit record.
      const dtx = r.dryRun
        ? { hash: `sim:${chainKeyFromLabel(opp.transfer?.network?.chain) || "chain"}:deposit:${opp.base}`, url: null }
        : txInfo(opp.transfer?.network?.chain, r.txHash, r.dryRun);
      // pending = 아직 안 들어옴(정상). 실패로 세면 서킷 브레이커가 정상 전송을
      // 장애로 오인해 킬 스위치를 켠다.
      return { ok: r.ok, pending: r.pending, dryRun: r.dryRun, message: r.message, tx: dtx, filledQty: r.filledQty };
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
      // Close exactly what the hedge opened. Using the threaded qty (the
      // deposit-credited amount) can exceed the position → reduceOnly rejects →
      // the short stays open after the spot leg is already sold = naked short.
      const closeQty = opts.hedgeQty && opts.hedgeQty > 0 ? opts.hedgeQty : qty;
      const r = await binancePerp(opp.base, "CLOSE", closeQty);
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
    // 롤백도 시장가 매도다 — 얇은 호가에 덤프하면 방어 동작이 손실을 만든다.
    // 진입과 같은 슬리피지 상한을 적용, 초과 시 보류하고 사람을 부른다.
    if (!CONFIG.DRY_RUN && buy?.venue && buy.symbol) {
      const est = await estimateLegSlippage(buy.venue, buy.symbol, "sell", { baseQty: qty }).catch(() => null);
      if (est && (est.slipPct > CONFIG.MAX_SLIPPAGE_PCT || !est.filled)) {
        void notify(`rollback-hold:${opp.base}`,
          `⚠ <b>${opp.base}</b> 롤백 보류 — 예상 슬리피지 ${est.slipPct.toFixed(2)}% > 상한 ${CONFIG.MAX_SLIPPAGE_PCT}% · 수동 처리 필요 (수량 ${qty.toFixed(6)})`);
        return { ok: false, dryRun: false, message: `롤백 보류: 슬리피지 ${est.slipPct.toFixed(2)}% > 상한 — 수동 처리 (텔레그램 발송)` };
      }
    }
    if (buy?.venue === "binance") return await binanceSpot(opp.base, "SELL", { qty });
    if (buy?.venue === "bybit") return await bybitOrder(opp.base, "SELL", { qty });
    if (buy?.venue === "okx") return await okxOrder(opp.base, "SELL", { qty });
    if (buy?.venue === "upbit") return await upbitOrder(opp.base, "ask", { volume: qty });
    if (buy?.venue === "bithumb") return await bithumbOrder(opp.base, "ask", qty);
  }
  if (stepId === "hedge") return await binancePerp(opp.base, "CLOSE", qty);
  return { ok: true, dryRun: CONFIG.DRY_RUN, message: `${stepId} 롤백 불필요` };
}

