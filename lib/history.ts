// Gap persistence — a flicker vs a sustained edge look identical in one 8s
// snapshot, so we keep a short rolling history per opportunity (server-side,
// updated every scan) and score how long/steadily the edge has held. A gap
// that's been profitable for several scans is real; a one-scan spike usually
// isn't tradeable (it's gone by the time you buy + transfer).

import { loadSection, saveSection } from "./persist";

const WINDOW_MS = 5 * 60_000; // rolling window
const MAX_SAMPLES = 120; // ≥ window / scan cadence (3s) so the cap never shrinks the window

export type Persistence = {
  heldSec: number; // consecutive seconds net has stayed > 0 (0 if currently ≤ 0)
  hitRatePct: number; // % of window samples that were profitable
  samples: number; // samples seen in window
  volPctPerMin: number; // PRICE volatility (σ of log-returns) per minute, %
  jumpPct: number; // largest single-sample % price move in the window (one-sided tail)
};

type Track = { streakStart: number | null; samples: { ts: number; pos: boolean; gross: number; price: number }[] };
const g = globalThis as unknown as { __arbHist?: Map<string, Track> };
// Hydrate from disk so persistence scores survive restarts.
g.__arbHist ??= new Map(loadSection<[string, Track][]>("history") ?? []);
const H = g.__arbHist;

// Per-minute σ of the GLOBAL PRICE log-returns (increments, not levels) — the
// real in-flight exposure is the coin's price vol, not the premium's. Also
// return the largest single-step move (jump proxy) since pump risk is one-sided,
// not Gaussian.
function priceVol(samples: { ts: number; price: number }[]): { volPctPerMin: number; jumpPct: number } {
  const pts = samples.filter((s) => s.price > 0);
  if (pts.length < 3) return { volPctPerMin: 0, jumpPct: 0 };
  const rets: { r: number; dtMin: number }[] = [];
  let jump = 0;
  for (let i = 1; i < pts.length; i++) {
    const r = Math.log(pts[i].price / pts[i - 1].price);
    const dtMin = Math.max(1 / 60, (pts[i].ts - pts[i - 1].ts) / 60_000);
    rets.push({ r, dtMin });
    jump = Math.max(jump, Math.abs(pts[i].price / pts[i - 1].price - 1) * 100);
  }
  // σ of returns normalized to 1-minute (random-walk: divide each by √dt).
  const norm = rets.map((x) => x.r / Math.sqrt(x.dtMin));
  const mean = norm.reduce((a, b) => a + b, 0) / norm.length;
  const variance = norm.reduce((a, b) => a + (b - mean) ** 2, 0) / norm.length;
  return { volPctPerMin: Math.sqrt(variance) * 100, jumpPct: jump };
}

/** Record this scan's net + gross + price for an opp id, return persistence + risk. */
export function recordGap(id: string, netPct: number, grossPct: number, price: number, ts: number): Persistence {
  const pos = netPct > 0;
  let t = H.get(id);
  if (!t) { t = { streakStart: null, samples: [] }; H.set(id, t); }

  // Consecutive-positive streak.
  if (pos) { if (t.streakStart == null) t.streakStart = ts; }
  else t.streakStart = null;

  t.samples.push({ ts, pos, gross: grossPct, price });
  const cutoff = ts - WINDOW_MS;
  while (t.samples.length > MAX_SAMPLES || (t.samples[0] && t.samples[0].ts < cutoff)) t.samples.shift();

  const hits = t.samples.filter((s) => s.pos).length;
  const pv = priceVol(t.samples);
  return {
    heldSec: pos && t.streakStart != null ? Math.round((ts - t.streakStart) / 1000) : 0,
    hitRatePct: t.samples.length ? Math.round((hits / t.samples.length) * 100) : 0,
    jumpPct: pv.jumpPct,
    volPctPerMin: pv.volPctPerMin,
    samples: t.samples.length,
  };
}

/** Drop tracks not seen this scan cycle (prevents unbounded growth). */
export function pruneHistory(seen: Set<string>, ts: number) {
  const cutoff = ts - WINDOW_MS;
  for (const [id, t] of H) {
    if (!seen.has(id) && (t.samples.length === 0 || t.samples[t.samples.length - 1].ts < cutoff)) H.delete(id);
  }
  saveSection("history", [...H.entries()]); // debounced snapshot (restart resilience)
}

// A gap held profitable this long counts as "confirmed" (full ranking weight).
export const SUSTAIN_SEC = 24;
/** Ranking confidence in [0.5, 1] — fresh spikes are down-weighted, not hidden. */
export function confidence(p: Persistence | undefined): number {
  if (!p) return 0.5;
  return 0.5 + 0.5 * Math.min(1, p.heldSec / SUSTAIN_SEC);
}
