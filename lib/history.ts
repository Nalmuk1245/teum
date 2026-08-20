// Gap persistence — a flicker vs a sustained edge look identical in one 8s
// snapshot, so we keep a short rolling history per opportunity (server-side,
// updated every scan) and score how long/steadily the edge has held. A gap
// that's been profitable for several scans is real; a one-scan spike usually
// isn't tradeable (it's gone by the time you buy + transfer).

import { loadSection, saveSection } from "./persist";

const WINDOW_MS = 30 * 60_000; // rolling window — long enough to see gap patterns
const MAX_SAMPLES = 650; // ≥ window / scan cadence (3s) so the cap never shrinks the window

export type Persistence = {
  heldSec: number; // consecutive seconds net has stayed > 0 (0 if currently ≤ 0)
  hitRatePct: number; // % of window samples that were profitable
  samples: number; // samples seen in window
  volPctPerMin: number; // PRICE volatility (σ of log-returns) per minute, %
  jumpPct: number; // largest single-sample % price move in the window (one-sided tail)
};

type Sample = { ts: number; pos: boolean; gross: number; price: number };
type Track = { streakStart: number | null; samples: Sample[] };

// On disk, samples are packed positional tuples instead of keyed objects, and
// only a downsampled tail is kept. The full 3s-resolution window (650 samples ×
// 4 keys × ~100 tracks) was 3.5MB of JSON — 97% of the state file — and none of
// that resolution needs to survive a restart: persistence scores only need
// enough shape to re-establish hit-rate and volatility.
type PackedSample = [ts: number, pos: 0 | 1, gross: number, price: number];
type PackedTrack = { s: number | null; p: PackedSample[] };
const PERSIST_MAX = 120; // per track, newest-last
const PERSIST_EVERY = 5; // keep 1 of every N samples

function pack(t: Track): PackedTrack {
  const out: PackedSample[] = [];
  // Walk newest-first so the retained tail is the most recent data, then flip.
  for (let i = t.samples.length - 1; i >= 0 && out.length < PERSIST_MAX; i -= PERSIST_EVERY) {
    const s = t.samples[i];
    out.push([s.ts, s.pos ? 1 : 0, round6(s.gross), round6(s.price)]);
  }
  out.reverse();
  return { s: t.streakStart, p: out };
}
function unpack(v: PackedTrack | Track): Track {
  // Tolerate the pre-packing layout so an existing state file still hydrates.
  if (Array.isArray((v as Track).samples)) return v as Track;
  const pt = v as PackedTrack;
  return {
    streakStart: pt.s ?? null,
    samples: (pt.p ?? []).map(([ts, pos, gross, price]) => ({ ts, pos: pos === 1, gross, price })),
  };
}
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

const g = globalThis as unknown as { __arbHist?: Map<string, Track> };
// Hydrate from disk so persistence scores survive restarts.
g.__arbHist ??= new Map(
  (loadSection<[string, PackedTrack | Track][]>("history") ?? []).map(([id, v]) => [id, unpack(v)]),
);
const H = g.__arbHist;

