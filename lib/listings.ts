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

const ANN_POLL_MS = 2500; // announcements are a sub-second race — poll tight
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
  title?: string;
  buys?: ListingBuy[]; // my entries (position tracking)
  sells?: ListingBuy[]; // my exits (same shape; usd = proceeds)
  peakPct?: number; // max % above announcement price seen so far
  surgeAlerted?: boolean; // hot-wallet inflow alert already sent
};

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
export async function globalVenueFor(base: string): Promise<{ venue: string; price: number } | null> {
  const tries: [string, string][] = [
    ["binance", `https://api.binance.com/api/v3/ticker/price?symbol=${base}USDT`],
    ["bybit", `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${base}USDT`],
    ["okx", `https://www.okx.com/api/v5/market/ticker?instId=${base}-USDT`],
  ];
  for (const [venue, url] of tries) {
    try {
      const j = await (await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(3000) })).json();
      const px = venue === "binance" ? Number(j.price)
        : venue === "bybit" ? Number(j.result?.list?.[0]?.lastPrice)
        : Number(j.data?.[0]?.last);
      if (px > 0) return { venue, price: px };
    } catch { /* next */ }
  }
  return null;
}

// ── 자동매수 프리셋 (공지 감지 즉시) ──────────────────────────────────────────
// UI에서 무장; 서버가 공지 등록 직후 바로 산다. 라이브 실행은 env
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

async function registerPlay(base: string, venue: "upbit" | "bithumb", title: string | undefined, fromAnnouncement: boolean) {
  const existing = L.plays.get(base);
  if (existing && fromAnnouncement) return; // announcement already registered it
  const g2 = await globalVenueFor(base);
  const play: ListingPlay = {
    base, venue, announcedAt: existing?.announcedAt ?? Date.now(),
    overseas: !!g2, globalVenue: g2?.venue, globalPrice: g2?.price,
    opened: existing?.opened ?? false, title,
    buys: existing?.buys, sells: existing?.sells,
  };
  L.plays.set(base, play);
  saveSection("listingPlays", [...L.plays.entries()]);
  if (fromAnnouncement && g2) void autoBuy(base, g2.venue, g2.price);
  const head = fromAnnouncement ? "📢 상장 공지" : "🚨 거래 개시";
  void notifyNow(
    `${head} — <b>${base}</b> (${venue === "upbit" ? "업비트" : "빗썸"})\n` +
    (g2
      ? `해외 매수 지금: <b>${g2.venue}</b> @ ${g2.price}\n${fromAnnouncement ? "→ 거래개시 전 선점 · 김프 스파이크 대비" : "→ 거래 개시됨(늦음)"}`
      : "해외 미상장 → 상장 펌핑만 (김프 아님)"),
  );
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
  let items: { id: number; title: string }[] = [];
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
    items = (Array.isArray(list) ? list : []).map((x: { id: number; title: string }) => ({ id: x.id, title: x.title })).filter((x) => x.id && x.title);
  } catch { return; }
  if (!items.length) return;

  const isFirst = !L.primedAnn;
  for (const it of items) {
    if (L.annSeen.has(it.id)) continue;
    L.annSeen.add(it.id);
    if (isFirst) continue; // prime the baseline silently
    if (!LISTING_RE.test(it.title)) continue;
    const tickers = new Set<string>();
    let m: RegExpExecArray | null;
    TICKER_RE.lastIndex = 0;
    while ((m = TICKER_RE.exec(it.title))) tickers.add(m[1]);
    for (const t of tickers) void registerPlay(t, "upbit", it.title, true);
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
        const play = L.plays.get(base);
        if (play) { play.opened = true; play.openedAt = Date.now(); } // announcement play now trading
        else void registerPlay(base, venue, undefined, false); // no notice seen → fallback
      }
    }
  }
  L.mkt[venue] = now;
}

