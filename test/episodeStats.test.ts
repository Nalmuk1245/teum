// 복기 집계 — "최장 연속"과 ETA 판정.
//
// 여기가 틀리면 카드가 조용히 거짓말을 한다. 특히 누적 시간과 최장 연속을
// 혼동하는 회귀: 실측 RED는 누적 123분인데 가장 길게 이어진 건 47분이었고,
// 전송 ETA는 60분이었다 — 즉 **먹을 수 없었던** 기회다. 누적을 쓰면 정반대로
// 읽힌다.

import { describe, it, expect } from "vitest";
import { mergeWindows, longestWindowSec, outlastsEta } from "@/lib/episodeStats";

const MIN = 60_000;
const span = (startMin: number, endMin: number) => ({ startTs: startMin * MIN, endTs: endMin * MIN });

describe("mergeWindows", () => {
  it("창 안에 붙은 구간은 하나로", () => {
    const w = mergeWindows([span(0, 10), span(15, 25)], 12 * MIN); // 간격 5분
    expect(w).toHaveLength(1);
    expect((w[0].endTs - w[0].startTs) / MIN).toBe(25);
  });

  it("창을 넘으면 나뉜다", () => {
    const w = mergeWindows([span(0, 10), span(40, 50)], 12 * MIN); // 간격 30분
    expect(w).toHaveLength(2);
  });

  it("입력 순서가 뒤죽박죽이어도 맞다 (목록은 최신순으로 온다)", () => {
    const w = mergeWindows([span(40, 50), span(0, 10), span(15, 25)], 12 * MIN);
    expect(w).toHaveLength(2);
    expect(w[0].startTs).toBe(0);
  });

  it("겹치는 구간을 삼킨다", () => {
    const w = mergeWindows([span(0, 30), span(10, 20)], 0);
    expect(w).toHaveLength(1);
    expect((w[0].endTs - w[0].startTs) / MIN).toBe(30);
  });

  it("빈 입력은 빈 결과", () => {
    expect(mergeWindows([], 12 * MIN)).toEqual([]);
  });
});

describe("longestWindowSec — 누적과 다르다", () => {
  it("조각의 합이 아니라 가장 긴 연결 구간", () => {
    // 조각 셋: 10분 + 10분 + 10분 = 누적 30분. 하지만 서로 멀리 떨어져 있다.
    const spans = [span(0, 10), span(60, 70), span(120, 130)];
    expect(longestWindowSec(spans, 12 * MIN) / 60).toBe(10); // 30이 아니다
  });

  it("붙어 있으면 이어진 길이", () => {
    const spans = [span(0, 10), span(15, 25), span(30, 47)];
    expect(longestWindowSec(spans, 12 * MIN) / 60).toBe(47);
  });

  it("실측 RED 모양 — 누적은 길지만 최장은 짧다", () => {
    // 5분짜리 12조각이 20분 간격으로 흩어져 있으면 누적 60분, 최장 5분.
    const spans = Array.from({ length: 12 }, (_, i) => span(i * 25, i * 25 + 5));
    const totalMin = spans.reduce((s, x) => s + (x.endTs - x.startTs) / MIN, 0);
    expect(totalMin).toBe(60);
    expect(longestWindowSec(spans, 12 * MIN) / 60).toBe(5);
  });
});

describe("outlastsEta", () => {
  it("최장 연속이 ETA 이상이면 실현 가능", () => {
    expect(outlastsEta(64 * 60, 60)).toBe(true);
  });

  it("ETA에 못 미치면 불가 — 순수익이 얼마든", () => {
    expect(outlastsEta(47 * 60, 60)).toBe(false);
  });

  it("딱 같으면 가능 (경계 포함)", () => {
    expect(outlastsEta(60 * 60, 60)).toBe(true);
  });

  it("ETA를 모르면 판정하지 않는다 — 모르면서 아는 척하지 않는다", () => {
    expect(outlastsEta(60 * 60, null)).toBeNull();
    expect(outlastsEta(60 * 60, undefined)).toBeNull();
    expect(outlastsEta(60 * 60, 0)).toBeNull();
  });
});
