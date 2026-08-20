// 에피소드 기록 하한 — 5분 못 버틴 기회는 안 적는다 (운영자 결정 2026-08-21).
//
// 전송 ETA 60분짜리 전략에서 5분도 못 버틴 갭은 복기 가치가 없다. 피크 우회도
// 없앴다 — 아무리 높은 피크도 못 버티면 못 먹는 기회다. 이 컷이 사라지면
// 복기 목록이 호가 반짝으로 다시 도배된다.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Opportunity } from "@/lib/types";

const written: unknown[] = [];
vi.mock("fs", async (orig) => {
  const real = (await orig()) as typeof import("fs");
  return {
    ...real,
    existsSync: () => true,
    mkdirSync: () => undefined,
    statSync: () => ({ size: 0 }) as never,
    promises: {
      ...real.promises,
      appendFile: async (_f: string, line: string) => { written.push(JSON.parse(String(line))); },
    },
  };
});

// 기본값(300s) 그대로 임포트 — episodes.test.ts와 달리 여기선 컷이 주인공이다.
delete process.env.EPISODE_MIN_DURATION_SEC;
vi.resetModules();
const { recordEpisodes, flushAllEpisodes } = await import("@/lib/episodes");

const opp = (net: number): Opportunity => ({
  id: "kimchi:CUT", kind: "kimchi", base: "CUT",
  legs: [
    { venue: "bithumb", side: "buy", symbol: "CUT_KRW", price: 1400, quote: "KRW" },
    { venue: "binance", side: "sell", symbol: "CUTUSDT", price: 1, quote: "USDT" },
  ],
  grossPct: net + 0.5, costPct: 0.5, netPct: net,
  notionalCapUsd: null, executable: true, ts: Date.now(),
} as Opportunity);

function ticks(n: number, net: number) {
  for (let i = 0; i < n; i++) {
    vi.advanceTimersByTime(3000);
    recordEpisodes([opp(net)]);
  }
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

beforeEach(() => {
  written.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-18T00:00:00Z"));
  const g = globalThis as unknown as { __arbEpisodes?: Map<string, unknown>; __arbEpisodesParked?: Map<string, unknown> };
  g.__arbEpisodes?.clear();
  g.__arbEpisodesParked?.clear();
});

describe("기록 하한 5분", () => {
  it("4분짜리는 피크가 높아도 버린다", async () => {
    ticks(80, 3.5); // 240초 — 예전 규칙(피크 0.5%+)이면 남았을 기회
    flushAllEpisodes();
    await settle();
    expect(written).toHaveLength(0);
  });

  it("6분짜리는 남는다", async () => {
    ticks(120, 0.8); // 360초
    flushAllEpisodes();
    await settle();
    expect(written).toHaveLength(1);
    expect((written[0] as { durationSec: number }).durationSec).toBeGreaterThanOrEqual(300);
  });
});
