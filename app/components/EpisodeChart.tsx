"use client";

// 기회 복기 곡선 — "그때 먹을 수 있었나"를 한 장으로.
//
// 이 차트가 답해야 하는 질문은 세 개다:
//   ① 0%(손익분기) 위에 **얼마나 오래** 있었나  ② 피크는 언제·얼마였나
//   ③ 그 사이 값이 어떻게 움직였나
// 그래서 0선이 이 그림의 주인공이고, 나머지는 전부 그 주위의 보조다.
//
// 데이터의 실제 모양(실측 278개 에피소드): 대부분 30~60초·11~14샘플의 짧은
// 구간이고, 값의 폭은 1%p 안쪽이다. 긴 것은 30분·120샘플까지 간다.
//   → 샘플이 적을 땐 점을 찍는다. 3초마다 찍힌 이산 관측이지 연속 곡선이
//     아니라는 걸 숨기면, 11개 점을 매끈한 선으로 보여주며 없는 해상도를
//     있는 척하게 된다.
//   → 값의 폭이 아주 좁을 땐 y축을 최소 폭으로 벌린다. 0.02%p 흔들림을 화면
//     가득 채워 그리면 잡음이 사건처럼 보인다.
//
// 색에 대하여: 0선 위/아래를 초록/빨강으로 칠하지만 **부호를 색으로만
// 말하지 않는다**. 이 두 색은 적록색약에서 사실상 구분되지 않는다(검증기 기준
// deutan ΔE 1.7 dark / 4.3 light — 통과 기준 8에 한참 못 미친다). 부호는
// 라벨 붙은 0선 기준의 **위치**와 하단의 "0% 위 X" 텍스트가 전달하고, 색은
// 눈이 빠르게 훑을 때의 보조일 뿐이다.

import { useEffect, useRef, useState } from "react";
import { secondsAboveZero } from "@/lib/episodeStats";

/** [ts, netPct, grossPct, priceUsd] */
export type CurvePoint = [number, number, number, number];

const H = 132;
const PAD = { top: 18, right: 12, bottom: 20, left: 42 };
/** y축 최소 표시 폭(%p) — 이보다 좁으면 잡음이 확대돼 사건처럼 보인다. */
const MIN_SPAN = 0.25;
/** 이 이하 샘플이면 점을 찍는다 — 이산 관측임을 숨기지 않는다. */
const DOT_MAX_POINTS = 28;

/** 컨테이너 실제 폭 — viewBox를 실제 픽셀에 맞춰 왜곡을 없앤다.
 *  예전 차트는 560×72 viewBox를 preserveAspectRatio="none"으로 늘여서, 점은
 *  타원이 되고 글자는 가로로 눌렸다. 그게 "구려" 보이던 가장 큰 이유다. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr) setW(cr.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const clock = (t: number) =>
  new Date(t).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
const clockSec = (t: number) =>
  new Date(t).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const durLabel = (sec: number) =>
  sec >= 3600 ? `${(sec / 3600).toFixed(1)}시간` : sec >= 90 ? `${Math.round(sec / 60)}분` : `${Math.round(sec)}초`;

/** 눈금 후보 — 0은 항상, 나머지는 위아래 극값. 촘촘한 격자는 이 크기에서 잡음이다. */
function ticks(lo: number, hi: number): number[] {
  const out = [0];
  if (hi > 0.02) out.push(hi);
  if (lo < -0.02) out.push(lo);
  return out;
}

/** 아래쪽 y 경계를 이상치에 내주지 않는다.
 *
 *  실데이터에서 이런 게 나온다: 30분짜리 EDEN 에피소드가 대부분 ±0.3% 안에서
 *  움직이다가 **한 샘플만 -2.38%**를 찍는다(호가가 순간 비었거나 피드가 튄 것).
 *  그 한 점에 축을 맞추면 정작 봐야 할 구간이 위쪽 1/3로 눌려 아무것도 안 보인다.
 *
 *  그래서 아래 경계는 하위 분위수로 잡고, 잘린 점은 **숨기지 않고** 경계에
 *  삼각형과 실제 값으로 표시한다. 축을 이상치에서 지키되 이상치가 있었다는
 *  사실은 지운다 — 그 둘은 다르다.
 *  위쪽은 자르지 않는다: 피크가 이 카드의 헤드라인이라 절대 가리면 안 된다. */
