// 상장따리 — announcement-driven. The tradeable moment is when the LISTING
// ANNOUNCEMENT drops, not when trading opens: the announcement makes Korean flow
// bid the coin up on BOTH the Upbit price (the premium) and the global price. If
// you buy on a global CEX in the first seconds after the notice — before the
// global pump and long before Upbit trading opens — you're positioned ahead of it.
//
// Primary trigger: Upbit's announcement API (api-manager). It's Cloudflare-gated
// off non-KR / datacenter IPs, so it works from a local KR box (the intended
// deploy) and degrades to null elsewhere. Secondary/confirmation trigger: the
// market-list diff (fires later, when trading actually opens).

import { notifyNow } from "./telegram";
import { loadSection, saveSection } from "./persist";
import { primeUpbitMarkets } from "./exchanges";

const ANN_POLL_MS = 2500; // announcements are a sub-second race — poll tight

// ── 스크레이핑 소스 방어 (공지·TG) ────────────────────────────────────────────
// 이 둘은 공식 API가 아니라 웹 엔드포인트다 — 문서화된 한도가 없고, Cloudflare/
// 텔레그램의 봇 감지가 지키고 있다. KR IP여도 예외가 아니다. 두 가지가 차단을
// 부른다: ① 로봇처럼 정확한 고정 주기 ② 챌린지를 받고도 같은 속도로 계속 두드리기
// (일시 챌린지가 장기 IP 차단으로 승격되는 전형적 경로).
// → 주기에 ±30% 지터를 섞고, 차단·429를 만나면 지수 백오프(최대 10분) 후 복귀한다.
// 공지가 막혀도 마켓 diff(공식 시세 API, 문서화된 한도 내)가 감지를 백업한다.
const SCRAPE_BACKOFF_MAX_MS = 10 * 60_000;
const jittered = (ms: number) => ms * (0.7 + Math.random() * 0.6);

/** 실패 시 4배 지수 백오프, 성공 시 리셋. 반환값 = 다음 폴까지 대기(ms). */
function nextScrapeDelay(baseMs: number, backoff: { ms: number }, blocked: boolean): number {
  if (blocked) {
    backoff.ms = Math.min(SCRAPE_BACKOFF_MAX_MS, (backoff.ms || baseMs) * 4);
    return jittered(backoff.ms);
  }
  backoff.ms = 0;
  return jittered(baseMs);
}
const MKT_POLL_MS = 3000;
const FRESH_MS = 60 * 60_000; // keep a play visible for 1h

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";
const ANN_HEADERS = { "User-Agent": UA, "Accept": "application/json", "Referer": "https://upbit.com/service_center/notice" };

// Titles that mean a NEW asset is being listed (not events/maintenance).
const LISTING_RE = /(디지털\s*자산\s*추가|마켓\s*추가|거래지원|신규\s*상장|KRW\s*마켓|원화\s*마켓)/;
// Ticker inside parens, e.g. "이름(ABC)" — uppercase 2–10 chars.
const TICKER_RE = /\(([A-Z0-9]{2,10})\)/g;

export type ListingBuy = {
  where: string; // "binance" | "okx" | ... | "dex:ethereum"
  usd: number;
  qty: number | null; // filled qty when known
  price: number | null;
  ts: number;
  dry: boolean;
  tx?: string; // 온체인 tx (DEX 매수/매도)
};

export type ListingPlay = {
  base: string;
  venue: "upbit" | "bithumb";
  announcedAt: number; // notice time (or detection time)
  overseas: boolean; // on a global CEX → arbable front-run
  globalVenue?: string; // cheapest global venue that lists it
  globalPrice?: number; // price at announcement (baseline for peak tracking)
  opened: boolean; // market-diff confirmed trading is live
  openedAt?: number;
  /** 공지에서 파싱한 거래지원 개시 예정 시각 (KST 명시 텍스트 기반, best-effort). */
  opensAt?: number;
  openSoonAlerted?: boolean;
  /** 모의 드릴 플레이 — 히스토리 제외, 라이브 자동매수 금지. */
  drill?: boolean;
  title?: string;
  buys?: ListingBuy[]; // my entries (position tracking)
  sells?: ListingBuy[]; // my exits (same shape; usd = proceeds)
  peakPct?: number; // max % above announcement price seen so far
  peakAt?: number; // when the peak was seen
  surgeAlerted?: boolean; // hot-wallet inflow alert already sent
  /** 감지 타이밍(ms) — 이 제품의 승부처라 구간을 쪼개 기록한다.
   *  publishLagMs가 진짜 실력치(공지가 뜬 뒤 몇 ms 만에 봤나),
   *  나머지는 우리 코드가 쓴 시간이라 줄일 수 있는 몫이다. */
  detect?: DetectTiming;
};

export type DetectSource = "ann" | "market" | "tg";
export type DetectTiming = {
  at: number; // 감지 시각 (ms epoch)
  source: DetectSource;
  publishedAt?: number; // 공지 발행 시각 (API가 줄 때만)
  publishLagMs?: number; // at − publishedAt  ← 발행 후 우리가 본 시각까지
  pollLagMs?: number; // at − 폴 요청 시작  ← 이번 요청에 쓴 시간
  alertMs?: number; // 감지 → 텔레그램 발송
  autoBuyMs?: number; // 감지 → 자동매수 주문 전송
  venueLookupMs?: number; // 감지 → 해외 거래소 가격 확보
};

