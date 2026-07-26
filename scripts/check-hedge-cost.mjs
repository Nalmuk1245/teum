// 헷지 비용 모델 회귀 확인 — `node scripts/check-hedge-cost.mjs`
//
// 한 번 틀렸던 부분을 고정한다: "진입 베이시스가 t0에 잠긴다"고 보고 비용에서
// 깎았는데, 보드 총차익과 비교해 전개하면 베이시스 수준은 소거되고 변화량만
// 남는다. 아래 시뮬레이션이 그 사실을 숫자로 못박는다.
//
// 실제 hedgeCost()를 import하려면 TS 컴파일이 필요해서, 여기서는 손익 항등식
// 자체를 검증한다 — 모델이 무엇을 비용으로 잡아야 하는지의 근거다.

let fail = 0;
const eq = (name, got, want, tol = 1e-9) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${got.toFixed(4)}% (기대 ${want.toFixed(4)}%)`);
};

/** 김프 정상 방향: 글로벌 현물 매수 → 전송 → KR 매도, 퍼프 숏 헷지. 수수료 제외. */
function pnlPct({ S0, K0, b0, move, b1 }) {
  const F0 = S0 * (1 + b0 / 100);
  const G1 = S0 * (1 + move / 100);
  const K1 = K0 * (1 + move / 100); // KR도 같이 움직임(프리미엄 유지)
  const F1 = G1 * (1 + b1 / 100);
  return ((K1 - S0) + (F0 - F1)) / S0 * 100;
}

const S0 = 100, K0 = 101;            // KR 프리미엄 +1%
const boardGross = (K0 - S0) / S0 * 100;

console.log("보드 총차익 %s%%\n", boardGross.toFixed(3));

// ① 베이시스가 유지되면 진입 베이시스는 회수되지 않는다 — 방향·부호 무관.
eq("콘탱고 +0.3% 유지, 가격 불변", pnlPct({ S0, K0, b0: 0.3, move: 0, b1: 0.3 }), boardGross);
eq("백워데이션 −0.3% 유지, 가격 불변", pnlPct({ S0, K0, b0: -0.3, move: 0, b1: -0.3 }), boardGross);

// ② 회수되는 건 베이시스 "변화"뿐이다.
eq("콘탱고 +0.3% → 0 수렴", pnlPct({ S0, K0, b0: 0.3, move: 0, b1: 0 }), boardGross + 0.3);
eq("베이시스 0 → +0.3% 확대", pnlPct({ S0, K0, b0: 0, move: 0, b1: 0.3 }), boardGross - 0.3);

// ③ 헷지는 가격 이동을 상쇄한다 — 단, 완전히는 아니다.
// 프리미엄은 가격에 **비례**하는데(KR이 1% 비싸다 = 가격의 1%) 헷지는 수량
// 기준이라, 실현 엣지가 boardGross×(1+가격변화)로 스케일된다. 즉 하락하면
// 엣지가 조금 줄고 상승하면 조금 늘어난다. 부호 대칭이고 기대값이 0이라
// 비용으로 모델링하지 않지만, "헷지했으니 엣지가 고정"은 아니라는 뜻이다.
// (예: −20% 급락이면 1.00% → 0.80%)
for (const move of [-20, -10, 10, 20]) {
  const got = pnlPct({ S0, K0, b0: 0, move, b1: 0 });
  eq(`가격 ${move > 0 ? "+" : ""}${move}% · 베이시스 0`, got, boardGross * (1 + move / 100));
}

console.log(`\n${fail === 0 ? "전부 통과" : `${fail}건 실패`}`);
process.exit(fail === 0 ? 0 : 1);
