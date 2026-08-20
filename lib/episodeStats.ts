// 복기 집계 — 저장된 구간들을 "기회 단위"로 읽는 순수 로직.
//
// 왜 읽는 쪽에서 또 묶는가: 적재 쪽(episodes.ts)에도 병합 창이 있지만 그건
// **앞으로 쌓일** 기록에만 걸린다. 이미 조각난 채 저장된 것과 새로 병합돼
// 들어오는 것이 한 목록에 섞이면, 같은 화면에서 "지속 30초"와 "지속 30분"이
// 서로 다른 잣대로 찍힌다. 읽을 때 한 번 더 같은 창으로 묶어 잣대를 맞춘다.
//
// fs를 쓰지 않는다 — 클라이언트 컴포넌트와 테스트가 그대로 임포트한다.

/** 집계에 필요한 최소 형태 (Episode의 부분집합). */
export type Span = { startTs: number; endTs: number };

/** 인접 구간을 창 안에서 하나로 묶는다. 반환은 시작 오름차순. */
export function mergeWindows<T extends Span>(spans: T[], gapMs: number): Span[] {
  if (spans.length === 0) return [];
  const asc = [...spans].sort((a, b) => a.startTs - b.startTs);
  const out: Span[] = [];
  let cur = { start: asc[0].startTs, end: asc[0].endTs };
  for (let i = 1; i < asc.length; i++) {
    if (asc[i].startTs - cur.end <= gapMs) cur.end = Math.max(cur.end, asc[i].endTs);
    else { out.push({ startTs: cur.start, endTs: cur.end } as Span); cur = { start: asc[i].startTs, end: asc[i].endTs }; }
  }
  out.push({ startTs: cur.start, endTs: cur.end } as Span);
  return out;
}

/** 가장 길게 **이어진** 구간의 길이(초).
 *
 *  누적 시간과 구별해야 한다. 실측 RED는 누적 123분이지만 가장 길게 이어진
 *  건 47분이었다 — 누적을 헤드라인에 쓰면 "2시간 먹을 수 있었다"로 읽히고
 *  그건 거짓이다. 조각의 합은 기회의 수명이 아니다.
 *
 *  주의: 이건 **묶는 창에 따라 늘어나는** 값이라 ETA 판정에 쓰면 안 된다
 *  (12분 창으로 이으면 12분짜리 구멍이 "연속" 안에 들어간다). 판정에는
 *  아래 longestProfitableRunSec을 쓴다. 이 값은 목록에서 "이 기회가 대략
 *  얼마나 오래 화면에 있었나"를 보여주는 용도다. */
export function longestWindowSec<T extends Span>(spans: T[], gapMs: number): number {
  const w = mergeWindows(spans, gapMs);
  if (!w.length) return 0;
  return Math.max(...w.map((x) => (x.endTs - x.startTs) / 1000));
}

/** [ts, netPct, ...] — 곡선 점의 최소 형태. */
export type NetPoint = [number, number, ...unknown[]];

/** 0% 위에 머문 **총** 시간(초) — 흩어져 있어도 다 더한다.
 *
 *  아래 longestProfitableRunSec(가장 긴 **연속** 구간)과 짝이다. 곡선 카드는
 *  "이 구간의 몇 %가 흑자였나"를 이걸로 말하고, ETA 경고는 연속 쪽을 쓴다.
 *  둘을 섞으면 안 된다 — 흩어진 30분과 이어진 30분은 전혀 다른 사실이다.
 *
 *  부호가 바뀌는 구간은 선형보간으로 교차점을 잡는다. "양수 샘플 수 × 간격"
 *  근사는 3초 스캔에서 최대 3초씩 밀리는데, 30초짜리 구간이 태반이라 그
 *  오차가 10%다. */