// ms 정밀도 로그 한 줄. pm2 로그에 그대로 남아 나중에 grep으로 집계할 수 있다.
function logDetect(base: string, d: DetectTiming, extra?: string) {
  const parts = [
    `src=${d.source}`,
    d.publishLagMs != null ? `publishLag=${d.publishLagMs}ms` : null,
    d.pollLagMs != null ? `pollLag=${d.pollLagMs}ms` : null,
    d.venueLookupMs != null ? `venue=${d.venueLookupMs}ms` : null,
    d.alertMs != null ? `alert=${d.alertMs}ms` : null,
    d.autoBuyMs != null ? `autoBuy=${d.autoBuyMs}ms` : null,
    extra,
  ].filter(Boolean);
  console.log(`[listing] ${new Date(d.at).toISOString()} ${base} ${parts.join(" ")}`);
}

/** 공지 객체에서 발행 시각을 찾아본다 — 업비트가 필드명을 바꿔도 견디게 후보를 넓게. */
function publishedAtOf(raw: Record<string, unknown>): number | undefined {
  for (const k of ["listed_at", "first_listed_at", "created_at", "published_at", "updated_at"]) {
    const v = raw[k];
    if (typeof v === "number" && v > 1e12) return v;
    if (typeof v === "string") {
      const t = Date.parse(v);
      if (Number.isFinite(t) && t > 0) return t;
    }
  }
  return undefined;
}

type State = {
  annSeen: Set<number>; // announcement ids already processed
  tgSeen: Set<number>; // telegram message hashes
  primedTg?: boolean;
  mkt: Partial<Record<"upbit" | "bithumb", Set<string>>>; // market-list baselines
  plays: Map<string, ListingPlay>; // base → play
  loops: ReturnType<typeof setInterval>[];
  primedAnn: boolean;
  primedMkt: boolean;
  /** Watcher health — last successful poll ts per source (0 = never). */
  srcOk: { ann: number; annBlocked: boolean; mkt: number; tg: number };
};
const g = globalThis as unknown as { __arbListings?: State };
g.__arbListings ??= { annSeen: new Set(), tgSeen: new Set(), mkt: {}, plays: new Map(loadSection<[string, ListingPlay][]>("listingPlays") ?? []), loops: [], primedAnn: false, primedMkt: false, srcOk: { ann: 0, annBlocked: false, mkt: 0, tg: 0 } };
g.__arbListings.srcOk ??= { ann: 0, annBlocked: false, mkt: 0, tg: 0 }; // hot-reload of older state shape
const L = g.__arbListings;

// Where is this coin cheapest to buy right now on a global CEX? Binance/Bybit/OKX.
// PARALLEL, not sequential: a fresh KR listing usually isn't on Binance spot, so
// probing in order cost 2-3 serial round-trips (~600ms typical, up to 9s) — and
// this sits directly in front of the listing alert AND the auto-buy. Preference
// order is preserved by picking the first venue in `tries` that answered.
export async function globalVenueFor(base: string): Promise<{ venue: string; price: number } | null> {
  const tries: [string, string][] = [
    ["binance", `https://api.binance.com/api/v3/ticker/price?symbol=${base}USDT`],
    ["bybit", `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${base}USDT`],
    ["okx", `https://www.okx.com/api/v5/market/ticker?instId=${base}-USDT`],
  ];
  // Fire all three at once, then take the first PREFERRED one that answers.
  // Awaiting them in priority order (rather than Promise.all) means a coin that
  // is on Binance returns as soon as Binance replies — waiting for all three
  // made the common case slower than the old serial version.
  const inflight = tries.map(async ([venue, url]) => {
    try {
      const j = await (await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(3000) })).json();
      const px = venue === "binance" ? Number(j.price)
        : venue === "bybit" ? Number(j.result?.list?.[0]?.lastPrice)
        : Number(j.data?.[0]?.last);
      return px > 0 ? { venue, price: px } : null;
    } catch {
      return null;
    }
  });
  for (const p of inflight) {
    const r = await p; // already in flight — no extra round-trip
    if (r) return r;
  }
  return null;
}

// ── 자동매수 프리셋 (공지 감지 즉시) ──────────────────────────────────────────
// UI에서 켜짐; 서버가 공지 등록 직후 바로 산다. 라이브 실행은 env
// LISTING_AUTO_LIVE=true 를 추가로 요구 (무인 자금 집행은 이중 옵트인).
export type ListingAutoCfg = { armed: boolean; sizeUsd: number };
export function getListingAuto(): ListingAutoCfg {
  const saved = loadSection<ListingAutoCfg>("listingAuto");
  return { armed: saved?.armed ?? false, sizeUsd: saved?.sizeUsd ?? Number(process.env.LISTING_BUY_USD ?? 500) };
}
export function setListingAuto(cfg: Partial<ListingAutoCfg>): ListingAutoCfg {
  const cur = getListingAuto();
  const next = {
    armed: typeof cfg.armed === "boolean" ? cfg.armed : cur.armed,
    sizeUsd: typeof cfg.sizeUsd === "number" && cfg.sizeUsd > 0 ? cfg.sizeUsd : cur.sizeUsd,
  };
  saveSection("listingAuto", next);
  return next;
}

// 자동매수 세이프티 가드 — 저유동성/기펌핑은 무인 집행하지 않는다 (수동은 자유).
const AUTO_MIN_MCAP_USD = Number(process.env.LISTING_AUTO_MIN_MCAP ?? 10_000_000);
const AUTO_MAX_PUMP_PCT = Number(process.env.LISTING_AUTO_MAX_PUMP ?? 50);

