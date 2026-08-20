// 에피소드 병합 — 같은 기회가 조각나지 않게.
//
// 실측 배경: 290개 에피소드가 사실 8개의 (코인+경로)였다. RED 하나가 82회,
// 재개 간격 중앙값 21~69초. 원인 두 가지를 둘 다 못 박는다:
//   ① 보드에서 잠깐 사라진 것(vanished)을 유예 없이 즉시 닫던 것
//      — 기회가 보드에서 빠지는 흔한 이유는 소멸이 아니라 스프레드 게이트다
//   ② 닫힌 직후 다시 올라오면 직전 구간을 기억하지 않고 새로 열던 것
//
// 이게 깨지면 복기의 "얼마나 지속됐나"가 조각 길이를 말하게 되고, 그 순간
// 카드 전체가 거짓말을 한다.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Opportunity } from "@/lib/types";

// 파일 쓰기를 가로채 "확정된" 에피소드만 센다.
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

// 이 파일은 병합 역학만 검증한다 — 픽스처가 1~3분짜리라 기록 하한(기본 5분)에
// 걸리면 전부 조용히 사라진다. 하한 자체는 episodeCut.test.ts가 못 박는다.
// resetModules: 같은 워커에서 episodeCut이 먼저 돌았으면 하한 300으로 캐시된
// 모듈이 남아 있다 — env를 바꿔도 임포트가 그걸 돌려줘 순서 따라 깨진다.
process.env.EPISODE_MIN_DURATION_SEC = "0";
vi.resetModules();
const { recordEpisodes, flushAllEpisodes } = await import("@/lib/episodes");

const opp = (net: number): Opportunity => ({
  id: "kimchi:TEST", kind: "kimchi", base: "TEST",
  legs: [
    { venue: "bithumb", side: "buy", symbol: "TEST_KRW", price: 1400, quote: "KRW" },
    { venue: "binance", side: "sell", symbol: "TESTUSDT", price: 1, quote: "USDT" },
  ],
  grossPct: net + 0.5, costPct: 0.5, netPct: net,
  notionalCapUsd: null, executable: true, ts: Date.now(),
} as Opportunity);

/** 틱을 n번 돌린다 (스캔 주기 3초를 흉내내려 시간을 앞으로 민다). */
function ticks(n: number, netOrGone: number | null) {
  for (let i = 0; i < n; i++) {
    vi.advanceTimersByTime(3000);
    recordEpisodes(netOrGone == null ? [] : [opp(netOrGone)]);
  }
}

/** append()는 void 비동기다 — 파일 쓰기가 끝나도록 마이크로태스크를 비운다.
 *  (fake timer는 타이머만 가로채고 프라미스는 그대로 돈다) */
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

beforeEach(() => {
  written.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-18T00:00:00Z"));
  // 모듈 상태(globalThis) 초기화
  const g = globalThis as unknown as { __arbEpisodes?: Map<string, unknown>; __arbEpisodesParked?: Map<string, unknown> };
  g.__arbEpisodes?.clear();
  g.__arbEpisodesParked?.clear();
});

describe("깜빡이는 기회는 한 구간으로 병합된다", () => {
  it("잠깐 임계 아래로 갔다 돌아오면 새 구간을 열지 않는다", async () => {
    ticks(20, 0.8);   // 60초 양수
    ticks(15, -0.3);  // 45초 음수 → 30초(10틱)에 park됨
    ticks(20, 0.8);   // 다시 양수 — 병합 창(3분) 안이라 이어 붙어야 한다
    flushAllEpisodes();
    await settle();
    expect(written).toHaveLength(1);
    const ep = written[0] as { durationSec: number };
    // 조각(60초)이 아니라 전체 수명이 기록돼야 한다
    expect(ep.durationSec).toBeGreaterThan(140);
  });

  it("보드에서 잠깐 사라져도(스프레드 게이트) 즉시 끊지 않는다", async () => {
    ticks(20, 0.8);
    ticks(3, null);   // 9초 사라짐 — 유예(30초) 안
    ticks(20, 0.8);
    flushAllEpisodes();
    await settle();
    expect(written).toHaveLength(1);
  });

  it("병합 창을 넘겨 돌아오면 별개 구간이다 — 무한정 이어붙이지 않는다", async () => {
    ticks(20, 0.8);
    ticks(15, -0.3);          // park
    vi.advanceTimersByTime(800_000); // 병합창(12분) 초과
    recordEpisodes([]);        // flushParked 트리거
    ticks(20, 0.8);            // 새 구간
    flushAllEpisodes();
    await settle();
    expect(written).toHaveLength(2);
  });

  it("진짜로 사라진 기회는 유예 뒤에 닫힌다", async () => {
    ticks(20, 0.8);
    ticks(15, null);          // 45초 부재 → 30초에 park
    vi.advanceTimersByTime(800_000);
    recordEpisodes([]);
    flushAllEpisodes();
    await settle();
    expect(written).toHaveLength(1);
    expect((written[0] as { endReason: string }).endReason).toBe("vanished");
  });
});

describe("병합해도 잃지 않는 것", () => {
  it("피크는 전 구간의 최대값이다", async () => {
    ticks(10, 0.4);
    ticks(5, 1.9);   // 1차 피크
    ticks(15, -0.3); // park
    ticks(10, 0.6);  // 재개 — 더 낮다
    flushAllEpisodes();
    await settle();
    expect((written[0] as { peakNetPct: number }).peakNetPct).toBeCloseTo(1.9, 1);
  });

  it("곡선에 양쪽 조각의 점이 모두 들어 있다", async () => {
    ticks(12, 0.8);
    ticks(15, -0.3);
    ticks(12, 0.8);
    flushAllEpisodes();
    await settle();
    const ep = written[0] as { curve: [number, number, number, number][] };
    expect(ep.curve.length).toBeGreaterThan(20);
  });
});
