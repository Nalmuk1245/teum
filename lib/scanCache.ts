// Scan cache — the fix for "every page load waits for a full venue sweep".
//
// The server keeps ONE warm snapshot and refreshes it in the background on a
// fixed cadence; /api/scan just returns the latest snapshot (~ms). The first
// request after boot is the only one that ever waits. Stale-while-revalidate:
// if the loop somehow lags, a request triggers a refresh but still returns the
// stale data immediately instead of blocking.

import { scanAll } from "./scanner";
import { loadSecretsIntoEnv } from "./secrets";
loadSecretsIntoEnv(); // 설정창에 저장된 키를 부팅 즉시 주입 (env보다 우선)

// 크래시 통보 — 프로세스가 죽기 직전 텔레그램으로 마지막 비명. pm2가 살리더라도
// "죽었었다"는 사실은 알아야 한다. (핸들러 중복 등록 방지 가드)
/** 종료 시 복기 기록 확정 — 실패해도 종료를 막지 않는다. */
function flushEpisodesOnExit(): void {
  try {
    // 정적 import를 피한다: 이 훅은 모듈 로드 순서와 무관하게 걸려야 한다.
    (require("./episodes") as typeof import("./episodes")).flushAllEpisodes();
  } catch { /* 종료 중 — 삼킨다 */ }
}

const gp = globalThis as unknown as { __arbCrashHook?: boolean };
if (!gp.__arbCrashHook) {
  gp.__arbCrashHook = true;
  const scream = (kind: string, err: unknown) => {
    const msg = err instanceof Error ? `${err.message}\n${(err.stack ?? "").slice(0, 300)}` : String(err);
    // notify는 쿨다운이 있으니 크래시 전용 키 사용; 실패해도 그냥 죽게 둔다.
    try { void notifyNow(`💥 <b>서버 ${kind}</b>\n${msg}`); } catch { /* dying anyway */ }
    console.error(`[${kind}]`, err); // 텔레그램 미설정이어도 흔적은 남는다
  };
  // unhandledRejection은 알리고 계속 산다 (대개 개별 fetch 실패).
  process.on("unhandledRejection", (e) => scream("unhandledRejection", e));
  // uncaughtException은 다르다: 핸들러를 등록하는 것만으로 Node의 기본 종료가
  // 사라져, 복구 불가 상태로 계속 주문을 받게 된다. 알린 뒤 반드시 죽고
  // 프로세스 관리자(pm2)가 깨끗한 상태로 살리게 한다.
  process.on("uncaughtException", (e) => {
    scream("uncaughtException", e);
    flushEpisodesOnExit();
    setTimeout(() => process.exit(1), 1500).unref(); // 텔레그램 전송 여유만 주고 종료
  });
  // 정상 종료(pm2 restart·Ctrl+C)에서도 진행 중인 복기 기록을 확정한다 —
  // 안 하면 재시작 때마다 "지금 가장 오래 살아 있는 기회"가 통째로 사라진다.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { flushEpisodesOnExit(); process.exit(0); });
  }
}
import type { Opportunity } from "./types";
import { notify, notifyNow, telegramConfigured } from "./telegram";
import { startListingWatch, watchStatus } from "./listings";
import { startWatchdog } from "./watchdog";
import { loopLag } from "./loopLag"; // 프로세스 멈춤 상시 감시 (import만으로 시작)
import { loadSection, saveSection } from "./persist";

// 3s: a sweep costs ~0.8-1.2s once every venue fetch is timeout-bounded and the
// Upbit/Bithumb calls run in parallel; per-venue call rates stay far below every
// venue's public limits.
const REFRESH_MS = 3000;
// A tick MUST finish. Every fetch inside scanAll is individually bounded, but
// this is the backstop for anything that never settles for another reason —
// without it, one hung promise latches `refreshing` and the board freezes on a
// stale snapshot until someone restarts the process (silently: the WS keeps the
// UI looking live while every live entry is blocked by the staleness gate).
const TICK_DEADLINE_MS = 8000;
// If `refreshing` has been set longer than this, the previous tick is considered
// lost and the latch is force-released so scanning can resume.
const STUCK_MS = 20_000;
const ALERT_NET_PCT = 0.5; // matches the client board threshold
// %가 아니라 돈으로도 거른다 — 0.6% 흑자여도 $3짜리 기회는 폰을 울릴 가치가 없다.
const ALERT_MIN_USD = Number(process.env.ALERT_MIN_USD || 5);