async function autoBuy(base: string, gVenue: string, gPrice: number) {
  const cfg = getListingAuto();
  if (!cfg.armed) return;
  const { CONFIG } = await import("./config");
  if (!CONFIG.DRY_RUN && process.env.LISTING_AUTO_LIVE !== "true") {
    void notifyNow(`⏸ 자동매수 보류 — <b>${base}</b>: 라이브인데 LISTING_AUTO_LIVE 미설정 (수동 승인 필요)`);
    return;
  }
  const { isKilled } = await import("./killswitch");
  const { checkEntry } = await import("./risk");
  if (isKilled()) return;
  const risk = checkEntry(cfg.sizeUsd);
  if (risk) { void notifyNow(`⏸ 자동매수 차단 — <b>${base}</b>: ${risk}`); return; }
  // 메타 가드 — CoinGecko가 모르는 코인/저시총/이미 급등은 무인 매수 스킵 (fail-closed).
  try {
    const { resolveToken } = await import("./tokenResolve");
    const t = await resolveToken(base);
    if (!t) { void notifyNow(`⏸ 자동매수 스킵 — <b>${base}</b>: 토큰 메타 미확인 (CoinGecko 미등록) — 수동 판단 필요`); return; }
    if (t.marketCapUsd != null && t.marketCapUsd < AUTO_MIN_MCAP_USD) {
      void notifyNow(`⏸ 자동매수 스킵 — <b>${base}</b>: 시총 $${(t.marketCapUsd / 1e6).toFixed(1)}M < 하한 $${(AUTO_MIN_MCAP_USD / 1e6).toFixed(0)}M (저유동성)`);
      return;
    }
    if (t.priceChange24hPct != null && t.priceChange24hPct > AUTO_MAX_PUMP_PCT) {
      void notifyNow(`⏸ 자동매수 스킵 — <b>${base}</b>: 24h +${t.priceChange24hPct.toFixed(0)}% 기펌핑 (정보 선반영 의심) — 추격 금지`);
      return;
    }
  } catch { /* resolve 오류 → 아래 주문은 진행하지 않음 */ return; }
  const { binanceSpot, bybitOrder, okxOrder } = await import("./orders");
  const r =
    gVenue === "binance" ? await binanceSpot(base, "BUY", { quoteUsd: cfg.sizeUsd })
    : gVenue === "bybit" ? await bybitOrder(base, "BUY", { quoteUsd: cfg.sizeUsd })
    : await okxOrder(base, "BUY", { quoteUsd: cfg.sizeUsd });
  if (r.ok) {
    recordListingBuy(base, {
      where: gVenue, usd: cfg.sizeUsd, qty: r.filledQty ?? null,
      price: r.filledQty ? cfg.sizeUsd / r.filledQty : gPrice, ts: Date.now(), dry: !!r.dryRun,
    });
  }
  void notifyNow(`${r.ok ? "🤖✅" : "🤖✗"} 자동매수 — <b>${base}</b> $${cfg.sizeUsd} @ ${gVenue} ${r.dryRun ? "(모의)" : ""}\n${r.message ?? ""}`);
}

// ── 개장 예정 시각 파싱 (공지/TG 텍스트, KST) ─────────────────────────────────
// "2026-07-19 18:00", "7월 19일 18:00", "7월 19일 오후 6시" 패턴 대응.
export function parseOpenTimeKst(text: string): number | null {
  const now = Date.now();
  const mk = (y: number, mo: number, d: number, h: number, mi: number) =>
    Date.UTC(y, mo - 1, d, h - 9, mi); // KST → UTC
  let m = /(\d{4})[.\-/년]\s*(\d{1,2})[.\-/월]\s*(\d{1,2})일?[^0-9]{0,8}(\d{1,2}):(\d{2})/.exec(text);
  if (m) return mk(+m[1], +m[2], +m[3], +m[4], +m[5]);
  m = /(\d{1,2})월\s*(\d{1,2})일[^0-9]{0,10}(오전|오후)?\s*(\d{1,2})(?::(\d{2})|시)/.exec(text);
  if (m) {
    const y = new Date(now).getUTCFullYear();
    let h = +m[4];
    if (m[3] === "오후" && h < 12) h += 12;
    let ts = mk(y, +m[1], +m[2], h, +(m[5] ?? 0));
    if (ts < now - 12 * 3600_000) ts = mk(y + 1, +m[1], +m[2], h, +(m[5] ?? 0)); // 연말 걸침
    return ts;
  }
  return null;
}

// Notice body (KR IP only) — 개장 시각은 보통 본문에 있다. Best-effort.
async function fetchNoticeOpensAt(noticeId: number): Promise<number | null> {
  try {
    const r = await fetch(`https://api-manager.upbit.com/api/v1/announcements/${noticeId}?os=web`, {
      headers: ANN_HEADERS, cache: "no-store", signal: AbortSignal.timeout(4000),
    });
    if (!(r.headers.get("content-type") ?? "").includes("json")) return null;
    const j = await r.json() as { data?: { content?: string } };
    const text = (j.data?.content ?? "").replace(/<[^>]+>/g, " ");
    return text ? parseOpenTimeKst(text) : null;
  } catch { return null; }
}

/** Dedupe sets only ever grew (one entry per announcement / telegram message,
 *  forever). Insertion order is chronological, so keeping the newest N is enough
 *  to stop re-processing anything we'd still see in a poll window. */
const SEEN_MAX = 400;
function trimSeen(s: Set<number>): void {
  if (s.size <= SEEN_MAX) return;
  const drop = s.size - SEEN_MAX;
  let i = 0;
  for (const v of s) {
    if (i++ >= drop) break;
    s.delete(v);
  }
}

