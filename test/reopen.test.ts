// 재개 대응 — 순수 판단 함수. 돈이 나가는 결정(사전 포지션·자동 실행)은 여기서 못 박는다.

import { describe, it, expect } from "vitest";
import { pickTargets, parseReopenNotice, watchIntervalMs, decideOnOpen, shouldPreposition, type ReopenAutoCfg } from "@/lib/reopen";
import type { Opportunity } from "@/lib/types";

const opp = (base: string, netPct: number, gate: Opportunity["gate"], id = `kimchi:${base}`): Opportunity => ({
  id, kind: "kimchi", base, grossPct: netPct + 1, costPct: 1, netPct, notionalCapUsd: 100, executable: false, ts: 0, gate,
  legs: [{ venue: "binance", side: "buy", symbol: `${base}USDT`, price: 1, quote: "USDT" }, { venue: "upbit", side: "sell", symbol: `KRW-${base}`, price: 1400, quote: "KRW" }],
});
const cfg: ReopenAutoCfg = { armed: true, sizeUsd: 300, minNet: 1, whitelist: [], preposition: true, prepositionLeadMin: 5, prepositionMaxWaitMin: 30 };

describe("pickTargets — 잠긴 코인 중 갭 살아 있는 것만, 순수익 순", () => {
  it("닫힘·정지 의심만 대상, 열림·미확인은 제외, 갭≤0 제외", () => {
    const t = pickTargets([opp("A", 3, "closed"), opp("B", 5, "suspect"), opp("C", 9, "open"), opp("D", 2, "unknown"), opp("E", -1, "closed")], {});
    expect(t.map((x) => x.base)).toEqual(["B", "A"]);
    expect(t[0].buyVenue).toBe("binance"); expect(t[0].sellVenue).toBe("upbit");
  });
  it("예정 시각을 붙이고 상한을 지킨다", () => {
    const many = Array.from({ length: 30 }, (_, i) => opp(`C${i}`, 30 - i, "closed"));
    const t = pickTargets(many, { C0: { venue: "upbit", at: 123, noticeId: 1, title: "", seenAt: 0 } }, 20);
    expect(t.length).toBe(20);
    expect(t[0].reopenAt).toBe(123);
  });
});

describe("parseReopenNotice — 재개 공지 인식 + 시각", () => {
  it("입출금 재개 제목에서 코인과 시각을 뽑는다", () => {
    const r = parseReopenNotice("리스크(LSK) 입출금 재개 안내 (2026년 9월 20일 14:00)");
    expect(r?.bases).toEqual(["LSK"]);
    expect(r?.at).toBe(Date.UTC(2026, 8, 20, 5, 0));
  });
  it("여러 코인, 본문에서 시각", () => {
    const r = parseReopenNotice("네트워크 점검 완료 — 솔라나(SOL), 세이(SEI) 입출금 정상화", "재개 예정: 2026.09.21 09:30");
    expect(r?.bases).toEqual(["SOL", "SEI"]);
    expect(r?.at).toBe(Date.UTC(2026, 8, 21, 0, 30));
  });
  it("중단 공지는 재개가 아니다 / 티커 없으면 null / 상장 공지는 null", () => {
    expect(parseReopenNotice("이더리움(ETH) 입출금 일시 중단 안내")).toBeNull();
    expect(parseReopenNotice("입출금 재개 안내")).toBeNull();
    expect(parseReopenNotice("디지털 자산 추가 — 미나(MINA) KRW 마켓")).toBeNull();
  });
});

describe("watchIntervalMs — 예정 5분 전부터 고속", () => {
  const now = 1_000_000_000;
  it("예정 없음 → 기본", () => expect(watchIntervalMs([{ id: "a", base: "A", buyVenue: "binance", sellVenue: "upbit", netPct: 1 }], now, 5000, 2000)).toBe(5000));
  it("예정 3분 후 → 고속 / 20분 후 → 기본 / 한참 지남 → 기본", () => {
    const t = (delta: number) => [{ id: "a", base: "A", buyVenue: "binance" as const, sellVenue: "upbit" as const, netPct: 1, reopenAt: now + delta }];
    expect(watchIntervalMs(t(3 * 60_000), now, 5000, 2000)).toBe(2000);
    expect(watchIntervalMs(t(20 * 60_000), now, 5000, 2000)).toBe(5000);
    expect(watchIntervalMs(t(-60 * 60_000), now, 5000, 2000)).toBe(5000);
  });
});

