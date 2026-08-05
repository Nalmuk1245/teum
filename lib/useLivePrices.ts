"use client";

// Real-time gap overlay. The 8s /api/scan defines the opportunity universe +
// cost + transfer gates; this hook opens client-side WebSockets to Binance,
// Upbit and Bithumb and recomputes each kimchi opp's premium/net live (sub-second)
// on top of that. Runs in the browser only (WebSocket + useEffect).
//
// KR exchange WS (Upbit/Bithumb) work natively from a Korean IP — the intended
// deploy is a local personal PC in Korea, so no relay/geo-block concerns there.

import { useEffect, useRef, useState } from "react";
import type { Opportunity } from "./types";

export type LiveGap = { premiumPct: number; grossPct: number; netPct: number };
export type LiveStatus = { binance: boolean; upbit: boolean; bithumb: boolean };
/** Seconds since each venue's last WS message (null = never received). */
export type LiveAges = { binance: number | null; upbit: number | null; bithumb: number | null };

// Equal-enough overlay comparison. Sub-0.005%p wiggle is below anything the UI
// renders (2 decimals), so treating it as "unchanged" avoids a full re-render
// for a difference nobody can see.
const EPS = 0.005;
// Module-scope decoder: Upbit orderbook frames arrive many times per second and
// a fresh TextDecoder was being allocated for each one.
const UTF8 = new TextDecoder();
function sameOverlay(a: Record<string, LiveGap>, b: Record<string, LiveGap>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const x = a[k], y = b[k];
    if (!y) return false;
    if (Math.abs(x.netPct - y.netPct) > EPS) return false;
    if (Math.abs(x.grossPct - y.grossPct) > EPS) return false;
    if (Math.abs(x.premiumPct - y.premiumPct) > EPS) return false;
  }
  return true;
}

