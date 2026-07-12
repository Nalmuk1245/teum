// Global kill switch — a single flag that, when set, makes every money-moving
// server call refuse immediately. Toggled from the UI via /api/kill.
//
// Stored on globalThis so ALL route bundles share one value (Next.js can give
// each route its own module copy, which would desync a plain module-level var).

type KillState = { killed: boolean; killedAt: number };
const g = globalThis as unknown as { __arbKill?: KillState };
g.__arbKill ??= { killed: false, killedAt: 0 };

export function isKilled(): boolean {
  return g.__arbKill!.killed;
}
export function killState(): KillState {
  return { ...g.__arbKill! };
}
export function setKilled(v: boolean): KillState {
  g.__arbKill = { killed: v, killedAt: v ? Date.now() : 0 };
  return killState();
}
