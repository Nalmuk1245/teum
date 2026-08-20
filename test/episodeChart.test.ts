// 복기 곡선의 헤드라인 숫자 — "0% 위에 얼마나 있었나".
//
// 이건 카드가 묻는 질문("그때 먹을 수 있었나")에 직접 답하는 값이라, 눈금이
// 조금 틀리면 복기 자체가 틀린 결론을 준다. 특히 부호가 바뀌는 구간을
// "양수 샘플 수 × 간격"으로 근사하면 3초 단위로 최대 3초씩 밀린다 —
// 30초짜리 에피소드가 태반이라 그 오차가 10%다. 선형보간을 못 박아둔다.

import { describe, it, expect } from "vitest";
import { secondsAboveZero } from "@/lib/episodeStats";
import type { CurvePoint } from "@/app/components/EpisodeChart";

const pt = (sec: number, net: number): CurvePoint => [sec * 1000, net, net + 0.5, 1];

describe("secondsAboveZero", () => {
  it("전 구간 양수면 전체 지속시간", () => {
    expect(secondsAboveZero([pt(0, 0.5), pt(3, 0.6), pt(6, 0.4)])).toBeCloseTo(6);
  });

  it("전 구간 음수면 0", () => {
    expect(secondsAboveZero([pt(0, -0.5), pt(3, -0.6), pt(6, -0.4)])).toBe(0);
  });

  it("부호가 바뀌는 구간은 교차점까지만 센다", () => {
    // +1 → -1 사이 3초: 정확히 절반 지점에서 0을 지난다 → 1.5초
    expect(secondsAboveZero([pt(0, 1), pt(3, -1)])).toBeCloseTo(1.5);
  });

  it("교차 비율이 대칭이 아니어도 맞다", () => {
    // +3 → -1 사이 4초: 0 교차는 3/(3+1) = 75% 지점 → 3초
    expect(secondsAboveZero([pt(0, 3), pt(4, -1)])).toBeCloseTo(3);
  });

  it("음수에서 양수로 올라오는 구간도 센다", () => {
    // -1 → +3 사이 4초: 마지막 75%가 양수 → 3초
    expect(secondsAboveZero([pt(0, -1), pt(4, 3)])).toBeCloseTo(3);
  });

  it("샘플이 하나면 0 — 구간이 없다", () => {
    expect(secondsAboveZero([pt(0, 1)])).toBe(0);
  });

  it("시간이 안 흐른 중복 샘플은 건너뛴다 (0으로 나누지 않는다)", () => {
    expect(secondsAboveZero([pt(0, 1), pt(0, 1), pt(3, 1)])).toBeCloseTo(3);
  });

  it("전체 지속시간을 넘지 않는다", () => {
    const curve = [pt(0, 1), pt(3, -1), pt(6, 1), pt(9, -1)];
    expect(secondsAboveZero(curve)).toBeLessThanOrEqual(9);
    expect(secondsAboveZero(curve)).toBeGreaterThan(0);
  });
});