/** Fill in the open time once the notice body has been read — the alert and the
 *  auto-buy already went out without waiting for it. */
function patchPlayOpensAt(base: string, opensAt: number) {
  const p = L.plays.get(base);
  if (!p || p.opensAt) return;
  p.opensAt = opensAt;
  saveSection("listingPlays", [...L.plays.entries()]);
}

// In-flight registration claims. `registerPlay` reads `L.plays`, then AWAITS
// globalVenueFor (up to 3s of HTTP) before writing — and callers fire it
// un-awaited in a loop, plus the Telegram poller does the same on a 3s timer. Two
// notices naming the same ticker inside that window both saw "no existing play"
// and each fired a live market buy. Claim the base synchronously.
const claiming = new Set<string>();

async function registerPlay(
  base: string, venue: "upbit" | "bithumb", title: string | undefined, fromAnnouncement: boolean,
  opts?: { opensAt?: number | null; drill?: boolean; detect?: DetectTiming },
) {
  if (claiming.has(base)) return; // another registration for this base is mid-flight
  claiming.add(base);
  try {
    return await registerPlayInner(base, venue, title, fromAnnouncement, opts);
  } finally {
    claiming.delete(base);
  }
}

async function registerPlayInner(
  base: string, venue: "upbit" | "bithumb", title: string | undefined, fromAnnouncement: boolean,
  opts?: { opensAt?: number | null; drill?: boolean; detect?: DetectTiming },
) {
  const existing = L.plays.get(base);
  if (existing && fromAnnouncement) {
    // 공지 재감지 — 개장 시각만 보강.
    if (opts?.opensAt && !existing.opensAt) { existing.opensAt = opts.opensAt; saveSection("listingPlays", [...L.plays.entries()]); }
    return;
  }
  const detect = opts?.detect;
  const g2 = await globalVenueFor(base);
  if (detect) detect.venueLookupMs = Date.now() - detect.at;
  const play: ListingPlay = {
    base, venue, announcedAt: existing?.announcedAt ?? detect?.at ?? Date.now(),
    overseas: !!g2, globalVenue: g2?.venue, globalPrice: g2?.price,
    opened: existing?.opened ?? false, title,
    opensAt: opts?.opensAt ?? existing?.opensAt, drill: opts?.drill,
    buys: existing?.buys, sells: existing?.sells,
    detect: detect ?? existing?.detect,
  };
  L.plays.set(base, play);
  saveSection("listingPlays", [...L.plays.entries()]);
  // 경로 DB 프리워밍. 감지 직후 몇 초 안에 패널을 열게 되는데, 그때 컨트랙트·풀을
  // 처음부터 캐면 그 왕복이 그대로 대기 시간이 된다. 여기서 미리 채워두면 패널은
  // 첫 페인트에 차트까지 뜬다. **await 하지 않는다** — 알림·자동매수 경로(~370ms)에
  // 단 1ms도 얹으면 안 된다.
  void import("./tokenRoutes").then((m) => m.ensureRoute(base)).catch(() => {});
  // 드릴은 라이브에서 자동매수 금지 (DRY에선 전체 플로우 리허설).
  const { CONFIG } = await import("./config");
  if (fromAnnouncement && g2 && (!opts?.drill || CONFIG.DRY_RUN)) {
    if (detect) detect.autoBuyMs = Date.now() - detect.at;
    void autoBuy(base, g2.venue, g2.price);
  }
  const head = fromAnnouncement ? "📢 상장 공지" : "🚨 거래 개시";
  if (detect) detect.alertMs = Date.now() - detect.at;
  void notifyNow(
    `${head} — <b>${base}</b> (${venue === "upbit" ? "업비트" : "빗썸"})\n` +
    (g2
      ? `해외 매수 지금: <b>${g2.venue}</b> @ ${g2.price}\n${fromAnnouncement ? "→ 거래개시 전 선점 · 김프 스파이크 대비" : "→ 거래 개시됨(늦음)"}`
      : "해외 미상장 → 상장 펌핑만 (김프 아님)"),
  );
  if (detect) {
    logDetect(base, detect, `reacted(감지→알림)`);
    saveSection("listingPlays", [...L.plays.entries()]); // 채워진 구간 persist
  }
  // Follow-up: on-chain exchange holdings (dump-supply signal). Fire-and-forget
  // so the primary alert is never delayed by RPC/CoinGecko.
  if (fromAnnouncement) {
    void (async () => {
      try {
        const { fetchHoldings, holdingsSummaryText } = await import("./holdings");
        const h = await fetchHoldings(base);
        if (!("error" in h)) void notifyNow(`📊 <b>${base}</b> ${holdingsSummaryText(h)}`);
      } catch { /* signal is best-effort */ }
    })();
  }
}

