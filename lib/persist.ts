// State persistence — the in-memory singletons (gap history, listing plays,
// daily P&L tally) evaporate on restart, which zeroes persistence scores and —
// worse — resets the daily-loss limit (a risk hole). Snapshot them to disk on a
// debounce and hydrate on boot. Server-only (fs).
//
// Sections live in SEPARATE files (data/state/<key>.json). Previously everything
// shared one 3MB blob, so flushing the tiny `runs` section — which happens on a
// 500ms debounce while real orders are in flight — re-serialized the whole gap
// history: a measured ~200ms of fully blocked event loop (stringify 154ms +
// write 48ms), repeatedly, at the worst possible moment.
//
// Writes are atomic (temp + rename). The old in-place write had a wider failure
// mode than losing one section: a truncated file failed to parse on boot, the
// loader fell back to `{}`, and the first debounced save then overwrote the file
// with that empty object — silently wiping riskPnl (the daily-loss backstop),
// listing plays and run state. Now a bad file is moved aside, not overwritten.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync } from "fs";
import { writeFile, rename } from "fs/promises";
import path from "path";

const DIR = path.join(process.cwd(), "data");
const SDIR = path.join(DIR, "state");
const LEGACY = path.join(DIR, "state.json");
const SAVE_DEBOUNCE_MS = 30_000;

type Sections = Record<string, unknown>;
type PState = {
  data: Sections;
  hydrated: Set<string>; // sections read from disk (so a null result isn't re-read)
  dirty: Set<string>;
  legacy: Sections | null; // parsed legacy blob, for one-time migration
  legacyRead: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  writing: boolean;
};
const g = globalThis as unknown as { __arbPersist?: PState };
g.__arbPersist ??= {
  data: {}, hydrated: new Set(), dirty: new Set(),
  legacy: null, legacyRead: false, timer: null, writing: false,
};
const P = g.__arbPersist;

const fileFor = (key: string) => path.join(SDIR, `${encodeURIComponent(key)}.json`);

function ensureDir(): void {
  if (!existsSync(SDIR)) mkdirSync(SDIR, { recursive: true });
}

/** Move a file that failed to parse aside instead of letting it be overwritten —
 *  the data is already lost, but the evidence shouldn't be. */
function quarantine(file: string): void {
  try { renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* best effort */ }
}

function readLegacy(): Sections | null {
  if (P.legacyRead) return P.legacy;
  P.legacyRead = true;
  try {
    if (existsSync(LEGACY)) P.legacy = JSON.parse(readFileSync(LEGACY, "utf8")) as Sections;
  } catch {
    quarantine(LEGACY); // corrupt legacy blob — don't keep re-parsing it
    P.legacy = null;
  }
  return P.legacy;
}

/** Read a section's persisted value (hydrates from disk once per key). */
export function loadSection<T>(key: string): T | null {
  if (P.hydrated.has(key)) return (P.data[key] as T) ?? null;
  P.hydrated.add(key);
  const file = fileFor(key);
  try {
    if (existsSync(file)) {
      P.data[key] = JSON.parse(readFileSync(file, "utf8"));
      return (P.data[key] as T) ?? null;
    }
  } catch {
    quarantine(file);
    return null; // rebuild this section from scratch; other sections are untouched
  }
  // Not migrated yet — fall back to the single-blob layout.
  const legacy = readLegacy();
  if (legacy && key in legacy) {
    P.data[key] = legacy[key];
    P.dirty.add(key); // rewrite into the per-section file on the next save
    schedule();
    return (P.data[key] as T) ?? null;
  }
  return null;
}

function serialize(key: string): string | null {
  try {
    return JSON.stringify(P.data[key] ?? null);
  } catch {
    return null; // circular / unserializable — skip rather than throw on a timer
  }
}

async function writeDirty(): Promise<void> {
  if (P.writing) return;
  P.writing = true;
  try {
    ensureDir();
    const keys = [...P.dirty];
    P.dirty.clear();
    for (const key of keys) {
      const text = serialize(key);
      if (text == null) continue;
      const file = fileFor(key);
      try {
        // Async so the 30s snapshot doesn't block the scan loop; atomic so a
        // crash mid-write can't truncate the live file.
        await writeFile(`${file}.tmp`, text, "utf8");
        await rename(`${file}.tmp`, file);
      } catch { /* persistence must never break the app */ }
    }
  } finally {
    P.writing = false;
    if (P.dirty.size) schedule(); // changes arrived during the write
  }
}

function schedule(): void {
  if (P.timer) return;
  P.timer = setTimeout(() => {
    P.timer = null;
    void writeDirty();
  }, SAVE_DEBOUNCE_MS);
  P.timer.unref?.(); // a pending snapshot must not hold the process open
}

/** Stage a section and schedule a debounced disk write. */
export function saveSection(key: string, value: unknown): void {
  if (!P.hydrated.has(key)) P.hydrated.add(key); // writing counts as knowing
  P.data[key] = value;
  P.dirty.add(key);
  schedule();
}

/** Stage + write ONE section NOW, synchronously — for state where the record
 *  right before a crash is money (run progress). Only this section is written,
 *  so the cost is its own size, not the whole state. */
export function flushSection(key: string, value: unknown): void {
  if (!P.hydrated.has(key)) P.hydrated.add(key);
  P.data[key] = value;
  P.dirty.delete(key); // superseded by this synchronous write
  const text = serialize(key);
  if (text == null) return;
  try {
    ensureDir();
    const file = fileFor(key);
    writeFileSync(`${file}.tmp`, text, "utf8");
    renameSync(`${file}.tmp`, file);
  } catch { /* persistence must never break the app */ }
}

/** Section keys present on disk (diagnostics / ops endpoint). */
export function persistedSections(): string[] {
  try {
    if (!existsSync(SDIR)) return [];
    return readdirSync(SDIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => decodeURIComponent(f.slice(0, -5)));
  } catch {
    return [];
  }
}
