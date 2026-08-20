// 매도 뮤텍스 — (거래소, 코인)당 한 명만 판다.
//
// 이 락이 지키는 것: 실행 엔진의 매도 다리와 자동매도 트리거가 같은 잔고를
// 동시에 던지면 하나가 거래소에서 거절되는데, 거절된 쪽이 하필 비가역 출금
// 뒤의 엔진이면 롤백이 불가능해 퍼프 숏이 현물 없이 남는다.

import { describe, it, expect, beforeEach } from "vitest";
import { acquireSell, releaseSell, renewSell, sellLockOwner, acquireSellWait, withSellLock } from "@/lib/sellLock";

// 락은 globalThis에 산다 — 테스트마다 같은 (거래소, 코인)을 쓰면 서로 오염된다.
let n = 0;
let base = "";
beforeEach(() => { base = `TEST${++n}`; });

describe("sellLock", () => {
  it("두 번째 소유자를 거부한다", () => {
    expect(acquireSell("upbit", base, "a")).toBe(true);
    expect(acquireSell("upbit", base, "b")).toBe(false);
  });

  it("해제하면 다음 소유자가 잡는다", () => {
    acquireSell("upbit", base, "a");
    releaseSell("upbit", base, "a");
    expect(acquireSell("upbit", base, "b")).toBe(true);
  });

  it("남의 락은 풀지 못한다 — 늦게 온 release가 새 소유자를 밀어내면 안 된다", () => {
    acquireSell("upbit", base, "a");
    releaseSell("upbit", base, "b"); // b는 소유자가 아니다
    expect(sellLockOwner("upbit", base)).toBe("a");
    expect(acquireSell("upbit", base, "c")).toBe(false);
  });

  it("거래소와 코인이 다르면 서로 막지 않는다", () => {
    expect(acquireSell("upbit", base, "a")).toBe(true);
    expect(acquireSell("binance", base, "b")).toBe(true);   // 다른 거래소
    expect(acquireSell("upbit", `${base}X`, "c")).toBe(true); // 다른 코인
  });

  it("renew는 소유자만 할 수 있다", () => {
    acquireSell("upbit", base, "a");
    expect(renewSell("upbit", base, "a")).toBe(true);
    expect(renewSell("upbit", base, "b")).toBe(false);
  });

  it("acquireSellWait은 락이 풀리면 잡는다", async () => {
    acquireSell("upbit", base, "a");
    setTimeout(() => releaseSell("upbit", base, "a"), 120);
    expect(await acquireSellWait("upbit", base, "b", 2000)).toBe(true);
  });

  it("acquireSellWait은 계속 잡혀 있으면 포기한다", async () => {
    acquireSell("upbit", base, "a");
    expect(await acquireSellWait("upbit", base, "b", 300)).toBe(false);
  });

  it("withSellLock은 예외가 나도 락을 돌려준다", async () => {
    await expect(
      withSellLock("upbit", base, "a", async () => { throw new Error("주문 실패"); }),
    ).rejects.toThrow("주문 실패");
    expect(acquireSell("upbit", base, "b")).toBe(true); // 락이 남아 있지 않다
  });
});