type Cache = {
  opps: Opportunity[];
  ts: number; // when the snapshot was taken (0 = never)
  refreshing: boolean;
  refreshStartedAt: number; // 0 = idle; used to detect a lost tick
  loop: ReturnType<typeof setInterval> | null;
  prewarm?: ReturnType<typeof setInterval> | null;
};
const g = globalThis as unknown as { __arbScanCache?: Cache };
g.__arbScanCache ??= { opps: [], ts: 0, refreshing: false, refreshStartedAt: 0, loop: null };
const C = g.__arbScanCache;
C.refreshStartedAt ??= 0; // 이전 버전 상태에서 핫리로드된 경우
// On (re)load, drop any prior interval so a hot-reload picks up new code — the
// old setInterval would otherwise keep calling a stale scanAll closure forever.
if (C.loop) { clearInterval(C.loop); C.loop = null; }
if (C.prewarm) { clearInterval(C.prewarm); C.prewarm = null; }
// A hot-reload (or a previously stuck tick) must not leave the latch set: the
// new module instance would never be able to scan.
C.refreshing = false;
C.refreshStartedAt = 0;

/** True when the latch is held by a tick that is never going to finish. */
function stuck(): boolean {
  return C.refreshing && C.refreshStartedAt > 0 && Date.now() - C.refreshStartedAt > STUCK_MS;
}

async function refresh(): Promise<void> {
  if (C.refreshing) {
    if (!stuck()) return; // a healthy tick is in flight — dedupe
    // Previous tick is unrecoverable. Force the latch open and take over; the
    // zombie can no longer apply its result (the startedAt guard below drops it).
    const heldSec = Math.round((Date.now() - C.refreshStartedAt) / 1000);
    console.error(`[scan] refresh stuck ${heldSec}s — 강제 해제`);
    void notify("scan:stuck", `⚠️ 스캔 틱이 ${heldSec}초간 멈춤 — 강제 해제하고 재개합니다`);
  }
  C.refreshing = true;
  C.refreshStartedAt = Date.now();
  const startedAt = C.refreshStartedAt;

  // The latch is released when the REAL scan settles — NOT when the deadline
  // below fires. A deadline cannot cancel the work already in flight, so
  // releasing early would let ticks overlap without bound and starve the event
  // loop. Overlap is only ever allowed by the `stuck()` path above.
  const scan = scanAll();
  void scan.then(
    (next) => {
      // A late zombie must not clobber a snapshot newer than itself.
      if (startedAt >= C.ts) {
        if (telegramConfigured()) void alertOnScan(next);
        recordHourlyHeat(next);
        recordSrcHeat();
        C.opps = next;
        // 기회 에피소드 기록 (복기용) — 임계 위 구간을 열고 닫는다. throw 안 함.
        import("./episodes").then((m) => m.recordEpisodes(next)).catch(() => {});
        C.ts = Date.now();
      }
    },
    (e) => { console.error("[scan refresh]", e); }, // 직전 스냅샷 유지
  ).finally(() => {
    if (C.refreshStartedAt === startedAt) {
      C.refreshing = false;
      C.refreshStartedAt = 0;
    }
  });

  // Callers (cold boot) must not block forever on a slow sweep. Stop AWAITING at
  // the deadline and let them serve what's there; the scan keeps going and fills
  // the cache for the next request.
  await Promise.race([
    scan.then(() => undefined, () => undefined),
    new Promise<void>((res) => setTimeout(res, TICK_DEADLINE_MS).unref()),
  ]);
}

