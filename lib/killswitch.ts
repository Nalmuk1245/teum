// Global kill switch — a single flag that, when set, makes every money-moving
// server call refuse immediately. Toggled from the UI via /api/kill.
//
// PERSISTED: it used to live only on globalThis, while pm2 runs with
// `autorestart: true` + `max_memory_restart`, and the listing auto-buy's `armed`
// flag IS persisted. So the sequence "operator kills during an incident →
// process restarts → killed = false, watchers re-armed, unattended auto-buy live
// again" was reachable, and the incident that tripped it is usually still true.
// A kill must survive a restart; releasing it is an explicit operator action.
//
// Stored on globalThis so ALL route bundles share one value (Next.js can give
// each route its own module copy, which would desync a plain module-level var).

import { loadSection, flushSection } from "./persist";

type KillState = { killed: boolean; killedAt: number };
const g = globalThis as unknown as { __arbKill?: KillState };
if (!g.__arbKill) {
  const saved = loadSection<KillState>("kill");
  g.__arbKill = { killed: !!saved?.killed, killedAt: saved?.killedAt ?? 0 };
}

export function isKilled(): boolean {
  return g.__arbKill!.killed;
}
export function killState(): KillState {
  return { ...g.__arbKill! };
}
export function setKilled(v: boolean): KillState {
  g.__arbKill = { killed: v, killedAt: v ? Date.now() : 0 };
  // flush, not debounced save: a kill that isn't on disk before the next crash
  // is a kill that didn't happen.
  try { flushSection("kill", g.__arbKill); } catch { /* disk */ }
  return killState();
}