export function secondsAboveZero(curve: NetPoint[]): number {
  let s = 0;
  for (let i = 1; i < curve.length; i++) {
    const [t0, v0] = curve[i - 1];
    const [t1, v1] = curve[i];
    const dt = (t1 - t0) / 1000;
    if (dt <= 0) continue;
    if (v0 > 0 && v1 > 0) s += dt;
    else if (v0 > 0 || v1 > 0) s += dt * (Math.abs(v0 > 0 ? v0 : v1) / (Math.abs(v0) + Math.abs(v1) || 1));
  }
  return s;
}

/** 순수익이 **끊김 없이** 0 위에 머문 가장 긴 시간(초).
 *
 *  ETA 판정의 유일한 정직한 근거다. 왜 위의 longestWindowSec이면 안 되는가:
 *  그건 구간을 묶는 창(12분)만큼의 구멍을 "연속"으로 삼킨다. 실측 RED는 그
 *  방식으로 재면 최장 86분이 나와 ETA 60분을 넘긴 것처럼 보이는데, 그 86분
 *  안에는 순수익이 음수였던 구간이 들어 있다. 60분 뒤 코인이 도착하는 시점이
 *  하필 그 구멍이면 손실로 판다.
 *
 *  그래서 실제 샘플만 본다: 부호가 바뀌는 지점은 선형보간으로 자르고, 관측이
 *  끊긴 곳(dt가 gapMs 초과)은 이어붙이지 않고 **끊는다** — 그 사이에 무슨 일이
 *  있었는지 모르니까. */
export function longestProfitableRunSec(curve: NetPoint[], gapMs = 30_000): number {
  let best = 0, run = 0;
  for (let i = 1; i < curve.length; i++) {
    const [t0, v0] = curve[i - 1];
    const [t1, v1] = curve[i];
    const dt = (t1 - t0) / 1000;
    if (dt <= 0) continue;
    if (t1 - t0 > gapMs) { best = Math.max(best, run); run = 0; continue; } // 관측 구멍
    if (v0 > 0 && v1 > 0) {
      run += dt;
    } else if (v0 > 0) {
      // 이 구간 안에서 0 아래로 내려간다 — 교차점까지만 세고 끊는다.
      run += dt * (Math.abs(v0) / (Math.abs(v0) + Math.abs(v1) || 1));
      best = Math.max(best, run);
      run = 0;
    } else if (v1 > 0) {
      // 올라오는 구간 — 교차점부터 새로 센다.
      run = dt * (Math.abs(v1) / (Math.abs(v0) + Math.abs(v1) || 1));
    } else {
      best = Math.max(best, run);
      run = 0;
    }
  }
  return Math.max(best, run);
}

/** 끊김 없이 흑자였던 최장 시간이 전송 ETA를 넘겼는가.
 *
 *  이 전략의 코인은 매수 시점이 아니라 **도착 시점**에 팔린다(역프 기준 ETA
 *  60분). 갭이 그보다 훨씬 짧게만 살아 있었다면 도착했을 땐 이미 사라졌을
 *  가능성이 크다.
 *
 *  단정하지 않는 이유: 엄밀히 필요한 건 "진입 시점과 도착 시점이 **둘 다**
 *  흑자"지 "그 사이 내내 흑자"가 아니다. 중간에 잠깐 음수로 내려가도 도착
 *  시점만 흑자면 먹는다. 그 엄밀한 판정을 하려면 곡선이 ETA보다 길게
 *  관측돼 있어야 하는데, 실측 에피소드는 대부분 30분 미만이라 60분 ETA를
 *  가로지르는 쌍 자체가 없다.
 *
 *  그래서 이 함수는 **증명이 아니라 경고**다: "끊김 없이 흑자였던 시간이
 *  ETA에 한참 못 미친다"는 사실 자체는 참이고, 진입을 말리기에 충분하다.
 *  호출부는 그 뜻이 드러나는 문구를 써야 한다 — "실현 불가"가 아니라
 *  "흑자 3분 < ETA 60분"처럼. ETA를 모르면 판정하지 않는다(null). */
export function outlastsEta(longestSec: number, etaMin: number | null | undefined): boolean | null {
  if (etaMin == null || !(etaMin > 0)) return null;
  return longestSec >= etaMin * 60;
}