// ── Announcement poll (primary) ───────────────────────────────────────────────
async function pollAnnouncements() {
  let items: { id: number; title: string; publishedAt?: number }[] = [];
  // Stamp BEFORE the request: `at − pollT0` is time this poll cycle cost us,
  // which is the part we can actually shrink (vs the publish lag we can't).
  const pollT0 = Date.now();
  try {
    const r = await fetch("https://api-manager.upbit.com/api/v1/announcements?os=web&page=1&per_page=20&category=trade", {
      headers: ANN_HEADERS, cache: "no-store", signal: AbortSignal.timeout(4000),
    });
    const ct = r.headers.get("content-type") ?? "";
    if (!ct.includes("json")) { L.srcOk.annBlocked = true; return; } // Cloudflare HTML challenge (non-KR IP)
    L.srcOk.annBlocked = false;
    L.srcOk.ann = Date.now();
    const j = await r.json();
    const list = j?.data?.notices ?? j?.data?.list ?? j?.data ?? [];
    items = (Array.isArray(list) ? list : [])
      .map((x: Record<string, unknown>) => ({
        id: x.id as number, title: x.title as string, publishedAt: publishedAtOf(x),
      }))
      .filter((x) => x.id && x.title);
  } catch { return; }
  if (!items.length) return;

  const isFirst = !L.primedAnn;
  for (const it of items) {
    if (L.annSeen.has(it.id)) continue;
    L.annSeen.add(it.id);
    trimSeen(L.annSeen);
    if (isFirst) continue; // prime the baseline silently
    if (!LISTING_RE.test(it.title)) continue;
    const tickers = new Set<string>();
    let m: RegExpExecArray | null;
    TICKER_RE.lastIndex = 0;
    while ((m = TICKER_RE.exec(it.title))) tickers.add(m[1]);
    if (!tickers.size) continue;
    // 개장 시각: 제목에 있으면 즉시 사용. 없으면 본문 조회를 기다리지 않고
    // 먼저 등록·알림·자동매수를 보낸 뒤, 조회 결과가 오면 패치한다.
    // (기존 주석은 "알림을 막지 않게 비동기"라 했지만 실제로는 폴링 루프만
    // 풀어줬고, registerPlay 자체가 본문 HTTP 조회 뒤에 호출돼 알림과 자동매수가
    // 최대 4초 늦었다 — 여기가 이 제품의 승부처다.)
    const titleOpensAt = parseOpenTimeKst(it.title);
    const at = Date.now();
    const detect: DetectTiming = {
      at, source: "ann", publishedAt: it.publishedAt,
      publishLagMs: it.publishedAt ? at - it.publishedAt : undefined,
      pollLagMs: at - pollT0,
    };
    // Log the DETECTION immediately — before any downstream work — so the
    // timestamp is the moment we knew, not the moment we finished reacting.
    logDetect([...tickers].join(","), detect, `notice=${it.id} "${it.title.slice(0, 40)}"`);
    if (detect.publishLagMs != null) recordAnnLag(detect.publishLagMs);
    for (const t of tickers) void registerPlay(t, "upbit", it.title, true, { opensAt: titleOpensAt, detect });
    if (titleOpensAt == null) {
      const noticeId = it.id;
      const bases = [...tickers];
      void (async () => {
        const opensAt = await fetchNoticeOpensAt(noticeId);
        if (opensAt == null) return;
        for (const t of bases) patchPlayOpensAt(t, opensAt);
      })();
    }
  }
  L.primedAnn = true;
}

// ── Market-list diff (confirmation: trading opened) ───────────────────────────
async function upbitMarkets(): Promise<Set<string>> {
  try {
    const j = (await (await fetch("https://api.upbit.com/v1/market/all", { cache: "no-store", signal: AbortSignal.timeout(4000) })).json()) as Array<{ market: string }>;
    return new Set(j.filter((m) => m.market.startsWith("KRW-")).map((m) => m.market.slice(4)));
  } catch { return new Set(); }
}
async function bithumbMarkets(): Promise<Set<string>> {
  try {
    const j = (await (await fetch("https://api.bithumb.com/public/ticker/ALL_KRW", { cache: "no-store", signal: AbortSignal.timeout(4000) })).json()) as { status: string; data?: Record<string, unknown> };
    if (j.status !== "0000" || !j.data) return new Set();
    return new Set(Object.keys(j.data).filter((k) => k !== "date"));
  } catch { return new Set(); }
}

function diffMarkets(venue: "upbit" | "bithumb", now: Set<string>) {
  const prev = L.mkt[venue];
  if (prev && L.primedMkt) {
    for (const base of now) {
      if (!prev.has(base)) {
        const at = Date.now();
        const play = L.plays.get(base);
        if (play) {
          play.opened = true;
          play.openedAt = at;
          // 공지 감지 → 실제 거래 개시까지 걸린 시간. 선점 창이 얼마였는지 = 이 값.
          const lead = play.detect?.at ? at - play.detect.at : null;
          console.log(`[listing] ${new Date(at).toISOString()} ${base} src=market OPENED${lead != null ? ` leadFromDetect=${lead}ms` : ""}`);
        } else {
          logDetect(base, { at, source: "market" }, "공지 미감지 → 마켓 diff로 최초 인지(늦음)");
          void registerPlay(base, venue, undefined, false, { detect: { at, source: "market" } });
        }
      }
    }
  }
  L.mkt[venue] = now;
}

async function pollMarkets() {
  const [up, bt] = await Promise.all([upbitMarkets(), bithumbMarkets()]);
  if (up.size === 0 && bt.size === 0) return;
  L.srcOk.mkt = Date.now();
  // Share this poll with the scanner instead of both loops fetching the same
  // ~61KB market/all every 3s (it was the single biggest item on the scan tick).
  if (up.size > 0) primeUpbitMarkets([...up]);
  if (up.size > 0) diffMarkets("upbit", up);
  if (bt.size > 0) diffMarkets("bithumb", bt);
  L.primedMkt = true;
  const cutoff = Date.now() - FRESH_MS;
  let expired = false;
  for (const [b, p] of L.plays) {
    if (p.announcedAt < cutoff) {
      archivePlay(p); // 만료 → 성과 히스토리로 (드릴 제외)
      L.plays.delete(b);
      forgetKrDeposit(b); // 시계열도 함께 정리 (영구 누적 방지)
      expired = true;
    }
  }
  // 메모리에서만 지우면 디스크엔 그대로 남는다 → 재시작할 때마다 다시 하이드레이트돼
  // 다시 만료되고 **히스토리에 같은 건이 한 번 더 쌓인다**(실제로 MORPHO가 3개
  // 찍혔다 — 재시작 3회). 지운 사실도 저장해야 지운 것이다.
  if (expired) saveSection("listingPlays", [...L.plays.entries()]);
}

