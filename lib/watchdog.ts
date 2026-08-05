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
/** Called when the scan looks stalled — should try to unwedge it. Recovery must
 *  not depend on Telegram being configured (it usually isn't during setup). */
export type WatchdogRecover = () => void;
const gr = globalThis as unknown as { __arbWdRecover?: WatchdogRecover };

function check(probe: WatchdogProbe) {
  const { scanTs, liveOpps } = probe();
  const now = Date.now();
  const stalled = scanTs > 0 && now - scanTs > SCAN_STALL_MS;

  // 1. Scan loop stalled — the whole tool is blind. ACT first, then tell.
  //    A silent freeze is the worst failure this app has: the WS keeps the board
  //    looking alive while every live entry is blocked by the staleness gate,
  //    and pm2 can't help because the process never dies.
  if (stalled) {
    try { gr.__arbWdRecover?.(); } catch { /* best effort */ }
    console.error(`[watchdog] scan stalled ${Math.round((now - scanTs) / 1000)}s — 복구 시도`);
  }

  if (!telegramConfigured()) return; // 알림만 스킵, 복구는 위에서 이미 했다
  if (stalled) {
    void notify("wd:stall", `🧨 스캔 루프 정지 — 마지막 스냅샷 ${Math.round((now - scanTs) / 60_000)}분 전. 자동 복구를 시도했습니다`);
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
    void notifyNow(`💓 Teum 정상 작동 — 스캔 ${scanTs ? Math.round((now - scanTs) / 1000) + "s 전" : "대기"} · 라이브 기회 ${liveOpps}건`);
  }
}

/** Arm the watchdog (idempotent; re-armed on hot reload). `recover` is invoked
 *  when the scan snapshot goes stale, regardless of Telegram configuration. */
export function startWatchdog(probe: WatchdogProbe, recover?: WatchdogRecover): void {
  if (recover) gr.__arbWdRecover = recover;
  if (W.loop) clearInterval(W.loop);
  W.loop = setInterval(() => check(probe), CHECK_MS);
}