// 시간대별 "수익 갭 열림" 빈도 (KST) — 언제 갭이 열리는지의 장기 패턴.
// 스캔마다 해당 시간 칸에 [스캔 수, 수익 기회가 있던 스캔 수]를 누적.
export type HourHeat = { scans: number; open: number };
// Hoisted: constructing an Intl formatter costs ~0.4ms, and this runs per tick.
const KST_HOUR = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: "Asia/Seoul" });
function recordHourlyHeat(opps: Opportunity[]) {
  try {
    const hour = Number(KST_HOUR.format(new Date()));
    const heat = loadSection<HourHeat[]>("hourlyHeat") ?? Array.from({ length: 24 }, () => ({ scans: 0, open: 0 }));
    const h = (heat[hour] ??= { scans: 0, open: 0 });
    h.scans++;
    if (opps.some((o) => !o.mock && o.kind !== "funding-basis" && o.netPct > 0)) h.open++;
    saveSection("hourlyHeat", heat); // 30s 디바운스 저장
  } catch { /* stats must never break the scan */ }
}
export function hourlyHeat(): HourHeat[] {
  return loadSection<HourHeat[]>("hourlyHeat") ?? Array.from({ length: 24 }, () => ({ scans: 0, open: 0 }));
}

// ── 감시 소스별 시간당 가동률 (24h 링) — 감시 카드의 미니 업타임 스트립 ────────
// "지금 초록"만 보이면 오늘 10번 끊긴 소스도 멀쩡해 보인다. 틱마다 소스 상태를
// 카드와 같은 기준으로 판정해 시간당 [ok, 표본수]로 누적한다. 루프 자체가 죽어
// 있던 시간은 표본이 없어 빈 칸으로 남는다 — 그것도 정보다.
export type SrcHeatCell = { h: number; ok: number; n: number }; // h = epoch-hour
export type SrcHeatMap = Record<string, SrcHeatCell[]>;
function recordSrcHeat(): void {
  try {
    const w = watchStatus();
    const lag = loopLag();
    const h = Math.floor(Date.now() / 3600_000);
    const verdicts: Record<string, boolean | null> = {
      scan: true, // 성공한 틱에서만 불린다 — 표본 없음 = 스캔이 죽어 있었음
      ann: w.annBlocked ? false : w.annOkAgoSec != null && w.annOkAgoSec < 120,
      mkt: w.mktOkAgoSec != null && w.mktOkAgoSec < 60,
      tg: w.tgConfigured ? w.tgOkAgoSec != null && w.tgOkAgoSec < 600 : null, // 미설정은 표본 제외
      // worstMs는 10분 창 최악값 — 그대로 쓰면 1회 멈춤이 이후 10분을 전부
      // down으로 칠한다. 발생 후 1분 안쪽일 때만 down으로 계상.
      proc: lag ? !(lag.worstMs >= 400 && lag.worstAgoSec != null && lag.worstAgoSec < 60) : null,
    };
    const heat = loadSection<SrcHeatMap>("srcHeat") ?? {};
    for (const [src, ok] of Object.entries(verdicts)) {
      if (ok == null) continue;
      const arr = (heat[src] ??= []);
      let cell = arr[arr.length - 1];
      if (!cell || cell.h !== h) { cell = { h, ok: 0, n: 0 }; arr.push(cell); }
      cell.n++;
      if (ok) cell.ok++;
      while (arr.length > 24) arr.shift();
    }
    saveSection("srcHeat", heat); // 30s 디바운스 저장 (hourlyHeat와 동일 경로)
  } catch { /* stats must never break the scan */ }
}
export function srcHeat(): SrcHeatMap {
  return loadSection<SrcHeatMap>("srcHeat") ?? {};
}

