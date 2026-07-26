// 헷지 실비용 — 테이커 수수료 + 현물·선물 괴리(베이시스) + 펀딩.
//
// 지금까지 보드는 헷지 비용을 "퍼프 테이커 왕복"만 잡았다. 그건 세 항목 중 하나다.
//
// ── 왜 베이시스가 비용(또는 수익)인가 ────────────────────────────────────────
// 김프 홉의 손익을 t0(현물 매수 + 퍼프 숏)와 t1(KR 매도 + 숏 청산)으로 전개하면:
//
//   PnL = (K1 − S0) + (F0 − F1)          // 현물 다리 + 숏 다리
//       = (K1 − F1) + (F0 − S0)
//       = [청산 시점의 KR−퍼프 스프레드] + [진입 시점 베이시스]
//
// 즉 **진입 베이시스는 t0에 확정된다.** 현물을 사고 퍼프를 파는 그 순간 (F0 − S0)이
// 잠긴다. 추정이나 리스크가 아니라 두 호가를 보면 바로 아는 값이다. 퍼프가 현물보다
// 비싸면(콘탱고) 숏이 그만큼 유리하게 들어가고, 싸면(백워데이션) 그만큼 손해를 안고
// 시작한다. 보드가 이걸 빼먹으면 백워데이션 코인의 순익을 과대평가한다.
//
// 남은 불확실성은 (K1 − F1)인데, 그건 이미 transferRisk가 드리프트·점프로 다룬다.
//
// ── 왜 펀딩을 "정산 시각"으로 따지는가 ────────────────────────────────────────
// 펀딩은 연속으로 흐르지 않는다. 정산 스냅샷 그 순간에만 오간다. 전송 ETA가 보통
// 5~30분이라 대부분의 홉은 정산을 한 번도 안 지나가고, 그때 기대 펀딩은 0이다.
// 반대로 경계를 걸치면 8시간치를 통째로 받거나 문다. 그래서 ETA×비율로 비례배분하면
// 양쪽 다 틀린다 — 평소엔 없는 비용을 잡고, 정작 걸칠 땐 실제의 몇 분의 일만 잡는다.
// funding.ts가 nextTs/intervalH를 이미 들고 있으므로 "창 안에 정산이 있는가"로 본다.
//
// 부호: 펀딩률 > 0 이면 롱이 숏에게 준다 → 우리는 숏이므로 **받는다**(비용 음수).

import { FEES } from "./config";
import type { FundingMap, Venue } from "./types";
import type { MarkMap } from "./funding";

/** 헷지 한 사이클의 비용 분해. 전부 % 단위, 양수 = 비용. */
export type HedgeCost = {
  takerPct: number;
  /** 진입 베이시스. 양수 = 퍼프가 현물보다 비쌈 = 숏에 유리 → 비용에서 차감. */
  basisPct: number;
  /** 창 안에 정산이 있을 때만 0이 아니다. 양수 = 우리가 무는 쪽. */
  fundingPct: number;
  /** 세 항목 합 — 이걸 netPct에서 뺀다. */
  totalPct: number;
  /** 정산을 지나가는가 (UI가 "이번 홉은 펀딩 없음"을 말할 수 있게). */
  settlesInWindow: boolean;
  /** 마크가 현물과 너무 벌어져 베이시스를 못 믿는다 → 0으로 뒀다는 표시.
   *  이 행은 헷지 비용이 **과소평가**돼 있을 수 있다. 숨기지 말고 보여줘야 한다. */
  basisSuspect?: boolean;
};

/** 헷지 거래소 — 가격 헷지라 현물을 어디서 사든 바이낸스 USDT-M 퍼프를 쓴다. */
export const HEDGE_VENUE: Venue = "binance";

// 베이시스가 이보다 크면 데이터 오류로 본다(마크가 낡았거나 계약 단위가 다름 —
// 실측: 바이낸스 449개 중 66개가 |3%| 초과, 최대 +378%). 실제 영구선물 베이시스는
// 정상 시장에서 ±0.5% 안쪽이고, 위 표본의 중앙값은 −0.10% / p95 +0.31%였다.
const MAX_SANE_BASIS_PCT = 3;

/**
 * @param spotUsd   진입할 현물 가격 (글로벌 다리)
 * @param etaMin    헷지를 들고 있는 시간 = 전송 ETA. null이면 정산 판단 불가 → 0.
 */
export function hedgeCost(
  base: string,
  spotUsd: number,
  etaMin: number | null,
  funding: FundingMap | undefined,
  marks: MarkMap | undefined,
): HedgeCost {
  const takerPct = (FEES.perpTakerPct[HEDGE_VENUE] ?? 0.045) * 2;

  // ── 베이시스 ──
  let basisPct = 0;
  let basisSuspect = false;
  const mark = marks?.get(base)?.[HEDGE_VENUE];
  if (mark && mark > 0 && spotUsd > 0) {
    const b = ((mark - spotUsd) / spotUsd) * 100;
    if (Math.abs(b) <= MAX_SANE_BASIS_PCT) {
      basisPct = b;
    } else {
      // 범위를 벗어나면 "진짜 큰 괴리"인지 "데이터가 틀린 것"인지 구분할 수 없다.
      // 어느 쪽이든 이득으로 잡지는 않는다(없는 수익을 만들지 않는다). 대신
      // 조용히 0으로 넘기면 백워데이션 −5%짜리가 무비용처럼 보이므로 표시한다.
      basisSuspect = true;
    }
  }

  // ── 펀딩 ──
  let fundingPct = 0;
  let settlesInWindow = false;
  const fr = funding?.get(base)?.find((f) => f.venue === HEDGE_VENUE);
  if (fr && etaMin != null && etaMin > 0) {
    const windowMs = etaMin * 60_000;
    if (fr.nextTs != null) {
      settlesInWindow = fr.nextTs - Date.now() <= windowMs;
    } else if (fr.intervalH != null && fr.intervalH > 0) {
      // 정산 시각을 모르면 창이 주기를 덮을 때만 확실히 지나간다고 본다.
      settlesInWindow = windowMs >= fr.intervalH * 3600_000;
    }
    if (settlesInWindow) {
      // rate8h는 8시간 기준으로 정규화된 값이고, 실제 정산은 intervalH마다다.
      // 한 번 지나갈 때 오가는 건 그 주기 몫이다.
      const perSettlement = fr.rate8h * ((fr.intervalH ?? 8) / 8);
      fundingPct = -perSettlement * 100; // 숏은 rate>0일 때 받는다 → 비용 음수
    }
  }

  // 베이시스는 숏에 유리할수록(양수) 비용을 깎는다.
  const totalPct = takerPct - basisPct + fundingPct;
  return { takerPct, basisPct, fundingPct, totalPct, settlesInWindow, basisSuspect: basisSuspect || undefined };
}
