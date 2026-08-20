// 끊김 없이 흑자였던 최장 시간 — ETA 경고의 유일한 근거.
//
// 왜 별도 함수인가: 처음엔 "구간을 묶은 창의 길이"를 썼는데, 그러면 묶는 창
// (12분)만큼의 구멍이 "연속"에 삼켜진다. 실측 RED가 그 방식으로는 최장 86분이
// 나와 ETA 60분을 넘긴 것처럼 보였지만, 실제로 끊김 없이 흑자였던 건 3분이었다.
// 두 숫자가 30배 차이 나고, 그 차이가 곧 "먹을 수 있었다/없었다"를 뒤집는다.

import { describe, it, expect } from "vitest";
import { longestProfitableRunSec, type NetPoint } from "@/lib/episodeStats";

const S = 1000;
/** 3초 간격 샘플로 net 배열을 곡선으로. */
const curve = (nets: number[], stepSec = 3): NetPoint[] =>
  nets.map((v, i) => [i * stepSec * S, v, v + 0.5, 1] as NetPoint);

describe("longestProfitableRunSec", () => {
  it("전 구간 흑자면 전체 길이", () => {
    expect(longestProfitableRunSec(curve([1, 1, 1, 1, 1]))).toBeCloseTo(12);
  });

  it("전 구간 적자면 0", () => {
    expect(longestProfitableRunSec(curve([-1, -1, -1]))).toBe(0);
  });

  it("한 번 음수로 내려가면 런이 끊긴다 — 이어 붙이지 않는다", () => {
    // 흑자 4틱(12초) → 음수 → 흑자 2틱(6초). 최장은 12초 쪽이지 18초가 아니다.
    const v = [1, 1, 1, 1, -1, 1, 1];
    const got = longestProfitableRunSec(v.map((x, i) => [i * 3 * S, x, 0, 1] as NetPoint));
    expect(got).toBeLessThan(15);
    expect(got).toBeGreaterThan(10);
  });

  it("부호가 바뀌는 구간은 교차점까지만 센다", () => {
    // +1 → -1 사이 3초는 절반만 흑자
    expect(longestProfitableRunSec([[0, 1, 0, 1], [3 * S, -1, 0, 1]] as NetPoint[])).toBeCloseTo(1.5);
  });

  it("관측이 끊긴 곳(구멍)에서는 이어 붙이지 않는다", () => {
    // 흑자 2틱 → 10분 공백 → 흑자 2틱. 최장은 6초지 10분+가 아니다.
    const pts: NetPoint[] = [
      [0, 1, 0, 1], [3 * S, 1, 0, 1], [6 * S, 1, 0, 1],
      [606 * S, 1, 0, 1], [609 * S, 1, 0, 1],
    ];
    expect(longestProfitableRunSec(pts)).toBeCloseTo(6);
  });

  it("가장 긴 런을 고른다 (마지막 런이 아니라)", () => {
    // 긴 흑자(30초) → 음수 → 짧은 흑자(6초)
    const nets = [...Array(11).fill(1), -1, 1, 1, 1];
    const got = longestProfitableRunSec(nets.map((x, i) => [i * 3 * S, x, 0, 1] as NetPoint));
    expect(got).toBeGreaterThan(28);
  });

  it("실측 RED 모양 — 걸친 시간은 길어도 끊김 없는 흑자는 짧다", () => {
    // 3초 간격으로 흑/적을 오가는 2시간치. 걸친 시간은 2시간이지만
    // 끊김 없는 흑자는 한 자릿수 분이어야 한다.
    const nets = Array.from({ length: 2400 }, (_, i) => (Math.floor(i / 20) % 3 === 0 ? 0.3 : -0.1));
    const got = longestProfitableRunSec(nets.map((x, i) => [i * 3 * S, x, 0, 1] as NetPoint));
    expect(got).toBeLessThan(120); // 2분 미만
  });

  it("샘플이 하나면 0", () => {
    expect(longestProfitableRunSec([[0, 1, 0, 1]] as NetPoint[])).toBe(0);
  });
});