// ── 성과 히스토리 — 만료된 플레이를 요약해 영구 보관 (기대값 캘리브레이션) ──────
export type ListingHistoryRow = {
  base: string; venue: string; announcedAt: number;
  openedAt: number | null; opensAt: number | null;
  peakPct: number | null; peakAfterMin: number | null; // 공지 → 피크까지 분
  buys: number; buyUsd: number; realizedUsd: number | null; // 실거래만 (dry 제외)
};
function archivePlay(p: ListingPlay) {
  if (p.drill) return;
  if (!p.overseas && !(p.buys?.length) && p.peakPct == null) return; // 정보가 없는 껍데기
  const hist = loadSection<ListingHistoryRow[]>("listingHistory") ?? [];
  // 같은 공지는 한 줄이다. 보관 경로가 하나뿐이어도 이 가드를 둔다 — 히스토리는
  // 기대값 캘리브레이션의 근거라, 중복 한 건이 곧 통계 왜곡이다.
  if (hist.some((h) => h.base === p.base && h.announcedAt === p.announcedAt)) return;
  const realBuys = (p.buys ?? []).filter((b) => !b.dry);
  const realSells = (p.sells ?? []).filter((s) => !s.dry);
  hist.unshift({
    base: p.base, venue: p.venue, announcedAt: p.announcedAt,
    openedAt: p.openedAt ?? null, opensAt: p.opensAt ?? null,
    peakPct: p.peakPct ?? null,
    peakAfterMin: p.peakAt != null ? Math.round((p.peakAt - p.announcedAt) / 60_000) : null,
    buys: (p.buys ?? []).length,
    buyUsd: (p.buys ?? []).reduce((s, b) => s + b.usd, 0),
    realizedUsd: realBuys.length && realSells.length
      ? realSells.reduce((s, x) => s + x.usd, 0) - realBuys.reduce((s, x) => s + x.usd, 0)
      : null,
  });
  saveSection("listingHistory", hist.slice(0, 100));
}
export function listingHistory(): ListingHistoryRow[] {
  return loadSection<ListingHistoryRow[]>("listingHistory") ?? [];
}

/** 모의 상장 드릴 — 가짜 공지를 주입해 전체 플로우(알림→카드→매수)를 리허설. */
export async function startDrill(base: string): Promise<void> {
  L.plays.delete(base); // 재드릴 허용
  void notifyNow(`🥁 [드릴] 상장 공지 시뮬 — <b>${base}</b> (업비트) · 실제 상장 아님`);
  // 드릴도 감지 타이밍 경로를 그대로 태운다 — 리허설의 목적이 "실제와 같은 흐름"이고,
  // 반응 구간(거래소 탐색·알림·자동매수)이 몇 ms인지 여기서 미리 볼 수 있어야 한다.
  const at = Date.now();
  await registerPlay(base, "upbit", `[드릴] ${base} KRW 마켓 디지털 자산 추가 (모의)`, true, {
    drill: true, opensAt: at + 10 * 60_000, // 10분 뒤 개장 가정 → 카운트다운 리허설
    detect: { at, source: "ann" },
  });
}

// ── 활성 플레이 추적 (60s): 피크 수익률 + 핫월렛 급증 알림 ─────────────────────
const TRACK_MS = 60_000;
const SURGE_USD_PER_MIN = Number(process.env.LISTING_SURGE_USD_MIN ?? 25_000);

async function trackPlays() {
  const now = Date.now();
  const active = [...L.plays.values()].filter((p) => now - p.announcedAt <= 2 * 3600_000);
  if (!active.length) return;
  // Plays are tracked in PARALLEL. Serially, each one awaited globalVenueFor
  // (up to 3 probes) plus a multi-chain holdings fetch, so during an actual
  // listing event — several active plays, exactly when hot-wallet surge alerts
  // matter most — the 60s tracker could overrun its own interval and the alerts
  // arrived late.
  const { fetchHoldings } = await import("./holdings");
  await Promise.all(active.map(async (p) => {
    // Peak vs announcement price (성과 히스토리 데이터).
    if (p.overseas && p.globalPrice && p.globalPrice > 0) {
      const g2 = await globalVenueFor(p.base).catch(() => null);
      if (g2 && g2.price > 0) {
        const pct = ((g2.price - p.globalPrice) / p.globalPrice) * 100;
        if (p.peakPct == null || pct > p.peakPct) { p.peakPct = pct; p.peakAt = now; }
      }
    }
    // 개장 임박 알림 (T−5분 이내, 1회).
    if (p.opensAt && !p.openSoonAlerted && p.opensAt > now && p.opensAt - now <= 5 * 60_000) {
      p.openSoonAlerted = true;
      void notifyNow(`⏰ <b>${p.base}</b> ${p.venue === "upbit" ? "업비트" : "빗썸"} 개장 임박 — T−${Math.ceil((p.opensAt - now) / 60_000)}분. 매도 준비.`);
    }
    // Hot-wallet inflow surge + 개장 전 KR 입금 물량 시계열 — 같은 holdings
    // 조회를 공유한다 (60s 캐시라 추가 비용 없음).
    try {
      const h = await fetchHoldings(p.base);
      if (!("error" in h) && h.priceUsd) {
        if (!p.surgeAlerted) {
          const surge = h.venues.find((v) => v.hotDeltaPerMin != null && v.hotDeltaPerMin * h.priceUsd! > SURGE_USD_PER_MIN);
          if (surge) {
            p.surgeAlerted = true;
            void notifyNow(`🌊 <b>${p.base}</b> ${surge.venue} 핫월렛 급증 +$${Math.round(surge.hotDeltaPerMin! * h.priceUsd / 1000)}K/분 — 덤핑 물량 유입 중`);
          }
        }
        recordKrDeposit(p.base, p.venue, h);
      }
    } catch { /* best-effort */ }
  }));
  saveSection("listingPlays", [...L.plays.entries()]);
}

