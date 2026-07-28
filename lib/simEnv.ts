// 모의(DRY_RUN) 환경의 정교화 — 리허설이 실전과 같은 "모양"으로 굴러가게 한다.
//
// 기존 모의는 모든 단계가 0초에 즉시 성공하고 체결가는 스냅샷 그대로였다.
// 그 리허설로는 실전의 세 가지를 연습할 수 없다:
//   ① 대기 — 입금 폴링·수신 확인이 실제로는 분 단위로 pending을 반복한다.
//      즉시 성공하면 폴링 경로·타임라인 대기 줄·승인 타이밍이 전부 미검증으로 남는다.
//   ② 체결 — 실전 체결은 호가를 먹으며 미끄러진다. 스냅샷가 체결이면 모의 손익이
//      항상 보드 숫자와 같아서, 모의 기록이 아무것도 말해주지 않는다.
//   ③ 전송 중 가격 변동 — 매수와 매도 사이에 시간이 흐르면 실현 엣지가 변한다.
//      시간이 0이면 이 리스크가 리허설에서 보이지 않는다.
//
// 설계 원칙: 시간은 **압축**하되(기본 60배속 — 15분 ETA가 15초) 구조는 실전과
// 동일하게 — pending은 진짜 pending으로, 체결은 그 순간의 실호가 VWAP로.
//
// 전부 env로 조절한다 (.env.example 참고):
//   SIM_TIME_SCALE      기본 60   — 실제 ETA ÷ 이 값 = 모의 대기 시간 (1 = 실시간)
//   SIM_STEP_LATENCY_MS 기본 800  — 주문류 단계당 인위 지연 (0 = 즉시)
//   SIM_BOOK_FILLS      기본 1    — 실호가 VWAP 체결 (0 = 예전처럼 스냅샷가)
//   SIM_FAIL_PCT        기본 0    — 단계 실패 확률 주입(%) — 롤백·브레이커 리허설용

const n = (v: string | undefined, d: number) => {
  const x = Number(v);
  return Number.isFinite(x) && x >= 0 ? x : d;
};

export const SIM = {
  get timeScale() { return Math.max(1, n(process.env.SIM_TIME_SCALE, 60)); },
  get stepLatencyMs() { return Math.min(10_000, n(process.env.SIM_STEP_LATENCY_MS, 800)); },
  get bookFills() { return (process.env.SIM_BOOK_FILLS ?? "1") !== "0"; },
  get failPct() { return Math.min(50, n(process.env.SIM_FAIL_PCT, 0)); }, // 상한 50% — 100%면 아무것도 못 굴린다
};

/** 주문류 단계의 인위 지연. 즉시 성공이 주는 가짜 리듬을 없앤다. */
export function simLatency(): Promise<void> {
  const ms = SIM.stepLatencyMs;
  if (!ms) return Promise.resolve();
  // ±40% 지터 — 매번 같은 간격이면 그것도 가짜 리듬이다.
  const jitter = ms * (0.6 + Math.random() * 0.8);
  return new Promise((res) => { setTimeout(res, jitter).unref?.(); });
}

/** 전송 ETA(분)를 모의 시간(ms)으로 압축. */
export function simEtaMs(etaMin: number | null | undefined): number {
  const min = etaMin && etaMin > 0 ? etaMin : 10; // ETA 미상이면 10분 가정
  return (min * 60_000) / SIM.timeScale;
}

/**
 * 장애 주입 — SIM_FAIL_PCT 확률로 이 단계를 실패시킨다. 롤백·서킷 브레이커·
 * 재시도 UI를 실제로 굴려보는 유일한 방법이다 (실전에서 연습할 수는 없으니).
 * 진입(buy/swap)은 제외 — 진입 실패는 그냥 아무 일도 안 일어나서 리허설 가치가
 * 낮고, 중간 단계 실패가 진짜 연습 대상(포지션 든 채 실패)이다.
 */
export function simInjectFail(stepId: string): string | null {
  if (SIM.failPct <= 0) return null;
  if (stepId === "buy" || stepId === "swap" || stepId === "settle") return null;
  if (Math.random() * 100 >= SIM.failPct) return null;
  return `모의 장애 주입 (SIM_FAIL_PCT=${SIM.failPct}%) — 실전이었다면 여기서 사람이 개입한다`;
}