export function robustLow(nets: number[]): { lo: number; clipped: boolean } {
  const min = Math.min(...nets, 0);
  if (nets.length < 12) return { lo: min, clipped: false };
  const sorted = [...nets].sort((a, b) => a - b);
  const q = sorted[Math.floor(sorted.length * 0.04)];
  // 분위수가 0 위면 쓰지 않는다 — 0은 언제나 보여야 한다.
  const lo = Math.min(0, q);
  // 이상치가 나머지보다 확실히 멀 때만 자른다 (2배 이상 아래).
  const span = Math.max(0.05, Math.abs(lo));
  if (min < lo - span) return { lo, clipped: true };
  return { lo: min, clipped: false };
}

export function EpisodeChart({ curve }: { curve: CurvePoint[] }) {
  const [wrapRef, W] = useWidth<HTMLDivElement>();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (curve.length === 0) return null;
  if (curve.length < 2) {
    return (
      <div style={{ fontSize: 11, color: "var(--text-mute)", padding: "10px 0" }}>
        샘플 1개 — 그릴 곡선이 없습니다 (스캔 1회 만에 사라진 기회)
      </div>
    );
  }

  const t0 = curve[0][0];
  const t1 = curve[curve.length - 1][0];
  const nets = curve.map((p) => p[1]);
  const { lo: loRaw, clipped } = robustLow(nets);
  let lo = loRaw;
  let hi = Math.max(...nets, 0);
  const trueMin = Math.min(...nets);
  const minIdx = nets.indexOf(trueMin);
  if (hi - lo < MIN_SPAN) {
    const mid = (hi + lo) / 2;
    lo = mid - MIN_SPAN / 2;
    hi = mid + MIN_SPAN / 2;
    if (lo > 0) lo = 0;          // 0은 항상 보인다 — 판단선이니까
    if (hi < 0) hi = 0;
  }
  const padY = (hi - lo) * 0.14;
  const yLo = lo - padY, yHi = hi + padY;

  const plotW = Math.max(0, W - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + (t1 === t0 ? plotW / 2 : ((t - t0) / (t1 - t0)) * plotW);
  // 잘린 이상치는 바닥에 눕힌다 — 선이 플롯 밖으로 새지 않게.
  const yRaw = (v: number) => PAD.top + (1 - (v - yLo) / (yHi - yLo)) * plotH;
  const y = (v: number) => Math.min(H - PAD.bottom, yRaw(v));

  const ready = W > 0;
  const zeroY = y(0);
  // 관측이 끊긴 구간은 선을 잇지 않는다.
  //
  // 에피소드는 잠깐 임계 아래로 내려갔다 돌아온 조각들을 하나로 병합한다
  // (lib/episodes.ts의 MERGE_GAP). 그 사이 구간에는 **관측이 없다** — 그걸
  // 직선으로 이으면 "그때 이 값이었다"고 없는 데이터를 그려주는 셈이다.
  // 샘플 간격의 중앙값보다 한참 벌어진 곳에서 조각을 나눈다.
  const dts: number[] = [];
  for (let i = 1; i < curve.length; i++) dts.push(curve[i][0] - curve[i - 1][0]);
  const medDt = dts.length ? [...dts].sort((a, b) => a - b)[Math.floor(dts.length / 2)] : 0;
  const gapMs = Math.max(medDt * 3, 20_000);
  const segments: CurvePoint[][] = [];
  let cur: CurvePoint[] = [];
  for (let i = 0; i < curve.length; i++) {
    if (i > 0 && curve[i][0] - curve[i - 1][0] > gapMs) { segments.push(cur); cur = []; }
    cur.push(curve[i]);
  }
  if (cur.length) segments.push(cur);
  const ptsOf = (seg: CurvePoint[]) => seg.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");
  // 0선까지 닫은 면 — 위/아래를 각각 clip해서 부호별로 칠한다.
  const areaOf = (seg: CurvePoint[]) =>
    `${x(seg[0][0]).toFixed(1)},${zeroY.toFixed(1)} ${ptsOf(seg)} ${x(seg[seg.length - 1][0]).toFixed(1)},${zeroY.toFixed(1)}`;

  let pi = 0;
  for (let i = 1; i < curve.length; i++) if (curve[i][1] > curve[pi][1]) pi = i;
  const peak = curve[pi];
  const px = x(peak[0]), py = y(peak[1]);
  // 피크 라벨이 좌우 밖으로 나가지 않게 앵커를 바꾼다 (잘림 방지).
  const anchor = px < PAD.left + 46 ? "start" : px > W - PAD.right - 46 ? "end" : "middle";

  const above = secondsAboveZero(curve);
  const total = Math.max(1, (t1 - t0) / 1000);
  const p0 = curve[0][3], pEnd = curve[curve.length - 1][3];
  const priceMovePct = p0 > 0 ? ((pEnd - p0) / p0) * 100 : null;
  const showDots = curve.length <= DOT_MAX_POINTS;
  const spanSec = (t1 - t0) / 1000;
  const axisClock = spanSec < 600 ? clockSec : clock;

  // 호버 — 가장 가까운 샘플. 히트 영역은 플롯 전체(마크보다 넉넉하게).
  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = e.clientX - rect.left;
    const frac = plotW <= 0 ? 0 : Math.min(1, Math.max(0, rel / plotW));
    const tAt = t0 + frac * (t1 - t0);
    let best = 0, bestD = Infinity;
    for (let i = 0; i < curve.length; i++) {
      const d = Math.abs(curve[i][0] - tAt);
      if (d < bestD) { bestD = d; best = i; }
    }
    setHoverIdx(best);
  };
  const hv = hoverIdx != null ? curve[hoverIdx] : null;
  const hx = hv ? x(hv[0]) : 0;
  // 툴팁은 HTML — SVG 안 텍스트와 달리 앱 폰트·토큰을 그대로 쓰고 스케일에 안 눌린다.
  const tipLeft = hv ? Math.min(Math.max(hx, 62), Math.max(62, W - 62)) : 0;

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%" }}>
      {ready && (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: "block", overflow: "visible" }}>
          <defs>
            <clipPath id="ep-above"><rect x={PAD.left} y={PAD.top} width={plotW} height={Math.max(0, zeroY - PAD.top)} /></clipPath>
            <clipPath id="ep-below"><rect x={PAD.left} y={zeroY} width={plotW} height={Math.max(0, H - PAD.bottom - zeroY)} /></clipPath>
          </defs>

          {/* 눈금 — 배경으로 물러나 있어야 데이터가 앞에 선다 */}
          {ticks(lo, hi).map((v) => (
            <g key={v}>
              {/* 실선 헤어라인. 점선 그리드는 "임계선/추정치"로 읽혀서, 그냥
                  눈금일 뿐인 선에 없는 의미를 붙인다. 0선만 한 단계 진하게 —
                  이 그림에서 유일하게 의미를 가진 가로선이다. */}
              <line
                x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)}
                stroke={v === 0 ? "var(--border-strong)" : "var(--border)"}
                strokeWidth="1"
              />
              <text
                x={PAD.left - 7} y={y(v) + 3.5} textAnchor="end" fontSize="9.5"
                fill={v === 0 ? "var(--text-dim)" : "var(--text-mute)"}
                fontWeight={v === 0 ? 700 : 400}
              >
                {v === 0 ? "0%" : `${v > 0 ? "+" : ""}${v.toFixed(2)}`}
              </text>
            </g>
          ))}

          {/* 부호별 면 — 색은 보조. 판단은 0선 위/아래라는 위치가 한다. */}
          {segments.map((seg, i) => seg.length >= 2 && (
            <g key={`a${i}`}>
              <polygon points={areaOf(seg)} fill="var(--pos-soft)" clipPath="url(#ep-above)" />
              <polygon points={areaOf(seg)} fill="var(--neg-soft)" clipPath="url(#ep-below)" />
            </g>
          ))}

          {segments.map((seg, i) => (
            <polyline
              key={`l${i}`} points={ptsOf(seg)} fill="none"
              stroke="var(--brand-2)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
            />
          ))}

          {/* 샘플 점 — 적을 때만. 없는 해상도를 있는 척하지 않는다. */}
          {showDots && curve.map((p, i) => (
            <circle key={i} cx={x(p[0])} cy={y(p[1])} r="2.5" fill="var(--brand-2)" stroke="var(--card)" strokeWidth="1.5" />
          ))}

          {/* 잘린 이상치 — 축은 지키되 있었다는 사실은 지우지 않는다 */}
          {clipped && (
            <g>
              <path
                d={`M ${x(curve[minIdx][0]) - 4} ${H - PAD.bottom - 5} L ${x(curve[minIdx][0]) + 4} ${H - PAD.bottom - 5} L ${x(curve[minIdx][0])} ${H - PAD.bottom + 1} Z`}
                fill="var(--neg)"
              />
              <text
                x={Math.min(W - PAD.right, x(curve[minIdx][0]) + 7)} y={H - PAD.bottom - 1}
                textAnchor={x(curve[minIdx][0]) > W - PAD.right - 50 ? "end" : "start"}
                fontSize="9.5" fontWeight="700" fill="var(--neg)"
              >
                {trueMin.toFixed(2)}%
              </text>
            </g>
          )}

          {/* 피크 — 이 그림에서 유일하게 직접 라벨을 다는 점 */}
          <circle cx={px} cy={py} r="4.5" fill="var(--pos)" stroke="var(--card)" strokeWidth="2" />
          <text x={px} y={Math.max(11, py - 10)} textAnchor={anchor} fontSize="10.5" fontWeight="700" fill="var(--pos)">
            피크 +{peak[1].toFixed(2)}%
          </text>

          {/* 시간축 — 양 끝만. 가운데 눈금은 이 폭에서 겹친다. */}
          <text x={PAD.left} y={H - 6} textAnchor="start" fontSize="9.5" fill="var(--text-mute)">{axisClock(t0)}</text>
          <text x={W - PAD.right} y={H - 6} textAnchor="end" fontSize="9.5" fill="var(--text-mute)">{axisClock(t1)}</text>

          {/* 호버 크로스헤어 */}
          {hv && (
            <g pointerEvents="none">
              <line x1={hx} x2={hx} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--border-strong)" strokeWidth="1" />
              <circle cx={hx} cy={y(hv[1])} r="4" fill="var(--brand-2)" stroke="var(--card)" strokeWidth="2" />
            </g>
          )}

          <rect
            x={PAD.left} y={PAD.top} width={plotW} height={plotH}
            fill="transparent" style={{ cursor: "crosshair" }}
            onMouseMove={onMove} onMouseLeave={() => setHoverIdx(null)}
          />
        </svg>
      )}

      {hv && (
        <div
          className="tnum"
          style={{
            position: "absolute", left: tipLeft, top: 0, transform: "translateX(-50%)",
            pointerEvents: "none", background: "var(--card-2)", border: "1px solid var(--border-strong)",
            borderRadius: 8, padding: "5px 8px", fontSize: 10.5, lineHeight: 1.5,
            color: "var(--text)", whiteSpace: "nowrap", boxShadow: "0 4px 14px rgba(0,0,0,0.28)",
          }}
        >
          <div style={{ color: "var(--text-dim)" }}>{clockSec(hv[0])}</div>
          <div>
            순수익 <b style={{ color: hv[1] >= 0 ? "var(--pos)" : "var(--neg)" }}>{hv[1] >= 0 ? "+" : ""}{hv[1].toFixed(2)}%</b>
            <span style={{ color: "var(--text-mute)" }}> · 총 {hv[2] >= 0 ? "+" : ""}{hv[2].toFixed(2)}%</span>
          </div>
          {hv[3] > 0 && <div style={{ color: "var(--text-mute)" }}>가격 ${hv[3] < 1 ? hv[3].toPrecision(4) : hv[3].toLocaleString()}</div>}
        </div>
      )}

      {/* 헤드라인 — 이 카드가 묻는 것에 숫자로 답하는 줄 */}
      <div
        className="tnum"
        style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 10, color: "var(--text-mute)", marginTop: 3 }}
      >
        <span style={{ color: above > 0 ? "var(--text-dim)" : "var(--text-mute)" }}>
          0% 위 <b style={{ color: above > 0 ? "var(--pos)" : "var(--text-mute)" }}>{durLabel(above)}</b>
          {` (${Math.round((above / total) * 100)}%)`}
        </span>
        <span>{curve.length}샘플</span>
        {priceMovePct != null && <span>구간 가격 {priceMovePct >= 0 ? "+" : ""}{priceMovePct.toFixed(2)}%</span>}
      </div>
    </div>
  );
}