describe("decideOnOpen — 열림 확인 시", () => {
  it("킬 스위치면 아무것도 안 한다 (사전 포지션 있어도)", () => {
    expect(decideOnOpen({ base: "A", netPct: 5, cfg, prepos: { runId: "r1", base: "A", startedAt: 0, reopenAt: 0 }, killed: true, hasOpenPosition: true }).action).toBe("none");
  });
  it("사전 포지션이 있으면 출금 승인(release)이 우선 — 자동 실행 꺼져 있어도", () => {
    const d = decideOnOpen({ base: "A", netPct: 5, cfg: { ...cfg, armed: false }, prepos: { runId: "r1", base: "A", startedAt: 0, reopenAt: 0 }, killed: false, hasOpenPosition: true });
    expect(d).toEqual({ action: "release", runId: "r1" });
  });
  it("이미 승인된 사전 포지션은 다시 안 건드리고 일반 판단으로", () => {
    const d = decideOnOpen({ base: "A", netPct: 5, cfg, prepos: { runId: "r1", base: "A", startedAt: 0, reopenAt: 0, released: true }, killed: false, hasOpenPosition: true });
    expect(d.action).toBe("none");
  });
  it("자동 실행: 꺼짐·화이트리스트·최소 순수익·중복 포지션 순으로 막는다", () => {
    expect(decideOnOpen({ base: "A", netPct: 5, cfg: { ...cfg, armed: false }, killed: false, hasOpenPosition: false }).action).toBe("none");
    expect(decideOnOpen({ base: "A", netPct: 5, cfg: { ...cfg, whitelist: ["B"] }, killed: false, hasOpenPosition: false }).action).toBe("none");
    expect(decideOnOpen({ base: "A", netPct: 0.5, cfg, killed: false, hasOpenPosition: false }).action).toBe("none");
    expect(decideOnOpen({ base: "A", netPct: 5, cfg, killed: false, hasOpenPosition: true }).action).toBe("none");
    expect(decideOnOpen({ base: "A", netPct: 5, cfg, killed: false, hasOpenPosition: false })).toEqual({ action: "start", sizeUsd: 300 });
  });
});

describe("shouldPreposition — 예정 시각 전 매수+헷지", () => {
  const now = 10_000_000;
  const base = { base: "A", netPct: 3, buyGlobal: true, cfg, now, already: false, killed: false };
  it("리드 안이면 OK, 밖이면 아직", () => {
    expect(shouldPreposition({ ...base, reopenAt: now + 4 * 60_000 }).ok).toBe(true);
    expect(shouldPreposition({ ...base, reopenAt: now + 6 * 60_000 }).ok).toBe(false);
  });
  it("예정 시각 지나도 최대 대기 안이면 OK, 넘으면 아니다", () => {
    expect(shouldPreposition({ ...base, reopenAt: now - 10 * 60_000 }).ok).toBe(true);
    expect(shouldPreposition({ ...base, reopenAt: now - 31 * 60_000 }).ok).toBe(false);
  });
  it("역프(국내 매수)·이미 포지션·꺼짐·킬·예정 없음은 전부 거부", () => {
    expect(shouldPreposition({ ...base, reopenAt: now, buyGlobal: false }).ok).toBe(false);
    expect(shouldPreposition({ ...base, reopenAt: now, already: true }).ok).toBe(false);
    expect(shouldPreposition({ ...base, reopenAt: now, cfg: { ...cfg, preposition: false } }).ok).toBe(false);
    expect(shouldPreposition({ ...base, reopenAt: now, killed: true }).ok).toBe(false);
    expect(shouldPreposition({ ...base, reopenAt: undefined }).ok).toBe(false);
  });
});