// ── 개장 전 KR 입금 물량 워치 ─────────────────────────────────────────────────
// 등록된 업비트/빗썸 지갑의 해당 코인 잔고를 60초마다 스냅샷 — "발표→개장
// 사이 들어온 물량 = 개장 직후 나올 수 있는 매도 재고"의 시계열. 첫 유의미
// 입금($1K+)은 텔레그램으로 즉시 알린다.
type KrDepositStore = Record<string, { pts: { ts: number; up: number; bt: number }[]; alerted: { upbit?: boolean; bithumb?: boolean } }>;
const KR_DEPOSIT_MIN_USD = 1_000;

function krDepositStore(): KrDepositStore {
  const gk = globalThis as unknown as { __arbKrDeposits?: KrDepositStore };
  gk.__arbKrDeposits ??= loadSection<KrDepositStore>("krDeposits") ?? {};
  return gk.__arbKrDeposits;
}

function recordKrDeposit(base: string, listVenue: "upbit" | "bithumb", h: { priceUsd: number | null; venues: { venue: string; hot: number; cold: number }[] }): void {
  const px = h.priceUsd ?? 0;
  const usdOf = (v?: { hot: number; cold: number }) => (v ? (v.hot + v.cold) * px : 0);
  const up = usdOf(h.venues.find((v) => v.venue === "upbit"));
  const bt = usdOf(h.venues.find((v) => v.venue === "bithumb"));
  const store = krDepositStore();
  const rec = (store[base] ??= { pts: [], alerted: {} });
  rec.pts.push({ ts: Date.now(), up, bt });
  if (rec.pts.length > 240) rec.pts = rec.pts.slice(-240); // 4시간
  // 첫 유의미 입금 알림 — 상장 거래소 우선, 양쪽 다 감시.
  for (const [venue, usd] of [["upbit", up], ["bithumb", bt]] as const) {
    if (usd >= KR_DEPOSIT_MIN_USD && !rec.alerted[venue]) {
      rec.alerted[venue] = true;
      const star = venue === listVenue ? " ★상장 거래소" : "";
      void notifyNow(`📥 <b>${base}</b> ${venue === "upbit" ? "업비트" : "빗썸"}${star} 입금 감지 — 잔고 $${(usd / 1000).toFixed(1)}K. 개장 전 물량 유입 시작.`);
    }
  }
  saveSection("krDeposits", store);
}

/** 상세 패널용 — 코인의 개장 전 입금 시계열. */
export function krDeposits(base: string): { pts: { ts: number; up: number; bt: number }[] } {
  return { pts: krDepositStore()[base]?.pts ?? [] };
}

/** Drop a coin's deposit series when its play is archived. Entries were keyed by
 *  base and never deleted, so one accumulated per coin ever tracked — and every
 *  one of them was re-serialized into the persisted state. */
function forgetKrDeposit(base: string): void {
  const store = krDepositStore();
  if (!(base in store)) return;
  delete store[base];
  saveSection("krDeposits", store);
}

// ── Telegram public-channel scrape (CF-free fallback) ─────────────────────────
// t.me/s/<channel> is Telegram's own public web view — no Cloudflare, no KR-IP
// requirement, works from anywhere. Point LISTING_TG_CHANNEL at the channel you
// trust (Upbit official or a fast listing-alert channel); empty = disabled.
// Verified mechanism: message texts live in .tgme_widget_message_text blocks.
const TG_POLL_MS = 3000;

async function pollTgChannel() {
  // Comma-separated list — e.g. an Upbit alert channel + a Bithumb one.
  const channels = (process.env.LISTING_TG_CHANNEL ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!channels.length) return;
  let any = false;
  for (const channel of channels) {
    const tgT0 = Date.now(); // 이 채널 요청에 쓴 시간 (감지 지연의 우리 몫)
    let html = "";
    try {
      const r = await fetch(`https://t.me/s/${channel}`, { cache: "no-store", signal: AbortSignal.timeout(5000), redirect: "follow" });
      html = await r.text();
    } catch { continue; }
    const texts = [...html.matchAll(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g)]
      .map((m) => m[1].replace(/<br\s*\/?\s*>/g, " ").replace(/<[^>]+>/g, "").trim())
      .slice(-20);
    if (!texts.length) continue;
    any = true;
    const isFirst = !L.primedTg;
    for (const t of texts) {
      // Hash the message so each is processed once.
      let h = 0;
      for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
      if (L.tgSeen.has(h)) continue;
      L.tgSeen.add(h);
      trimSeen(L.tgSeen);
      if (isFirst) continue; // baseline silently
      if (!LISTING_RE.test(t)) continue;
      // Which KR venue is this notice about? (alert channels cover both)
      const krVenue: "upbit" | "bithumb" = /빗썸|bithumb/i.test(t) ? "bithumb" : "upbit";
      const tickers = new Set<string>();
      let m: RegExpExecArray | null;
      TICKER_RE.lastIndex = 0;
      while ((m = TICKER_RE.exec(t))) tickers.add(m[1]);
      const opensAt = parseOpenTimeKst(t);
      const at = Date.now();
      const detect: DetectTiming = { at, source: "tg", pollLagMs: at - tgT0 };
      logDetect([...tickers].join(","), detect, `tg "${t.slice(0, 40)}"`);
      for (const tk of tickers) void registerPlay(tk, krVenue, t.slice(0, 80), true, { opensAt, detect });
    }
  }
  if (any) { L.srcOk.tg = Date.now(); L.primedTg = true; }
}

