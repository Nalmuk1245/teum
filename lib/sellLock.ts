// 매도 뮤텍스 — (거래소, 코인)당 한 번에 하나만 판다.
//
// 병렬 안전성 감사(2026-08-04)가 잡은 최악 시나리오: 실행 엔진의 매도 다리와
// 자동매도 트리거가 같은 코인·거래소를 동시에 팔면, 하나는 거절되고 — 그게 하필
// 실행 엔진 쪽이면 비가역 출금 뒤라 롤백이 안 돼 **퍼프 숏이 현물 없이 남는다**
// (네이키드 숏 = 실제 돈 노출). activeSellForVenue는 tick 맨 위 한 번만 보는
// advisory read라 TOCTOU 창이 열려 있었다.
//
// 해법: 주문 **직전에** 이 락을 잡는다. 못 잡으면 이번 주기는 양보. 프로세스가
// 하나라 단순 in-memory Map으로 충분하다(멀티프로세스가 되면 여기만 바꾸면 됨).
//
// 락은 짧게 잡는다 — 주문 한 번을 감싸는 용도지, 런 전체를 잠그는 게 아니다.
// 소유자가 죽어 release를 못 하면 STALE_MS 후 강제 해제(교착 방지).

type Held = { owner: string; at: number };
const g = globalThis as unknown as { __arbSellLocks?: Map<string, Held> };
g.__arbSellLocks ??= new Map();
const L = g.__arbSellLocks;

const STALE_MS = 30_000; // 주문 한 번이 이보다 오래 걸릴 리 없다 — 넘으면 소유자 사망으로 간주

const key = (venue: string, base: string) => `${venue}:${base.toUpperCase()}`;

/** 락 획득 시도. 성공하면 true(호출자가 반드시 release). 이미 잡혀 있으면 false. */
export function acquireSell(venue: string, base: string, owner: string): boolean {
  const k = key(venue, base);
  const cur = L.get(k);
  if (cur) {
    if (Date.now() - cur.at < STALE_MS) return false; // 살아있는 소유자 — 양보
    // 소유자가 release 없이 사라졌다 — 강제 회수.
    console.warn(`[sellLock] stale ${k} (owner=${cur.owner}, ${Math.round((Date.now() - cur.at) / 1000)}s) — 강제 해제`);
  }
  L.set(k, { owner, at: Date.now() });
  return true;
}

export function releaseSell(venue: string, base: string, owner: string): void {
  const k = key(venue, base);
  const cur = L.get(k);
  // 자기 락만 푼다 — 강제 회수된 뒤 늦게 온 release가 새 소유자를 밀어내지 않게.
  if (cur && cur.owner === owner) L.delete(k);
}

/** 지금 이 (거래소, 코인)을 누가 팔고 있나 (락 소유자). 없으면 null.
 *  startRun/manual route가 "이미 매도 중이면 거부"에 쓴다. */
export function sellLockOwner(venue: string, base: string): string | null {
  const cur = L.get(key(venue, base));
  if (!cur) return null;
  if (Date.now() - cur.at >= STALE_MS) return null; // stale = 없는 것으로
  return cur.owner;
}

/** owner로 감싼 임계구역 — 주문 하나를 락 안에서 실행. 못 잡으면 null 반환. */
export async function withSellLock<T>(venue: string, base: string, owner: string, fn: () => Promise<T>): Promise<T | null> {
  if (!acquireSell(venue, base, owner)) return null;
  try {
    return await fn();
  } finally {
    releaseSell(venue, base, owner);
  }
}