export function useLivePrices(opps: Opportunity[], enabled: boolean) {
  const oppsRef = useRef(opps);
  oppsRef.current = opps;

  const bn = useRef(new Map<string, number>()); // base -> USDT last
  const bnBook = useRef(new Map<string, { bid: number; ask: number }>()); // base -> best b/a (from !ticker@arr)
  const upBook = useRef(new Map<string, { bid: number; ask: number }>()); // base -> KRW best b/a (orderbook WS)
  const up = useRef(new Map<string, number>()); // base -> KRW
  const bt = useRef(new Map<string, number>()); // base -> KRW
  // Bithumb depth deltas → price→qty maps per side. No snapshot on this WS, so
  // the book converges from updates; phantom levels are clamped by last price.
  const btDepth = useRef(new Map<string, { bids: Map<number, number>; asks: Map<number, number>; ts: number }>());
  const fx = useRef({ upbit: 0, bithumb: 0 }); // USDT/KRW per venue

  const [overlay, setOverlay] = useState<Record<string, LiveGap>>({});
  const [status, setStatus] = useState<LiveStatus>({ binance: false, upbit: false, bithumb: false });
  const lastMsg = useRef<{ binance: number; upbit: number; bithumb: number }>({ binance: 0, upbit: 0, bithumb: 0 });
  const [ages, setAges] = useState<LiveAges>({ binance: null, upbit: null, bithumb: null });

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    let closed = false;
    const sockets: WebSocket[] = [];
    const timers: ReturnType<typeof setInterval>[] = [];
    const set = (k: keyof LiveStatus, v: boolean) =>
      setStatus((s) => (s[k] === v ? s : { ...s, [k]: v }));

    // Codes currently needed on each KR venue (KRW-USDT/USDT_KRW always).
    const krCodes = (venue: "upbit" | "bithumb") => {
      const out = new Set<string>();
      for (const o of oppsRef.current) {
        if (o.mock || o.kind !== "kimchi") continue;
        const kr = o.legs.find((l) => l.quote === "KRW");
        if (kr && kr.venue === venue) out.add(o.base);
      }
      return out;
    };

    // ── Binance: a COMBINED stream of only the symbols we actually need ──
    //
    // This used to subscribe to `!ticker@arr` — the all-symbols 24h ticker array,
    // ~2800 symbols pushed every second, hundreds of KB to low-MB per message —
    // and JSON.parse'd the whole thing on the main thread to keep the ~30 bases
    // on the board. On a phone that is a recurring tens-of-ms main-thread block
    // every second, independent of how many rows are displayed, and it competed
    // directly with the render tick. `@bookTicker` per symbol gives exactly the
    // best bid/ask we use, in ~200-byte messages.
    let bnWs: WebSocket | null = null;
    let bnStreamKey = "";
    const bnBases = () => {
      const out = new Set<string>();
      for (const o of oppsRef.current) {
        if (o.mock) continue;
        // Any USDT-quoted leg is priced off Binance in the overlay math.
        if (o.legs.some((l) => l.quote === "USDT")) out.add(o.base);
      }
      return [...out].sort();
    };
    const connectBinance = () => {
      if (closed) return;
      const bases = bnBases();
      bnStreamKey = bases.join(",");
      if (!bases.length) {
        // Nothing to watch yet — retry once the first scan lands.
        setTimeout(() => { if (!closed) connectBinance(); }, 1500);
        return;
      }
      // Combined-stream URL cap: keep it sane by chunking to 200 symbols.
      const streams = bases.slice(0, 200).map((b) => `${b.toLowerCase()}usdt@bookTicker`).join("/");
      const ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
      bnWs = ws;
      sockets.push(ws);
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        set("binance", false);
        if (!closed && bnWs === ws) setTimeout(connectBinance, 2000);
      };
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data as string) as { data?: { s?: string; b?: string; a?: string } };
          const d = m.data;
          if (!d?.s || !d.s.endsWith("USDT")) return;
          lastMsg.current.binance = Date.now();
          set("binance", true); // green only once data actually arrives
          const base = d.s.slice(0, -4);
          const bid = Number(d.b), ask = Number(d.a);
          if (bid > 0 && ask > 0) {
            bnBook.current.set(base, { bid, ask });
            bn.current.set(base, (bid + ask) / 2); // mid stands in for "last"
          }
        } catch {
          /* ignore */
        }
      };
    };
    // The needed symbol set changes as the board changes — reconnect only when it
    // ACTUALLY differs (a reconnect per tick would be worse than the firehose).
    const resyncBinance = () => {
      if (closed) return;
      const key = bnBases().join(",");
      if (key === bnStreamKey || !key) return;
      const old = bnWs;
      bnWs = null; // suppress the old socket's reconnect
      try { old?.close(); } catch { /* already closing */ }
      connectBinance();
    };

    // ── Upbit ─────────────────────────────────────────────────────────────
    let upWs: WebSocket | null = null;
    const upSubbed = new Set<string>();
    const subUpbit = () => {
      if (!upWs || upWs.readyState !== WebSocket.OPEN) return;
      const codes = new Set<string>(["KRW-USDT"]);
      for (const base of krCodes("upbit")) codes.add(`KRW-${base}`);
      // Sync to the EXACT desired set — additions AND removals. Upbit's
      // subscription frame is declarative (the last one replaces the previous),
      // but this only ever ADDED, so the orderbook subscription ratcheted upward
      // with every transient candidate for the life of the tab: inbound message
      // rate and main-thread parse cost grew all session (which is why a reload
      // made the app feel fast again). Still send only on a real change — a frame
      // per tick counts against Upbit's rate limit and drops the connection.
      const same = codes.size === upSubbed.size && [...codes].every((c) => upSubbed.has(c));
      if (same && upSubbed.size > 0) return;
      upSubbed.clear();
      for (const c of codes) upSubbed.add(c);
      upWs.send(JSON.stringify([
        { ticket: "teum" },
        { type: "ticker", codes: [...upSubbed] },
        { type: "orderbook", codes: [...upSubbed] }, // best bid/ask → executable overlay
      ]));
      // Drop cached prices for codes we no longer follow (they'd go stale and the
      // overlay would keep using them).
      for (const b of [...upBook.current.keys()]) if (!codes.has(`KRW-${b}`)) upBook.current.delete(b);
      for (const b of [...up.current.keys()]) if (!codes.has(`KRW-${b}`)) up.current.delete(b);
    };
    const connectUpbit = () => {
      if (closed) return;
      const ws = new WebSocket("wss://api.upbit.com/websocket/v1");
      ws.binaryType = "arraybuffer";
      upWs = ws;
      sockets.push(ws);
      ws.onopen = () => {
        upSubbed.clear(); // fresh socket knows nothing — force a full (re)subscribe
        subUpbit();
      };
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        set("upbit", false);
        if (!closed) setTimeout(connectUpbit, 2000);
      };
      ws.onmessage = (e) => {
        try {
          const text = UTF8.decode(e.data as ArrayBuffer);
          const m = JSON.parse(text);
          if (m.type === "orderbook" && m.code && Array.isArray(m.orderbook_units)) {
            const u = m.orderbook_units[0];
            const base = String(m.code).replace("KRW-", "");
            if (u?.bid_price > 0 && u?.ask_price > 0) {
              lastMsg.current.upbit = Date.now();
              upBook.current.set(base, { bid: u.bid_price, ask: u.ask_price });
            }
            return;
          }
          if (m.code && typeof m.trade_price === "number") {
            lastMsg.current.upbit = Date.now();
            set("upbit", true);
            const base = String(m.code).replace("KRW-", "");
            if (base === "USDT") fx.current.upbit = m.trade_price;
            else up.current.set(base, m.trade_price);
          }
        } catch {
          /* ignore */
        }
      };
    };

    // ── Bithumb ───────────────────────────────────────────────────────────
    let btWs: WebSocket | null = null;
    const btSubbed = new Set<string>();
    const subBithumb = () => {
      if (!btWs || btWs.readyState !== WebSocket.OPEN) return;
      const syms = new Set<string>(["USDT_KRW"]);
      for (const base of krCodes("bithumb")) syms.add(`${base}_KRW`);
      // Sync to the exact set (see subUpbit) — this only added, so the
      // subscription grew monotonically for the whole session.
      const same = syms.size === btSubbed.size && [...syms].every((s) => btSubbed.has(s));
      if (same && btSubbed.size > 0) return;
      btSubbed.clear();
      for (const s of syms) btSubbed.add(s);
      btWs.send(JSON.stringify({ type: "ticker", symbols: [...btSubbed], tickTypes: ["24H"] }));
      btWs.send(JSON.stringify({ type: "orderbookdepth", symbols: [...btSubbed] })); // 실호가 (델타)
      for (const b of [...btDepth.current.keys()]) if (!syms.has(`${b}_KRW`)) btDepth.current.delete(b);
      for (const b of [...bt.current.keys()]) if (!syms.has(`${b}_KRW`)) bt.current.delete(b);
    };
    const connectBithumb = () => {
      if (closed) return;
      const ws = new WebSocket("wss://pubwss.bithumb.com/pub/ws");
      btWs = ws;
      sockets.push(ws);
      ws.onopen = () => {
        btSubbed.clear(); // fresh socket — force full resubscribe
        subBithumb();
      };
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        set("bithumb", false);
        if (!closed) setTimeout(connectBithumb, 2000);
      };
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data as string);
          const c = m.content;
          if (m.type === "orderbookdepth" && c && Array.isArray(c.list)) {
            lastMsg.current.bithumb = Date.now();
            for (const d of c.list) {
              const base = String(d.symbol ?? "").replace("_KRW", "");
              if (!base) continue;
              let book = btDepth.current.get(base);
              if (!book) { book = { bids: new Map(), asks: new Map(), ts: 0 }; btDepth.current.set(base, book); }
              const side = d.orderType === "bid" ? book.bids : book.asks;
              const price = Number(d.price), qty = Number(d.quantity);
              if (!(price > 0)) continue;
              if (qty > 0) side.set(price, qty); else side.delete(price);
              book.ts = Date.now();
            }
            return;
          }
          if (m.type === "ticker" && c && c.symbol) {
            const base = String(c.symbol).replace("_KRW", "");
            const px = Number(c.closePrice);
            if (!px) return;
            lastMsg.current.bithumb = Date.now();
            set("bithumb", true);
            if (base === "USDT") fx.current.bithumb = px;
            else bt.current.set(base, px);
          }
        } catch {
          /* ignore */
        }
      };
    };

    // 델타북에서 best bid/ask — 스냅샷이 없는 WS라 마지막 체결가 ±5% 밖의
    // 팬텀 레벨(업데이트가 끊긴 잔재)은 걸러낸다.
    const btBest = (base: string): { bid: number; ask: number } | undefined => {
      const book = btDepth.current.get(base);
      if (!book || Date.now() - book.ts > 15_000) return undefined; // 신선한 것만
      const last = bt.current.get(base) ?? 0;
      let bid = 0, ask = Infinity;
      for (const [p] of book.bids) { if (last > 0 && p > last * 1.05) { book.bids.delete(p); continue; } if (p > bid) bid = p; }
      for (const [p] of book.asks) { if (last > 0 && p < last * 0.95) { book.asks.delete(p); continue; } if (p < ask) ask = p; }
      return bid > 0 && Number.isFinite(ask) && ask > bid ? { bid, ask } : undefined;
    };

    connectBinance();
    connectUpbit();
    connectBithumb();

    // Recompute the live overlay from the latest prices + latest opps.
    const recompute = () => {
      // pick up any newly-listed KR bases since last tick (both are no-ops when
      // the desired set is unchanged)
      subUpbit();
      subBithumb();
      resyncBinance();
      const ov: Record<string, LiveGap> = {};
      for (const o of oppsRef.current) {
        if (o.mock || o.kind !== "kimchi") continue;
        const kr = o.legs.find((l) => l.quote === "KRW");
        const globalLeg = o.legs.find((l) => l.quote === "USDT");
        if (!kr || !globalLeg) continue;
        const venue = kr.venue as "upbit" | "bithumb";
        const buyGlobal = o.legs.find((l) => l.side === "buy")?.quote === "USDT";
        // PREFERRED: fully-executable live gross from real best bid/ask on both
        // sides (Upbit orderbook WS + Binance b/a) — same math as the scan.
        const kb = venue === "upbit" ? upBook.current.get(o.base) : btBest(o.base);
        const gb = bnBook.current.get(o.base);
        const rate = venue === "upbit" ? fx.current.upbit : fx.current.bithumb;
        if (kb && gb && rate > 0) {
          const grossPct = buyGlobal
            ? ((kb.bid / rate - gb.ask) / gb.ask) * 100      // buy global ask → sell KR bid
            : ((gb.bid - kb.ask / rate) / (kb.ask / rate)) * 100; // buy KR ask → sell global bid
          ov[o.id] = { premiumPct: grossPct, grossPct, netPct: grossPct - o.costPct };
          continue;
        }
        // FALLBACK (bithumb leg / book not yet streamed): anchor to the scan's
        // executable gross and apply only the live price-movement delta.
        const liveKr = venue === "upbit" ? up.current.get(o.base) : bt.current.get(o.base);
        const liveGlobal = bn.current.get(o.base); // Binance WS last (proxy for the USDT mover)
        const scanKr = kr.price, scanGlobal = globalLeg.price;
        if (!liveKr || !liveGlobal || !scanKr || !scanGlobal) continue; // no live pair → keep scan value
        const ratioNow = (liveKr / scanKr) / (liveGlobal / scanGlobal);
        const premiumDeltaPct = (ratioNow - 1) * 100;
        // buyGlobal (sell KR): profit rises as KR outpaces global (+delta).
        // reverse (sell global): profit rises as global outpaces KR (−delta).
        const grossPct = o.grossPct + (buyGlobal ? premiumDeltaPct : -premiumDeltaPct);
        ov[o.id] = { premiumPct: premiumDeltaPct, grossPct, netPct: grossPct - o.costPct };
      }
      // Only publish when something actually MOVED. These two setters used to
      // fire unconditionally with fresh object identities every 600ms — even
      // with zero WS messages and identical numbers — which re-rendered the
      // whole app (~100 renders/min on every tab, each cascading into full
      // sorts/filters over the opportunity list) purely to redraw the same
      // pixels. The WS message handlers were already identity-guarded; only this
      // interval was not.
      setOverlay((prev) => (sameOverlay(prev, ov) ? prev : ov));
      const now = Date.now();
      const age = (t: number) => (t ? Math.round((now - t) / 1000) : null);
      const nextAges: LiveAges = {
        binance: age(lastMsg.current.binance),
        upbit: age(lastMsg.current.upbit),
        bithumb: age(lastMsg.current.bithumb),
      };
      setAges((prev) =>
        prev.binance === nextAges.binance && prev.upbit === nextAges.upbit && prev.bithumb === nextAges.bithumb
          ? prev
          : nextAges,
      );
    };
    // Pause the recompute while the tab is hidden. The 600ms loop, the WS parse
    // work and the render churn all kept running with the screen off — pure
    // battery and cellular drain for a view nobody is looking at, and it left a
    // backlog to flush on return (which is what made switching back feel slow).
    let tick: ReturnType<typeof setInterval> | null = setInterval(recompute, 600);
    const onVisibility = () => {
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      if (hidden) {
        if (tick) { clearInterval(tick); tick = null; }
      } else if (!tick) {
        recompute(); // catch up immediately, then resume the cadence
        tick = setInterval(recompute, 600);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    // Keepalive pings (Upbit/Bithumb drop idle sockets).
    timers.push(
      setInterval(() => {
        try {
          if (upWs?.readyState === WebSocket.OPEN) upWs.send("PING");
          if (btWs?.readyState === WebSocket.OPEN) btWs.send(JSON.stringify({ type: "ping" }));
        } catch {
          /* ignore */
        }
      }, 30000),
    );

    return () => {
      closed = true;
      if (tick) clearInterval(tick);
      timers.forEach(clearInterval);
      document.removeEventListener("visibilitychange", onVisibility);
      sockets.forEach((ws) => {
        try {
          ws.onclose = null;
          ws.close();
        } catch {
          /* ignore */
        }
      });
      sockets.length = 0; // 재연결마다 죽은 소켓 객체가 누적되던 것 정리
    };
  }, [enabled]);

  return { overlay, status, ages };
}
