// 상장따리 자동 청산 판단 — 돈이 나가는 결정이라 규칙마다 못 박는다.

import { describe, it, expect } from "vitest";
import { decideExit, DEFAULT_EXIT, type ListingExitCfg } from "@/lib/listingExit";

const cfg: ListingExitCfg = { ...DEFAULT_EXIT, enabled: true, takeProfitPct: 20, stopLossPct: 8, trailingPct: 7, afterOpenMin: 5, maxHoldMin: 60 };
const base = { entryPx: 100, curPx: 100, peakPx: 100, heldMin: 1, openedMinAgo: null as number | null, cfg };

describe("decideExit", () => {
  it("꺼져 있으면 아무것도 안 판다", () => {
    expect(decideExit({ ...base, curPx: 50, cfg: { ...cfg, enabled: false } }).sell).toBe(false);
  });
  it("손절·익절", () => {
    const s = decideExit({ ...base, curPx: 91 });
    expect(s.sell && s.rule).toBe("stop");
    const t = decideExit({ ...base, curPx: 121, peakPx: 121 });
    expect(t.sell && t.rule).toBe("take");
  });
  it("트레일링은 최고가가 진입가 위일 때만", () => {
    const tr = decideExit({ ...base, curPx: 106, peakPx: 115 }); // 115에서 −7.8%
    expect(tr.sell && tr.rule).toBe("trail");
    // 한 번도 수익권에 못 간 포지션은 트레일링이 아니라 손절이 맡는다
    expect(decideExit({ ...base, curPx: 94, peakPx: 100 }).sell).toBe(false);
  });
  it("국내 개장 후 N분, 최대 보유", () => {
    const o = decideExit({ ...base, curPx: 103, peakPx: 104, openedMinAgo: 5 });
    expect(o.sell && o.rule).toBe("open");
    expect(decideExit({ ...base, curPx: 103, peakPx: 104, openedMinAgo: 4 }).sell).toBe(false);
    const h = decideExit({ ...base, heldMin: 60 });
    expect(h.sell && h.rule).toBe("hold");
  });
  it("0으로 둔 규칙은 끈다", () => {
    const off = { ...cfg, stopLossPct: 0, maxHoldMin: 0 };
    expect(decideExit({ ...base, curPx: 50, cfg: off }).sell).toBe(false);
    expect(decideExit({ ...base, heldMin: 999, cfg: off }).sell).toBe(false);
  });
  it("손절이 익절·트레일링보다 먼저 (같은 틱에 둘 다 걸리는 비정상 값에서도 보수적으로)", () => {
    const d = decideExit({ ...base, curPx: 90, peakPx: 130 });
    expect(d.sell && d.rule).toBe("stop");
  });
});
