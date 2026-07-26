// 헷지 실비용 — 테이커 수수료 + 현물·선물 괴리(베이시스) + 펀딩.
//
// 지금까지 보드는 헷지 비용을 "퍼프 테이커 왕복"만 잡았다. 그건 세 항목 중 하나다.
//
// ── 베이시스는 비용이 아니다 (한 번 틀렸던 부분) ──────────────────────────────
// 처음엔 "진입 베이시스 (F0 − S0)가 t0에 잠긴다"고 보고 비용에서 깎았다. 틀렸다.
// 손익을 **보드가 보여준 총차익과 비교해서** 전개해야 한다:
//
//   실제 = (K1 − S0) + (F0 − F1)                     // 현물 다리 + 숏 다리
//   보드 = (K0 − S0)                                  // t0 시점 프리미엄
//   차이 = (K1 − K0) + (F0 − F1)
//        = (K1 − K0) − (G1 − G0) − (b1 − b0)          // F = G + b 대입
//
// 남는 건 전부 **변화량**이다 — KR/글로벌 상대 이동과 베이시스 변화. 진입 베이시스
// 수준(b0)은 소거된다. 퍼프를 현물에 되파는 게 아니라 퍼프로 되사서 닫기 때문이다.
//
// 수치 확인 (S0=100, KR +1%, 콘탱고 +0.3%):
//   가격 불변·베이시스 유지     → 실제 +1.000%  (크레딧 예측 +1.300%)  ← 허깨비
//   −10% 하락·베이시스 유지     → 실제 +0.930%
//   가격 불변·베이시스 0 수렴    → 실제 +1.300%  ← 이때만 회수된다
//
// 무기한물은 만기 수렴이 없고, 우리 보유 시간은 5~30분이라 펀딩이 베이시스를 끌어
// 당기는 시간축(8시간)보다 훨씬 짧다. 그래서 수렴을 기대할 근거가 없다.
// → basisPct는 **표시만** 한다. 없는 수익을 장부에 올리지 않는다.
//   (반대로 없는 비용도 만들지 않는다 — 부호 대칭을 깨면 코인 간 비교가 망가진다.)
// 진짜 남는 위험인 "베이시스 변화"는 크기 문제이며 transferRisk가 다루는 종류다.
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
  /**
   * 진입 베이시스 (마크 − 현물). **표시 전용 — totalPct에 안 들어간다.**
   * 양수 = 콘탱고(퍼프가 비쌈). 수렴하면 숏에 유리하지만 무기한물 5~30분
   * 보유에서 수렴을 기대할 근거가 없다(위 주석 참고). 크면 헷지가 현물을
   * 그만큼 못 따라간다는 신호로 읽는다.
   */
  basisPct: number;
  /** 창 안에 정산이 있을 때만 0이 아니다. 양수 = 우리가 무는 쪽. */
  fundingPct: number;
  /** 실제로 netPct에서 빼는 값 = 테이커 왕복 + (창 안) 펀딩. 베이시스 제외. */
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

  // 베이시스는 더하지도 빼지도 않는다 — 표시만 한다(위 주석의 수치 근거).
  //
  // 펀딩은 **무는 쪽만 반영하고 받는 쪽은 장부에 올리지 않는다.** 비대칭이 의도다:
  // 이 값은 예측치(predicted)이고 정산 스냅샷에 우리가 여전히 숏이어야 들어온다.
  // 반면 테이커 왕복은 확정 비용이다. 크레딧을 반영하면 총비용이 음수가 될 수
  // 있고, 그러면 실행 게이트(execNetPct <= extra)가 **적자 거래를 통과시킨다** —
  // 아직 들어오지도 않은 돈으로 손실을 정당화하는 셈이다.
  // 실측(바이낸스 799개): 크레딧이 테이커 왕복(0.09%)을 덮는 코인은 1개뿐이라
  // 잃는 기회는 거의 없고, 무는 쪽은 최대 −1.29%까지 있어 반영이 꼭 필요하다.
  const totalPct = takerPct + Math.max(0, fundingPct);
  return { takerPct, basisPct, fundingPct, totalPct, settlesInWindow, basisSuspect: basisSuspect || undefined };
}
