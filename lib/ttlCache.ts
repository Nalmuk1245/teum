// Tiny shared TTL cache (globalThis so every route bundle sees one store).
// Stale-while-revalidate: expired entries return immediately while a refresh
// runs in the background — API latency stays ~ms after first load.
//
// swr와 peek는 **진행 중 조회를 공유한다** (감사 R5). 예전엔 peek가 지핀 콜드
// 조회를 swr가 몰라서, 패널 하나 열 때 fetchPortfolio(인증 조회 10회 + 지갑 RPC
// 스윕)가 두 번 돌았다 — 속도를 올리려던 경로가 레이트리밋을 두 배로 썼다.
// 값의 ts는 **조회 시작 시각**이다: 완료 시각으로 찍으면 늦게 끝난 오래된
// 스냅샷이 더 신선한 값을 덮고도 새것처럼 보인다.

type Entry = { v: unknown; ts: number; refreshing: boolean };
type G = { __arbTtlShared?: Map<string, Entry>; __arbTtlInflight?: Map<string, Promise<unknown>> };
const g = globalThis as unknown as G;
g.__arbTtlShared ??= new Map();
g.__arbTtlInflight ??= new Map(); // 실제 값과 키공간 분리 — 센티넬을 값으로 오인할 수 없다
const M = g.__arbTtlShared;
const F = g.__arbTtlInflight;

/** 공유 조회 시작 (이미 돌고 있으면 그걸 반환). startedAt으로 ts를 찍는다. */
function launch<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const running = F.get(key);
  if (running) return running as Promise<T>;
  const startedAt = Date.now();
  const p = fn()
    .then((v) => {
      const cur = M.get(key);
      // 더 새 조회가 이미 값을 썼다면 덮지 않는다 (늦게 끝난 옛 스냅샷 방지).
      if (!cur || cur.ts <= startedAt) M.set(key, { v, ts: startedAt, refreshing: false });
      return v;
    })
    .finally(() => {
      if (F.get(key) === p) F.delete(key);
      const cur = M.get(key);
      if (cur) cur.refreshing = false;
    });
  F.set(key, p);
  return p;
}

export async function swr<T>(key: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const hit = M.get(key);
  if (hit) {
    if (Date.now() - hit.ts >= ms && !hit.refreshing) {
      hit.refreshing = true;
      void launch(key, fn).catch(() => { hit.refreshing = false; });
    }
    return hit.v as T; // serve current (possibly stale) value instantly
  }
  return launch(key, fn); // first call: nothing cached, must wait (공유 조회)
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
      void launch(key, fn).catch(() => { hit.refreshing = false; });
    }
    return hit.v as T;
  }
  void launch(key, fn).catch(() => {}); // 콜드 — 지피기만 하고 기다리지 않는다
  return null;
}
