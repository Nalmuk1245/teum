// Tiny shared TTL cache (globalThis so every route bundle sees one store).
// Stale-while-revalidate: expired entries return immediately while a refresh
// runs in the background — API latency stays ~ms after first load.

type Entry = { v: unknown; ts: number; refreshing: boolean };
const g = globalThis as unknown as { __arbTtlShared?: Map<string, Entry> };
g.__arbTtlShared ??= new Map();
const M = g.__arbTtlShared;

export async function swr<T>(key: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const hit = M.get(key);
  if (hit) {
    if (Date.now() - hit.ts >= ms && !hit.refreshing) {
      hit.refreshing = true;
      void fn().then((v) => M.set(key, { v, ts: Date.now(), refreshing: false }))
        .catch(() => { hit.refreshing = false; });
    }
    return hit.v as T; // serve current (possibly stale) value instantly
  }
  const v = await fn(); // first call: nothing cached, must wait
  M.set(key, { v, ts: Date.now(), refreshing: false });
  return v;
}