async function pollMarkets() {
  const [up, bt] = await Promise.all([upbitMarkets(), bithumbMarkets()]);
  if (up.size === 0 && bt.size === 0) return;
  L.srcOk.mkt = Date.now();
  if (up.size > 0) diffMarkets("upbit", up);
  if (bt.size > 0) diffMarkets("bithumb", bt);
  L.primedMkt = true;
  const cutoff = Date.now() - FRESH_MS;
  for (const [b, p] of L.plays) if (p.announcedAt < cutoff) L.plays.delete(b);
}

// ── 활성 플레이 추적 (60s): 피크 수익률 + 핫월렛 급증 알림 ─────────────────────
const TRACK_MS = 60_000;
const SURGE_USD_PER_MIN = Number(process.env.LISTING_SURGE_USD_MIN ?? 25_000);

async function trackPlays() {
  const now = Date.now();
  for (const p of L.plays.values()) {
    if (now - p.announcedAt > 2 * 3600_000) continue; // stale — stop tracking
    // Peak vs announcement price (성과 히스토리 데이터).
    if (p.overseas && p.globalPrice && p.globalPrice > 0) {
      const g2 = await globalVenueFor(p.base).catch(() => null);
      if (g2 && g2.price > 0) {
        const pct = ((g2.price - p.globalPrice) / p.globalPrice) * 100;
        if (p.peakPct == null || pct > p.peakPct) p.peakPct = pct;
      }
    }
    // Hot-wallet inflow surge — arb sellers loading KR exchanges ⇒ dump soon.
    if (!p.surgeAlerted) {
      try {
        const { fetchHoldings } = await import("./holdings");
        const h = await fetchHoldings(p.base);
        if (!("error" in h) && h.priceUsd) {
          const surge = h.venues.find((v) => v.hotDeltaPerMin != null && v.hotDeltaPerMin * h.priceUsd! > SURGE_USD_PER_MIN);
          if (surge) {
            p.surgeAlerted = true;
            void notifyNow(`🌊 <b>${p.base}</b> ${surge.venue} 핫월렛 급증 +$${Math.round(surge.hotDeltaPerMin! * h.priceUsd / 1000)}K/분 — 덤핑 물량 유입 중`);
          }
        }
      } catch { /* best-effort */ }
    }
  }
  saveSection("listingPlays", [...L.plays.entries()]);
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
      if (isFirst) continue; // baseline silently
      if (!LISTING_RE.test(t)) continue;
      // Which KR venue is this notice about? (alert channels cover both)
      const krVenue: "upbit" | "bithumb" = /빗썸|bithumb/i.test(t) ? "bithumb" : "upbit";
      const tickers = new Set<string>();
      let m: RegExpExecArray | null;
      TICKER_RE.lastIndex = 0;
      while ((m = TICKER_RE.exec(t))) tickers.add(m[1]);
      for (const tk of tickers) void registerPlay(tk, krVenue, t.slice(0, 80), true);
    }
  }
  if (any) { L.srcOk.tg = Date.now(); L.primedTg = true; }
}

/** Start all watchers (idempotent; re-armed on hot reload). */
export function startListingWatch(): void {
  for (const l of L.loops) clearInterval(l);
  L.loops = [];
  void pollAnnouncements(); void pollMarkets(); void pollTgChannel();
  L.loops.push(setInterval(() => void pollAnnouncements(), ANN_POLL_MS));
  L.loops.push(setInterval(() => void pollMarkets(), MKT_POLL_MS));
  L.loops.push(setInterval(() => void pollTgChannel(), TG_POLL_MS));
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

/** Watcher-source health for the listing dashboard. */
export function watchStatus() {
  const ago = (t: number) => (t ? Math.round((Date.now() - t) / 1000) : null);
  return {
    annOkAgoSec: ago(L.srcOk.ann),
    annBlocked: L.srcOk.annBlocked,
    mktOkAgoSec: ago(L.srcOk.mkt),
    tgConfigured: !!process.env.LISTING_TG_CHANNEL,
    tgChannel: process.env.LISTING_TG_CHANNEL ?? null,
    tgOkAgoSec: ago(L.srcOk.tg),
    plays: L.plays.size,
  };
}
