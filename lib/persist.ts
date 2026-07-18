// State persistence — the in-memory singletons (gap history, listing plays,
// daily P&L tally) evaporate on restart, which zeroes persistence scores and —
// worse — resets the daily-loss limit (a risk hole). Snapshot them to
// data/state.json on a debounce and hydrate on boot. Server-only (fs).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";

const DIR = path.join(process.cwd(), "data");
const FILE = path.join(DIR, "state.json");
const SAVE_DEBOUNCE_MS = 30_000;

type Sections = Record<string, unknown>;
type PState = { data: Sections; loaded: boolean; timer: ReturnType<typeof setTimeout> | null };
const g = globalThis as unknown as { __arbPersist?: PState };
g.__arbPersist ??= { data: {}, loaded: false, timer: null };
const P = g.__arbPersist;

function loadAll(): void {
  if (P.loaded) return;
  P.loaded = true;
  try {
    if (existsSync(FILE)) P.data = JSON.parse(readFileSync(FILE, "utf8"));
  } catch { P.data = {}; }
}

/** Read a section's persisted value (once, at module hydration). */
export function loadSection<T>(key: string): T | null {
  loadAll();
  return (P.data[key] as T) ?? null;
}

/** Stage a section and schedule a debounced disk write. */
export function saveSection(key: string, value: unknown): void {
  loadAll();
  P.data[key] = value;
  if (P.timer) return; // a write is already scheduled
  P.timer = setTimeout(() => {
    P.timer = null;
    try {
      if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
      writeFileSync(FILE, JSON.stringify(P.data), "utf8");
    } catch { /* persistence must never break the app */ }
  }, SAVE_DEBOUNCE_MS);
}
