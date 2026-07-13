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
  volPctPerMin: number; // gross-premium volatility (σ) per minute, %
};

type Track = { streakStart: number | null; samples: { ts: number; pos: boolean; gross: number }[] };
const g = globalThis as unknown as { __arbHist?: Map<string, Track> };
g.__arbHist ??= new Map();
const H = g.__arbHist;

// Per-minute σ of the gross premium over the window — the raw material for the
// transfer-window risk (how much the edge can move while the coin is in flight).
function volPerMin(samples: { ts: number; gross: number }[]): number {
  if (samples.length < 3) return 0;
  const gs = samples.map((s) => s.gross);
  const mean = gs.reduce((a, b) => a + b, 0) / gs.length;
  const variance = gs.reduce((a, b) => a + (b - mean) ** 2, 0) / gs.length;
  const sd = Math.sqrt(variance); // σ over the window
  // Normalize to a per-minute figure by the sample cadence (~8s).
  const spanMin = Math.max(1 / 60, (samples[samples.length - 1].ts - samples[0].ts) / 60_000);
  const perSample = spanMin / (samples.length - 1);
  return perSample > 0 ? sd / Math.sqrt(perSample) : sd; // random-walk scaling
}

/** Record this scan's net + gross for an opp id, return persistence + volatility. */
export function recordGap(id: string, netPct: number, grossPct: number, ts: number): Persistence {
  const pos = netPct > 0;
  let t = H.get(id);
  if (!t) { t = { streakStart: null, samples: [] }; H.set(id, t); }

  // Consecutive-positive streak.
  if (pos) { if (t.streakStart == null) t.streakStart = ts; }
  else t.streakStart = null;

  t.samples.push({ ts, pos, gross: grossPct });
  const cutoff = ts - WINDOW_MS;
  while (t.samples.length > MAX_SAMPLES || (t.samples[0] && t.samples[0].ts < cutoff)) t.samples.shift();

  const hits = t.samples.filter((s) => s.pos).length;
  return {
    heldSec: pos && t.streakStart != null ? Math.round((ts - t.streakStart) / 1000) : 0,
    hitRatePct: t.samples.length ? Math.round((hits / t.samples.length) * 100) : 0,
    samples: t.samples.length,
    volPctPerMin: volPerMin(t.samples),
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
