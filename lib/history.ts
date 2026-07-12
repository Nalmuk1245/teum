// Gap persistence — a flicker vs a sustained edge look identical in one 8s
// snapshot, so we keep a short rolling history per opportunity (server-side,
// updated every scan) and score how long/steadily the edge has held. A gap
// that's been profitable for several scans is real; a one-scan spike usually
// isn't tradeable (it's gone by the time you buy + transfer).

const WINDOW_MS = 5 * 60_000; // rolling window
const MAX_SAMPLES = 60;

export type Persistence = {
  heldSec: number; // consecutive seconds net has stayed > 0 (0 if currently ≤ 0)
  hitRatePct: number; // % of window samples that were profitable
  samples: number; // samples seen in window
};

type Track = { streakStart: number | null; samples: { ts: number; pos: boolean }[] };
const g = globalThis as unknown as { __arbHist?: Map<string, Track> };
g.__arbHist ??= new Map();
const H = g.__arbHist;

/** Record this scan's net for an opp id, return its persistence. */
export function recordGap(id: string, netPct: number, ts: number): Persistence {
  const pos = netPct > 0;
  let t = H.get(id);
  if (!t) { t = { streakStart: null, samples: [] }; H.set(id, t); }

  // Consecutive-positive streak.
  if (pos) { if (t.streakStart == null) t.streakStart = ts; }
  else t.streakStart = null;

  t.samples.push({ ts, pos });
  const cutoff = ts - WINDOW_MS;
  while (t.samples.length > MAX_SAMPLES || (t.samples[0] && t.samples[0].ts < cutoff)) t.samples.shift();

  const hits = t.samples.filter((s) => s.pos).length;
  return {
    heldSec: pos && t.streakStart != null ? Math.round((ts - t.streakStart) / 1000) : 0,
    hitRatePct: t.samples.length ? Math.round((hits / t.samples.length) * 100) : 0,
    samples: t.samples.length,
  };
}

/** Drop tracks not seen this scan cycle (prevents unbounded growth). */
export function pruneHistory(seen: Set<string>, ts: number) {
  const cutoff = ts - WINDOW_MS;
  for (const [id, t] of H) {
    if (!seen.has(id) && (t.samples.length === 0 || t.samples[t.samples.length - 1].ts < cutoff)) H.delete(id);
  }
}

// A gap held profitable this long counts as "confirmed" (full ranking weight).
export const SUSTAIN_SEC = 24; // ~3 scans at 8s
/** Ranking confidence in [0.5, 1] — fresh spikes are down-weighted, not hidden. */
export function confidence(p: Persistence | undefined): number {
  if (!p) return 0.5;
  return 0.5 + 0.5 * Math.min(1, p.heldSec / SUSTAIN_SEC);
}
