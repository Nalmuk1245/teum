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

/**
 * swr의 "절대 기다리지 않는" 버전 — 있으면(낡았어도) 주고, 없으면 null을 주면서
 * 뒤에서 채운다.
 *
 * 첫 페인트를 위한 것이다. 인증 잔고 조회처럼 느린 값을 first-paint 경로에서
 * await하면 화면 전체가 그 값 때문에 서 있는다. 그 값이 화면의 **부속**일 뿐이라면
 * 없는 채로 먼저 그리고 다음 응답에서 채우는 게 맞다.
 *
 * 반환 null은 "값 없음"이 아니라 "아직 모름"이다 — 호출부가 그 둘을 구분해 표시해야
 * 한다. 안 그러면 사용자는 "키 없음" 같은 확정적인 거짓말을 잠깐 보게 된다.
 */
export function peek<T>(key: string, ms: number, fn: () => Promise<T>): T | null {
  const hit = M.get(key);
  if (hit) {
    if (Date.now() - hit.ts >= ms && !hit.refreshing) {
      hit.refreshing = true;
      void fn().then((v) => M.set(key, { v, ts: Date.now(), refreshing: false }))
        .catch(() => { hit.refreshing = false; });
    }
    return hit.v as T;
  }
  const pending = M.get(`${key}__warming`);
  if (!pending) {
    M.set(`${key}__warming`, { v: true, ts: Date.now(), refreshing: false });
    void fn()
      .then((v) => M.set(key, { v, ts: Date.now(), refreshing: false }))
      .catch(() => {})
      .finally(() => M.delete(`${key}__warming`));
  }
  return null;
}
