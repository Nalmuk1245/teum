// 입출금 게이트 상태 분류 — 순수 함수 (스캐너·UI가 같이 쓴다).
//
// 닫힌 갭은 지우지 않는다. 입출금이 다시 열리는 순간이 가장 좋은 기회이기
// 때문이다. 대신 상태를 넷으로 나눠 표시·순위·알림을 따로 한다:
//   open    — 매수 거래소 출금·매도 거래소 입금이 **확인된** 열림
//   closed  — 어느 한쪽이 정지로 **확인됨** (transfer.blocked)
//   suspect — 확인은 안 됐지만(키 없음) 갭이 크고 오래 지속 → 사실상 정지일 가능성
//             (지속되는 대형 김프는 대개 KR 입금이 막혀서 생긴다)
//   unknown — 나머지 (키 없어 미확인, 갭도 평범)

import type { Opportunity } from "./types";

export type GateState = "open" | "closed" | "suspect" | "unknown";

/** 이보다 큰 갭이 */
export const SUSPECT_GROSS_PCT = 10;
/** 이보다 오래 순수익>0으로 버티면 정지 의심 */
export const SUSPECT_HELD_SEC = 30 * 60;

export function classifyGate(o: Pick<Opportunity, "transfer" | "grossPct" | "persistence">): GateState {
  const t = o.transfer;
  if (!t) return "unknown";
  if (t.blocked) return "closed";
  if (t.withdraw.enabled === true && t.deposit.enabled === true) return "open";
  if (Math.abs(o.grossPct) >= SUSPECT_GROSS_PCT && (o.persistence?.heldSec ?? 0) >= SUSPECT_HELD_SEC) return "suspect";
  return "unknown";
}

/** 잠긴 것으로 취급 — 배지·순위 강등·대기 목록 대상. */
export const isLocked = (g: GateState | undefined) => g === "closed" || g === "suspect";