// Per-minute σ of the GLOBAL PRICE log-returns (increments, not levels) — the
// real in-flight exposure is the coin's price vol, not the premium's. Also
// return the largest single-step move (jump proxy) since pump risk is one-sided,
// not Gaussian.
// Single numeric pass, no intermediate arrays. Same math as before (σ of
// √dt-normalized log-returns, plus the largest one-step move) — this used to
// allocate three arrays of objects per opportunity per 3s tick, which at the KR
// universe size is hundreds of thousands of short-lived objects feeding GC.
// Variance via Σx/Σx² on normalized returns; identical result, one loop.
function priceVol(samples: { ts: number; price: number }[]): { volPctPerMin: number; jumpPct: number } {
  let n = 0, sum = 0, sumSq = 0, jump = 0;
  let prevPrice = 0, prevTs = 0;
  for (const s of samples) {
    if (!(s.price > 0)) continue;
    if (prevPrice > 0) {
      const ratio = s.price / prevPrice;
      const dtMin = Math.max(1 / 60, (s.ts - prevTs) / 60_000);
      const x = Math.log(ratio) / Math.sqrt(dtMin);
      n++; sum += x; sumSq += x * x;
      const move = Math.abs(ratio - 1) * 100;
      if (move > jump) jump = move;
    }
    prevPrice = s.price; prevTs = s.ts;
  }
  if (n < 2) return { volPctPerMin: 0, jumpPct: 0 };
  const variance = Math.max(0, sumSq / n - (sum / n) ** 2); // E[x²] − E[x]²
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
  // Drop everything expired in ONE splice. The old `while (…) shift()` did an
  // O(n) memmove per removed sample, per opportunity, per tick.
  const cutoff = ts - WINDOW_MS;
  let drop = 0;
  while (drop < t.samples.length && t.samples[drop].ts < cutoff) drop++;
  if (t.samples.length - drop > MAX_SAMPLES) drop = t.samples.length - MAX_SAMPLES;
  if (drop > 0) t.samples.splice(0, drop);

  let hits = 0;
  for (const s of t.samples) if (s.pos) hits++;
  const pv = priceVol(t.samples);
  return {
    heldSec: pos && t.streakStart != null ? Math.round((ts - t.streakStart) / 1000) : 0,
    hitRatePct: t.samples.length ? Math.round((hits / t.samples.length) * 100) : 0,
    jumpPct: pv.jumpPct,
    volPctPerMin: pv.volPctPerMin,
    samples: t.samples.length,
  };
}

/** Raw gross-history samples for one opp (sparkline). Newest last. */
export function getTrack(id: string): { ts: number; gross: number }[] {
  return (H.get(id)?.samples ?? []).map((s) => ({ ts: s.ts, gross: s.gross }));
}

/** Downsampled gross series for the board's row sparkline (oldest→newest).
 *  값만 보낸다(타임스탬프 생략) — 보드는 모양이 필요하지 전체 해상도가 필요한 게
 *  아니고, 이건 스캔 응답에 실려 3초마다 전 기회 수만큼 곱해지는 페이로드다.
 *  마지막 샘플은 항상 포함한다(현재값이 잘리면 스파크 끝과 순수익 칸이 어긋난다). */
export function sparkGross(id: string, points = 40): number[] {
  const s = H.get(id)?.samples ?? [];
  if (s.length < 2) return [];
  const r3 = (n: number) => Math.round(n * 1e3) / 1e3;
  if (s.length <= points) return s.map((x) => r3(x.gross));
  const out: number[] = [];
  const step = (s.length - 1) / (points - 1);
  for (let i = 0; i < points; i++) out.push(r3(s[Math.round(i * step)].gross));
  return out;
}

/** Drop tracks not seen this scan cycle (prevents unbounded growth). */
export function pruneHistory(seen: Set<string>, ts: number) {
  const cutoff = ts - WINDOW_MS;
  for (const [id, t] of H) {
    if (!seen.has(id) && (t.samples.length === 0 || t.samples[t.samples.length - 1].ts < cutoff)) H.delete(id);
  }
  // Snapshot for restart resilience — packed + downsampled, and only every
  // PERSIST_INTERVAL_MS. Staging this every 3s meant JSON.stringify ran on the
  // whole history on each debounce flush; the scores it protects tolerate a
  // minute of granularity just fine.
  if (ts - lastPersist < PERSIST_INTERVAL_MS) return;
  lastPersist = ts;
  const packed: [string, PackedTrack][] = [];
  for (const [id, t] of H) packed.push([id, pack(t)]);
  saveSection("history", packed);
}
const PERSIST_INTERVAL_MS = 60_000;
let lastPersist = 0;

// A gap held profitable this long counts as "confirmed" (full ranking weight).
export const SUSTAIN_SEC = 24;
/** Ranking confidence in [0.5, 1] — fresh spikes are down-weighted, not hidden. */
export function confidence(p: Persistence | undefined): number {
  if (!p) return 0.5;
  return 0.5 + 0.5 * Math.min(1, p.heldSec / SUSTAIN_SEC);
}
