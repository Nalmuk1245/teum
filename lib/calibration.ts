// 비용 모델 자동 보정 — "탐지 net vs 실현 net"의 평균 누수(leak)를 김프/크로스
// 비용에 가산한다. 보드 숫자가 실현치에 수렴하게 만드는 피드백 루프.
//
// 안전장치: 실거래(!dryRun, realized 있음)만, 최소 3건, 최근 20건, 0~1.0%p로
// 클램프(이상치 한 건이 보드를 죽이지 않게). COST_CAL=off로 비활성.

import { readTrades } from "./trades";

const MIN_SAMPLES = 3;
const WINDOW = 20;
const CLAMP_MAX_PCT = 1.0;

export async function computeCalibrationPct(): Promise<{ pct: number; samples: number }> {
  if (process.env.COST_CAL === "off") return { pct: 0, samples: 0 };
  try {
    const { trades } = await readTrades(200);
    const real = trades
      .filter((t) => !t.dryRun && t.realizedNetPct != null && t.kind !== "listing")
      .slice(0, WINDOW);
    if (real.length < MIN_SAMPLES) return { pct: 0, samples: real.length };
    const leaks = real.map((t) => t.detectedNetPct - (t.realizedNetPct ?? 0));
    const avg = leaks.reduce((a, b) => a + b, 0) / leaks.length;
    return { pct: Math.min(CLAMP_MAX_PCT, Math.max(0, avg)), samples: real.length };
  } catch {
    return { pct: 0, samples: 0 };
  }
}
