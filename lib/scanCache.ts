// Scan cache — the fix for "every page load waits for a full venue sweep".
//
// The server keeps ONE warm snapshot and refreshes it in the background on a
// fixed cadence; /api/scan just returns the latest snapshot (~ms). The first
// request after boot is the only one that ever waits. Stale-while-revalidate:
// if the loop somehow lags, a request triggers a refresh but still returns the
// stale data immediately instead of blocking.

import { scanAll } from "./scanner";
import type { Opportunity } from "./types";
import { notify, telegramConfigured } from "./telegram";
import { startListingWatch } from "./listings";
import { startWatchdog } from "./watchdog";

// 3s: a full sweep takes ~1.2s (binance bookTicker + parallel upbit chunks),
// and per-venue call rates stay far below every venue's public limits.
const REFRESH_MS = 3000;
const ALERT_NET_PCT = 0.5; // matches the client board threshold

type Cache = {
  opps: Opportunity[];
  ts: number; // when the snapshot was taken (0 = never)
  refreshing: boolean;
  loop: ReturnType<typeof setInterval> | null;
};
const g = globalThis as unknown as { __arbScanCache?: Cache };
g.__arbScanCache ??= { opps: [], ts: 0, refreshing: false, loop: null };
const C = g.__arbScanCache;
// On (re)load, drop any prior interval so a hot-reload picks up new code — the
// old setInterval would otherwise keep calling a stale scanAll closure forever.
if (C.loop) { clearInterval(C.loop); C.loop = null; }

async function refresh(): Promise<void> {
  if (C.refreshing) return; // dedupe concurrent refreshes
  C.refreshing = true;
  try {
    const next = await scanAll();
    if (telegramConfigured()) void alertOnScan(next);
    C.opps = next;
    C.ts = Date.now();
  } catch {
    /* keep the previous snapshot on failure */
  } finally {
    C.refreshing = false;
  }
}

// Phone alerts from the server loop — fires whether or not the site is open.
async function alertOnScan(opps: Opportunity[]): Promise<void> {
  for (const o of opps) {
    if (o.mock || o.kind === "funding-basis") continue;
    // Threshold crossing — cooldown keeps a hovering coin from spamming.
    if (o.netPct >= ALERT_NET_PCT) {
      const [buy, sell] = o.legs;
      void notify(
        `net:${o.id}`,
        `🔔 <b>${o.base}</b> 갭 <b>+${o.netPct.toFixed(2)}%</b>\n${buy?.venue} → ${sell?.venue} · ${o.kind}${o.persistence?.heldSec ? ` · 지속 ${o.persistence.heldSec}s` : ""}`,
      );
    }
    // Settlement gate went down while an edge exists.
    if (o.transfer?.blocked && o.netPct > 0) {
      void notify(`gate:${o.id}`, `⛔ <b>${o.base}</b> 입출금 중단 — 실행 불가 (net +${o.netPct.toFixed(2)}%)`);
    }
  }
}

/** Latest scan snapshot. Only the very first call (cold boot) awaits a sweep. */
export async function getScan(): Promise<{ opps: Opportunity[]; ts: number }> {
  // Background refresh loop — started lazily on first request, then keeps the
  // snapshot warm even between visits (personal local box, cost is fine).
  if (!C.loop) {
    C.loop = setInterval(() => void refresh(), REFRESH_MS);
    startListingWatch(); // 상장따리: notice/TG/market watchers
    startWatchdog(() => ({ scanTs: C.ts, liveOpps: C.opps.filter((o) => !o.mock).length }));
  }
  if (C.ts === 0) {
    await refresh(); // cold boot: nothing to serve yet
  } else if (Date.now() - C.ts > REFRESH_MS * 2 && !C.refreshing) {
    void refresh(); // loop lagged — kick one off but serve stale NOW
  }
  return { opps: C.opps, ts: C.ts };
}
