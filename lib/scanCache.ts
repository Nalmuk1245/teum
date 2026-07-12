// Scan cache — the fix for "every page load waits for a full venue sweep".
//
// The server keeps ONE warm snapshot and refreshes it in the background on a
// fixed cadence; /api/scan just returns the latest snapshot (~ms). The first
// request after boot is the only one that ever waits. Stale-while-revalidate:
// if the loop somehow lags, a request triggers a refresh but still returns the
// stale data immediately instead of blocking.

import { scanAll } from "./scanner";
import type { Opportunity } from "./types";

const REFRESH_MS = 8000;

type Cache = {
  opps: Opportunity[];
  ts: number; // when the snapshot was taken (0 = never)
  refreshing: boolean;
  loop: ReturnType<typeof setInterval> | null;
};
const g = globalThis as unknown as { __arbScanCache?: Cache };
g.__arbScanCache ??= { opps: [], ts: 0, refreshing: false, loop: null };
const C = g.__arbScanCache;

async function refresh(): Promise<void> {
  if (C.refreshing) return; // dedupe concurrent refreshes
  C.refreshing = true;
  try {
    C.opps = await scanAll();
    C.ts = Date.now();
  } catch {
    /* keep the previous snapshot on failure */
  } finally {
    C.refreshing = false;
  }
}

/** Latest scan snapshot. Only the very first call (cold boot) awaits a sweep. */
export async function getScan(): Promise<{ opps: Opportunity[]; ts: number }> {
  // Background refresh loop — started lazily on first request, then keeps the
  // snapshot warm even between visits (personal local box, cost is fine).
  if (!C.loop) {
    C.loop = setInterval(() => void refresh(), REFRESH_MS);
  }
  if (C.ts === 0) {
    await refresh(); // cold boot: nothing to serve yet
  } else if (Date.now() - C.ts > REFRESH_MS * 2 && !C.refreshing) {
    void refresh(); // loop lagged — kick one off but serve stale NOW
  }
  return { opps: C.opps, ts: C.ts };
}
