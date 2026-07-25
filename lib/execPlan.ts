// Execution plan — 순수 로직(단계 구성·재검증 대상·자동화 레벨 판정).
// 서버 실행엔진과 클라이언트 UI가 함께 임포트한다: "use client"도, react도
// 여기 넣지 말 것 (서버 번들에 들어간다).

import type { Opportunity } from "./types";
import { chainKeyFromLabel, getChain, isGlobal, isKr } from "./chains";

export type StepId =
  | "buy" | "hedge" | "withdraw" | "transfer" | "deposit" | "sell" | "close" | "settle"
  | "approve" | "swap"; // cex-dex (transfer-style): DEX approve + swap legs

export type ExecStep = {
  id: StepId; label: string; desc: string;
  /** Money leaves our control here and we cannot undo it: an on-chain send, an
   *  exchange withdrawal, a DEX swap. Everything BEFORE the first irreversible
   *  step can be unwound by selling the entry back; at or after it, the machine
   *  must hold and call a human instead of dumping.
   *
   *  This used to be derived as `findIndex(s => s.id === "withdraw")`, which
   *  returned -1 on the cex-dex buyDex plan (it has no withdraw step) — so on
   *  that plan the rollback branch could never run at all, and the automation
   *  level labelled "출금 전(권장)" never paused, letting the irreversible
   *  `transfer` fire with no confirmation. */
  irreversible?: boolean;
};

/** Index of the first irreversible step, or -1 if the plan has none. */
export function firstIrreversibleIdx(plan: ExecStep[]): number {
  return plan.findIndex((s) => s.irreversible);
}
export type StepPhase = "pending" | "running" | "done" | "error" | "rolledback";
export type RunPhase = "idle" | "running" | "paused" | "done" | "error";
export type StepResult = {
  ok: boolean;
  message?: string;
  /** On-chain transaction of this step (transfer send / deposit credit). url =
   *  chain explorer link, null when there's nothing real to open (DRY_RUN). */
  tx?: { hash: string; url: string | null };
};
export type AutoLevel = "manual" | "beforeWithdraw" | "beforeSell" | "auto";

const VENUE: Record<string, string> = {
  binance: "Binance", upbit: "Upbit", bithumb: "Bithumb",
  bybit: "Bybit", okx: "OKX", uniswap: "Uniswap", dex: "DEX",
};
const vlabel = (v?: string) => (v ? VENUE[v] ?? v : "?");

