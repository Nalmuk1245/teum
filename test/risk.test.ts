// 리스크 한도 — 서버 authoritative 게이트. 이 게이트가 조용히 통과시키면
// 한도라는 방어선 자체가 없는 것과 같으므로, 경계값을 못으로 박아둔다.

import { describe, it, expect, beforeEach } from "vitest";
import { setLimits, checkEntry, recordPnl, riskState } from "@/lib/risk";

beforeEach(() => {
  setLimits({ maxPerTradeUsd: 1000, maxInFlightUsd: 5000, maxDailyLossUsd: 100 });
});

describe("checkEntry — 1회 규모 한도", () => {
  it("한도 안이면 통과", () => {
    expect(checkEntry(999)).toBeNull();
  });

  it("한도와 같으면 통과 — 경계는 포함이다", () => {
    expect(checkEntry(1000)).toBeNull();
  });

  it("한도를 넘으면 이유를 돌려준다", () => {
    expect(checkEntry(1001)).toMatch(/1회 한도 초과/);
  });
});

describe("checkEntry — 일일 손실 한도", () => {
  it("손실이 한도 미만이면 통과", () => {
    const start = riskState().realizedPnlUsd;
    recordPnl(-(99 + start)); // 누적 -99
    expect(checkEntry(10)).toBeNull();
  });

  it("손실이 한도에 닿으면 신규 진입을 막는다", () => {
    recordPnl(-1000);
    expect(checkEntry(10)).toMatch(/일일 손실 한도/);
  });

  it("이익은 한도를 소모하지 않는다", () => {
    recordPnl(2000); // 위 테스트의 손실을 덮고도 남게
    expect(checkEntry(10)).toBeNull();
  });
});

describe("setLimits", () => {
  it("음수·NaN은 무시하고 기존 값을 지킨다 — 한도가 0/NaN이 되면 게이트가 죽는다", () => {
    setLimits({ maxPerTradeUsd: -5 });
    expect(riskState().maxPerTradeUsd).toBe(1000);
    setLimits({ maxPerTradeUsd: Number.NaN });
    expect(riskState().maxPerTradeUsd).toBe(1000);
  });

  it("0은 유효한 값이다 — 의도적인 전면 정지", () => {
    setLimits({ maxPerTradeUsd: 0 });
    expect(riskState().maxPerTradeUsd).toBe(0);
    expect(checkEntry(1)).toMatch(/1회 한도 초과/);
  });
});
