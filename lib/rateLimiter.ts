// 거래소별 주문 rate limiter — 토큰 버킷.
//
// 병렬 안전성 감사(2026-08-04): 공유 rate limiter가 없어서 여러 루프(실행 엔진
// 폴링·자동매도 250ms·상장 감시·스캔)가 같은 IP에서 조율 없이 거래소 주문
// 엔드포인트를 두드린다. 특히 hammer 모드는 도착 전까지 거절 주문을 계속 쏘는데,
// 거래소는 거절 주문도 abuse로 세어 IP를 정지시킨다 — arb 중 정지는 곧 좌초다.
//
// 여기 한 곳으로 모든 주문 fetch를 통과시켜, 거래소별 문서화 한도의 안쪽으로
// 프로세스 전체를 페이싱한다. 주문(create)만 대상 — 시세·잔고 조회는 별도 버킷이라
// 여기 안 태운다(그건 여유롭고, 태우면 매도가 조회에 막힌다).

type Bucket = { tokens: number; last: number };

// 거래소별 주문 한도 (초당). 문서값의 ~70%로 보수적 — 여러 계정·다른 트래픽과
// 나눠 쓰는 걸 감안. 실측 후 조정.
//   업비트: 주문 8req/s 문서 → 5 · 바이낸스: 10/s → 7 · 빗썸: 보수적으로 2
//   바이비트: 10/s → 7 · OKX: 60/2s(=30/s)지만 보수적으로 7
// 선물(binancePerp)도 같은 "binance" 버킷을 쓴다 — 거래소 IP 한도는 현물·선물을
// 따로 세지 않으므로 버킷을 나누면 한도 안쪽이라는 보장이 깨진다.
const RATE_PER_SEC: Record<string, number> = { upbit: 5, binance: 7, bithumb: 2, bybit: 7, okx: 7 };
const BURST: Record<string, number> = { upbit: 5, binance: 7, bithumb: 2, bybit: 7, okx: 7 }; // 버킷 최대치

const g = globalThis as unknown as { __arbOrderBuckets?: Map<string, Bucket> };
g.__arbOrderBuckets ??= new Map();
const B = g.__arbOrderBuckets;

const MAX_WAIT_MS = 5_000; // 이보다 오래 기다려야 하면 포기(호출자가 다음 주기 재시도)

function refill(venue: string): Bucket {
  const rate = RATE_PER_SEC[venue] ?? 3;
  const cap = BURST[venue] ?? 3;
  const now = Date.now();
  let b = B.get(venue);
  if (!b) { b = { tokens: cap, last: now }; B.set(venue, b); return b; }
  const elapsed = (now - b.last) / 1000;
  b.tokens = Math.min(cap, b.tokens + elapsed * rate);
  b.last = now;
  return b;
}

/**
 * 주문 슬롯 하나 확보. 토큰이 있으면 즉시, 없으면 채워질 때까지 대기(최대 5초).
 * 반환 false = 한도 대기가 너무 길다 → 호출자는 이번 주문을 건너뛰고 다음 주기에.
 */
export async function acquireOrderSlot(venue: string): Promise<boolean> {
  const rate = RATE_PER_SEC[venue] ?? 3;
  const deadline = Date.now() + MAX_WAIT_MS;
  // 필요 시간을 정확히 자고 한 번만 재확인하면 안 된다 — setTimeout은 ms 절사에
  // 이르게 깰 수 있어 토큰이 0.99…로 1에 못 미치는 타이밍 결함이 있었다(CI에서
  // 재현). 올림+마진으로 자고, 그래도 모자라면 데드라인까지 루프.
  for (;;) {
    const b = refill(venue);
    if (b.tokens >= 1) { b.tokens -= 1; return true; }
    const waitMs = Math.ceil(((1 - b.tokens) / rate) * 1000) + 5;
    if (Date.now() + waitMs > deadline) return false; // 너무 오래 걸림 — 포기
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

/** 진단용 — 현재 버킷 잔량. */
export function orderBudget(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of Object.keys(RATE_PER_SEC)) out[v] = Math.round(refill(v).tokens * 10) / 10;
  return out;
}
