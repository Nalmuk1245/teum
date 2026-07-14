// 상장따리 — new-listing detection. A brand-new KRW market on Upbit/Bithumb is
// the fastest, most violent kimchi spike there is (the coin often trades far
// above its global price for minutes). We poll the public market list on a tight
// cadence, diff against the last snapshot, and flag/alert the instant a new
// market appears (= real trading opened, not just an announcement).
//
// The exchange-notice API (api-manager) is Cloudflare-gated off non-KR IPs, so
// market-list diffing is the reliable signal. On a local KR box it fires within
// the poll interval of the listing going live. Server-only.

import { notifyNow } from "./telegram";

const POLL_MS = 3000; // tight — listings are a race
const FRESH_MS = 30 * 60_000; // a coin stays "new" for 30 min after listing

type Listing = { base: string; venue: "upbit" | "bithumb"; ts: number; overseas: boolean };
type State = {
  seen: Partial<Record<"upbit" | "bithumb", Set<string>>>; // baseline market sets
  recent: Map<string, Listing>; // base → listing (within FRESH_MS)
  loop: ReturnType<typeof setInterval> | null;
  primed: boolean; // first poll only establishes the baseline (no alerts)
};
const g = globalThis as unknown as { __arbListings?: State };
g.__arbListings ??= { seen: {}, recent: new Map(), loop: null, primed: false };
const L = g.__arbListings;

async function upbitMarkets(): Promise<Set<string>> {
  try {
    const r = await fetch("https://api.upbit.com/v1/market/all", { cache: "no-store", signal: AbortSignal.timeout(4000) });
    const j = (await r.json()) as Array<{ market: string }>;
    return new Set(j.filter((m) => m.market.startsWith("KRW-")).map((m) => m.market.slice(4)));
  } catch { return new Set(); }
}
async function bithumbMarkets(): Promise<Set<string>> {
  try {
    const r = await fetch("https://api.bithumb.com/public/ticker/ALL_KRW", { cache: "no-store", signal: AbortSignal.timeout(4000) });
    const j = (await r.json()) as { status: string; data?: Record<string, unknown> };
    if (j.status !== "0000" || !j.data) return new Set();
    return new Set(Object.keys(j.data).filter((k) => k !== "date"));
  } catch { return new Set(); }
}

// Is the coin already on a global CEX? (Then a listing = kimchi spike we can
// actually arb: buy global, sell the pumped KR price.) Binance spot as proxy.
async function onGlobal(base: string): Promise<boolean> {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${base}USDT`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    const j = (await r.json()) as { price?: string };
    return !!j.price;
  } catch { return false; }
}

async function poll(): Promise<void> {
  const [up, bt] = await Promise.all([upbitMarkets(), bithumbMarkets()]);
  const check = async (venue: "upbit" | "bithumb", now: Set<string>) => {
    if (now.size === 0) return; // fetch failed — don't diff against empty
    const prev = L.seen[venue];
    if (prev && L.primed) {
      for (const base of now) {
        if (!prev.has(base) && !L.recent.has(base)) {
          const overseas = await onGlobal(base);
          L.recent.set(base, { base, venue, ts: Date.now(), overseas });
          void notifyNow(
            `🚨 <b>${venue === "upbit" ? "업비트" : "빗썸"} 신규 상장 — ${base}</b>\n` +
            (overseas ? "해외 상장 있음 → 김프 급등 가능 (해외 매수 준비)" : "해외 미상장 → 상장 펌핑만 (김프 아님)"),
          );
        }
      }
    }
    L.seen[venue] = now;
  };
  await check("upbit", up);
  await check("bithumb", bt);
  L.primed = true;
  // Expire stale entries.
  const cutoff = Date.now() - FRESH_MS;
  for (const [b, l] of L.recent) if (l.ts < cutoff) L.recent.delete(b);
}

/** Start the background listing watcher (idempotent; re-armed on hot reload). */
export function startListingWatch(): void {
  if (L.loop) clearInterval(L.loop);
  void poll();
  L.loop = setInterval(() => void poll(), POLL_MS);
}

/** Is this base a fresh listing? (used to badge/boost the board opp) */
export function listingInfo(base: string): { venue: string; ageSec: number; overseas: boolean } | null {
  const l = L.recent.get(base);
  if (!l) return null;
  return { venue: l.venue, ageSec: Math.round((Date.now() - l.ts) / 1000), overseas: l.overseas };
}

/** Recent listings, newest first (for the dashboard). */
export function recentListings(): Listing[] {
  return [...L.recent.values()].sort((a, b) => b.ts - a.ts);
}