// Buy on the buy-venue → withdraw to personal wallet → (auto) deposit to the
// sell-venue → sell. Hedge = short Binance perp for the whole in-flight window.
export function buildPlan(opp: Opportunity, hedge: boolean): ExecStep[] {
  const buy = opp.legs.find((l) => l.side === "buy");
  const sell = opp.legs.find((l) => l.side === "sell");
  const bv = vlabel(buy?.venue);
  const sv = vlabel(sell?.venue);

  // cex-dex is TRANSFER-style: buy the cheap side, move the coin, sell the
  // expensive side. buyDex = DEX 매수 → 지갑→CEX 전송 → 매도 / sellDex = CEX
  // 매수 → 출금 → DEX 매도. In-flight exposure is hedged like kimchi.
  if (opp.kind === "cex-dex") {
    const dexLeg = opp.legs.find((l) => l.venue === "dex");
    const cexLeg = opp.legs.find((l) => l.venue !== "dex");
    const cv = vlabel(cexLeg?.venue);
    const dexBuys = dexLeg?.side === "buy";
    const eta = opp.transfer?.etaMin;
    const steps: ExecStep[] = [];
    if (dexBuys) {
      steps.push({ id: "approve", label: "스테이블 승인", desc: "1회 approve (필요 시)" });
      steps.push({ id: "swap", label: "DEX 매수 (스왑)", desc: `${opp.base} · 온체인 · minReceive 보호`, irreversible: true });
      if (hedge) steps.push({ id: "hedge", label: "Binance 선물 숏", desc: "전송 구간 가격 잠금" });
      steps.push({ id: "transfer", label: `개인지갑 → ${cv} 입금 전송`, desc: "온체인 · 되돌릴 수 없음", irreversible: true });
      steps.push({ id: "deposit", label: `${cv} 입금 확인`, desc: `컨펌 대기${eta ? ` · ~${eta}분` : ""}` });
      steps.push({ id: "sell", label: `${cv} 현물 매도`, desc: `${opp.base} → USDT` });
      if (hedge) steps.push({ id: "close", label: "선물 청산", desc: "매도와 동시 · 헷지 해제" });
    } else {
      steps.push({ id: "buy", label: `${cv} 현물 매수`, desc: `${opp.base} 매수 · 진입` });
      if (hedge) steps.push({ id: "hedge", label: "Binance 선물 숏", desc: "전송 구간 가격 잠금" });
      steps.push({ id: "withdraw", label: `${cv} → 개인지갑 출금`, desc: "온체인 · 되돌릴 수 없음", irreversible: true });
      steps.push({ id: "deposit", label: "지갑 수신 확인", desc: `컨펌 대기${eta ? ` · ~${eta}분` : ""}` });
      steps.push({ id: "approve", label: `${opp.base} 승인`, desc: "1회 approve (필요 시)" });
      steps.push({ id: "swap", label: "DEX 매도 (스왑)", desc: "온체인 · minReceive 보호", irreversible: true });
      if (hedge) steps.push({ id: "close", label: "선물 청산", desc: "스왑과 동시 · 헷지 해제" });
    }
    steps.push({ id: "settle", label: "정산", desc: "P&L 확정" });
    return steps;
  }
  // Personal-wallet hop is ONLY for overseas → KR deposits (direct Binance→Upbit
  // stalls on travel-rule verification; wallet-origin deposits credit
  // automatically). KR → overseas and global ↔ global send DIRECT. Non-EVM
  // chains also go direct (wallet send not reliable there yet).
  const evm = getChain(chainKeyFromLabel(opp.transfer?.network?.chain))?.family === "evm";
  const hop = evm && isGlobal(buy?.venue) && isKr(sell?.venue);

  const steps: ExecStep[] = [];
  steps.push({ id: "buy", label: `${bv} 현물 매수`, desc: `${opp.base} 매수 · 진입` });
  if (hedge) steps.push({ id: "hedge", label: "Binance 선물 숏", desc: "같은 수량 · 진입가에 가격 잠금" });
  if (hop) {
    steps.push({ id: "withdraw", label: `${bv} → 개인지갑 출금`, desc: "온체인 · 되돌릴 수 없음", irreversible: true });
    steps.push({ id: "transfer", label: `개인지갑 → ${sv} 송금`, desc: "트래블룰 우회 · 자동 입금", irreversible: true });
  } else {
    steps.push({
      id: "withdraw", label: `${bv} → ${sv} 직접 출금`,
      desc: isKr(buy?.venue) ? "국내 → 해외 직접 · 주소 등록(화이트리스트) 필요" : "거래소 간 직접",
      irreversible: true,
    });
  }
  steps.push({ id: "deposit", label: `${sv} 입금 확인`, desc: "컨펌 대기" });
  steps.push({ id: "sell", label: `${sv} 현물 매도`, desc: `${opp.base} → ${sell?.quote ?? "KRW"}` });
  if (hedge) steps.push({ id: "close", label: "Binance 선물 청산", desc: "매도와 동시 · 헷지 해제" });
  steps.push({ id: "settle", label: "정산", desc: "P&L 확정" });
  return steps;
}

// `step` (not just its id) so the boundary follows the plan's own irreversible
// flag. "beforeWithdraw" is the level the UI labels 권장, and it must pause
// before ANY irreversible step — on the cex-dex buyDex plan the irreversible one
// is `transfer`/`swap`, not `withdraw`, and matching on the id alone let it run
// unconfirmed.
function needsConfirmBefore(step: ExecStep, level: AutoLevel): boolean {
  if (level === "auto") return false;
  if (level === "manual") return true; // pause before every step
  if (level === "beforeWithdraw") return !!step.irreversible;
  return step.id === "sell"; // beforeSell: auto through deposit, stop before selling
}
// Re-exported for the background run store (which owns its own loop).
export const needsConfirmBeforePublic = needsConfirmBefore;
// Steps that must re-check the edge right before firing. `transfer` is included
// because on the buyDex plan it is the irreversible leg (it was omitted, so that
// plan committed the on-chain send without any re-quote).
export const REVALIDATE_STEPS: ReadonlySet<StepId> = new Set<StepId>(["buy", "withdraw", "sell", "swap", "transfer"]);

export type Revalidation = { ok: boolean; reason?: string };
