// 이벤트 루프 지연 측정.
//
// 이 앱의 느림은 두 종류다: 외부 API가 늦은 것과, **프로세스가 멈춰 있는 것**.
// 둘은 화면에서 똑같이 보이지만 고치는 곳이 완전히 다르다. 단계별 소요만으로는
// 구분이 안 된다 — 루프가 막히면 모든 단계가 같이 늘어나기 때문이다.
//
// 판독: p50이 수십 ms면 정상. p99가 수백 ms~초 단위면 그 시간 동안 이 프로세스는
// 아무 요청도 처리하지 못한 것이다(동기 작업 폭주 또는 메모리 스왑).

import { monitorEventLoopDelay } from "perf_hooks";

type G = { __arbLoopLag?: ReturnType<typeof monitorEventLoopDelay>; __arbLagWatch?: NodeJS.Timeout };
const g = globalThis as unknown as G;
if (!g.__arbLoopLag) {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  g.__arbLoopLag = h;
}

// 멈춤은 요청이 없으면 아무 흔적도 안 남는다 — 사용자가 "느렸다"고 말해줘야만
// 아는 고장이다. 그래서 상시 감시한다: 창(5초) 안에서 한 번이라도 크게 멈췄으면
// 그 사실과 그때의 메모리를 남기고 창을 비운다. 로그의 시각이 곧 재현 단서다.
const STALL_MS = 400;
if (!g.__arbLagWatch) {
  const h = g.__arbLoopLag!;
  g.__arbLagWatch = setInterval(() => {
    const max = h.max / 1e6;
    if (max >= STALL_MS) {
      const rss = Math.round(process.memoryUsage().rss / 1048576);
      console.warn(`[loop] 멈춤 ${Math.round(max)}ms (최근 5초) · rss ${rss}MB`);
    }
    h.reset();
  }, 5000);
  g.__arbLagWatch.unref();
}

export function loopLag(): { p50: number; p99: number; max: number } {
  const h = g.__arbLoopLag!;
  const ms = (n: number) => Math.round(n / 1e5) / 10; // ns → ms(소수 1자리)
  return { p50: ms(h.percentile(50)), p99: ms(h.percentile(99)), max: ms(h.max) };
}

/** 스파이크 원인을 구간별로 좁힐 때 — 읽은 뒤 창을 비운다. */
export function resetLoopLag(): void {
  g.__arbLoopLag?.reset();
}