// Phone alerts from the server loop — fires whether or not the site is open.
async function alertOnScan(opps: Opportunity[]): Promise<void> {
  for (const o of opps) {
    if (o.mock || o.kind === "funding-basis") continue;
    // Threshold crossing — cooldown keeps a hovering coin from spamming.
    const refUsd = Math.min(o.notionalCapUsd ?? 2000, 2000);
    const expUsd = (o.netPct / 100) * refUsd;
    if (o.netPct >= ALERT_NET_PCT && expUsd >= ALERT_MIN_USD) {
      const [buy, sell] = o.legs;
      void notify(
        `net:${o.id}`,
        `🔔 <b>${o.base}</b> 갭 <b>+${o.netPct.toFixed(2)}%</b> (≈$${expUsd.toFixed(0)})\n${buy?.venue} → ${sell?.venue} · ${o.kind}${o.persistence?.heldSec ? ` · 지속 ${o.persistence.heldSec}s` : ""}`,
      );
    }
    // Settlement gate went down while an edge exists.
    if (o.transfer?.blocked && o.netPct > 0) {
      void notify(`gate:${o.id}`, `⛔ <b>${o.base}</b> 입출금 중단 — 실행 불가 (net +${o.netPct.toFixed(2)}%)`);
    }
  }
}

/** Latest scan snapshot. Only the very first call (cold boot) awaits a sweep. */
export async function getScan(): Promise<{ opps: Opportunity[]; ts: number }> {
  // Background refresh loop — started lazily on first request, then keeps the
  // snapshot warm even between visits (personal local box, cost is fine).
  if (!C.loop) {
    C.loop = setInterval(() => void refresh(), REFRESH_MS);
    // 오더북 프리웜 — 상위 기회의 실호가를 항상 캐시에 데워 둔다 (클릭→견적 즉시).
    void import("./quote").then(({ prewarmBooks, PREWARM_MS }) => {
      if (C.prewarm) return;
      C.prewarm = setInterval(() => { void prewarmBooks(C.opps); }, PREWARM_MS);
    }).catch(() => {});
    startListingWatch(); // 상장따리: notice/TG/market watchers
    void import("./sellTriggers").then((m) => m.bootSellTriggers()).catch(() => {}); // 자동매도 재무장
    // 경로 DB 워머 — KR 유니버스의 공식 컨트랙트를 미리 검증·적재해 둔다.
    // 런타임 해석(recv/transfer)이 콜드 구축을 밟는 일이 없어진다.
    void import("./tokenRoutes").then(({ startRouteWarmer }) =>
      startRouteWarmer(async () => {
        const { upbitKrwMarkets } = await import("./exchanges");
        const up = (await upbitKrwMarkets()).map((m) => m.replace(/^KRW-/, ""));
        // 빗썸 목록은 공개 게이트 스윕이 이미 들고 있다 — 별도 호출 없이 재사용.
        const { fetchTransferStatus } = await import("./transfers");
        const { swr } = await import("./ttlCache");
        const ts = await swr("gates", 60_000, fetchTransferStatus);
        const bt = [...(ts.byVenue.bithumb?.keys() ?? [])];
        return [...new Set([...up, ...bt])];
      }),
    ).catch(() => {});
    startWatchdog(
      () => ({ scanTs: C.ts, liveOpps: C.opps.filter((o) => !o.mock).length }),
      // Recovery: force the latch open if a tick is wedged, then scan now.
      () => {
        if (C.refreshing) { C.refreshing = false; C.refreshStartedAt = 0; }
        void refresh();
      },
    );
  }
  if (C.ts === 0) {
    await refresh(); // cold boot: nothing to serve yet
  } else if (Date.now() - C.ts > REFRESH_MS * 2 && (!C.refreshing || stuck())) {
    // Loop lagged (or its latch is stuck) — kick one off but serve stale NOW.
    // `stuck()` matters here: without it, a wedged tick made this branch a
    // no-op too, so nothing could ever restart the scan.
    void refresh();
  }
  return { opps: C.opps, ts: C.ts };
}

/** 감시 카드 "재시작" — 멈춘 latch를 강제 해제하고 즉시 한 틱 돈다.
 *  건강한 틱(10초 미만 진행 중)은 건드리지 않는다 — refresh()의 중첩 금지
 *  원칙(이벤트 루프 기아)을 무인증 POST가 우회하면 안 된다. */
export function kickScan(): void {
  if (C.refreshing && Date.now() - C.refreshStartedAt < 10_000) return;
  C.refreshing = false;
  C.refreshStartedAt = 0;
  void refresh();
}
