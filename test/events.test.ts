// 이벤트 로그 — 텔레그램 여부와 무관하게 사건이 파일에 남는지.
// setup.ts가 cwd를 임시 디렉터리로 옮기므로 운영 data/를 건드리지 않는다.

import { describe, it, expect } from "vitest";
import { logEvent, readEvents } from "@/lib/events";

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("events.jsonl", () => {
  it("append 후 최신순으로 읽힌다", async () => {
    logEvent("gate.change", { base: "LSK", from: "suspect", to: "open", netPct: 48.2 });
    logEvent("alert.reopen", { base: "LSK", netPct: 48.2, sizeUsd: 1200 });
    await settle();
    const all = await readEvents(10);
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all[0].type).toBe("alert.reopen");
    expect(all[1].type).toBe("gate.change");
    expect(all[1].from).toBe("suspect");
    expect(typeof all[0].ts).toBe("number");
  });

  it("type으로 거른다", async () => {
    logEvent("telegram.unconfigured", { text: "🔓 LSK 입출금 열림" });
    await settle();
    const tg = await readEvents(10, "telegram.unconfigured");
    expect(tg.length).toBeGreaterThanOrEqual(1);
    expect(tg.every((e) => e.type === "telegram.unconfigured")).toBe(true);
    expect(String(tg[0].text)).toContain("LSK");
  });
});
