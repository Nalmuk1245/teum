// Operational watchdog — the server watches ITSELF and pushes a Telegram alert
// when something silently breaks. Without this, "no alerts" is indistinguishable
// from "the watcher died". Also sends a once-a-day heartbeat so you know the
// loop is alive at all. Armed from the scanCache loop init.

import { notify, notifyNow, telegramConfigured } from "./telegram";

const CHECK_MS = 60_000;
const SCAN_STALL_MS = 3 * 60_000; // snapshot older than this = loop is stuck
const HEARTBEAT_MS = 24 * 60 * 60_000;

type WdState = {
  loop: ReturnType<typeof setInterval> | null;
  lastHeartbeat: number;
  emptyStreak: number; // consecutive checks with zero live opps
  prevHadOpps: boolean;
};
const g = globalThis as unknown as { __arbWatchdog?: WdState };
g.__arbWatchdog ??= { loop: null, lastHeartbeat: 0, emptyStreak: 0, prevHadOpps: false };
const W = g.__arbWatchdog;

export type WatchdogProbe = () => {
  scanTs: number; // last successful scan snapshot time
  liveOpps: number; // non-mock opportunities in the snapshot
};

function check(probe: WatchdogProbe) {
  if (!telegramConfigured()) return;
  const { scanTs, liveOpps } = probe();
  const now = Date.now();

  // 1. Scan loop stalled — the whole tool is blind.
  if (scanTs > 0 && now - scanTs > SCAN_STALL_MS) {
    void notify("wd:stall", `🧨 스캔 루프 정지 — 마지막 스냅샷 ${Math.round((now - scanTs) / 60_000)}분 전. 서버 재시작 필요할 수 있음`);
  }

  // 2. Feeds went dark — scans run but return nothing (exchange API breakage),
  //    only after we've previously seen data (avoids cold-boot noise).
  if (liveOpps === 0 && W.prevHadOpps) {
    W.emptyStreak++;
    if (W.emptyStreak === 3) {
      void notify("wd:empty", "⚠️ 라이브 기회 0건이 3분째 — 거래소 티커 수집 실패 가능성 (네트워크/차단 확인)");
    }
  } else if (liveOpps > 0) {
    W.emptyStreak = 0;
    W.prevHadOpps = true;
  }

  // 3. Daily heartbeat — proof of life.
  if (now - W.lastHeartbeat > HEARTBEAT_MS) {
    W.lastHeartbeat = now;
    void notifyNow(`💓 Arb Cockpit 정상 작동 — 스캔 ${scanTs ? Math.round((now - scanTs) / 1000) + "s 전" : "대기"} · 라이브 기회 ${liveOpps}건`);
  }
}

/** Arm the watchdog (idempotent; re-armed on hot reload). */
export function startWatchdog(probe: WatchdogProbe): void {
  if (W.loop) clearInterval(W.loop);
  W.loop = setInterval(() => check(probe), CHECK_MS);
}
