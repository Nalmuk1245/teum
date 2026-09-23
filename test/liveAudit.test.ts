// 실사용 감사(2026-09-16) 수정분 중 순수 로직으로 못 박을 수 있는 것들.
// 거래소 왕복이 필요한 항목(잔고 GET·슬리피지 게이트·wait 타임아웃)은 RUNBOOK의
// DRY-RUN 리허설이 담당한다.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { isBootFreshNotice, ANN_BOOT_FRESH_MS } from "@/lib/listings";
import { setLimits, riskState } from "@/lib/risk";

describe("isBootFreshNotice — 재시작 직후 첫 폴의 공지 처리 판정", () => {
  const now = 1_800_000_000_000;
  const fresh = { id: 101, publishedAt: now - 60_000 }; // 1분 전 발행

  it("마지막으로 본 id보다 새롭고 10분 이내 발행이면 처리한다", () => {
    expect(isBootFreshNotice(fresh, 100, now)).toBe(true);
  });

  it("마지막으로 본 id 이하면 baseline — 이미 본 공지를 다시 쏘지 않는다", () => {
    expect(isBootFreshNotice({ id: 100, publishedAt: now - 60_000 }, 100, now)).toBe(false);
    expect(isBootFreshNotice({ id: 99, publishedAt: now - 60_000 }, 100, now)).toBe(false);
  });

  it("영속된 id가 없으면(최초 부팅) 전부 baseline — 첫 실행에 과거 공지로 매수하지 않는다", () => {
    expect(isBootFreshNotice(fresh, 0, now)).toBe(false);
  });

  it("발행 10분 지난 공지는 새 id여도 baseline — 며칠 꺼졌다 켜져도 자동매수가 쏟아지지 않는다", () => {
    expect(isBootFreshNotice({ id: 101, publishedAt: now - ANN_BOOT_FRESH_MS }, 100, now)).toBe(false);
    expect(isBootFreshNotice({ id: 101, publishedAt: now - ANN_BOOT_FRESH_MS + 1 }, 100, now)).toBe(true);
  });

  it("발행 시각을 모르면 baseline — 보수적", () => {
    expect(isBootFreshNotice({ id: 101 }, 100, now)).toBe(false);
  });

  it("미래 발행 시각(시계 어긋남)은 baseline", () => {
    expect(isBootFreshNotice({ id: 101, publishedAt: now + 5_000 }, 100, now)).toBe(false);
  });
});

describe("setLimits — 재시작 내성", () => {
  it("한도 변경이 즉시 디스크에 flush된다 (data/state/riskLimits.json)", () => {
    setLimits({ maxPerTradeUsd: 123, maxInFlightUsd: 456, maxDailyLossUsd: 78 });
    const file = path.join(process.cwd(), "data", "state", "riskLimits.json");
    expect(existsSync(file)).toBe(true);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved).toEqual({ maxPerTradeUsd: 123, maxInFlightUsd: 456, maxDailyLossUsd: 78 });
    expect(riskState().maxPerTradeUsd).toBe(123);
  });

  it("무시된 값(음수·NaN)은 기존 값 그대로 저장된다", () => {
    setLimits({ maxPerTradeUsd: 500 });
    setLimits({ maxPerTradeUsd: -1, maxDailyLossUsd: Number.NaN });
    const file = path.join(process.cwd(), "data", "state", "riskLimits.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.maxPerTradeUsd).toBe(500);
  });
});

import { kstStrToMs } from "@/lib/listings";
describe("kstStrToMs — 빗썸 공지 발행 시각(KST, 시간대 표기 없음)", () => {
  it("KST로 읽는다", () => {
    expect(kstStrToMs("2026-09-23 18:00:00")).toBe(Date.UTC(2026, 8, 23, 9, 0, 0));
    expect(kstStrToMs("nope")).toBeUndefined();
  });
});
