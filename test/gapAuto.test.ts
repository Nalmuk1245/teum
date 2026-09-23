// 갭 자동 진입 후보 선택 — 돈이 나가는 무인 판단이라 거르는 규칙마다 못 박는다.

import { describe, it, expect } from "vitest";
import { pickCandidate, DEFAULT_GAP_AUTO, type GapAutoCfg } from "@/lib/gapAuto";
import type { Opportunity } from "@/lib/types";

const cfg: GapAutoCfg = { ...DEFAULT_GAP_AUTO, armed: true };
const opp = (base: string, net: number, o: Partial<Opportunity> = {}): Opportunity => ({
  id: `kimchi:${base}`, kind: "kimchi", base, legs: [], grossPct: net + 1, costPct: 1, netPct: net,
  notionalCapUsd: 1000, executable: true, hasPerp: true, gate: "open", ts: 0,
  persistence: { heldSec: 120, hitRatePct: 100, samples: 10, volPctPerMin: 0, jumpPct: 0 }, ...o,
});
const run = (opps: Opportunity[], over: Partial<Parameters<typeof pickCandidate>[0]> = {}) =>
  pickCandidate({ opps, cfg, now: 10_000_000, dry: false, lastEntryByBase: {}, busyBases: new Set(), ...over });

describe("pickCandidate", () => {
  it("조건을 다 채운 것 중 순수익 최고", () => {
    expect(run([opp("A", 1.0), opp("B", 1.5), opp("C", 0.5)]).pick?.base).toBe("B");
  });
  it("대형 갭·지속 부족·실행 불가·잠김·헷지 불가는 거른다", () => {
    const r = run([
      opp("BIG", 20), opp("SHORT", 2, { persistence: { heldSec: 10, hitRatePct: 100, samples: 1, volPctPerMin: 0, jumpPct: 0 } }),
      opp("X", 2, { executable: false }), opp("L", 2, { gate: "suspect" }), opp("NP", 2, { hasPerp: false }),
    ]);
    expect(r.pick).toBeNull();
    expect(r.skipped).toMatchObject({ "대형 갭": 1, "지속 부족": 1, "실행 불가": 1, "입출금 잠김": 1, "헷지 불가": 1 });
  });
  it("라이브는 확인된 열림만, 페이퍼는 미확인도 허용", () => {
    expect(run([opp("U", 2, { gate: "unknown" })]).pick).toBeNull();
    expect(run([opp("U", 2, { gate: "unknown" })], { dry: true }).pick?.base).toBe("U");
  });
  it("쿨다운·진행 중 코인은 건너뛴다", () => {
    expect(run([opp("A", 2)], { lastEntryByBase: { A: 10_000_000 - 60_000 } }).pick).toBeNull();
    expect(run([opp("A", 2)], { lastEntryByBase: { A: 10_000_000 - 31 * 60_000 } }).pick?.base).toBe("A");
    expect(run([opp("A", 2)], { busyBases: new Set(["A"]) }).pick).toBeNull();
  });
  it("크로스는 퍼프 없어도 된다 (전송형 헷지 선택), 전략 목록 밖은 무시", () => {
    expect(run([opp("C", 2, { kind: "cross-cex", hasPerp: false })]).pick?.base).toBe("C");
    expect(run([opp("D", 2, { kind: "cex-dex" })]).pick).toBeNull();
  });
});