/** Start all watchers (idempotent; re-armed on hot reload). */
export function startListingWatch(): void {
  for (const l of L.loops) clearInterval(l);
  L.loops = [];
  void pollAnnouncements(); void pollMarkets(); void pollTgChannel();
  // 공지·TG는 setInterval이 아니라 자기 재스케줄 — 차단 시 백오프 간격이
  // 다음 폴에 반영돼야 하는데 고정 인터벌로는 불가능하다.
  const annBackoff = { ms: 0 };
  const annLoop = () => {
    const t = setTimeout(async () => {
      await pollAnnouncements().catch(() => { L.srcOk.annBlocked = true; });
      L.loops[annSlot] = annLoop();
    }, nextScrapeDelay(ANN_POLL_MS, annBackoff, L.srcOk.annBlocked));
    return t;
  };
  const tgBackoff = { ms: 0 };
  const tgLoop = () => {
    const t = setTimeout(async () => {
      await pollTgChannel().catch(() => {});
      L.loops[tgSlot] = tgLoop();
      // TG는 blocked 플래그가 없다 — "채널이 설정됐고 한때 수신했는데 1분 넘게
      // 끊김"을 차단 신호로 쓴다 (미설정·초기 상태는 백오프 대상이 아니다).
    }, nextScrapeDelay(TG_POLL_MS, tgBackoff, !!process.env.LISTING_TG_CHANNEL && L.primedTg === true && Date.now() - L.srcOk.tg > 60_000));
    return t;
  };
  const annSlot = L.loops.push(annLoop()) - 1;
  const tgSlot = L.loops.push(tgLoop()) - 1;
  L.loops.push(setInterval(() => void pollMarkets(), MKT_POLL_MS));
  L.loops.push(setInterval(() => void trackPlays(), TRACK_MS)); // 피크·급증 추적
}

/** Is this base a fresh listing? (board badge/boost) */
export function listingInfo(base: string): { venue: string; ageSec: number; overseas: boolean; opened: boolean } | null {
  const p = L.plays.get(base);
  if (!p) return null;
  return { venue: p.venue, ageSec: Math.round((Date.now() - p.announcedAt) / 1000), overseas: p.overseas, opened: p.opened };
}

/** Recent listing plays, newest first (dashboard). */
export function recentListings(): ListingPlay[] {
  return [...L.plays.values()].sort((a, b) => b.announcedAt - a.announcedAt);
}

/** Record one of my entries on a play (position tracking). Creates the play if
 *  the buy came before any watcher registered it (manual ticker). */
export function recordListingBuy(base: string, buy: ListingBuy): void {
  let p = L.plays.get(base);
  if (!p) {
    p = { base, venue: "upbit", announcedAt: Date.now(), overseas: true, opened: false, title: "수동 등록" };
    L.plays.set(base, p);
  }
  (p.buys ??= []).push(buy);
  saveSection("listingPlays", [...L.plays.entries()]);
}

export function getPlay(base: string): ListingPlay | null {
  return L.plays.get(base) ?? null;
}

export function recordListingSell(base: string, sell: ListingBuy): void {
  const p = L.plays.get(base);
  if (!p) return;
  (p.sells ??= []).push(sell);
  saveSection("listingPlays", [...L.plays.entries()]);
}

// 공지 감지 지연 실측 (발행 → 우리가 본 시각, ms) — 최근 50건 롤링.
// 이 앱의 모트가 "빨리 잡는 것"인데, 그 지연이 숫자로 보이는 곳이 없었다.
function recordAnnLag(ms: number): void {
  try {
    const a = loadSection<number[]>("annLagMs") ?? [];
    a.push(Math.round(ms));
    while (a.length > 50) a.shift();
    saveSection("annLagMs", a);
  } catch { /* stats must never break the watch */ }
}

/** Watcher-source health for the listing dashboard. */
export function watchStatus() {
  const ago = (t: number) => (t ? Math.round((Date.now() - t) / 1000) : null);
  const lags = loadSection<number[]>("annLagMs") ?? [];
  const annLagP50Ms = lags.length ? [...lags].sort((a, b) => a - b)[Math.floor(lags.length / 2)] : null;
  return {
    annOkAgoSec: ago(L.srcOk.ann),
    annBlocked: L.srcOk.annBlocked,
    annLagP50Ms,
    mktOkAgoSec: ago(L.srcOk.mkt),
    tgConfigured: !!process.env.LISTING_TG_CHANNEL,
    tgChannel: process.env.LISTING_TG_CHANNEL ?? null,
    tgOkAgoSec: ago(L.srcOk.tg),
    plays: L.plays.size,
  };
}
