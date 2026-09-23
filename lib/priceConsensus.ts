// 같은 티커 = 같은 토큰이 아니다 — 거래소끼리 가격을 대조해 튀는 곳을 걸러낸다.
//
// 신규 상장 코인은 옛 코인과 티커가 겹치는 일이 흔하다(예: 2026-08 LIT — 바이낸스의
// LITUSDT $0.74는 다른 토큰, 바이비트·OKX의 $5.15가 상장 코인). "바이낸스에 있으면
// 바이낸스"로 매수처를 고르면 공지 자동매수가 엉뚱한 토큰을 산다. 김프 계산도
// "가장 싼 해외 가격"을 쓰면 +587% 같은 유령값이 나온다.
//
// 규칙: 가격이 서로 ±TOL 안이면 같은 토큰으로 본다. 가장 많이 동의받는 묶음이 정답.
//  - 둘 이상이 서로 동의 → 그 묶음이 합의, 나머지는 의심(outlier)
//  - 전부 제각각(동의 0) → 판단 불가(ambiguous) — 무인 매수는 하지 않는다
//  - 한 곳뿐 → 대조 불가(single) — 그대로 쓰되 표시만

export const CONSENSUS_TOL = 0.3; // ±30% — 상장 직후 펌프로 거래소 간 괴리가 커도 다른 토큰(수 배~수십 배)과는 구분된다

export type PricedVenue = { venue: string; price: number };
export type Consensus = {
  /** 합의 묶음에 든 거래소 (입력 순서 유지 — 호출부의 선호 순서가 곧 우선순위) */
  agreed: string[];
  /** 합의에서 튀는 거래소 — 다른 토큰이거나 멈춘 시장 */
  outliers: string[];
  ambiguous: boolean;
  single: boolean;
};

const near = (a: number, b: number, tol: number) => Math.abs(a / b - 1) <= tol;

export function priceConsensus(rows: PricedVenue[], tol = CONSENSUS_TOL): Consensus {
  const xs = rows.filter((r) => r.price > 0 && Number.isFinite(r.price));
  if (xs.length === 0) return { agreed: [], outliers: [], ambiguous: false, single: false };
  if (xs.length === 1) return { agreed: [xs[0].venue], outliers: [], ambiguous: false, single: true };
  const support = xs.map((a) => xs.filter((b) => b !== a && near(a.price, b.price, tol)).length);
  const best = Math.max(...support);
  if (best === 0) return { agreed: [], outliers: xs.map((x) => x.venue), ambiguous: true, single: false };
  // 최다 동의 거래소를 씨앗으로 그 묶음을 모은다 (씨앗과 가까운 것만).
  const seed = xs[support.indexOf(best)];
  const agreed = xs.filter((x) => x === seed || near(x.price, seed.price, tol)).map((x) => x.venue);
  return { agreed, outliers: xs.map((x) => x.venue).filter((v) => !agreed.includes(v)), ambiguous: false, single: false };
}
