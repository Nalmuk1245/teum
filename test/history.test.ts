// 보드 스파크라인 다운샘플 — 조용히 틀리는 지점 두 곳에 못을 박는다:
// ① 마지막 샘플 누락(스파크 끝과 순수익 칸이 다른 시점을 가리키게 된다)
// ② 상한 초과(스캔 응답 페이로드가 기회 수 × 창 해상도로 곱해진다).

import { describe, it, expect } from "vitest";
import { recordGap, sparkGross } from "@/lib/history";

describe("sparkGross", () => {
  it("샘플 2개 미만이면 빈 배열", () => {
    expect(sparkGross("t:none")).toEqual([]);
    recordGap("t:one", 1, 2, 100, Date.now());
    expect(sparkGross("t:one")).toEqual([]);
  });

  it("적으면 그대로, 많으면 상한으로 줄이되 처음/끝을 보존한다", () => {
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) recordGap("t:few", 1, i, 100, t0 + i * 3000);
    expect(sparkGross("t:few")).toHaveLength(10);
    expect(sparkGross("t:few")[9]).toBe(9);

    for (let i = 0; i < 200; i++) recordGap("t:many", 1, i * 0.01, 100, t0 + i * 3000);
    const s = sparkGross("t:many");
    expect(s).toHaveLength(40);
    expect(s[0]).toBe(0); // 첫 샘플
    expect(s[39]).toBeCloseTo(1.99); // 마지막 샘플 — 현재값과 일치해야 한다
    // 단조 증가 입력이면 다운샘플도 단조 — 순서가 섞이지 않는다
    for (let i = 1; i < s.length; i++) expect(s[i]).toBeGreaterThan(s[i - 1]);
  });
});
