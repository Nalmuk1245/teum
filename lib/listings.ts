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

const ANN_POLL_MS = 2500; // announcements are a sub-second race — poll tight
const MKT_POLL_MS = 3000;
const FRESH_MS = 60 * 60_000; // keep a play visible for 1h

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";
const ANN_HEADERS = { "User-Agent": UA, "Accept": "application/json", "Referer": "https://upbit.com/service_center/notice" };

// Titles that mean a NEW asset is being listed (not events/maintenance).
const LISTING_RE = /(디지털\s*자산\s*추가|마켓\s*추가|거래지원|신규\s*상장|KRW\s*마켓|원화\s*마켓)/;
// Ticker inside parens, e.g. "이름(ABC)" — uppercase 2–10 chars.
const TICKER_RE = /\(([A-Z0-9]{2,10})\)/g;

export type ListingPlay = {
  base: string;
  venue: "upbit" | "bithumb";
  announcedAt: number; // notice time (or detection time)
  overseas: boolean; // on a global CEX → arbable front-run
  globalVenue?: string; // cheapest global venue that lists it
  globalPrice?: number;
  opened: boolean; // market-diff confirmed trading is live
  title?: string;
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
};
const g = globalThis as unknown as { __arbListings?: State };
g.__arbListings ??= { annSeen: new Set(), tgSeen: new Set(), mkt: {}, plays: new Map(), loops: [], primedAnn: false, primedMkt: false };
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

async function registerPlay(base: string, venue: "upbit" | "bithumb", title: string | undefined, fromAnnouncement: boolean) {
  const existing = L.plays.get(base);
  if (existing && fromAnnouncement) return; // announcement already registered it
  const g2 = await globalVenueFor(base);
  const play: ListingPlay = {
    base, venue, announcedAt: existing?.announcedAt ?? Date.now(),
    overseas: !!g2, globalVenue: g2?.venue, globalPrice: g2?.price,
    opened: existing?.opened ?? false, title,
  };
  L.plays.set(base, play);
  const head = fromAnnouncement ? "📢 상장 공지" : "🚨 거래 개시";
  void notifyNow(
    `${head} — <b>${base}</b> (${venue === "upbit" ? "업비트" : "빗썸"})\n` +
    (g2
      ? `해외 매수 지금: <b>${g2.venue}</b> @ ${g2.price}\n${fromAnnouncement ? "→ 거래개시 전 선점 · 김프 스파이크 대비" : "→ 거래 개시됨(늦음)"}`
      : "해외 미상장 → 상장 펌핑만 (김프 아님)"),
  );
}

// ── Announcement poll (primary) ───────────────────────────────────────────────
async function pollAnnouncements() {
  let items: { id: number; title: string }[] = [];
  try {
    const r = await fetch("https://api-manager.upbit.com/api/v1/announcements?os=web&page=1&per_page=20&category=trade", {
      headers: ANN_HEADERS, cache: "no-store", signal: AbortSignal.timeout(4000),
    });
    const ct = r.headers.get("content-type") ?? "";
    if (!ct.includes("json")) return; // Cloudflare HTML challenge (non-KR IP) — skip
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
async function pollMarkets() {
  const now = await upbitMarkets();
  if (now.size === 0) return;
  const prev = L.mkt.upbit;
  if (prev && L.primedMkt) {
    for (const base of now) {
      if (!prev.has(base)) {
        const play = L.plays.get(base);
        if (play) { play.opened = true; } // announcement play now trading — upgrade
        else void registerPlay(base, "upbit", undefined, false); // no notice seen (non-KR) → fallback
      }
    }
  }
  L.mkt.upbit = now;
  L.primedMkt = true;
  const cutoff = Date.now() - FRESH_MS;
  for (const [b, p] of L.plays) if (p.announcedAt < cutoff) L.plays.delete(b);
}

// ── Telegram public-channel scrape (CF-free fallback) ─────────────────────────
// t.me/s/<channel> is Telegram's own public web view — no Cloudflare, no KR-IP
// requirement, works from anywhere. Point LISTING_TG_CHANNEL at the channel you
// trust (Upbit official or a fast listing-alert channel); empty = disabled.
// Verified mechanism: message texts live in .tgme_widget_message_text blocks.
const TG_POLL_MS = 3000;

async function pollTgChannel() {
  const channel = process.env.LISTING_TG_CHANNEL;
  if (!channel) return;
  let html = "";
  try {
    const r = await fetch(`https://t.me/s/${channel}`, { cache: "no-store", signal: AbortSignal.timeout(5000), redirect: "follow" });
    html = await r.text();
  } catch { return; }
  const texts = [...html.matchAll(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g)]
    .map((m) => m[1].replace(/<br\s*\/?\s*>/g, " ").replace(/<[^>]+>/g, "").trim())
    .slice(-20);
  if (!texts.length) return;
  const isFirst = !L.primedTg;
  for (const t of texts) {
    // Hash the message so each is processed once.
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
    if (L.tgSeen.has(h)) continue;
    L.tgSeen.add(h);
    if (isFirst) continue; // baseline silently
    if (!LISTING_RE.test(t)) continue;
    const tickers = new Set<string>();
    let m: RegExpExecArray | null;
    TICKER_RE.lastIndex = 0;
    while ((m = TICKER_RE.exec(t))) tickers.add(m[1]);
    for (const tk of tickers) void registerPlay(tk, "upbit", t.slice(0, 80), true);
  }
  L.primedTg = true;
}

/** Start all watchers (idempotent; re-armed on hot reload). */
export function startListingWatch(): void {
  for (const l of L.loops) clearInterval(l);
  L.loops = [];
  void pollAnnouncements(); void pollMarkets(); void pollTgChannel();
  L.loops.push(setInterval(() => void pollAnnouncements(), ANN_POLL_MS));
  L.loops.push(setInterval(() => void pollMarkets(), MKT_POLL_MS));
  L.loops.push(setInterval(() => void pollTgChannel(), TG_POLL_MS));
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
